import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import ProviderUsage from "../src/components/provider-workspace/ProviderUsage";
import { LanguageProvider } from "../src/i18n/provider";
import { buildProviderModelUsage } from "../src/provider-workspace/usage";
import type { WorkspaceItem } from "../src/provider-workspace/catalog";

const item: WorkspaceItem = {
  name: "kimi", adapter: "openai-chat", authMode: "oauth",
  baseUrl: "https://api.kimi.com/coding/v1", tier: "accounts",
};
const base = { requests: 1, inputTokens: 70, outputTokens: 10, totalTokens: 80, shareRatio: 0.008 };

test("model grouping preserves serving provider and uses provider-local shares", () => {
  const rows = buildProviderModelUsage([
    { ...base, provider: "kimi", model: "anthropic/claude-opus-5", hasUnresolvedRequestedModel: true },
    { ...base, provider: "kimi", model: "k3", totalTokens: 20 },
    { ...base, provider: "anthropic", model: "claude-opus-5", totalTokens: 9900 },
  ], { kimi: { totalTokens: 100 }, anthropic: { totalTokens: 9900 } });
  expect(rows.kimi).toHaveLength(2);
  expect(rows.kimi[0]?.shareRatio).toBe(0.8);
  expect(rows.kimi[1]?.shareRatio).toBe(0.2);
  expect(rows.anthropic).toHaveLength(1);
  expect(rows.anthropic[0]?.shareRatio).toBe(1);
  expect(rows.kimi[0]?.hasUnresolvedRequestedModel).toBe(true);
  expect(rows.anthropic[0]?.hasUnresolvedRequestedModel).toBeUndefined();
});

test("missing or zero provider totals do not produce infinite model shares", () => {
  const models = [{ ...base, provider: "kimi", model: "k3" }];
  expect(buildProviderModelUsage(models, {}).kimi[0]?.shareRatio).toBe(0);
  expect(buildProviderModelUsage(models, { kimi: { totalTokens: 0 } }).kimi[0]?.shareRatio).toBe(0);
});

test("the provider table qualifies unresolved requests without hiding their usage", () => {
  const rows = buildProviderModelUsage([
    { ...base, provider: "kimi", model: "policy/does-not-exist", hasUnresolvedRequestedModel: true },
  ], { kimi: { totalTokens: 100 } });
  const markup = renderToStaticMarkup(<LanguageProvider>
    <ProviderUsage item={item} usageTotals={{ requests: 1, totalTokens: 100 }} modelUsage={rows.kimi} />
  </LanguageProvider>);
  expect(markup).toContain("policy/does-not-exist");
  expect(markup).toContain("Includes unresolved requested model usage");
  expect(markup).toContain("width:80%");
  expect(markup).not.toContain("~$");
});
