import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigPath, saveConfig } from "../../src/config";
import { flushConfigDirHardeningForTests } from "../../src/config/paths";
import { clearModelCache } from "../../src/codex/model-cache";
import { initializeProviderModelSelection, reconcileInitialModelSelections } from "../../src/providers/initial-model-selection";
import { handleManagementAPI } from "../../src/server/management-api";
import type { OcxConfig, OcxProviderConfig } from "../../src/types";
import { catalogConvergenceFactory } from "../helpers/catalog-convergence";
import { installIsolatedCodexHome, type IsolatedCodexHome } from "../helpers/isolated-codex-home";
import { ManagementRequest } from "../helpers/management-auth";
import { removeTreeWithRetry } from "../helpers/remove-tree";

const ids = ["anthropic/claude-opus-5", "openai/gpt-5.6-sol"];
const operations = [
  { path: "/api/model-presets", input: { mode: "all" }, selected: undefined, mode: undefined },
  { path: "/api/model-presets", input: { mode: "custom" }, selected: [ids[0]], mode: "custom" },
  { path: "/api/model-presets", input: { mode: "preset" }, selected: ids, mode: "preset" },
  { path: "/api/selected-models", input: { models: [ids[1]] }, selected: [ids[1]], mode: "custom" },
  { path: "/api/selected-models", input: { models: [] }, selected: undefined, mode: "custom" },
] as const;
let home: string;
let previousHome: string | undefined;
let codex: IsolatedCodexHome;
beforeEach(() => {
  previousHome = process.env.OPENCODEX_HOME;
  home = mkdtempSync(join(tmpdir(), "ocx-selection-writes-"));
  process.env.OPENCODEX_HOME = home;
  codex = installIsolatedCodexHome("ocx-selection-writes-codex-");
});
afterEach(async () => {
  clearModelCache();
  await flushConfigDirHardeningForTests();
  codex.restore();
  if (previousHome === undefined) delete process.env.OPENCODEX_HOME;
  else process.env.OPENCODEX_HOME = previousHome;
  removeTreeWithRetry(home);
});

function fixture(state: "pending" | "ready" | "legacy"): OcxConfig {
  const provider: OcxProviderConfig = {
    adapter: "openai-chat", baseUrl: "https://models.example.test/v1", authMode: "key",
    apiKey: "fixture-key", liveModels: false, models: [...ids],
    selectedModels: [ids[0]], modelPreset: { mode: "preset", appliedVersion: 1 },
  };
  const config: OcxConfig = { port: 0, defaultProvider: "openrouter", providers: { openrouter: provider }, clientIntegrations: { codex: false } };
  if (state !== "legacy") initializeProviderModelSelection("openrouter", provider);
  if (state === "ready") reconcileInitialModelSelections(config, ids.map(id => ({ provider: "openrouter", id })), ["openrouter"]);
  saveConfig(config);
  return config;
}

async function put(config: OcxConfig, operation: typeof operations[number]): Promise<Response> {
  const url = new URL(`http://localhost${operation.path}`);
  const request = new ManagementRequest(url, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider: "openrouter", ...operation.input }),
  });
  const response = await handleManagementAPI(request, url, config, { createManagementConvergeCodex: catalogConvergenceFactory() });
  if (!response) throw new Error("missing management route");
  return response;
}

test.each([...operations])("pending selection write is rejected without mutation: %j", async operation => {
  const config = fixture("pending");
  const before = structuredClone(config);
  const disk = readFileSync(getConfigPath(), "utf8");
  const response = await put(config, operation);
  expect(response.status).toBe(409);
  expect(await response.json()).toMatchObject({ code: "initial_model_selection_pending" });
  expect(config).toEqual(before);
  expect(readFileSync(getConfigPath(), "utf8")).toBe(disk);
  expect(config.providers.openrouter.disabled).not.toBe(true);
});

for (const state of ["ready", "legacy"] as const) {
  test.each([...operations])(`${state} selection write retains normal behavior: %j`, async operation => {
    const config = fixture(state);
    const response = await put(config, operation);
    expect(response.status).toBe(200);
    expect(config.providers.openrouter.selectedModels).toEqual(operation.selected === undefined ? undefined : [...operation.selected]);
    expect(config.providers.openrouter.modelPreset?.mode).toBe(operation.mode);
    expect(config.providers.openrouter.disabled).not.toBe(true);
    expect(config.providers.openrouter.initialModelSelection?.status).toBe(state === "ready" ? "ready" : undefined);
  });
}
