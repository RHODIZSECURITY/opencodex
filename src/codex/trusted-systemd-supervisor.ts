import { execFileSync } from "node:child_process";
import { lstatSync, type Stats } from "node:fs";

const UNIT = "opencodex-rhodiz.service";
const UNIT_PATH = "/etc/systemd/system/opencodex-rhodiz.service";
const DROPIN_DIR = "/etc/systemd/system/opencodex-rhodiz.service.d/";
const LAUNCHER = "/home/opencodex-rhodiz/.local/bin/ocx";
// RHODIZ's certified systemd override is pinned to this listener. Any changed
// port must undergo a new deployment/diagnostics certification.
const PORT = 10101;

export function trustedRhodizSystemdSupervisorState(
  showOutput: string,
  rootOwnedFiles: (paths: readonly string[]) => boolean,
  requiredState: "running" | "configured-stopped" = "running",
): boolean {
  if (typeof showOutput !== "string") return false;
  const fields = new Map<string,string>();
  for (const line of showOutput.split(/\r?\n/)) {
    if (!line) continue;
    const index = line.indexOf("=");
    if (index < 1 || fields.has(line.slice(0,index))) return false;
    fields.set(line.slice(0,index),line.slice(index+1));
  }
  const exact: Record<string,string> = {
    Id: UNIT, LoadState: "loaded", UnitFileState: "enabled",
    NeedDaemonReload: "no", User: "opencodex-rhodiz",
    FragmentPath: UNIT_PATH,
  };
  if (Object.entries(exact).some(([key,value]) => fields.get(key)!==value)) return false;
  const pid=Number(fields.get("MainPID"));
  const running=fields.get("ActiveState")==="active" && fields.get("SubState")==="running"
    && Number.isSafeInteger(pid) && pid>0;
  const stopped=(fields.get("ActiveState")==="inactive" || fields.get("ActiveState")==="failed")
    && (fields.get("SubState")==="dead" || fields.get("SubState")==="failed")
    && fields.get("MainPID")==="0";
  if (requiredState==="running" ? !running : !stopped) return false;
  const exec=fields.get("ExecStart");
  if (!exec || !exec.includes(`path=${LAUNCHER} ;`) ||
      !exec.includes(`argv[]=${LAUNCHER} start --port ${PORT} ;`)) return false;
  const dropins=(fields.get("DropInPaths") ?? "").trim();
  const paths=dropins ? dropins.split(/\s+/) : [];
  if (!paths.includes(`${DROPIN_DIR}zz-lan-dashboard.conf`)) return false;
  if (paths.some(path => !path.startsWith(DROPIN_DIR) || !path.endsWith(".conf") ||
      path.includes("..") || path.includes("\0"))) return false;
  return rootOwnedFiles([UNIT_PATH,...paths]);
}

/** Independently testable root-file predicate; production always uses lstatSync. */
export function trustedRootUnitFile(path: string, stat: (path: string) => Pick<Stats,"isFile"|"isSymbolicLink"|"uid"|"mode"> = lstatSync): boolean {
  try {
    const s=stat(path);
    return s.isFile() && !s.isSymbolicLink() && s.uid===0 &&
      (s.mode & 0o022)===0;
  } catch { return false; }
}

/** Read-only, fail-closed verification of root-owned RHODIZ systemd supervisor.
 * Active and installed-but-stopped trust are distinct: stopped never earns protection.
 * No systemctl start/stop/reload and no credentials are ever read.
 */
export function inspectRhodizRootSupervisor(platform: NodeJS.Platform=process.platform): {
  active: boolean;
  configured: boolean;
} {
  if (platform!=="linux") return { active: false, configured: false };
  try {
    const stdout=execFileSync("/usr/bin/systemctl", [
      "show", UNIT, "-p", "Id", "-p", "LoadState",
      "-p", "ActiveState", "-p", "SubState",
      "-p", "UnitFileState", "-p", "NeedDaemonReload",
      "-p", "User", "-p", "FragmentPath", "-p", "DropInPaths",
      "-p", "MainPID", "-p", "ExecStart", "--no-pager",
    ], { encoding: "utf8", timeout: 1500, maxBuffer: 32*1024,
      stdio: ["ignore","pipe","ignore"] });
    const owned=(paths: readonly string[]) => paths.every(path => trustedRootUnitFile(path));
    const active=trustedRhodizSystemdSupervisorState(stdout,owned);
    const configured=active || trustedRhodizSystemdSupervisorState(stdout,owned,"configured-stopped");
    return {active,configured};
  } catch { return { active: false, configured: false }; }
}

export function verifyRhodizRootSupervisor(platform: NodeJS.Platform=process.platform): boolean {
  return inspectRhodizRootSupervisor(platform).active;
}
