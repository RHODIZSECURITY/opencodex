import { afterEach, beforeEach, describe, expect, mock, setDefaultTimeout, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagementRequest as Request } from "../helpers/management-auth";
import { comboProviderFactory } from "../helpers/combo-provider";
import { chatStream, chatSuccess } from "../helpers/combo-failover-upstream";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";
import { clearComboSelectionState, clearComboTargetCooldowns } from "../../src/combos";
import { clearComboRecallForTests } from "../../src/server/responses/combo-session-recall";
import { clearKeyCooldowns } from "../../src/providers/key-failover";
import { clearCodexUpstreamHealth } from "../../src/codex/routing";
import { clearRequestLogsForTests, type RequestLogContext } from "../../src/server/request-log";
import {
  clearResponseStateForTests,
  flushResponseState,
  responseStatePersistPendingForTests,
} from "../../src/responses/state";
import { handleResponses } from "../../src/server/responses";
import type { ProviderAdapter } from "../../src/adapters/base";
import { handleClaudeMessages } from "../../src/server/claude-messages";
import type { AdapterEvent, OcxConfig, OcxProviderConfig } from "../../src/types";
import { createRequestExecutionBudget } from "../../src/lib/request-execution-budget";

/**
 * Zero-output combo failover driven by a bare Responses SSE `error` event.
 *
 * This case was written in `server-combo-failover-e2e.test.ts` and moved here unchanged.
 * That file carries a file-size-ratchet cap, and two separately passing pull requests
 * (#4824 and #4817) grew it past that cap once both were on `dev`. The ratchet only ever
 * lowers a cap, so the way back under it is to hold new cases in a sibling file rather
 * than to raise the number.
 *
 * The harness below is the subset of that file's fixture this case actually uses: real
 * loopback upstreams, an isolated home, and the combo/request-log state that leaks
 * between tests. No module is mocked here, because this case drives the real
 * `openai-responses` adapter.
 */

// The parent file raises this for the same reason: a real loopback server plus combo
// failover exceeds the 5s default under full-suite load on Windows.
setDefaultTimeout(30_000);

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;
const servers: Array<ReturnType<typeof Bun.serve>> = [];
const provider = comboProviderFactory(() => undefined);
const actualResolver = await import("../../src/server/adapter-resolve");
const actualResolveAdapter = actualResolver.resolveAdapter;
let customRunTurn: NonNullable<ProviderAdapter["runTurn"]> | undefined;

mock.module("../../src/server/adapter-resolve", () => ({
  ...actualResolver,
  resolveAdapter(
    providerConfig: OcxProviderConfig,
    cacheRetention?: "none" | "short" | "long",
    providerId?: string,
  ) {
    if (providerConfig.adapter === "test-run-turn") {
      const adapter: ProviderAdapter = {
        name: "test-run-turn",
        buildRequest: () => ({ url: providerConfig.baseUrl, method: "POST", headers: {}, body: "" }),
        async *parseStream(): AsyncGenerator<AdapterEvent> {
          yield { type: "error", message: "test runTurn adapter does not use parseStream" };
        },
        async runTurn(parsed, incoming, emit) {
          if (!customRunTurn) throw new Error("custom runTurn not installed");
          await customRunTurn(parsed, incoming, emit);
        },
      };
      return adapter;
    }
    return actualResolveAdapter(providerConfig, cacheRetention, providerId);
  },
}));

let releaseSpendHome: (() => void) | undefined;

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-combo-zero-output-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-combo-zero-output-"));
  process.env.OPENCODEX_HOME = testDir;
  // Direct handler dispatches need the writer lease that startServer normally holds.
  releaseSpendHome = acquireOwnedSpendHome();
  clearComboSelectionState();
  clearComboRecallForTests();
  clearComboTargetCooldowns();
  clearKeyCooldowns();
  clearCodexUpstreamHealth();
  customRunTurn = undefined;
  clearRequestLogsForTests();
  clearResponseStateForTests();
});

afterEach(async () => {
  // Release before home teardown to prevent Windows removal failures and a live unlinked database.
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  let responseStatePending = true;
  try {
    for (const server of servers.splice(0)) await server.stop(true);
    await flushResponseState();
    responseStatePending = responseStatePersistPendingForTests();
  } finally {
    clearResponseStateForTests();
    if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
    else process.env.OPENCODEX_HOME = previousHome;
    isolatedCodexHome?.restore();
    isolatedCodexHome = null;
    if (testDir) removeTreeWithRetry(testDir);
    clearComboSelectionState();
    clearComboRecallForTests();
    clearComboTargetCooldowns();
    clearKeyCooldowns();
    clearCodexUpstreamHealth();
    clearRequestLogsForTests();
  }
  expect(responseStatePending).toBe(false);
});

/** Loopback upstream whose lifetime the afterEach owns. */
function serve(handler: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  servers.push(server);
  return server;
}

/** Provider base URL for a fixture server, without the trailing slash. */
function baseUrl(server: ReturnType<typeof Bun.serve>): string {
  return `${server.url.toString().replace(/\/$/, "")}/v1`;
}

/** Minimal completed Responses payload the backup target answers with. */
function responsesSuccess(text: string, model = "responses-model"): Record<string, unknown> {
  return {
    id: `resp-${model}`,
    object: "response",
    status: "completed",
    model,
    output: [{
      id: "msg_backup",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text, annotations: [] }],
    }],
    usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
  };
}

/** Failover combo over the supplied providers, one target per provider in order. */
function comboConfig(
  providers: OcxConfig["providers"],
  targets = Object.keys(providers).map((name, index) => ({ provider: name, model: `m${index + 1}` })),
  extra: Partial<NonNullable<OcxConfig["combos"]>[string]> = {},
): OcxConfig {
  return {
    port: 0,
    defaultProvider: Object.keys(providers)[0]!,
    providers,
    combos: { free: { strategy: "failover", targets, ...extra } },
  };
}


type HandleOptions = NonNullable<Parameters<typeof handleResponses>[3]>;

async function post(
  config: OcxConfig,
  raw: Record<string, unknown> = {},
  options: HandleOptions = {},
): Promise<Response> {
  return handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "combo/free", input: "hello", stream: false, ...raw }),
  }), config, { model: "", provider: "" }, options);
}

describe("combo zero-output bare Responses error failover", () => {
  test("zero-output bare Responses SSE error hops before committing the child stream", async () => {
    const hits: string[] = [];
    const a = serve(() => {
      hits.push("a");
      return new Response([
        "event: response.created",
        `data: ${JSON.stringify({ type: "response.created", response: { id: "r1", status: "in_progress" } })}`,
        "",
        "event: error",
        `data: ${JSON.stringify({
          type: "error",
          message: "An error occurred while processing your request. Please include request ID r1.",
        })}`,
        "",
        "",
      ].join("\n"), { headers: { "content-type": "text/event-stream" } });
    });
    const b = serve(() => {
      hits.push("b");
      return new Response([
        "event: response.completed",
        `data: ${JSON.stringify({
          type: "response.completed",
          response: { ...responsesSuccess("bare-error backup", "m2"), status: "completed" },
        })}`,
        "",
        "",
      ].join("\n"), { headers: { "content-type": "text/event-stream" } });
    });
    const config = comboConfig({
      a: provider("openai-responses", baseUrl(a), "key-a"),
      b: provider("openai-responses", baseUrl(b), "key-b"),
    });

    const parent: RequestLogContext = { model: "", provider: "" };
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ model: "combo/free", input: "hello", stream: true }),
    }), config, parent);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("bare-error backup");
    expect(hits).toEqual(["a", "b"]);
    expect(parent).toMatchObject({
      provider: "combo",
      model: "combo/free",
      resolvedModel: "m2",
      attempts: [
        { ordinal: 1, provider: "a", model: "m1", status: 502 },
        { ordinal: 2, provider: "b", model: "m2" },
      ],
    });
  });

  test("undeclared client tool before output fails closed on the target and hops to backup", async () => {
    const hits: string[] = [];
    const a = serve(() => {
      hits.push("a");
      return new Response([
        "event: response.created",
        `data: ${JSON.stringify({ type: "response.created", response: { id: "r-stale", status: "in_progress" } })}`,
        "",
        "event: response.output_item.added",
        `data: ${JSON.stringify({
          type: "response.output_item.added",
          output_index: 0,
          item: {
            type: "function_call",
            id: "fc-stale",
            call_id: "call-stale",
            name: "not_declared",
            arguments: "{}",
          },
        })}`,
        "",
        "event: response.completed",
        `data: ${JSON.stringify({
          type: "response.completed",
          response: { ...responsesSuccess("must not commit", "m1"), output: [], status: "completed" },
        })}`,
        "",
        "",
      ].join("\n"), { headers: { "content-type": "text/event-stream" } });
    });
    const b = serve(() => {
      hits.push("b");
      return new Response([
        "event: response.completed",
        `data: ${JSON.stringify({
          type: "response.completed",
          response: { ...responsesSuccess("declared-catalog backup", "m2"), status: "completed" },
        })}`,
        "",
        "",
      ].join("\n"), { headers: { "content-type": "text/event-stream" } });
    });
    const config = comboConfig({
      a: provider("openai-responses", baseUrl(a), "key-a"),
      b: provider("openai-responses", baseUrl(b), "key-b"),
    });

    const parent: RequestLogContext = { model: "", provider: "" };
    const response = await handleResponses(new Request("http://localhost/v1/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "combo/free",
        input: "hello",
        stream: true,
        tools: [{
          type: "function",
          name: "declared_only",
          description: "Only this tool is authorized for the current request.",
          parameters: { type: "object", properties: {}, additionalProperties: false },
        }],
      }),
    }), config, parent);
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).toContain("declared-catalog backup");
    expect(text).not.toContain("not_declared");
    expect(hits).toEqual(["a", "b"]);
    expect(parent).toMatchObject({
      provider: "combo",
      model: "combo/free",
      resolvedModel: "m2",
      attempts: [
        { ordinal: 1, provider: "a", model: "m1", status: 502 },
        { ordinal: 2, provider: "b", model: "m2" },
      ],
    });
  });

  test("Claude /v1/messages inherits undeclared-tool failover and returns the backup", async () => {
    const hits: string[] = [];
    const a = serve(() => {
      hits.push("a");
      return new Response([
        "event: response.created",
        `data: ${JSON.stringify({ type: "response.created", response: { id: "r-claude-stale", status: "in_progress" } })}`,
        "",
        "event: response.output_item.added",
        `data: ${JSON.stringify({
          type: "response.output_item.added",
          output_index: 0,
          item: {
            type: "function_call",
            id: "fc-claude-stale",
            call_id: "call-claude-stale",
            name: "not_declared",
            arguments: "{}",
          },
        })}`,
        "",
        "event: response.completed",
        `data: ${JSON.stringify({
          type: "response.completed",
          response: { ...responsesSuccess("must not commit", "m1"), output: [], status: "completed" },
        })}`,
        "",
        "",
      ].join("\n"), { headers: { "content-type": "text/event-stream" } });
    });
    const b = serve(() => {
      hits.push("b");
      return new Response([
        "event: response.output_text.delta",
        `data: ${JSON.stringify({
          type: "response.output_text.delta",
          delta: "claude backup",
          item_id: "msg_backup",
          output_index: 0,
          content_index: 0,
        })}`,
        "",
        "event: response.completed",
        `data: ${JSON.stringify({
          type: "response.completed",
          response: { ...responsesSuccess("claude backup", "m2"), status: "completed" },
        })}`,
        "",
        "",
      ].join("\n"), { headers: { "content-type": "text/event-stream" } });
    });
    const config = comboConfig({
      a: provider("openai-responses", baseUrl(a), "key-a"),
      b: provider("openai-responses", baseUrl(b), "key-b"),
    });

    const parent: RequestLogContext = { model: "", provider: "" };
    const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: "combo/free",
        max_tokens: 64,
        stream: true,
        messages: [{ role: "user", content: "hello" }],
        tools: [{
          name: "declared_only",
          description: "Only this tool is authorized for the current request.",
          input_schema: { type: "object", properties: {}, additionalProperties: false },
        }],
      }),
    }), config, parent);
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).toContain("claude backup");
    expect(text).not.toContain("not_declared");
    expect(hits).toEqual(["a", "b"]);
    expect(parent).toMatchObject({
      provider: "combo",
      model: "combo/free",
      resolvedModel: "m2",
      attempts: [
        { ordinal: 1, provider: "a", model: "m1", status: 502 },
        { ordinal: 2, provider: "b", model: "m2" },
      ],
    });
  });

  test("Claude /v1/messages hops past an OpenRouter-like stale chat tool call", async () => {
    const hits: string[] = [];
    const a = serve(() => {
      hits.push("a");
      return new Response([
        `data: ${JSON.stringify({
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: 0,
                id: "call-stale-github",
                type: "function",
                function: { name: "mcp__github__list_branches", arguments: "{}" },
              }],
            },
            finish_reason: null,
          }],
        })}`,
        "",
        `data: ${JSON.stringify({
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        })}`,
        "",
        "data: [DONE]",
        "",
        "",
      ].join("\n"), { headers: { "content-type": "text/event-stream" } });
    });
    const b = serve(() => {
      hits.push("b");
      return new Response([
        "event: response.output_text.delta",
        `data: ${JSON.stringify({
          type: "response.output_text.delta",
          delta: "openrouter stale-tool backup",
          item_id: "msg_backup",
          output_index: 0,
          content_index: 0,
        })}`,
        "",
        "event: response.completed",
        `data: ${JSON.stringify({
          type: "response.completed",
          response: { ...responsesSuccess("openrouter stale-tool backup", "m2"), status: "completed" },
        })}`,
        "",
        "",
      ].join("\n"), { headers: { "content-type": "text/event-stream" } });
    });
    const config = comboConfig({
      openrouterFixture: provider("openai-chat", baseUrl(a), "key-openrouter"),
      backup: provider("openai-responses", baseUrl(b), "key-backup"),
    }, [
      { provider: "openrouterFixture", model: "nvidia/nemotron" },
      { provider: "backup", model: "m2" },
    ]);

    const parent: RequestLogContext = { model: "", provider: "" };
    const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "claude-cli/2.1.200" },
      body: JSON.stringify({
        model: "combo/free",
        max_tokens: 64,
        stream: true,
        messages: [{ role: "user", content: "hello" }],
        tools: [{
          name: "declared_only",
          description: "Only this tool is authorized for the current request.",
          input_schema: { type: "object", properties: {}, additionalProperties: false },
        }],
      }),
    }), config, parent);
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).toContain("openrouter stale-tool backup");
    expect(text).not.toContain("mcp__github__list_branches");
    expect(hits).toEqual(["a", "b"]);
    expect(parent).toMatchObject({
      provider: "combo",
      model: "combo/free",
      resolvedModel: "m2",
      attempts: [
        { ordinal: 1, provider: "openrouterFixture", model: "nvidia/nemotron", status: 502 },
        { ordinal: 2, provider: "backup", model: "m2" },
      ],
    });
  });

  test("Claude /v1/messages preserves a deferred partial catalog instead of treating it as stale", async () => {
    const hits: string[] = [];
    const a = serve(() => {
      hits.push("a");
      return new Response([
        `data: ${JSON.stringify({
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: 0,
                id: "call-deferred-github",
                type: "function",
                function: { name: "mcp__github__list_branches", arguments: "{}" },
              }],
            },
            finish_reason: null,
          }],
        })}`,
        "",
        `data: ${JSON.stringify({
          choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }],
        })}`,
        "",
        "data: [DONE]",
        "",
        "",
      ].join("\n"), { headers: { "content-type": "text/event-stream" } });
    });
    const b = serve(() => {
      hits.push("b");
      return Response.json(responsesSuccess("unexpected backup", "m2"));
    });
    const config = comboConfig({
      openrouterFixture: provider("openai-chat", baseUrl(a), "key-openrouter"),
      backup: provider("openai-responses", baseUrl(b), "key-backup"),
    }, [
      { provider: "openrouterFixture", model: "nvidia/nemotron" },
      { provider: "backup", model: "m2" },
    ]);

    const parent: RequestLogContext = { model: "", provider: "" };
    const response = await handleClaudeMessages(new Request("http://localhost/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "claude-cli/2.1.200" },
      body: JSON.stringify({
        model: "combo/free",
        max_tokens: 64,
        stream: true,
        messages: [{ role: "user", content: "hello" }],
        tools: [{
          name: "declared_only",
          description: "This request intentionally uses a partial deferred catalog.",
          defer_loading: true,
          input_schema: { type: "object", properties: {}, additionalProperties: false },
        }],
      }),
    }), config, parent);
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).toContain("mcp__github__list_branches");
    expect(text).not.toContain("unexpected backup");
    expect(hits).toEqual(["a"]);
    expect(parent).toMatchObject({
      provider: "combo",
      model: "combo/free",
      resolvedModel: "nvidia/nemotron",
      attempts: [{ ordinal: 1, provider: "openrouterFixture", model: "nvidia/nemotron" }],
    });
  });

  test("last-resort cooldown policy defers an available final target for a recoverable primary", async () => {
    let aHits = 0;
    let bHits = 0;
    const a = serve(() => {
      aHits += 1;
      return aHits === 1
        ? Response.json({ error: { message: "rate limited" } }, { status: 429 })
        : chatSuccess("primary recovered", "m1");
    });
    const b = serve(() => {
      bHits += 1;
      return chatSuccess("last resort", "m2");
    });
    const providers = {
      a: provider("openai-chat", baseUrl(a), "key-a"),
      b: provider("openai-chat", baseUrl(b), "key-b"),
    };

    const prior = await post(comboConfig(
      providers,
      [{ provider: "a", model: "m1" }],
      { cooldownMs: 100 },
    ));
    expect(prior.status).toBe(429);
    await prior.text();

    const fresh = await post(comboConfig(
      providers,
      [{ provider: "a", model: "m1" }, { provider: "b", model: "m2" }],
      { cooldownMs: 100, waitForCooldownMs: 500, cooldownWaitPolicy: "last-resort" },
    ));
    expect(fresh.status).toBe(200);
    expect(await fresh.text()).toContain("primary recovered");
    expect([aHits, bHits]).toEqual([2, 0]);
  });

  test("authoritative Anthropic combo catalog rejects a stale runTurn tool before commit", async () => {
    let aHits = 0;
    let bHits = 0;
    customRunTurn = async (_parsed, _incoming, emit) => {
      aHits += 1;
      emit({ type: "tool_call_start", id: "call-stale", name: "mcp__github__list_branches" });
      emit({ type: "tool_call_delta", arguments: "{}" });
      emit({ type: "tool_call_end" });
      emit({ type: "done", endTurn: true });
    };
    const b = serve(() => {
      bHits += 1;
      return chatStream("runTurn stale-tool backup");
    });
    const config = comboConfig({
      a: provider("test-run-turn", "test://run-turn", "key-a"),
      b: provider("openai-chat", baseUrl(b), "key-b"),
    });
    const response = await post(config, {
      stream: true,
      tools: [{
        type: "function",
        name: "declared_only",
        description: "Current client tool catalog.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      }],
    }, {
      inboundWire: "anthropic",
      authoritativeClientToolCatalog: true,
    });
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).toContain("runTurn stale-tool backup");
    expect(text).not.toContain("mcp__github__list_branches");
    expect([aHits, bHits]).toEqual([1, 1]);
  });

  test("authoritative Anthropic combo catalog rejects a stale buffered runTurn tool before commit", async () => {
    let aHits = 0;
    let bHits = 0;
    customRunTurn = async (_parsed, _incoming, emit) => {
      aHits += 1;
      emit({ type: "tool_call_start", id: "call-stale-buffered", name: "mcp__github__list_branches" });
      emit({ type: "tool_call_delta", arguments: "{}" });
      emit({ type: "tool_call_end" });
      emit({ type: "done", endTurn: true });
    };
    const b = serve(() => {
      bHits += 1;
      return chatSuccess("buffered runTurn stale-tool backup", "m2");
    });
    const config = comboConfig({
      a: provider("test-run-turn", "test://run-turn", "key-a"),
      b: provider("openai-chat", baseUrl(b), "key-b"),
    });
    const response = await post(config, {
      stream: false,
      tools: [{
        type: "function",
        name: "declared_only",
        description: "Current client tool catalog.",
        parameters: { type: "object", properties: {}, additionalProperties: false },
      }],
    }, {
      inboundWire: "anthropic",
      authoritativeClientToolCatalog: true,
    });
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(text).toContain("buffered runTurn stale-tool backup");
    expect(text).not.toContain("mcp__github__list_branches");
    expect([aHits, bHits]).toEqual([1, 1]);
  });


  test("an exhausted shared budget refuses the first combo target before upstream dispatch", async () => {
    let hits = 0;
    const upstream = serve(() => {
      hits += 1;
      return chatSuccess("must not dispatch", "m1");
    });
    const config = comboConfig({
      a: provider("openai-chat", baseUrl(upstream), "key-a"),
    });
    const exhausted = createRequestExecutionBudget(undefined, "combo-initial-denied");
    // Simulate sends already consumed by an enclosing leg of the same logical request. A
    // one-target combo's declared total is four, so its first reservation must now be refused.
    exhausted.used = 4;

    const response = await post(config, {}, { sendBudget: exhausted });
    const text = await response.text();

    expect(response.status).toBe(429);
    expect(text).toContain("request_send_budget_exhausted");
    expect(hits).toBe(0);
  });

  test("a denied later combo target preserves the last real upstream failure", async () => {
    let aHits = 0;
    let bHits = 0;
    const a = serve(() => {
      aHits += 1;
      return new Response(JSON.stringify({
        error: { message: "primary budget sentinel", type: "server_error" },
      }), {
        status: 502,
        headers: { "content-type": "application/json" },
      });
    });
    const b = serve(() => {
      bHits += 1;
      return chatSuccess("must not dispatch backup", "m2");
    });
    const config = comboConfig({
      a: provider("openai-chat", baseUrl(a), "key-a"),
      b: provider("openai-chat", baseUrl(b), "key-b"),
    });

    let charges = 0;
    const budget = createRequestExecutionBudget(undefined, "combo-later-denied", {
      charge: () => {
        charges += 1;
        return charges === 1;
      },
      refund: () => {},
    });

    const response = await post(config, {}, { sendBudget: budget });
    const text = await response.text();

    expect(response.status).toBe(502);
    expect(text).toContain("primary budget sentinel");
    expect([aHits, bHits]).toEqual([1, 0]);
    expect(charges).toBe(2);
  });

});
