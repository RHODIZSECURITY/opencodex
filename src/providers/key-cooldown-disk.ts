/** Persist only long-lived API-key quota cooldowns across proxy restarts. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile, getConfigDir } from "../config";

const FILENAME = "provider-key-quota-cooldowns.json";
const MAX_FUTURE_MS = 31 * 24 * 60 * 60_000;
const PERSIST_DEBOUNCE_MS = 250;
type DiskFile = { version: 1; rows: Record<string, number> };

function isSafeCooldownRowKey(value: string): boolean {
  const split = value.lastIndexOf("\0");
  if (split <= 0) return false;
  const keyId = value.slice(split + 1);
  return /^[0-9a-f]{8}$/.test(keyId);
}

let persistTimer: ReturnType<typeof setTimeout> | null = null;
let pendingRows: (() => Iterable<[string, number]>) | null = null;
let pendingDirectory: string | null = null;

export function keyQuotaCooldownStoreDirectory(): string {
  return getConfigDir();
}

export function readPersistedKeyQuotaCooldowns(directory: string, now = Date.now()): Map<string, number> {
  const rows = new Map<string, number>();
  try {
    const path = join(directory, FILENAME);
    if (!existsSync(path)) return rows;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as DiskFile;
    if (!parsed || parsed.version !== 1 || !parsed.rows || typeof parsed.rows !== "object") return rows;
    for (const [key, until] of Object.entries(parsed.rows)) {
      if (!isSafeCooldownRowKey(key)) continue;
      if (typeof until !== "number" || !Number.isFinite(until)) continue;
      if (until <= now || until - now > MAX_FUTURE_MS) continue;
      rows.set(key, until);
    }
  } catch {
    // Missing/corrupt best-effort state must never block routing.
  }
  return rows;
}
function persistNow(directory: string, rows: Iterable<[string, number]>, now = Date.now()): void {
  try {
    const out: Record<string, number> = {};
    for (const [key, until] of rows) {
      if (!isSafeCooldownRowKey(key)) continue;
      if (!Number.isFinite(until) || until <= now || until - now > MAX_FUTURE_MS) continue;
      out[key] = until;
    }
    atomicWriteFile(join(directory, FILENAME), `${JSON.stringify({ version: 1, rows: out } satisfies DiskFile)}\n`);
  } catch {
    // Runtime failover remains authoritative if persistence fails.
  }
}

export function schedulePersistKeyQuotaCooldowns(directory: string, rows: () => Iterable<[string, number]>): void {
  pendingDirectory = directory;
  pendingRows = rows;
  // Keep the first debounce deadline. Repeated failures update the pending snapshot
  // but cannot postpone durable persistence indefinitely.
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const snapshot = pendingRows;
    const targetDirectory = pendingDirectory;
    pendingRows = null;
    pendingDirectory = null;
    if (snapshot && targetDirectory) persistNow(targetDirectory, snapshot());
  }, PERSIST_DEBOUNCE_MS);
}
export function flushPendingKeyQuotaCooldownPersist(now = Date.now()): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = null;
  const snapshot = pendingRows;
  const targetDirectory = pendingDirectory;
  pendingRows = null;
  pendingDirectory = null;
  if (snapshot && targetDirectory) persistNow(targetDirectory, snapshot(), now);
}

export function flushKeyQuotaCooldownPersistForTests(now = Date.now()): void {
  flushPendingKeyQuotaCooldownPersist(now);
}

export function cancelPendingKeyQuotaCooldownPersist(): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = null;
  pendingRows = null;
  pendingDirectory = null;
}
