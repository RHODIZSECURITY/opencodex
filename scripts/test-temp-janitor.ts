import { removeOwnedTestTempRoot } from "./test-temp";

const [root, pidText] = process.argv.slice(2);
const ownerPid = Number(pidText);
if (!root || !/^\d+$/.test(pidText ?? "") || !Number.isSafeInteger(ownerPid) || ownerPid <= 0) process.exit(2);
const deadline = Date.now() + 10 * 60 * 1000;
for (;;) {
  let alive = true;
  try { process.kill(ownerPid, 0); }
  catch (error) {
    if (error && typeof error === "object" && "code" in error && String(error.code) === "ESRCH") alive = false;
    else process.exit(0);
  }
  if (!alive) break;
  if (Date.now() >= deadline) process.exit(0);
  await Bun.sleep(50);
}
try { removeOwnedTestTempRoot(root, ownerPid); } catch { /* leave ownership-marked root for bounded stale recovery */ }
