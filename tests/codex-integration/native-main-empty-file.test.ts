import { describe, expect, test } from "bun:test";
import { skipAbsentNativeMainFileWhenClientOff as skip } from "../../src/codex/native-main-empty-file";

const off = { clientIntegrations: { codex: false } } as const;
const missing = () => { throw Object.assign(new Error("ENOENT"), { code: "ENOENT" }); };
const present = () => ({});
const evaluate = (config: Parameters<typeof skip>[0], text: string,
  stat: typeof missing | typeof present = missing) =>
  skip(config, "/fixture/codex", {
    platform: "linux", lstat: stat as never,
    read: (() => text) as never,
  });

describe("Linux native main file store absent with Codex local integration OFF", () => {
  test("does not launch Codex app-server for a missing file-backed login", () => {
    expect(evaluate(off, 'model = "gpt-6"\n')).toBe(true);
    expect(evaluate(off, 'cli_auth_credentials_store = "file"\n')).toBe(true);
  });
  test("retains keyring, auto store, and explicitly delegated refresh", () => {
    expect(evaluate(off, 'cli_auth_credentials_store = "keyring"\n')).toBe(false);
    expect(evaluate(off, 'cli_auth_credentials_store = "auto"\n')).toBe(false);
    expect(evaluate({ ...off, nativeMainRefresh: "codex" }, 'model = "gpt-6"\n')).toBe(false);
  });
  test("never classifies an existing, unreadable, or corrupt login as absent", () => {
    expect(evaluate(off, 'model = "gpt-6"\n', present)).toBe(false);
    expect(skip(off, "/fixture/codex", { platform: "linux",
      lstat: (() => { throw Object.assign(new Error("permission"), { code: "EACCES" }); }) as never,
      read: (() => "model = \"gpt-6\"") as never })).toBe(false);
    expect(evaluate(off, 'cli_auth_credentials_store = [')).toBe(false);
  });
  test("other platforms and locally enabled Codex preserve prior behavior", () => {
    expect(skip(off, "/fixture/codex", { platform: "darwin", lstat: missing as never })).toBe(false);
    expect(evaluate({ clientIntegrations: {} }, 'model = "gpt-6"\n')).toBe(false);
    expect(evaluate({ clientIntegrations: { codex: true } }, 'model = "gpt-6"\n')).toBe(false);
  });
});
