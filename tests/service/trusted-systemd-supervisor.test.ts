import { describe, expect, test } from "bun:test";
import { trustedRootUnitFile, trustedRhodizSystemdSupervisorState, verifyRhodizRootSupervisor } from "../../src/codex/trusted-systemd-supervisor";

const unit = "/etc/systemd/system/opencodex-rhodiz.service";
const override = "/etc/systemd/system/opencodex-rhodiz.service.d/zz-lan-dashboard.conf";
const rootLauncher="/home/opencodex-rhodiz/.local/bin/ocx";
const sample=[
  "Id=opencodex-rhodiz.service",
  "LoadState=loaded",
  "ActiveState=active",
  "SubState=running",
  "UnitFileState=enabled",
  "NeedDaemonReload=no",
  "User=opencodex-rhodiz",
  "FragmentPath="+unit,
  "DropInPaths="+override,
  "MainPID=3267569",
  `ExecStart={ path=${rootLauncher} ; argv[]=${rootLauncher} start --port 10101 ; ignore_errors=no ; }`,
].join("\n")+"\n";

describe("trusted systemd supervisor attestation", () => {
  test("requires root-owned system unit and approved late port override", () => {
    const inspected: string[][]=[];
    const valid=trustedRhodizSystemdSupervisorState(sample, paths => {inspected.push([...paths]);return true;});
    expect(valid).toBe(true);
    expect(inspected).toEqual([[unit,override]]);
    expect(trustedRhodizSystemdSupervisorState(sample,()=>false)).toBe(false);
  });

  test("fails closed on stopped, disabled, stale, wrong-user, wrong-port and duplicate manager states", () => {
    const replacements=[
      ["ActiveState=active","ActiveState=inactive"],
      ["SubState=running","SubState=dead"],
      ["UnitFileState=enabled","UnitFileState=disabled"],
      ["NeedDaemonReload=no","NeedDaemonReload=yes"],
      ["User=opencodex-rhodiz","User=root"],
      ["MainPID=3267569","MainPID=0"],
      ["start --port 10101","start --port 10100"],
      [override,"/tmp/attacker.conf"],
      [unit,"/tmp/similar-unit.service"],
    ];
    for(const [good,bad] of replacements) {
      const modified=sample.replace(good,bad);
      expect(trustedRhodizSystemdSupervisorState(modified,()=>true)).toBe(false);
    }
    expect(trustedRhodizSystemdSupervisorState(sample+"ActiveState=active\n",()=>true)).toBe(false);
  });

  test("a trusted stopped unit is configured but never counts as running",()=>{
    const stopped=sample.replace("ActiveState=active","ActiveState=inactive")
      .replace("SubState=running","SubState=dead")
      .replace("MainPID=3267569","MainPID=0");
    expect(trustedRhodizSystemdSupervisorState(stopped,()=>true)).toBe(false);
    expect(trustedRhodizSystemdSupervisorState(stopped,()=>true,"configured-stopped")).toBe(true);
    const failed=stopped.replace("ActiveState=inactive","ActiveState=failed").replace("SubState=dead","SubState=failed");
    expect(trustedRhodizSystemdSupervisorState(failed,()=>true,"configured-stopped")).toBe(true);
    for(const tampered of [
      stopped.replace("UnitFileState=enabled","UnitFileState=disabled"),
      stopped.replace("User=opencodex-rhodiz","User=attacker"),
      stopped.replace("start --port 10101","start --port 10100"),
      stopped.replace("DropInPaths="+override,"DropInPaths=/tmp/evil.conf"),
      stopped.replace("MainPID=0","MainPID=1234"),
    ]) expect(trustedRhodizSystemdSupervisorState(tampered,()=>true,"configured-stopped")).toBe(false);
    expect(trustedRhodizSystemdSupervisorState(sample,()=>true,"configured-stopped")).toBe(false);
    expect(trustedRhodizSystemdSupervisorState(stopped,()=>false,"configured-stopped")).toBe(false);
  });

  test("validates root ownership, restrictive file mode and symlink rejection",()=>{
    const owned={isFile:()=>true,isSymbolicLink:()=>false,uid:0,mode:0o100644};
    expect(trustedRootUnitFile("/isolated/unit",()=>owned)).toBe(true);
    for(const unsafe of [
      {...owned,uid:1001},
      {...owned,mode:0o100666},
      {...owned,mode:0o100664},
      {...owned,isFile:()=>false},
      {...owned,isSymbolicLink:()=>true},
    ]) expect(trustedRootUnitFile("/isolated/unit",()=>unsafe)).toBe(false);
    expect(trustedRootUnitFile("/isolated/missing",()=>{throw new Error("ENOENT");})).toBe(false);
  });

  test("drop-in traversal, extension and foreign origins fail closed",()=>{
    const trustedExtra="/etc/systemd/system/opencodex-rhodiz.service.d/audit.conf";
    const multiple=sample.replace("DropInPaths="+override,"DropInPaths="+override+" "+trustedExtra);
    const visited:string[][]=[];
    expect(trustedRhodizSystemdSupervisorState(multiple,paths=>{visited.push([...paths]);return true;})).toBe(true);
    expect(visited).toEqual([[unit,override,trustedExtra]]);
    for(const bad of [
      "/etc/systemd/system/opencodex-rhodiz.service.d/../attack.conf",
      "/etc/systemd/system/opencodex-rhodiz.service.d/attack.service",
      "/etc/systemd/system/opencodex-rhodiz.service.d/bad"+String.fromCharCode(0)+".conf",
      "/usr/lib/systemd/system/service.d/global.conf",
    ]) expect(trustedRhodizSystemdSupervisorState(sample.replace("DropInPaths="+override,
      "DropInPaths="+override+" "+bad),()=>true)).toBe(false);
  });

  test("never probes systemd on non-Linux systems", () => {
    expect(verifyRhodizRootSupervisor("win32")).toBe(false);
    expect(verifyRhodizRootSupervisor("darwin")).toBe(false);
  });
});
