import { expect, test } from "bun:test";
import { createAnthropicAdapter as createAnthropicAdapterProduction } from "../../src/adapters/anthropic";
import { createResponsesPassthroughAdapter } from "../../src/adapters/openai-responses";
import { providerConfigSeed } from "../../src/providers/derive";
import { getProviderRegistryEntry } from "../../src/providers/registry";
import { parseRequest } from "../../src/responses/parser";
import type { OcxProviderConfig } from "../../src/types";
import { withTestTranslatorBudget } from "../helpers/translator-budget";

function seeded(id: string): OcxProviderConfig {
  const entry = getProviderRegistryEntry(id);
  if (!entry) throw new Error(`missing provider fixture: ${id}`);
  return providerConfigSeed(entry);
}

test("OpenCode Go Luna strips Claude stop sequences rejected by Console Go", () => {
  const raw = { model: "gpt-5.6-luna", input: "ping", stop: ["END"] };
  const adapter = withTestTranslatorBudget(createResponsesPassthroughAdapter({
    ...seeded("opencode-go"), apiKey: "test-key", adapter: "openai-responses",
  }));
  const sent = JSON.parse(adapter.buildRequest(parseRequest(raw)).body);
  expect(sent.stop).toBeUndefined();
  expect(raw.stop).toEqual(["END"]);
});

test("Meta Muse maps Claude thinking-disabled none to the vendor minimum", () => {
  const raw = { model: "muse-spark-1.3-contributor", input: "ping",
    reasoning: { effort: "none" } };
  const before = structuredClone(raw);
  const adapter = withTestTranslatorBudget(createResponsesPassthroughAdapter({
    ...seeded("meta-muse"), apiKey: "test-key",
  }));
  const sent = JSON.parse(adapter.buildRequest(parseRequest(raw)).body);
  expect(sent.reasoning?.effort).toBe("minimal");
  expect(raw).toEqual(before);
});

test("Meta Muse rewrites only the nonportable NUL regex escape", () => {
  const incompatible = "^/(?:(?!\\.\\.(?:/|$))[^\\0])*$";
  const ordinary = "^[A-Za-z0-9._/-]+$";
  const legacyOctal = "^\\01$";
  const raw = {
    model: "muse-spark-1.3-contributor",
    input: "ping",
    tools: [{
      type: "function",
      name: "read_path",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", pattern: incompatible },
          label: { type: "string", pattern: ordinary },
          legacyOctal: { type: "string", pattern: legacyOctal },
        },
      },
    }],
  };
  const before = structuredClone(raw);
  const adapter = withTestTranslatorBudget(createResponsesPassthroughAdapter({
    ...seeded("meta-muse"), apiKey: "test-key",
  }));
  const sent = JSON.parse(adapter.buildRequest(parseRequest(raw)).body);
  expect(sent.tools[0].parameters.properties.path.pattern)
    .toBe(incompatible.replaceAll("\\0", "\\x00"));
  expect(sent.tools[0].parameters.properties.label.pattern).toBe(ordinary);
  expect(sent.tools[0].parameters.properties.legacyOctal.pattern).toBe(legacyOctal);
  expect(raw).toEqual(before);
});

test.each(["claude-opus-5", "claude-opus-5-5"])(
  "%s omits deprecated temperature while preserving other sampling",
  async model => {
    const provider = {
      ...seeded("anthropic-apikey"),
      apiKey: "test-key",
    } as OcxProviderConfig;
    const adapter = withTestTranslatorBudget(createAnthropicAdapterProduction(provider));
    const parsed = parseRequest({
      model,
      input: "ping",
      temperature: 0.3,
      top_p: 0.9,
    });
    const built = await adapter.buildRequest(parsed);
    const sent = JSON.parse(typeof built.body === "string"
      ? built.body
      : JSON.stringify(built.body));
    expect(sent.temperature).toBeUndefined();
    expect(sent.top_p).toBe(0.9);
  },
);

test("Meta Muse advertises forced tool-choice incompatibility for every Muse model", () => {
  const provider = seeded("meta-muse");
  for (const model of provider.models ?? []) expect(provider.autoToolChoiceOnlyModels).toContain(model);
});
