import { describe, expect, test } from "bun:test";
import { trustedRhodizSystemdSupervisorState, verifyRhodizRootSupervisor } from "../../src/codex/trusted-systemd-supervisor";

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

  test("never probes systemd on non-Linux systems", () => {
    expect(verifyRhodizRootSupervisor("win32")).toBe(false);
    expect(verifyRhodizRootSupervisor("darwin")).toBe(false);
  });
});
