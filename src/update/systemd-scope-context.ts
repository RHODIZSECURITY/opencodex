import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * A system service runs under an ordinary UID without receiving the lingered
 * user manager's XDG_RUNTIME_DIR. If systemd-run --user --scope cannot reach
 * that bus, a detached dashboard updater dies inside the parent service cgroup.
 * Accept only a UID-owned private /run/user/<uid> and its real user-bus socket.
 */
export interface ScopeFs {
  lstat: typeof lstatSync;
  getuid: () => number | undefined;
}

export function trustedUserBusRuntimeDir(
  env: NodeJS.ProcessEnv = process.env,
  deps: ScopeFs = { lstat: lstatSync, getuid: () => process.getuid?.() },
): string | undefined {
  const uid = deps.getuid();
  if (!Number.isSafeInteger(uid) || uid === undefined || uid < 1) return undefined;
  const dir = "/run/user/" + uid;
  if (env.XDG_RUNTIME_DIR && env.XDG_RUNTIME_DIR !== dir) return undefined;
  try {
    for (const parent of ["/run", "/run/user"]) {
      const st = deps.lstat(parent);
      if (!st.isDirectory() || st.uid !== 0 || (st.mode & 0o022) !== 0) return undefined;
    }
    const runtime = deps.lstat(dir);
    if (!runtime.isDirectory() || runtime.uid !== uid || (runtime.mode & 0o077) !== 0) return undefined;
    const bus = deps.lstat(join(dir, "bus"));
    if (!bus.isSocket() || bus.uid !== uid) return undefined;
    return dir;
  } catch {
    return undefined;
  }
}

/** Add only verified bus discovery to the detached updater's own environment. */
export function withTrustedSystemdUserBusEnv(
  env: NodeJS.ProcessEnv,
  deps?: ScopeFs,
): NodeJS.ProcessEnv {
  const next = { ...env };
  if (process.platform !== "linux" || !env.INVOCATION_ID) return next;
  const dir = trustedUserBusRuntimeDir(env, deps);
  if (dir) {
    next.XDG_RUNTIME_DIR = dir;
    // The service may inherit a forged DBUS_SESSION_BUS_ADDRESS. Bind both
    // discovery inputs to the same verified, UID-owned Unix socket.
    next.DBUS_SESSION_BUS_ADDRESS = "unix:path=" + join(dir, "bus");
  } else {
    delete next.XDG_RUNTIME_DIR;
    delete next.DBUS_SESSION_BUS_ADDRESS;
  }
  return next;
}

/**
 * The Dashboard cannot restart a root-owned system unit from its unprivileged
 * update worker. Refuse before launching an updater that could kill the proxy.
 */
export function dashboardSystemUnitUpdateBlockReason(
  env: NodeJS.ProcessEnv = process.env,
  cgroupText?: string,
  ownerUid: number | undefined = process.getuid?.(),
): string | null {
  if (process.platform !== "linux" || env.OCX_SERVICE_MANAGED !== "1" || !env.INVOCATION_ID) return null;
  let cgroup = cgroupText;
  if (cgroup === undefined) {
    try { cgroup = readFileSync("/proc/self/cgroup", "utf8"); }
    catch { return "Cannot verify which systemd unit owns the proxy; Dashboard update is disabled for safety."; }
  }
  // A service manager ID without a trustworthy, matching user service path
  // is not evidence that this process can be restarted by an unprivileged worker.
  const match = /^\d+::(\/[^\n]*)$/m.exec(cgroup);
  if (!match) return "Cannot verify a cgroup v2 service owner; Dashboard update is disabled for safety.";
  const path = match[1]!;
  if (/^\/system\.slice\/.+\.service(?:\/|$)/.test(path)) {
    return "OpenCodex is supervised by a system-wide systemd service, not its user service. "
      + "Dashboard update cannot safely restart that unit. Use a supervised administrator update "
      + "or migrate ownership to the OpenCodex user service first.";
  }
  // Any other user unit (including a sibling, a generic scope, or a process
  // serving from an unrelated login manager) is not OpenCodex's own supervisor.
  // Match its exact installed unit name and process UID; a user-bus being
  // available does not prove that user manager owns the serving process.
  const owner = /^\/user\.slice\/user-(\d+)\.slice\/user@(\d+)\.service\/app\.slice\/opencodex-proxy\.service(?:\/|$)/.exec(path);
  if (!owner || owner[1] !== owner[2] || ownerUid === undefined
    || !Number.isSafeInteger(ownerUid) || Number(owner[1]) !== ownerUid
    || path.split("/").some(part => part === "." || part === "..")) {
    return "Cannot verify OpenCodex's exact user-service owner; Dashboard update is disabled for safety.";
  }
  return null;
}
