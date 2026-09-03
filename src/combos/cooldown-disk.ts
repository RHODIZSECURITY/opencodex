/** Persist only long-lived combo quota cooldowns across proxy restarts. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile, getConfigDir } from "../config";

const FILENAME = "combo-quota-cooldowns.json";
const MAX_FUTURE_MS = 31 * 24 * 60 * 60_000;
const PERSIST_DEBOUNCE_MS = 250;

type DiskFile = { version: 1; rows: Record<string, number> };
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let pendingRows: (() => Iterable<[string, number]>) | null = null;
let pendingDirectory: string | null = null;

export function comboQuotaCooldownStoreDirectory(): string {
  return getConfigDir();
}

export function readPersistedComboQuotaCooldowns(directory: string, now = Date.now()): Map<string, number> {
  const rows = new Map<string, number>();
  try {
    const path = join(directory, FILENAME);
    if (!existsSync(path)) return rows;
    const parsed = JSON.parse(readFileSync(path, "utf8")) as DiskFile;
    if (!parsed || parsed.version !== 1 || !parsed.rows || typeof parsed.rows !== "object") return rows;
    for (const [key, until] of Object.entries(parsed.rows)) {
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
      if (!Number.isFinite(until) || until <= now || until - now > MAX_FUTURE_MS) continue;
      out[key] = until;
    }
    atomicWriteFile(join(directory, FILENAME), `${JSON.stringify({ version: 1, rows: out } satisfies DiskFile)}\n`);
  } catch {
    // Best-effort persistence only. Runtime failover remains authoritative.
  }
}

export function schedulePersistComboQuotaCooldowns(directory: string, rows: () => Iterable<[string, number]>): void {
  pendingDirectory = directory;
  pendingRows = rows;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const snapshot = pendingRows;
    const directory = pendingDirectory;
    pendingRows = null;
    pendingDirectory = null;
    if (snapshot && directory) persistNow(directory, snapshot());
  }, PERSIST_DEBOUNCE_MS);
}

export function flushComboQuotaCooldownPersistForTests(now = Date.now()): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = null;
  const snapshot = pendingRows;
  const directory = pendingDirectory;
  pendingRows = null;
  pendingDirectory = null;
  if (snapshot && directory) persistNow(directory, snapshot(), now);
}

export function cancelPendingComboQuotaCooldownPersist(): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = null;
  pendingRows = null;
  pendingDirectory = null;
}
