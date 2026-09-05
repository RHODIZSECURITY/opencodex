import { isSafeResponseHeader, safeResponseHeaders } from "../safe-response-headers";

export const CODEX_WS_METADATA_MAX_BYTES = 32 * 1024;
export const CODEX_WS_METADATA_MAX_FAMILIES = 16;
export const CODEX_WS_METADATA_MAX_HEADERS = 128;
export const CODEX_WS_METADATA_MAX_VALUE_BYTES = 4096;

type MetadataObserver = (headers: Headers) => void;
const owners = new WeakMap<Response, CodexWsMetadata>();

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function finiteNonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function nativeLimitFamily(event: Record<string, unknown>): string | null {
  const raw = event.metered_limit_name ?? event.limit_name ?? "codex";
  if (typeof raw !== "string") return null;
  const name = raw.trim().toLowerCase().replaceAll("_", "-");
  return name.length <= 64 && /^codex(?:-[a-z0-9-]+)?$/.test(name) ? name : null;
}

function writeWindow(headers: Headers, prefix: string, value: unknown): void {
  if (!record(value) || !finiteNonnegative(value.used_percent)) return;
  headers.set(`${prefix}-used-percent`, String(value.used_percent));
  for (const [field, suffix] of [["window_minutes", "window-minutes"], ["reset_at", "reset-at"]]) {
    const number = value[field!];
    if (finiteNonnegative(number) && Number.isSafeInteger(number)) headers.set(`${prefix}-${suffix}`, String(number));
  }
}

function quotaHeaders(event: Record<string, unknown>): Headers {
  const headers = new Headers();
  const family = nativeLimitFamily(event);
  if (family && record(event.rate_limits)) {
    writeWindow(headers, `x-${family}-primary`, event.rate_limits.primary);
    writeWindow(headers, `x-${family}-secondary`, event.rate_limits.secondary);
  }
  if (record(event.credits)) {
    for (const [field, suffix] of [["has_credits", "has-credits"], ["unlimited", "unlimited"]]) {
      const value = event.credits[field!];
      if (typeof value === "boolean") headers.set(`x-codex-credits-${suffix}`, String(value));
    }
    if (typeof event.credits.balance === "string") setMetadataHeader(headers, "x-codex-credits-balance", event.credits.balance);
  }
  return headers;
}

function setMetadataHeader(headers: Headers, name: string, value: string): void {
  if (Buffer.byteLength(value) > CODEX_WS_METADATA_MAX_VALUE_BYTES) throw new Error("codex websocket metadata value exceeds the size limit");
  if (/[\r\n\0]/.test(value)) return;
  try { headers.set(name, value); } catch { /* invalid provider header is not HTTP authority */ }
}

function responseHeaders(value: unknown): Headers {
  const headers = new Headers();
  if (!record(value)) return headers;
  for (const [name, field] of Object.entries(value)) {
    if (!isSafeResponseHeader(name)) continue;
    if (typeof field !== "string" && typeof field !== "number" && typeof field !== "boolean") continue;
    setMetadataHeader(headers, name, String(field));
  }
  return headers;
}

function assertMetadataBounds(headers: Headers): void {
  let bytes = 0;
  let count = 0;
  const families = new Set<string>();
  for (const [name, value] of headers) {
    bytes += Buffer.byteLength(name) + Buffer.byteLength(value);
    count++;
    const family = /^(x-codex(?:-[a-z0-9-]+)?)-(?:primary|secondary)-(?:used-percent|window-minutes|reset-at)$/.exec(name);
    if (family) families.add(family[1]!);
  }
  if (bytes > CODEX_WS_METADATA_MAX_BYTES || count > CODEX_WS_METADATA_MAX_HEADERS || families.size > CODEX_WS_METADATA_MAX_FAMILIES) {
    throw new Error("codex websocket metadata exceeds the bounded header budget");
  }
}

/** One exchange's metadata. The Response owns its final snapshot, not a global history ledger. */
export class CodexWsMetadata {
  private headers = new Headers();
  private observer: MetadataObserver | undefined;
  private ended = false;
  private preludeBytes = 0;
  private committed = false;

  snapshot(): Headers { return new Headers(this.headers); }

  bind(response: Response): void {
    this.committed = true;
    owners.set(response, this);
  }

  /** Returns a sanitized control frame, or null for an ordinary Responses event. */
  consume(event: Record<string, unknown>, bytes: number): string | null {
    if (event.type !== "codex.rate_limits" && event.type !== "codex.response.metadata") return null;
    if (bytes > CODEX_WS_METADATA_MAX_BYTES) throw new Error("codex websocket metadata frame exceeds the size limit");
    if (!this.committed) this.preludeBytes += bytes;
    if (this.preludeBytes > CODEX_WS_METADATA_MAX_BYTES) throw new Error("codex websocket metadata prelude exceeds the size limit");
    const updates = event.type === "codex.rate_limits" ? quotaHeaders(event) : responseHeaders(event.headers);
    const next = this.snapshot();
    for (const [name, value] of updates) next.set(name, value);
    assertMetadataBounds(next);
    this.headers = next;
    this.observer?.(this.snapshot());
    return event.type === "codex.response.metadata"
      ? JSON.stringify({ type: event.type, headers: safeResponseHeaders(updates) })
      : JSON.stringify(event);
  }

  observe(observer: MetadataObserver): () => void {
    observer(this.snapshot());
    if (!this.ended) this.observer = observer;
    return () => { if (this.observer === observer) this.observer = undefined; };
  }

  finish(): void {
    this.ended = true;
    this.observer = undefined;
  }
}

/** Attach after the prelude quota write; a completed exchange replays its final snapshot once. */
export function observeCodexWsResponseMetadata(response: Response, observer: MetadataObserver): () => void {
  return owners.get(response)?.observe(observer) ?? (() => {});
}
