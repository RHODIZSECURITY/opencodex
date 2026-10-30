import { isProcessAlive } from "../lib/process-control";
import { readUpdateJob, staleActiveUpdateJobReason, type UpdateJobState } from "./job";

/**
 * Dashboard polling must not show a permanent "running" spinner for an updater
 * that died when its parent service stopped. Project an immutable failed view.
 * The on-disk record is untouched; startUpdateJob owns serialized stale cleanup.
 */
export function visibleUpdateJob(
  job: UpdateJobState,
  now: number = Date.now(),
  alive: (pid: number) => boolean = isProcessAlive,
): UpdateJobState {
  if (!staleActiveUpdateJobReason(job, now, alive)) return job;
  return {
    ...job,
    status: "failed",
    restarted: false,
    exitCode: null,
    error: "The update worker stopped without reporting completion. Verify proxy/service health before retrying.",
  };
}

export function readVisibleUpdateJob(jobId?: string | null): UpdateJobState | null {
  const job = readUpdateJob(jobId);
  return job ? visibleUpdateJob(job) : null;
}
