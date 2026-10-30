import { describe, expect, test } from "bun:test";
import { visibleUpdateJob } from "../../src/update/job-visibility";
import { readLinuxProcessStartTicks } from "../../src/update/process-start-identity";
import { staleActiveUpdateJobReason } from "../../src/update/job";
import type { UpdateJobState } from "../../src/update/job";

const now = Date.parse("2026-10-29T17:00:00.000Z");
const job = (): UpdateJobState => ({
  id: "fixture", status: "running",
  startedAt: new Date(now - 60_000).toISOString(),
  updatedAt: new Date(now - 30_000).toISOString(),
  currentVersion: "2.89.0", latestVersion: "2.93.0",
  channel: "latest", installer: "npm", restart: true,
  command: "test-only", releaseNotesUrl: "https://example.invalid", log: [], pid: 321,
});

describe("Dashboard orphaned update job presentation", () => {
  test("dead updater immediately produces a failed, actionable view without mutating the stored object", () => {
    const stored = job();
    const visible = visibleUpdateJob(stored, now, () => false);
    expect(visible.status).toBe("failed");
    expect(visible.restarted).toBe(false);
    expect(visible.exitCode).toBeNull();
    expect(visible.error).toContain("Verify proxy/service health");
    expect(stored.status).toBe("running");
    expect(stored.error).toBeUndefined();
  });

  test("live worker, completed job, and recent legacy no-PID record stay unchanged", () => {
    const live = job();
    expect(visibleUpdateJob(live, now, () => true)).toBe(live);
    const success = { ...job(), status: "succeeded" as const };
    expect(visibleUpdateJob(success, now, () => false)).toBe(success);
    const legacy = { ...job(), pid: undefined };
    expect(visibleUpdateJob(legacy, now, () => false)).toBe(legacy);
  });

  test("old no-PID records are visibly failed after their conservative stale window", () => {
    const legacy = { ...job(), pid: undefined, updatedAt: new Date(0).toISOString() };
    expect(visibleUpdateJob(legacy, now, () => false).status).toBe("failed");
  });

  test("a reused numeric PID is rejected using its Linux start token", () => {
    if (process.platform !== "linux") return;
    const actual = readLinuxProcessStartTicks(process.pid);
    expect(actual).toMatch(/^\d+$/);
    const active = { ...job(), pid: process.pid, workerProcessStartTicks: actual! };
    expect(staleActiveUpdateJobReason(active, now, () => true)).toBeNull();
    expect(visibleUpdateJob(active, now, () => true)).toBe(active);
    const reused = { ...active, workerProcessStartTicks: "0" };
    expect(staleActiveUpdateJobReason(reused, now, () => true)).toContain("identity changed");
    expect(visibleUpdateJob(reused, now, () => true).status).toBe("failed");
  });
});
