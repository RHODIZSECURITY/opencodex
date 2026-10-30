import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { OcxConfig } from "../types/config";

/**
 * An explicitly OFF local Codex client must not start the native app-server
 * just to discover the absence of a Linux file-backed main login. That native
 * process creates skills and sqlite files in CODEX_HOME even for getAuthStatus.
 *
 * Preserve keyring/auto-store and explicit Codex-delegated modes: only a
 * proven ENOENT and known file-store mode admit this no-spawn optimization.
 */
export function skipAbsentNativeMainFileWhenClientOff(
  config: Pick<OcxConfig, "clientIntegrations" | "nativeMainRefresh">,
  codexHome: string,
  deps: {
    lstat?: typeof lstatSync;
    read?: typeof readFileSync;
    platform?: NodeJS.Platform;
  } = {},
): boolean {
  if ((deps.platform ?? process.platform) !== "linux"
    || config.clientIntegrations?.codex !== false
    || config.nativeMainRefresh === "codex") return false;

  try {
    (deps.lstat ?? lstatSync)(join(codexHome, "auth.json"));
    return false; // An existing, malformed, unreadable or linked auth is not proven absent.
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false;
  }

  try {
    const toml = (deps.read ?? readFileSync)(join(codexHome, "config.toml"), "utf8");
    if (typeof toml !== "string") return false;
    const parsed: unknown = Bun.TOML.parse(toml);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const store = (parsed as Record<string, unknown>).cli_auth_credentials_store;
    // Linux's ordinary absent option uses the file store; explicit keyring or
    // auto modes may have a credential without auth.json, so they must probe.
    return store === undefined || store === "file";
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}
