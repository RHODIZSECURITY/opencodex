import { describe, expect, test } from "bun:test";
import type { Stats } from "node:fs";
import {
  dashboardSystemUnitUpdateBlockReason,
  trustedUserBusRuntimeDir,
  withTrustedSystemdUserBusEnv,
  type ScopeFs,
} from "../../src/update/systemd-scope-context";

const base = { INVOCATION_ID: "service-id", OCX_SERVICE_MANAGED: "1" };
const canonicalUserCgroup = (
  uid: number, managerUid = uid, unit = "opencodex-proxy.service", suffix = "",
): string => "0::/user.slice/user-" + uid + ".slice/user" + "@" + managerUid
  + ".service/app.slice/" + unit + suffix + "\n";
const fixture = (changes: Record<string, { uid?: number; mode?: number; kind?: "dir" | "socket" | "symlink" } | null> = {}): ScopeFs => {
  const file = (uid: number, mode: number, kind: "dir" | "socket" | "symlink") => ({
    uid, mode,
    isDirectory: () => kind === "dir",
    isSocket: () => kind === "socket",
    isSymbolicLink: () => kind === "symlink",
  });
  const entries = {
    "/run": file(0, 0o755, "dir"),
    "/run/user": file(0, 0o755, "dir"),
    "/run/user/1001": file(1001, 0o700, "dir"),
    "/run/user/1001/bus": file(1001, 0o600, "socket"),
  } as Record<string, ReturnType<typeof file>>;
  for (const [path, value] of Object.entries(changes)) {
    if (value === null) delete entries[path];
    else entries[path] = file(value.uid ?? 1001, value.mode ?? 0o700, value.kind ?? "dir");
  }
  return {
    getuid: () => 1001,
    lstat: ((path: string) => {
      const result = entries[path];
      if (!result) throw new Error("ENOENT");
      return result as Stats;
    }) as ScopeFs["lstat"],
  };
};

describe("Dashboard updater systemd scope safety", () => {
  test("recovers a verified private lingered user bus when the service omits XDG_RUNTIME_DIR", () => {
    expect(trustedUserBusRuntimeDir(base, fixture())).toBe("/run/user/1001");
    const original = { ...base, OPENCODEX_API_AUTH_TOKEN: "never-log-or-replace" };
    const next = withTrustedSystemdUserBusEnv(original, fixture());
    if (process.platform === "linux") expect(next.XDG_RUNTIME_DIR).toBe("/run/user/1001");
    expect(next.OPENCODEX_API_AUTH_TOKEN).toBe("never-log-or-replace");
    if (process.platform === "linux") expect(next.DBUS_SESSION_BUS_ADDRESS).toBe("unix:path=/run/user/1001/bus");
    expect(original).not.toHaveProperty("XDG_RUNTIME_DIR");
  });

  test("refuses a supplied path outside the UID runtime directory", () => {
    expect(trustedUserBusRuntimeDir({ ...base, XDG_RUNTIME_DIR: "/tmp/attacker" }, fixture())).toBeUndefined();
    const next = withTrustedSystemdUserBusEnv({ ...base, XDG_RUNTIME_DIR: "/tmp/attacker", DBUS_SESSION_BUS_ADDRESS: "tcp:host=attacker" }, fixture());
    if (process.platform === "linux") {
      expect(next.XDG_RUNTIME_DIR).toBeUndefined();
      expect(next.DBUS_SESSION_BUS_ADDRESS).toBeUndefined();
    }
    const fixed = withTrustedSystemdUserBusEnv({ ...base, DBUS_SESSION_BUS_ADDRESS: "unix:path=/tmp/other" }, fixture());
    if (process.platform === "linux") expect(fixed.DBUS_SESSION_BUS_ADDRESS).toBe("unix:path=/run/user/1001/bus");
  });

  test("fails closed for root, missing bus, symlink bus, broad permissions, and altered owner", () => {
    expect(trustedUserBusRuntimeDir(base, { ...fixture(), getuid: () => 0 })).toBeUndefined();
    for (const changes of [
      { "/run/user/1001/bus": null },
      { "/run/user/1001/bus": { kind: "symlink" as const } },
      { "/run/user/1001": { mode: 0o750 } },
      { "/run/user/1001": { uid: 1002 } },
      { "/run/user": { uid: 1001 } },
      { "/run/user": { uid: 0, mode: 0o777 } },
    ]) {
      expect(trustedUserBusRuntimeDir(base, fixture(changes))).toBeUndefined();
    }
  });

  test("blocks root-owned system services but leaves the ordinary user service eligible", () => {
    if (process.platform !== "linux") return;
    expect(dashboardSystemUnitUpdateBlockReason(base, "0::/system.slice/opencodex-rhodiz.service\n")).toContain("system-wide systemd service");
    expect(dashboardSystemUnitUpdateBlockReason(base, canonicalUserCgroup(1001), 1001)).toBeNull();
    expect(dashboardSystemUnitUpdateBlockReason({ INVOCATION_ID: "service-id" }, "0::/system.slice/opencodex-rhodiz.service\n")).toBeNull();
    expect(dashboardSystemUnitUpdateBlockReason(base, "0::/other.slice/untrusted.service\n")).toContain("Cannot verify");
    expect(dashboardSystemUnitUpdateBlockReason(base, "5:memory:/system.slice/opencodex-rhodiz.service\n")).toContain("Cannot verify");
    expect(dashboardSystemUnitUpdateBlockReason(base, "")).toContain("Cannot verify");
    expect(dashboardSystemUnitUpdateBlockReason(base, canonicalUserCgroup(1001, 1001, "unrelated.service"), 1001)).toContain("exact user-service owner");
    expect(dashboardSystemUnitUpdateBlockReason(base, canonicalUserCgroup(1001, 1002), 1001)).toContain("exact user-service owner");
    expect(dashboardSystemUnitUpdateBlockReason(base, canonicalUserCgroup(1001), 1002)).toContain("exact user-service owner");
    expect(dashboardSystemUnitUpdateBlockReason(base, canonicalUserCgroup(1001, 1001, "opencodex-proxy.service", "/../other.service"), 1001)).toContain("exact user-service owner");
  });
});
