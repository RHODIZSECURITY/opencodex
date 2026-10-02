import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

/**
 * Regression guard for the `.dirfd-probe-<pid>[.ok]` leak in `detectArtifactIoMode`
 * (src/lab/artifacts/secure-fs.ts).
 *
 * The probe used to be left on disk by two paths: the early `return` when
 * `existsSync(join(dir.path, finalName))` misses (leaving `finalName`), and the
 * `catch` after `renameSync` throws (leaving the pre-rename `probe`). Every leaked
 * file was an orphan that showed up in `git status` across worktrees and was never
 * gitignored.
 *
 * `artifactIoMode` is cached at module scope, so the detection runs once per
 * process. To exercise it freshly we spawn a short-lived child with
 * `process.execPath` (no reliance on `bun` in PATH, so this works in CI as well)
 * and have the child run detection against a scratch dir, then report whether
 * any probe name is still present.
 *
 * The forced-failure scenario pre-creates a directory named exactly
 * `finalName` before detection runs: rename(file -> existing-dir) fails with
 * EISDIR on POSIX, driving detection into the `catch` path — the historical
 * pre-rename `probe` leak — without monkey-patching node:fs. On a filesystem
 * where the dirfd and plain-path namespaces disagree, the same fixture instead
 * trips the existsSync early return (the other historical leak), so both
 * early-exit paths are covered; the assertions hold in either world.
 */

const DIRS: string[] = [];

function scratchDir(): string {
  const dir = join(tmpdir(), `ocx-io-mode-leak-${process.pid}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  DIRS.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of DIRS.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
});

interface DetectionReport {
  fixturePresent: boolean;
  inDir: string[];
  inCwd: string[];
}

interface DetectionResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

function runDetection(artifactsDir: string, forceRenameFailure = false): DetectionResult {
  const childSource = `
    const fs = await import("node:fs");
    const force = ${JSON.stringify(forceRenameFailure)};
    const finalName = \`.dirfd-probe-\${process.pid}.ok\`;
    if (force) fs.mkdirSync(finalName, { recursive: true });
    const { openTrustedArtifactDir, closeTrustedArtifactDir } = await import(${JSON.stringify(
      resolve(import.meta.dir, "../src/lab/artifacts/secure-fs.ts"),
    )});
    const dir = openTrustedArtifactDir(${JSON.stringify(artifactsDir)});
    // openTrustedArtifactDir triggers detectArtifactIoMode via the open path.
    closeTrustedArtifactDir(dir);
    const fixturePresent = force && fs.existsSync(finalName);
    if (fixturePresent) fs.rmSync(finalName, { recursive: true, force: true });
    // Report every probe-named entry found in the artifacts dir and the process cwd.
    const report = (base) => fs.readdirSync(base).filter((n) => n.startsWith(".dirfd-probe-"));
    console.log(JSON.stringify({
      fixturePresent,
      inDir: report(${JSON.stringify(artifactsDir)}),
      inCwd: report(process.cwd()),
    }));
  `;
  const spawned = Bun.spawnSync([process.execPath, "-e", childSource], {
    cwd: artifactsDir,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    stdout: spawned.stdout.toString(),
    stderr: spawned.stderr.toString(),
    exitCode: spawned.exitCode,
  };
}

describe("detectArtifactIoMode does not leak probe files", () => {
  test("normal detection leaves no probe in the artifacts dir or cwd", () => {
    const artifactsDir = scratchDir();
    const { stdout, stderr, exitCode } = runDetection(artifactsDir);
    expect(exitCode, stderr).toBe(0);
    const parsed = JSON.parse(stdout.trim()) as DetectionReport;
    expect(parsed.inDir).toEqual([]);
    expect(parsed.inCwd).toEqual([]);
    expect(parsed.fixturePresent).toBe(false);
  });

  test("a second detection run stays clean", () => {
    const artifactsDir = scratchDir();
    const before = readdirSync(artifactsDir).filter((n) => n.startsWith(".dirfd-probe-"));
    expect(before).toEqual([]);
    const { stdout, stderr, exitCode } = runDetection(artifactsDir);
    expect(exitCode, stderr).toBe(0);
    const parsed = JSON.parse(stdout.trim()) as DetectionReport;
    expect(parsed.inDir).toEqual([]);
  });

  test("forced renameSync failure (pre-existing finalName dir) leaves no pre-rename probe", () => {
    const artifactsDir = scratchDir();
    const { stdout, stderr, exitCode } = runDetection(artifactsDir, true);
    expect(exitCode, stderr).toBe(0);
    const parsed = JSON.parse(stdout.trim()) as DetectionReport;
    // The fixture dir must still be there at report time: it proves the scenario
    // was armed. unlink of a directory correctly fails and is swallowed — the
    // sweep is only responsible for the probe FILE this scenario leaks.
    expect(parsed.fixturePresent).toBe(true);
    expect(parsed.inDir).toEqual([]);
    expect(parsed.inCwd).toEqual([]);
  });
});
