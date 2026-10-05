import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clearComboSelectionState,
  clearComboTargetCooldowns,
  isComboTargetInCooldown,
} from "../../src/combos";
import { handleResponses } from "../../src/server/responses";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { chatStream, chatSuccess } from "../helpers/combo-failover-upstream";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";
import { removeTreeWithRetry } from "../helpers/remove-tree";

let testDir = "";
let previousHome: string | undefined;
let releaseSpendHome: (() => void) | undefined;
const servers: Array<ReturnType<typeof Bun.serve>> = [];

beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  testDir = mkdtempSync(join(tmpdir(), "ocx-vertex-malformed-"));
  process.env.OPENCODEX_HOME = testDir;
  clearComboSelectionState();
  clearComboTargetCooldowns();
  releaseSpendHome = acquireOwnedSpendHome();
});
afterEach(async () => {
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  for (const server of servers.splice(0)) server.stop(true);
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  await removeTreeWithRetry(testDir);
});

function serve(handler: (request: Request) => Response | Promise<Response>) {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: handler });
  servers.push(server);
  return server;
}

function baseUrl(server: ReturnType<typeof Bun.serve>): string {
  return `${server.url.toString().replace(/\/$/, "")}/v1`;
}

function provider(url: string, apiKey: string): OcxProviderConfig {
  return {
    adapter: "openai-chat",
    baseUrl: url,
    allowPrivateNetwork: true,
    authMode: "key",
    apiKey,
  };
}
function comboConfig(a: string, b: string): OcxConfig {
  return {
    port: 0,
    defaultProvider: "a",
    providers: {
      a: provider(a, "key-a"),
      b: provider(b, "key-b"),
    },
    combos: {
      free: {
        strategy: "failover",
        targets: [
          { provider: "a", model: "m1" },
          { provider: "b", model: "m2" },
        ],
      },
    },
  };
}

async function post(config: OcxConfig, raw: Record<string, unknown>): Promise<Response> {
  return await handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: "combo/free", input: "hello", stream: false, ...raw }),
  }), config, { model: "", provider: "" });
}
test("Vertex malformed function-call 400 hops to backup for non-stream and stream", async () => {
  const hits: string[] = [];
  const leaf = {
    message: "Vertex AI response truncated upstream before the turn completed (MALFORMED_FUNCTION_CALL)",
    type: "invalid_request_error",
    code: "invalid_request_error",
  };
  const vertex = serve(async request => {
    const body = await request.json() as { model?: string; stream?: boolean };
    hits.push(`vertex:${body.model}:${body.stream}`);
    return Response.json({ error: leaf, response: { error: leaf } }, { status: 400 });
  });
  const backup = serve(async request => {
    const body = await request.json() as { model?: string; stream?: boolean };
    hits.push(`backup:${body.model}:${body.stream}`);
    return body.stream
      ? chatStream("vertex stream backup")
      : chatSuccess("vertex json backup", "m2");
  });
  const config = comboConfig(baseUrl(vertex), baseUrl(backup));
  const tools = [{
    type: "function",
    name: "lookup",
    description: "lookup",
    parameters: { type: "object", properties: {} },
  }];
  const unary = await post(config, { tools });
  expect(unary.status).toBe(200);
  expect(JSON.stringify(await unary.json())).toContain("vertex json backup");
  expect(isComboTargetInCooldown("free", { provider: "a", model: "m1" })).toBe(false);

  clearComboTargetCooldowns();
  clearComboSelectionState();
  const streaming = await post(config, { stream: true, tools });
  expect(streaming.status).toBe(200);
  expect(await streaming.text()).toContain("vertex stream backup");
  expect(isComboTargetInCooldown("free", { provider: "a", model: "m1" })).toBe(false);
  expect(hits).toEqual([
    "vertex:m1:false", "backup:m2:false",
    "vertex:m1:true", "backup:m2:true",
  ]);
});
