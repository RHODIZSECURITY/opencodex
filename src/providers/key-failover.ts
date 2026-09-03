/**
 * Multi-key 429 failover for non-OpenAI providers.
 *
 * When a provider's upstream returns 429, this module picks the next available key
 * from `apiKeyPool`, puts the exhausted key into cooldown (respecting Retry-After),
 * and returns a fresh provider config with the swapped key. If all keys are in
 * cooldown, returns null so the caller surfaces the 429 to the client.
 *
 * Modelled after src/codex/routing.ts cooldown logic but scoped to plain API-key pools.
 */
import { saveConfigPreservingClaudeCode } from "../config";
import type { OcxConfig, OcxProviderConfig, RateLimitRetryPolicy, TransientRetryPolicy } from "../types";
import { deleteCachedProviderQuota, getCachedProviderQuota } from "./quota-routing-cache";
import { apiKeyPoolEntryId } from "./api-keys";
import type { ProviderQuota } from "./quota-types";
import {
  keyQuotaCooldownStoreDirectory,
  readPersistedKeyQuotaCooldowns,
  schedulePersistKeyQuotaCooldowns,
} from "./key-cooldown-disk";
import { resolveProviderTransport, type OcxProviderTransport } from "./xai-transport";
import { sweepExpiredOnWrite } from "../lib/state-store-sweeper";

// ---- cooldown state (in-memory, same as codex/routing.ts) ----

interface KeyCooldown {
  cooldownUntil: number;
}

const DEFAULT_COOLDOWN_MS = 60_000;
const MAX_COOLDOWN_MS = 10 * 60_000; // cap at 10 min for api-key rotation
const MAX_QUOTA_COOLDOWN_MS = 31 * 24 * 60 * 60_000;

function exhaustedQuotaRecoveryMs(quota: ProviderQuota | null, now: number): number | undefined {
  if (!quota) return undefined;
  const resets: number[] = [];
  const add = (percent: number | undefined, resetAt: number | undefined) => {
    if (typeof percent !== "number" || !Number.isFinite(percent) || percent < 100) return;
    if (typeof resetAt !== "number" || !Number.isFinite(resetAt) || resetAt <= now) return;
    resets.push(resetAt);
  };
  add(quota.fiveHourPercent, quota.fiveHourResetAt);
  add(quota.weeklyPercent, quota.weeklyResetAt);
  add(quota.monthlyPercent, quota.monthlyResetAt);
  for (const window of quota.customWindows ?? []) add(window.percent, window.resetAt);
  if (resets.length === 0) return undefined;
  return Math.min(Math.max(...resets) - now, MAX_QUOTA_COOLDOWN_MS);
}

/**
 * Default same-target 429 retry policy used when a provider opts in via a bare
 * `retryOn429: {}` (presence = opt-in with these defaults).
 */
const DEFAULT_RATE_LIMIT_RETRY = {
  enabled: true,
  attempts: 3,
  intervalMs: 5_000,
  maxIntervalMs: 60_000,
  respectRetryAfter: true,
} as const satisfies Required<RateLimitRetryPolicy>;

/**
 * Default transient-5xx retry used when a provider opts in with a bare
 * `transientRetryOn5xx: {}`. `attempts` is a TOTAL send budget, not extra retries.
 */
const DEFAULT_TRANSIENT_RETRY = {
  enabled: true,
  attempts: 3,
} as const satisfies Required<TransientRetryPolicy>;

/** Map<`${providerName}\0${keyId}`, KeyCooldown> */
const keyCooldowns = new Map<string, KeyCooldown>();
const persistedQuotaCooldownKeys = new Set<string>();
let quotaCooldownPersistenceDirectory: string | undefined;

function persistedQuotaCooldownRows(): Iterable<[string, number]> {
  return [...persistedQuotaCooldownKeys].flatMap(key => {
    const state = keyCooldowns.get(key);
    return state ? [[key, state.cooldownUntil] as [string, number]] : [];
  });
}

function scheduleQuotaCooldownPersistence(): void {
  if (!quotaCooldownPersistenceDirectory) return;
  schedulePersistKeyQuotaCooldowns(quotaCooldownPersistenceDirectory, () => persistedQuotaCooldownRows());
}

function cooldownKey(providerName: string, apiKey: string): string {
  return `${providerName}\0${apiKeyPoolEntryId(apiKey)}`;
}

export function hydrateKeyQuotaCooldownsFromDisk(now = Date.now()): void {
  const directory = keyQuotaCooldownStoreDirectory();
  if (quotaCooldownPersistenceDirectory === directory) return;
  for (const key of persistedQuotaCooldownKeys) keyCooldowns.delete(key);
  persistedQuotaCooldownKeys.clear();
  quotaCooldownPersistenceDirectory = directory;
  for (const [key, cooldownUntil] of readPersistedKeyQuotaCooldowns(directory, now)) {
    keyCooldowns.set(key, { cooldownUntil });
    persistedQuotaCooldownKeys.add(key);
  }
}

export function resetKeyQuotaCooldownPersistenceForTests(): void {
  keyCooldowns.clear();
  persistedQuotaCooldownKeys.clear();
  quotaCooldownPersistenceDirectory = undefined;
}

/**
 * Parse an upstream `Retry-After` header: numeric seconds (including `0`) or an HTTP-date.
 * Returns a bounded delay in ms (1..MAX_COOLDOWN_MS), or undefined when the value is
 * malformed. An HTTP-date already in the past yields an immediate (1 ms) retry.
 */
function parseRetryAfterMs(value: string | null | undefined, now = Date.now()): number | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const seconds = Number(text);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(Math.max(Math.ceil(seconds * 1000), 1), MAX_COOLDOWN_MS);
    }
  }
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) return undefined;
  const delay = timestamp - now;
  // A valid HTTP-date whose retry time has already passed is an immediate retry, exactly like
  // numeric `Retry-After: 0` — never a malformed-header fallback to the fixed interval.
  return Math.min(Math.max(delay, 1), MAX_COOLDOWN_MS);
}

/**
 * True while the given key is inside its 429 cooldown window (lazily evicting the entry once the
 * window expires). Used to skip keys that the upstream just rate-limited during failover.
 */
function isKeyInCooldown(providerName: string, apiKey: string, now = Date.now()): boolean {
  const key = cooldownKey(providerName, apiKey);
  const entry = keyCooldowns.get(key);
  if (!entry) return false;
  if (entry.cooldownUntil <= now) {
    keyCooldowns.delete(key);
    if (persistedQuotaCooldownKeys.delete(key)) scheduleQuotaCooldownPersistence();
    return false;
  }
  return true;
}

// ---- public API ----

/**
 * Check whether a provider has multiple keys available for failover.
 * Returns true only for key-auth providers with 2+ pool entries.
 */
export function hasKeyPoolFailover(provider: OcxProviderConfig): boolean {
  if (provider.authMode === "oauth" || provider.authMode === "forward") return false;
  return (provider.apiKeyPool?.length ?? 0) >= 2;
}

/**
 * Normalize a provider's `retryOn429` policy, or return null when the knob is absent,
 * explicitly disabled, or the provider is not key-auth (OAuth/forward credentials must not be
 * replayed on the same token, forward passthrough never reaches the recovery loop anyway, and
 * local runtimes have no remote key to preserve). The returned policy is fully defaulted so
 * callers never re-check fields.
 */
export function rateLimitRetryPolicyFor(
  provider: Pick<OcxProviderConfig, "retryOn429" | "authMode">,
): Required<RateLimitRetryPolicy> | null {
  const policy = provider.retryOn429;
  if (!policy || policy.enabled === false) return null;
  // Fail closed: only explicit key auth or the documented omitted-default (undefined == key for
  // custom API-key providers) may use same-key replays. OAuth/forward are never replayed on the
  // same token, local runtimes have no remote key to preserve, and unknown/custom values are
  // rejected rather than guessed at.
  if (provider.authMode !== undefined && provider.authMode !== "key") return null;
  return {
    enabled: policy.enabled ?? DEFAULT_RATE_LIMIT_RETRY.enabled,
    attempts: policy.attempts ?? DEFAULT_RATE_LIMIT_RETRY.attempts,
    intervalMs: policy.intervalMs ?? DEFAULT_RATE_LIMIT_RETRY.intervalMs,
    maxIntervalMs: policy.maxIntervalMs ?? DEFAULT_RATE_LIMIT_RETRY.maxIntervalMs,
    respectRetryAfter: policy.respectRetryAfter ?? DEFAULT_RATE_LIMIT_RETRY.respectRetryAfter,
  };
}

/**
 * Normalize a provider's `transientRetryOn5xx` policy, or return null when it is absent,
 * explicitly disabled, not key-auth, or not the `openai-chat` adapter.
 *
 * The adapter gate is part of the accepted scope, not incidental: this first version covers
 * key-auth `openai-chat` only, and without an explicit check any generic key-auth adapter
 * could opt in. Auth mode follows the same fail-closed rule as `rateLimitRetryPolicyFor` —
 * explicit `key` or the documented omitted default, never OAuth, forward, local, or an
 * unknown value.
 */
export function transientRetryPolicyFor(
  provider: Pick<OcxProviderConfig, "transientRetryOn5xx" | "authMode" | "adapter">,
): Required<TransientRetryPolicy> | null {
  const policy = provider.transientRetryOn5xx;
  if (!policy || policy.enabled === false) return null;
  if (provider.adapter !== "openai-chat") return null;
  if (provider.authMode !== undefined && provider.authMode !== "key") return null;
  return {
    enabled: policy.enabled ?? DEFAULT_TRANSIENT_RETRY.enabled,
    attempts: policy.attempts ?? DEFAULT_TRANSIENT_RETRY.attempts,
  };
}

/**
 * Wait before the next same-target replay: upstream Retry-After (seconds or HTTP-date) when
 * `respectRetryAfter` is on and the header parses, capped at `maxIntervalMs`; otherwise the
 * fixed `intervalMs`, also capped at `maxIntervalMs` (a single wait never exceeds the cap).
 * Malformed headers fall back to the fixed interval.
 */
export function rateLimitRetryDelayMs(
  policy: Required<RateLimitRetryPolicy>,
  retryAfterHeader: string | null | undefined,
  now = Date.now(),
): number {
  const raw = retryAfterHeader?.trim();
  if (policy.respectRetryAfter && raw) {
    const parsed = parseRetryAfterMs(raw, now);
    if (parsed !== undefined) return Math.min(parsed, policy.maxIntervalMs);
  }
  return Math.min(policy.intervalMs, policy.maxIntervalMs);
}

/**
 * Record a 429 for the current key and attempt to switch to the next available one.
 *
 * @returns A new OcxProviderConfig with the swapped key (and mutated config on disk),
 *          or `null` when no alternative key is available (all in cooldown or pool < 2).
 *
 * The returned object is a snapshot of the PERSISTED config — it carries none of the
 * registry backfills `routedProviderConfig` merges in at request time. Request paths must
 * not assign it to an active route wholesale; use `rotateProviderTransportOn429`, which
 * takes only the swapped key and keeps the routed provider intact.
 */
function rotateKeyAfterFailure(
  config: OcxConfig,
  providerName: string,
  failureStatus: 401 | 429,
  retryAfterHeader: string | null | undefined,
  now = Date.now(),
  attemptedKey?: string,
): OcxProviderConfig | null {
  const provider = config.providers[providerName];
  if (!provider) return null;
  if (provider.authMode === "oauth" || provider.authMode === "forward") return null;
  const pool = provider.apiKeyPool;
  if (!pool || pool.length < 2) return null;

  const failedKey = attemptedKey ?? provider.apiKey;
  const failedKeyWasActive = failedKey === provider.apiKey;
  const quotaRecoveryMs = failureStatus === 429 && failedKeyWasActive
    ? exhaustedQuotaRecoveryMs(getCachedProviderQuota(providerName, now), now)
    : undefined;
  const currentEntry = pool.find(e => e.key === failedKey);
  if (currentEntry) {
    const headerCooldownMs = failureStatus === 429 ? parseRetryAfterMs(retryAfterHeader, now) : undefined;
    const authCooldownMs = failureStatus === 401 ? MAX_COOLDOWN_MS : DEFAULT_COOLDOWN_MS;
    const cooldownMs = Math.max(headerCooldownMs ?? 0, quotaRecoveryMs ?? 0, authCooldownMs);
    const key = cooldownKey(providerName, currentEntry.key);
    const cooldownUntil = now + cooldownMs;
    keyCooldowns.set(key, { cooldownUntil });
    const durableLongQuota = quotaRecoveryMs !== undefined && cooldownMs > MAX_COOLDOWN_MS;
    const persistenceChanged = durableLongQuota
      ? (persistedQuotaCooldownKeys.add(key), true)
      : persistedQuotaCooldownKeys.delete(key);
    if (persistenceChanged) scheduleQuotaCooldownPersistence();
    sweepExpiredOnWrite(now);
  }

  // CAS: another request may already have rotated away from the exact credential that failed.
  if (attemptedKey !== undefined && provider.apiKey !== attemptedKey) {
    const liveEntry = pool.find(e => e.key === provider.apiKey);
    if (liveEntry && !isKeyInCooldown(providerName, liveEntry.key, now)) return { ...provider };
  }

  const currentIndex = currentEntry ? pool.indexOf(currentEntry) : -1;
  for (let i = 1; i < pool.length; i++) {
    const candidate = pool[(currentIndex + i) % pool.length]!;
    if (isKeyInCooldown(providerName, candidate.key, now)) continue;
    provider.apiKey = candidate.key;
    deleteCachedProviderQuota(providerName);
    saveConfigPreservingClaudeCode(config);
    console.warn(
      `[key-failover] ${providerName}: ${failureStatus} on key ${currentEntry ? apiKeyPoolEntryId(currentEntry.key) : "?"}; rotating to key ${apiKeyPoolEntryId(candidate.key)}`,
    );
    return { ...provider };
  }

  console.warn(
    `[key-failover] ${providerName}: all ${pool.length} keys in cooldown after ${failureStatus}; no replacement available`,
  );
  return null;
}

export function rotateKeyOn429(
  config: OcxConfig,
  providerName: string,
  retryAfterHeader: string | null | undefined,
  now = Date.now(),
  attemptedKey?: string,
): OcxProviderConfig | null {
  return rotateKeyAfterFailure(config, providerName, 429, retryAfterHeader, now, attemptedKey);
}

export function rotateKeyOn401(
  config: OcxConfig,
  providerName: string,
  now = Date.now(),
  attemptedKey?: string,
): OcxProviderConfig | null {
  return rotateKeyAfterFailure(config, providerName, 401, null, now, attemptedKey);
}

export function sweepExpiredApiKeyCooldowns(now = Date.now()): number {
  let removed = 0;
  let persistenceChanged = false;
  for (const [key, cooldown] of keyCooldowns) {
    if (cooldown.cooldownUntil > now) continue;
    keyCooldowns.delete(key);
    if (persistedQuotaCooldownKeys.delete(key)) persistenceChanged = true;
    removed += 1;
  }
  if (persistenceChanged) scheduleQuotaCooldownPersistence();
  return removed;
}

interface RotateProviderTransportOptions {
  retryAfter?: string | null;
  now?: number;
  attemptedKey?: string;
  promptCacheKey?: string;
}

/**
 * Rotate a failed key and re-apply provider-specific transport metadata to the replacement.
 *
 * `routedProvider` is the request's active provider (the `routedProviderConfig` output the
 * route was built with). The result inherits it and swaps ONLY the API key: the persisted
 * config that `rotateKeyOn429` snapshots predates registry backfill, so building the retry
 * provider from that snapshot would silently drop every field the registry merged in at
 * routing time (scalar flags like `promptCacheKey`/`parallelToolCalls`, merged model
 * metadata such as `noTemperatureModels`, a pinned baseUrl). Mirrors the OAuth-401 replay
 * path in src/server/responses/core.ts, which spreads `route.provider` for the same reason.
 */
export function rotateProviderTransportOn429(
  config: OcxConfig,
  providerName: string,
  routedProvider: OcxProviderTransport,
  options: RotateProviderTransportOptions = {},
): OcxProviderTransport | null {
  const rotated = rotateKeyOn429(
    config,
    providerName,
    options.retryAfter,
    options.now,
    options.attemptedKey,
  );
  return rotated
    ? resolveProviderTransport(
        providerName,
        { ...routedProvider, apiKey: rotated.apiKey },
        options.promptCacheKey,
      )
    : null;
}

export function rotateProviderTransportOn401(
  config: OcxConfig,
  providerName: string,
  routedProvider: OcxProviderTransport,
  options: Omit<RotateProviderTransportOptions, "retryAfter"> = {},
): OcxProviderTransport | null {
  const rotated = rotateKeyOn401(config, providerName, options.now, options.attemptedKey);
  return rotated
    ? resolveProviderTransport(
        providerName,
        { ...routedProvider, apiKey: rotated.apiKey },
        options.promptCacheKey,
      )
    : null;
}

/** Clear cooldown state for a provider (e.g. after manual key management). */
export function clearKeyCooldowns(providerName?: string): void {
  let persistenceChanged = false;
  if (!providerName) {
    keyCooldowns.clear();
    persistenceChanged = persistedQuotaCooldownKeys.size > 0;
    persistedQuotaCooldownKeys.clear();
  } else {
    const prefix = `${providerName}\0`;
    for (const key of keyCooldowns.keys()) {
      if (!key.startsWith(prefix)) continue;
      keyCooldowns.delete(key);
      if (persistedQuotaCooldownKeys.delete(key)) persistenceChanged = true;
    }
  }
  if (persistenceChanged) scheduleQuotaCooldownPersistence();
}

/** Visible-for-testing: get the cooldown-until timestamp for a key. */
export function getKeyCooldownUntil(providerName: string, apiKey: string, now = Date.now()): number | null {
  const entry = keyCooldowns.get(cooldownKey(providerName, apiKey));
  if (!entry) return null;
  return entry.cooldownUntil > now ? entry.cooldownUntil : null;
}
