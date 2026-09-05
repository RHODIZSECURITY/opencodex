import type { OcxConfig } from "../types";

/** Bind scope, not the dial address: wildcard listeners are never loopback-only. */
export function isLoopbackHostname(hostname: string | undefined): boolean {
  const normalized = (hostname ?? "127.0.0.1").trim().toLowerCase();
  return (
    normalized === "" ||
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]"
  );
}

export function shouldInjectApiAuthHeader(
  config: Pick<OcxConfig, "hostname" | "unauthenticatedLoopbackListener"> | undefined,
): boolean {
  // The dedicated listener binds loopback and does not require an admission credential.
  if (config?.unauthenticatedLoopbackListener?.enabled) return false;
  return !isLoopbackHostname(config?.hostname);
}

/** Match standalone injection, never a remote client's independently supplied routing target. */
export function isEffectiveCodexDesktopAuthless(
  config: Pick<OcxConfig, "runtimeRole" | "hostname" | "unauthenticatedLoopbackListener" | "codexDesktopAuthless"> | undefined,
): boolean {
  return config?.codexDesktopAuthless === true
    && config.runtimeRole !== "client"
    && !shouldInjectApiAuthHeader(config);
}
