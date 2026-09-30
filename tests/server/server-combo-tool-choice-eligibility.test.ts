import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { clearComboSelectionState, clearComboTargetCooldowns } from "../../src/combos";
import { clearKeyCooldowns } from "../../src/providers/key-failover";
import { clearResponseStateForTests, flushResponseState, responseStatePersistPendingForTests } from "../../src/responses/state";
import { handleResponses } from "../../src/server/responses";
import { clearComboRecallForTests } from "../../src/server/responses/combo-session-recall";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let testDir = "";
let previousHome: string | undefined;
let isolatedCodexHome: IsolatedCodexHome | null = null;
let releaseSpendHome: (() => void) | undefined;
const servers: Array<ReturnType<typeof Bun.serve>> = [];

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  isolatedCodexHome = installIsolatedCodexHome("ocx-combo-tool-choice-codex-");
  testDir = mkdtempSync(join(tmpdir(), "ocx-combo-tool-choice-"));
  process.env.OPENCODEX_HOME = testDir;
  releaseSpendHome = acquireOwnedSpendHome();
  clearComboSelectionState();
  clearComboRecallForTests();
  clearComboTargetCooldowns();
  clearKeyCooldowns();
  clearResponseStateForTests();
});

afterEach(async () => {
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  let pending = true;
  try {
    for (const server of servers.splice(0)) await server.stop(true);
    await flushResponseState();
    pending = responseStatePersistPendingForTests();
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
  }
  expect(pending).toBe(false);
});

function serve(label: string, hits: string[], bodies?: Array<{ label: string; body: Record<string, unknown> }>) {
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async request => {
      hits.push(label);
      if (bodies) bodies.push({ label, body: await request.json() as Record<string, unknown> });
      return Response.json({
        id: "resp_fixture",
        object: "response",
        status: "completed",
        model: label,
        output: [{
          id: "msg_fixture",
          type: "message",
          role: "assistant",
          status: "completed",
          content: [{ type: "output_text", text: label, annotations: [] }],
        }],
        usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
      });
    },
  });
  servers.push(server);
  return server;
}

function provider(server: ReturnType<typeof Bun.serve>, extra: Partial<OcxProviderConfig> = {}): OcxProviderConfig {
  return {
    adapter: "openai-responses",
    baseUrl: `${server.url.toString().replace(/\/$/, "")}/v1`,
    allowPrivateNetwork: true,
    authMode: "key",
    apiKey: "fixture-key",
    ...extra,
  };
}

function config(hits: string[], bodies?: Array<{ label: string; body: Record<string, unknown> }>): OcxConfig {
  const limited = serve("limited", hits, bodies);
  const capable = serve("capable", hits, bodies);
  return {
    port: 0,
    defaultProvider: "limited",
    providers: {
      limited: provider(limited, { models: ["m1"], autoToolChoiceOnlyModels: ["m1"] }),
      capable: provider(capable, { models: ["m2"] }),
    },
    combos: {
      free: {
        strategy: "failover",
        targets: [
          { provider: "limited", model: "m1" },
          { provider: "capable", model: "m2" },
        ],
      },
    },
  };
}

async function post(cfg: OcxConfig, toolChoice: unknown): Promise<Response> {
  return handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "combo/free",
      input: "use the search contract",
      stream: false,
      tools: [{ type: "web_search" }],
      tool_choice: toolChoice,
    }),
  }), cfg, { model: "", provider: "" });
}

describe("combo tool_choice eligibility", () => {
  test("forced hosted tool choice skips auto-only target before any send", async () => {
    const hits: string[] = [];
    const response = await post(config(hits), { type: "web_search" });
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("capable");
    expect(hits).toEqual(["capable"]);
  });

  test("tool_choice none also skips a target proven auto-only", async () => {
    const hits: string[] = [];
    const response = await post(config(hits), "none");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("capable");
    expect(hits).toEqual(["capable"]);
  });

  test("auto preserves configured combo priority", async () => {
    const hits: string[] = [];
    const response = await post(config(hits), "auto");
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("limited");
    expect(hits).toEqual(["limited"]);
  });

  test("omitted tool_choice preserves configured combo priority", async () => {
    const hits: string[] = [];
    const response = await post(config(hits), undefined);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("limited");
    expect(hits).toEqual(["limited"]);
  });

  test("forced hosted choice reaches the capable fallback unchanged", async () => {
    const hits: string[] = [];
    const bodies: Array<{ label: string; body: Record<string, unknown> }> = [];
    const choice = { type: "web_search" };
    const response = await post(config(hits, bodies), choice);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("capable");
    expect(hits).toEqual(["capable"]);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]?.label).toBe("capable");
    expect(bodies[0]?.body.tool_choice).toEqual(choice);
  });
});
