import { expect, test } from "bun:test";
import { clearComboSelectionState } from "../../src/combos";
import { evidenceFromBody } from "../../src/routing/request-evidence";
import { routeModel } from "../../src/router";
import type { OcxConfig } from "../../src/types";

function config(): OcxConfig {
  return {
    port: 10100,
    defaultProvider: "limited",
    providers: {
      limited: {
        adapter: "openai-responses", baseUrl: "https://limited.example/v1", apiKey: "test",
        models: ["m1"], autoToolChoiceOnlyModels: ["m1"],
      },
      capable: {
        adapter: "openai-responses", baseUrl: "https://capable.example/v1", apiKey: "test", models: ["m2"],
      },
    },
    combos: {
      free: { strategy: "failover", targets: [
        { provider: "limited", model: "m1" },
        { provider: "capable", model: "m2" },
      ] },
    },
  };
}

test("combo routing skips an auto-tool-choice-only target when the request forces a tool", () => {
  clearComboSelectionState();
  const body = { model: "combo/free", tools: [{ type: "web_search" }], tool_choice: { type: "web_search" } };
  const route = routeModel(config(), "combo/free", evidenceFromBody(body));
  expect(route.providerName).toBe("capable");
  expect(route.modelId).toBe("m2");
});

test("combo routing keeps an auto-tool-choice-only target for ordinary auto tool use", () => {
  clearComboSelectionState();
  const body = { model: "combo/free", tools: [{ type: "web_search" }], tool_choice: "auto" };
  const route = routeModel(config(), "combo/free", evidenceFromBody(body));
  expect(route.providerName).toBe("limited");
  expect(route.modelId).toBe("m1");
});

test("request evidence distinguishes non-auto choices from auto", () => {
  expect(evidenceFromBody({ tools: [{}], tool_choice: "required" }).nonAutoToolChoiceRequired).toBe(true);
  expect(evidenceFromBody({ tools: [{}], tool_choice: { type: "web_search" } }).nonAutoToolChoiceRequired).toBe(true);
  expect(evidenceFromBody({ tools: [{}], tool_choice: { type: "tool", name: "WebSearch" } }).nonAutoToolChoiceRequired).toBe(true);
  expect(evidenceFromBody({ tools: [{}], tool_choice: { type: "allowed_tools", mode: "required" } }).nonAutoToolChoiceRequired).toBe(true);
  expect(evidenceFromBody({ tools: [{}], tool_choice: "auto" }).nonAutoToolChoiceRequired).toBeUndefined();
  expect(evidenceFromBody({ tools: [{}], tool_choice: "none" }).nonAutoToolChoiceRequired).toBe(true);
});

test("combo routing skips an auto-tool-choice-only target for tool_choice none", () => {
  clearComboSelectionState();
  const body = { model: "combo/free", tools: [{ type: "function", name: "probe" }], tool_choice: "none" };
  const route = routeModel(config(), "combo/free", evidenceFromBody(body));
  expect(route.providerName).toBe("capable");
  expect(route.modelId).toBe("m2");
});
