import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { clearComboSelectionState, clearComboTargetCooldowns } from "../../src/combos";
import { museAcceptsToolChoice, museComboChoiceIsKnownIncompatible } from "../../src/adapters/openai-responses/muse-tool-choice";
import { handleResponses } from "../../src/server/responses";
import type { OcxConfig } from "../../src/types";
import { acquireOwnedSpendHome } from "../helpers/owned-spend-home";

const originalFetch = globalThis.fetch;
let releaseSpendHome: (() => void) | undefined;

beforeEach(() => {
  clearComboSelectionState();
  clearComboTargetCooldowns();
  releaseSpendHome = acquireOwnedSpendHome();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  releaseSpendHome?.();
  releaseSpendHome = undefined;
  clearComboSelectionState();
  clearComboTargetCooldowns();
});

const provider = (baseUrl: string) => ({
  adapter: "openai-responses",
  baseUrl,
  authMode: "key",
  apiKey: "test-key",
  models: ["fixture"],
});
const config = {
  defaultProvider: "muse",
  providers: {
    muse: provider("https://api.meta.ai/v1"),
    alternate: provider("https://api.x.ai/v1"),
  },
  combos: {
    safe: {
      strategy: "failover",
      targets: [
        { provider: "muse", model: "fixture" },
        { provider: "alternate", model: "fixture" },
      ],
    },
  },
} as unknown as OcxConfig;

const tool = {
  type: "function", name: "health_marker", description: "Inert test",
  parameters: { type: "object", properties: {}, additionalProperties: false },
};

async function probe(choice: unknown) {
  const hosts: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request) => {
    hosts.push(new URL(input instanceof Request ? input.url : String(input)).host);
    return Response.json({
      id: "resp_fixture", object: "response", created_at: 1, status: "completed", model: "fixture",
      output: [{ id: "fc_1", type: "function_call", call_id: "call_1",
        name: "health_marker", arguments: "{}" }],
    });
  }) as typeof fetch;
  const response = await handleResponses(new Request("http://localhost/v1/responses", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      model: "combo/safe", input: "synthetic test only", tools: [tool],
      tool_choice: choice, stream: false,
    }),
  }), config, { model: "", provider: "" });
  return { response, hosts };
}

describe("Meta mandatory-tool combo eligibility", () => {
  test("shares exactly the Meta wire choice vocabulary", () => {
    for (const choice of [undefined, "auto", "none"]) {
      expect(museAcceptsToolChoice(choice)).toBe(true);
    }
    for (const choice of ["required", { type: "function", name: "health_marker" },
      { type: "allowed_tools", mode: "auto", tools: [tool] }, null]) {
      expect(museAcceptsToolChoice(choice)).toBe(false);
    }
  });

  test("does not reclassify malformed selectors as target-specific incompatibility", async () => {
    for (const choice of [
      null, { type: "unknown" }, { type: "function", name: "" },
      { type: "function", name: " " },
      { type: "allowed_tools", mode: "auto", tools: [123, null] },
      { type: "allowed_tools", mode: "required", tools: [{ type: "function", name: "" }] },
      { type: "allowed_tools", mode: "auto", tools: [{ type: "unrecognized_kind" }] },
      { type: "allowed_tools", mode: "invalid", tools: [tool] },
    ]) {
      expect(museComboChoiceIsKnownIncompatible(choice)).toBe(false);
      const { response, hosts } = await probe(choice);
      expect(response.status).toBe(400);
      expect(hosts).toEqual([]);
    }
  });

  test("required skips Meta before dispatch and keeps strict choice for alternate", async () => {
    const { response, hosts } = await probe("required");
    expect(response.status).toBe(200);
    expect(hosts).toEqual(["api.x.ai"]);
  });

  test("named choice also skips Meta before dispatch", async () => {
    const { response, hosts } = await probe({ type: "function", name: "health_marker" });
    expect(response.status).toBe(200);
    expect(hosts).toEqual(["api.x.ai"]);
  });

  test("allowed_tools recognizes well-formed function and hosted selectors only", () => {
    expect(museComboChoiceIsKnownIncompatible({
      type: "allowed_tools", mode: "auto", tools: [{ type: "web_search" }],
    })).toBe(true);
    expect(museComboChoiceIsKnownIncompatible({
      type: "allowed_tools", mode: "required", tools: [{ type: "mcp", server_label: "fixture" }],
    })).toBe(true);
    expect(museComboChoiceIsKnownIncompatible({
      type: "allowed_tools", mode: "auto", tools: [{ type: "mcp", server_label: "" }],
    })).toBe(false);
  });

  test("allowed_tools selectors skip Meta without weakening the caller request", async () => {
    for (const mode of ["auto", "required"]) {
      const { response, hosts } = await probe({ type: "allowed_tools", mode, tools: [tool] });
      expect(response.status).toBe(200);
      expect(hosts).toEqual(["api.x.ai"]);
    }
  });

  test("auto, none, and omitted choices preserve Meta eligibility", async () => {
    for (const choice of ["auto", "none", undefined]) {
      const { response, hosts } = await probe(choice);
      expect(response.status).toBe(200);
      expect(hosts).toEqual(["api.meta.ai"]);
    }
  });
});
