import { readFileSync } from "node:fs";

/**
 * Linux process identity, distinct from numeric PID liveness. Field 22 of
 * /proc/PID/stat records starttime ticks since boot and changes on PID reuse.
 * A saved identity that cannot be re-read is not evidence of a live updater.
 */
export function readLinuxProcessStartTicks(
  pid: number,
  read: (path: string) => string = path => readFileSync(path, "utf8"),
): string | null {
  if (process.platform !== "linux" || !Number.isSafeInteger(pid) || pid <= 0) return null;
  try {
    const raw = read("/proc/" + pid + "/stat");
    if (!raw.startsWith(String(pid) + " (")) return null;
    // Field 2 (comm) may contain whitespace and parentheses.
    const end = raw.lastIndexOf(") ");
    if (end < 0) return null;
    const fields = raw.slice(end + 2).trim().split(/\s+/);
    // Fields begin at state (3), so starttime field 22 is index 19.
    const ticks = fields[19];
    return ticks && /^\d{1,24}$/.test(ticks) ? ticks : null;
  } catch {
    return null;
  }
}
