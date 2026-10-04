import { removeOwnedTestTempRoot } from "./test-temp";

const [root, pidText] = process.argv.slice(2);
const ownerPid = Number(pidText);
if (!root || !/^\d+$/.test(pidText ?? "") || !Number.isSafeInteger(ownerPid) || ownerPid <= 0) process.exit(2);

// The owner retains the write end until exit. Kernel EOF, not elapsed wall time,
// ends the lifetime: even a long bare test keeps its cleanup monitor. This pipe
// conveys no commands or data, and EOF alone never grants deletion authority.
const reader = Bun.stdin.stream().getReader();
try {
  const next = await reader.read();
  if (!next.done) process.exit(2);
} finally {
  reader.releaseLock();
}

// EOF can arrive before the parent's zombie is reaped. Bound only that final
// settlement, using a monotonic clock; PID reuse/uncertainty still fails closed.
const deadline = performance.now() + 5_000;
for (;;) {
  let alive = true;
  try { process.kill(ownerPid, 0); }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && String(error.code) === "ESRCH") alive = false;
    else process.exit(0);
  }
  if (!alive) break;
  if (performance.now() >= deadline) process.exit(0);
  await Bun.sleep(50);
}
try { removeOwnedTestTempRoot(root, ownerPid); } catch { /* preserve the marked root on uncertain cleanup */ }
