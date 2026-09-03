import { classifyError, isCyberPolicyCode } from "../lib/errors";
import type { OcxComboTarget } from "../types";
import { targetKey } from "./types";
import {
  comboQuotaCooldownStoreDirectory,
  readPersistedComboQuotaCooldowns,
  schedulePersistComboQuotaCooldowns,
} from "./cooldown-disk";
import {
  captureConfigGeneration,
  sweepExpiredOnWrite,
  type GenerationContext,
} from "../lib/state-store-sweeper";

interface TargetCooldown {
  cooldownUntil: number;
}

const DEFAULT_COOLDOWN_MS = 60_000;
const MAX_COOLDOWN_MS = 10 * 60_000;
/** Long provider quota windows may legitimately span days; keep this bounded. */
const MAX_QUOTA_COOLDOWN_MS = 31 * 24 * 60 * 60_000;
/** Short cooldown for request-rate 429s (for example provider code 1302) that omit Retry-After. */
export const COMBO_REQUEST_RATE_COOLDOWN_MS = 5_000;

const QUOTA_LIMIT_CODES = new Set([
  "1308",
  "1310",
  "1316",
  "1317",
  "1318",
  "1319",
  "1320",
  "1321",
  "insufficient_quota",
]);
const TRANSIENT_REQUEST_RATE_CODES = new Set(["1302", "1305"]);
const IMF_FIXDATE_RE = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/i;
const RFC850_DATE_RE = /^(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), (\d{2})-(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)-(\d{2}) (\d{2}):(\d{2}):(\d{2}) GMT$/i;
const ASCTIME_DATE_RE = /^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ( \d|\d{2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/i;
const HTTP_MONTH_INDEX: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

/** Target keys are combo-local; provider keys represent provider-wide evidence shared by every combo. */
const PROVIDER_COOLDOWN_PREFIX = "\u0001provider\0";
const targetCooldowns = new Map<string, TargetCooldown>();
const persistedQuotaCooldownKeys = new Set<string>();
let quotaCooldownPersistenceDirectory: string | undefined;
let lastReconciledGeneration = 0;
let liveComboTargets = new Set<string>();
let liveProviders = new Set<string>();

function providerCooldownMapKey(provider: string): string {
  return `${PROVIDER_COOLDOWN_PREFIX}${provider}`;
}

function cooldownMapKey(
  comboId: string,
  target: Pick<OcxComboTarget, "provider" | "model">,
): string {
  return `${comboId}\0${targetKey(target)}`;
}

function persistedQuotaCooldownRows(): Iterable<[string, number]> {
  return [...persistedQuotaCooldownKeys].flatMap(key => {
    const state = targetCooldowns.get(key);
    return state ? [[key, state.cooldownUntil] as [string, number]] : [];
  });
}

function scheduleQuotaCooldownPersistence(): void {
  if (!quotaCooldownPersistenceDirectory) return;
  schedulePersistComboQuotaCooldowns(
    quotaCooldownPersistenceDirectory,
    () => persistedQuotaCooldownRows(),
  );
}

/** Hydrate only durable long quota cooldowns; transient transport/rate cooldowns stay process-local. */
export function hydrateComboQuotaCooldownsFromDisk(now = Date.now()): void {
  const directory = comboQuotaCooldownStoreDirectory();
  if (quotaCooldownPersistenceDirectory === directory) return;
  for (const key of persistedQuotaCooldownKeys) targetCooldowns.delete(key);
  persistedQuotaCooldownKeys.clear();
  quotaCooldownPersistenceDirectory = directory;
  for (const [key, cooldownUntil] of readPersistedComboQuotaCooldowns(directory, now)) {
    targetCooldowns.set(key, { cooldownUntil });
    persistedQuotaCooldownKeys.add(key);
  }
}

export function resetComboQuotaCooldownPersistenceForTests(): void {
  for (const key of persistedQuotaCooldownKeys) targetCooldowns.delete(key);
  persistedQuotaCooldownKeys.clear();
  quotaCooldownPersistenceDirectory = undefined;
}

function parseUtcDateParts(
  year: number,
  monthName: string,
  day: number,
  hour: number,
  minute: number,
  second: number,
): number | undefined {
  const month = HTTP_MONTH_INDEX[monthName.toLowerCase()];
  if (month === undefined) return undefined;
  const timestamp = Date.UTC(year, month, day, hour, minute, second);
  const parsed = new Date(timestamp);
  return parsed.getUTCFullYear() === year
    && parsed.getUTCMonth() === month
    && parsed.getUTCDate() === day
    && parsed.getUTCHours() === hour
    && parsed.getUTCMinutes() === minute
    && parsed.getUTCSeconds() === second
    ? timestamp
    : undefined;
}

function parseHttpDate(value: string, now: number): number | undefined {
  const imf = IMF_FIXDATE_RE.exec(value);
  if (imf) {
    return parseUtcDateParts(
      Number(imf[3]), imf[2]!, Number(imf[1]),
      Number(imf[4]), Number(imf[5]), Number(imf[6]),
    );
  }
  const rfc850 = RFC850_DATE_RE.exec(value);
  if (rfc850) {
    const current = new Date(now);
    const currentYear = current.getUTCFullYear();
    const month = HTTP_MONTH_INDEX[rfc850[2]!.toLowerCase()];
    if (month === undefined) return undefined;
    let year = Math.floor(currentYear / 100) * 100 + Number(rfc850[3]);
    const yearDelta = year - currentYear;
    const candidateTimeOfYear = Date.UTC(
      2000, month, Number(rfc850[1]),
      Number(rfc850[4]), Number(rfc850[5]), Number(rfc850[6]),
    );
    const currentTimeOfYear = Date.UTC(
      2000, current.getUTCMonth(), current.getUTCDate(),
      current.getUTCHours(), current.getUTCMinutes(), current.getUTCSeconds(),
      current.getUTCMilliseconds(),
    );
    if (yearDelta < -50 || (yearDelta === -50 && candidateTimeOfYear < currentTimeOfYear)) {
      year += 100;
    } else if (yearDelta > 50 || (yearDelta === 50 && candidateTimeOfYear > currentTimeOfYear)) {
      year -= 100;
    }
    return parseUtcDateParts(
      year, rfc850[2]!, Number(rfc850[1]),
      Number(rfc850[4]), Number(rfc850[5]), Number(rfc850[6]),
    );
  }
  const asctime = ASCTIME_DATE_RE.exec(value);
  if (!asctime) return undefined;
  return parseUtcDateParts(
    Number(asctime[6]), asctime[1]!, Number(asctime[2]),
    Number(asctime[3]), Number(asctime[4]), Number(asctime[5]),
  );
}

function parseRetryAfterMsWithLimit(
  value: string | null | undefined,
  now: number,
  maxMs: number,
  options?: { preserveImmediate?: boolean },
): number | undefined {
  const text = value?.trim();
  if (!text) return undefined;
  if (/^\d+(?:\.\d+)?$/.test(text)) {
    const seconds = Number(text);
    if (
      Number.isFinite(seconds)
      && (seconds > 0 || (options?.preserveImmediate && seconds === 0))
    ) {
      return Math.min(Math.max(Math.ceil(seconds * 1000), 1), maxMs);
    }
  }
  const timestamp = parseHttpDate(text, now);
  if (timestamp === undefined) return undefined;
  const delay = timestamp - now;
  if (delay > 0) return Math.min(delay, maxMs);
  return options?.preserveImmediate ? 1 : undefined;
}

export function parseRetryAfterMs(
  value: string | null | undefined,
  now = Date.now(),
  options?: { preserveImmediate?: boolean },
): number | undefined {
  return parseRetryAfterMsWithLimit(value, now, MAX_COOLDOWN_MS, options);
}

function parseQuotaResetHintMs(message: string): number | undefined {
  const match = /\bresets?\s+in\s+((?:\d+(?:\.\d+)?\s*(?:days?|hours?|hrs?|minutes?|mins?|seconds?|secs?)\s*){1,4})/i.exec(message);
  if (!match?.[1]) return undefined;
  const unitMs: Record<string, number> = {
    day: 86_400_000, days: 86_400_000,
    hour: 3_600_000, hours: 3_600_000, hr: 3_600_000, hrs: 3_600_000,
    minute: 60_000, minutes: 60_000, min: 60_000, mins: 60_000,
    second: 1_000, seconds: 1_000, sec: 1_000, secs: 1_000,
  };
  let total = 0;
  const parts = match[1].matchAll(/(\d+(?:\.\d+)?)\s*(days?|hours?|hrs?|minutes?|mins?|seconds?|secs?)/gi);
  for (const part of parts) {
    const value = Number(part[1]);
    const unit = unitMs[part[2]!.toLowerCase()];
    if (!Number.isFinite(value) || value < 0 || unit === undefined) return undefined;
    total += value * unit;
  }
  if (!Number.isFinite(total) || total <= 0) return undefined;
  return Math.min(Math.ceil(total), MAX_QUOTA_COOLDOWN_MS);
}

function isDurableQuotaFailure(
  status: number | undefined,
  message: string,
  code?: string | null,
): boolean {
  return isProviderScopedQuotaCap(status, message, code)
    || QUOTA_LIMIT_CODES.has(normalizedFailureCode(code));
}

export function knownComboFailureRecoveryMs(input: {
  retryAfter?: string | null;
  status?: number;
  code?: string | null;
  message?: string;
  now?: number;
}): number | undefined {
  const now = input.now ?? Date.now();
  const durableQuota = isDurableQuotaFailure(input.status, input.message ?? "", input.code);
  const maxMs = durableQuota ? MAX_QUOTA_COOLDOWN_MS : MAX_COOLDOWN_MS;
  return parseRetryAfterMsWithLimit(input.retryAfter, now, maxMs)
    ?? (durableQuota ? parseQuotaResetHintMs(input.message ?? "") : undefined);
}

export function isComboTargetInCooldown(
  comboId: string,
  target: Pick<OcxComboTarget, "provider" | "model">,
  now = Date.now(),
): boolean {
  const providerKey = providerCooldownMapKey(target.provider);
  const providerEntry = targetCooldowns.get(providerKey);
  if (providerEntry) {
    if (providerEntry.cooldownUntil > now) return true;
    targetCooldowns.delete(providerKey);
    if (persistedQuotaCooldownKeys.delete(providerKey)) scheduleQuotaCooldownPersistence();
  }

  const key = cooldownMapKey(comboId, target);
  const entry = targetCooldowns.get(key);
  if (!entry) return false;
  if (entry.cooldownUntil <= now) {
    targetCooldowns.delete(key);
    if (persistedQuotaCooldownKeys.delete(key)) scheduleQuotaCooldownPersistence();
    return false;
  }
  return true;
}

export function isTransientRequestRateLimit(input: {
  status?: number;
  code?: string | null;
  message?: string;
}): boolean {
  if (isProviderScopedQuotaCap(input.status, input.message ?? "", input.code)) return false;
  const code = (input.code ?? "").trim().toLowerCase().replaceAll("-", "_");
  if (QUOTA_LIMIT_CODES.has(code)) return false;
  if (TRANSIENT_REQUEST_RATE_CODES.has(code)) return true;
  const text = (input.message ?? "").toLowerCase();
  if (
    text.includes("usage limit reached")
    || text.includes("insufficient_quota")
    || text.includes("quota exhausted")
  ) {
    return false;
  }
  return text.includes("rate limit reached for requests");
}

export function remainingComboCooldownMs(
  comboId: string,
  now = Date.now(),
  providers?: Iterable<string>,
): number | undefined {
  const prefix = `${comboId}\0`;
  const providerSet = providers === undefined ? undefined : new Set(providers);
  let soonest: number | undefined;
  for (const [key, cooldown] of targetCooldowns) {
    const comboLocal = key.startsWith(prefix);
    const providerGlobal = providerSet !== undefined
      && key.startsWith(PROVIDER_COOLDOWN_PREFIX)
      && providerSet.has(key.slice(PROVIDER_COOLDOWN_PREFIX.length));
    if (!comboLocal && !providerGlobal) continue;
    const remaining = cooldown.cooldownUntil - now;
    if (remaining <= 0) {
      targetCooldowns.delete(key);
      if (persistedQuotaCooldownKeys.delete(key)) scheduleQuotaCooldownPersistence();
      continue;
    }
    if (soonest === undefined || remaining < soonest) soonest = remaining;
  }
  return soonest;
}

export function comboCooldownRetryAfterSeconds(
  comboId: string,
  now = Date.now(),
  providers?: Iterable<string>,
): string | undefined {
  const remainingMs = remainingComboCooldownMs(comboId, now, providers);
  if (remainingMs === undefined) return undefined;
  return String(Math.max(1, Math.ceil(remainingMs / 1000)));
}

export function coolComboProvider(
  provider: string,
  options?: {
    retryAfter?: string | null;
    now?: number;
    cooldownMs?: number;
    writerGeneration?: number;
    status?: number;
    code?: string | null;
    message?: string;
  },
): void {
  const now = options?.now ?? Date.now();
  const writerGeneration = options?.writerGeneration ?? captureConfigGeneration();
  if (writerGeneration < lastReconciledGeneration && !liveProviders.has(provider)) return;
  const durableQuota = isDurableQuotaFailure(
    options?.status,
    options?.message ?? "",
    options?.code,
  );
  const maxCooldownMs = durableQuota ? MAX_QUOTA_COOLDOWN_MS : MAX_COOLDOWN_MS;
  const cooldownMs = options?.cooldownMs
    ?? knownComboFailureRecoveryMs({
      retryAfter: options?.retryAfter,
      status: options?.status,
      code: options?.code,
      message: options?.message,
      now,
    })
    ?? (isTransientRequestRateLimit({
      status: options?.status,
      code: options?.code,
      message: options?.message,
    }) ? COMBO_REQUEST_RATE_COOLDOWN_MS : DEFAULT_COOLDOWN_MS);
  const key = providerCooldownMapKey(provider);
  const cooldownUntil = now + Math.min(Math.max(cooldownMs, 1), maxCooldownMs);
  targetCooldowns.set(key, { cooldownUntil });
  const durableLongQuota = durableQuota && cooldownUntil - now > MAX_COOLDOWN_MS;
  const persistenceChanged = durableLongQuota
    ? (persistedQuotaCooldownKeys.add(key), true)
    : persistedQuotaCooldownKeys.delete(key);
  if (persistenceChanged) scheduleQuotaCooldownPersistence();
  sweepExpiredOnWrite(now);
}

export function coolComboTarget(
  comboId: string,
  target: Pick<OcxComboTarget, "provider" | "model">,
  options?: {
    retryAfter?: string | null;
    now?: number;
    cooldownMs?: number;
    writerGeneration?: number;
    status?: number;
    code?: string | null;
    message?: string;
  },
): void {
  const now = options?.now ?? Date.now();
  const writerGeneration = options?.writerGeneration ?? captureConfigGeneration();
  const ownerKey = `${comboId}::${targetKey(target)}`;
  if (writerGeneration < lastReconciledGeneration && !liveComboTargets.has(ownerKey)) return;
  const durableQuota = isDurableQuotaFailure(
    options?.status,
    options?.message ?? "",
    options?.code,
  );
  const maxCooldownMs = durableQuota ? MAX_QUOTA_COOLDOWN_MS : MAX_COOLDOWN_MS;
  const cooldownMs = options?.cooldownMs
    ?? knownComboFailureRecoveryMs({
      retryAfter: options?.retryAfter,
      status: options?.status,
      code: options?.code,
      message: options?.message,
      now,
    })
    ?? (isTransientRequestRateLimit({
      status: options?.status,
      code: options?.code,
      message: options?.message,
    }) ? COMBO_REQUEST_RATE_COOLDOWN_MS : DEFAULT_COOLDOWN_MS);
  const key = cooldownMapKey(comboId, target);
  const cooldownUntil = now + Math.min(Math.max(cooldownMs, 1), maxCooldownMs);
  targetCooldowns.set(key, { cooldownUntil });
  const durableLongQuota = durableQuota && cooldownUntil - now > MAX_COOLDOWN_MS;
  const persistenceChanged = durableLongQuota
    ? (persistedQuotaCooldownKeys.add(key), true)
    : persistedQuotaCooldownKeys.delete(key);
  if (persistenceChanged) scheduleQuotaCooldownPersistence();
  sweepExpiredOnWrite(now);
}

export function reconcileComboTargetCooldowns(context: GenerationContext): number {
  if (context.generation <= lastReconciledGeneration) return 0;
  let removed = 0;
  let persistenceChanged = false;
  for (const key of targetCooldowns.keys()) {
    let live = false;
    if (key.startsWith(PROVIDER_COOLDOWN_PREFIX)) {
      live = context.providerNames.has(key.slice(PROVIDER_COOLDOWN_PREFIX.length));
    } else {
      const separator = key.indexOf("\0");
      if (separator >= 0) {
        const ownerKey = `${key.slice(0, separator)}::${key.slice(separator + 1)}`;
        live = context.comboTargets.has(ownerKey);
      }
    }
    if (live) continue;
    targetCooldowns.delete(key);
    if (persistedQuotaCooldownKeys.delete(key)) persistenceChanged = true;
    removed += 1;
  }
  if (persistenceChanged) scheduleQuotaCooldownPersistence();
  liveComboTargets = new Set(context.comboTargets);
  liveProviders = new Set(context.providerNames);
  lastReconciledGeneration = context.generation;
  return removed;
}

export function sweepExpiredComboTargetCooldowns(now = Date.now()): number {
  let removed = 0;
  for (const [key, cooldown] of targetCooldowns) {
    if (cooldown.cooldownUntil > now) continue;
    targetCooldowns.delete(key);
    if (persistedQuotaCooldownKeys.delete(key)) scheduleQuotaCooldownPersistence();
    removed += 1;
  }
  return removed;
}

export function clearComboTargetCooldowns(comboId?: string): void {
  if (comboId === undefined) {
    targetCooldowns.clear();
    const persistenceChanged = persistedQuotaCooldownKeys.size > 0;
    persistedQuotaCooldownKeys.clear();
    if (persistenceChanged) scheduleQuotaCooldownPersistence();
    liveComboTargets.clear();
    liveProviders.clear();
    lastReconciledGeneration = 0;
    return;
  }
  const prefix = `${comboId}\0`;
  let persistenceChanged = false;
  for (const key of targetCooldowns.keys()) {
    if (!key.startsWith(prefix)) continue;
    targetCooldowns.delete(key);
    if (persistedQuotaCooldownKeys.delete(key)) persistenceChanged = true;
  }
  if (persistenceChanged) scheduleQuotaCooldownPersistence();
}

export type ComboFailureDecision = "hop" | "stop";
export type ComboFailureCooldownScope = "none" | "target" | "provider";

function normalizedFailureCode(code?: string | null): string {
  return code?.trim().toLowerCase().replaceAll("-", "_") ?? "";
}

function isProviderScopedQuotaCap(
  status: number | undefined,
  message: string,
  code?: string | null,
): boolean {
  const normalizedCode = normalizedFailureCode(code);
  const text = message.toLowerCase();
  if (
    status === 429
    && (normalizedCode === "gousagelimiterror" || text.includes("monthly usage limit reached"))
  ) {
    return true;
  }
  return normalizedCode === "free_rate_limited"
    || text.includes("err_free_prompt_cap")
    || (text.includes("free tier") && text.includes("single request"));
}

export function comboFailureCooldownScope(
  status: number,
  message: string,
  options?: { code?: string | null },
): ComboFailureCooldownScope {
  const code = normalizedFailureCode(options?.code);
  const text = message.toLowerCase();
  // Request-shape limits must exclude only this attempt. Cooling the provider globally would
  // make an unrelated shorter/simpler request skip a provider that is still healthy.
  if (
    code === "free_rate_limited"
    || text.includes("err_free_prompt_cap")
    || [
      "input_admission_refused",
      "context_length_exceeded",
      "tool_catalog_too_large",
      "cursor_root_envelope_limit",
      "target_incompatible",
    ].includes(code)
    || status === 413
  ) return "none";
  if (isProviderScopedQuotaCap(status, message, code)) return "provider";
  if (status === 401 || status === 402 || status === 403) return "provider";
  if ([
    "invalid_api_key",
    "insufficient_quota",
    "subscription_required",
    "payment_required",
    "billing_error",
    "insufficient_balance",
    "provider_unavailable",
  ].includes(code)) return "provider";
  return "target";
}

function isModelLifecycleGone(
  status: number,
  message: string,
  code?: string | null,
): boolean {
  if (status !== 410) return false;
  const normalizedCode = code?.trim().toLowerCase().replaceAll("-", "_");
  if ([
    "model_deprecated",
    "model_end_of_life",
    "model_eol",
    "model_not_found",
    "model_retired",
  ].includes(normalizedCode ?? "")) return true;
  const text = message.toLowerCase();
  return /\bmodel\b/.test(text) && (
    /\bend[ -]of[ -]life\b/.test(text)
    || /\bno longer available\b/.test(text)
    || /\b(?:deprecated|retired|retirement|sunset|decommissioned)\b/.test(text)
  );
}

export function comboFailureDecision(
  status: number,
  message: string,
  options?: { code?: string | null },
): ComboFailureDecision {
  if (status === 499) return "stop";
  if (message.toLowerCase().includes("origin_rejected")) return "stop";
  // Cyber policy is a hard non-retryable refusal — honor structured code even when
  // classificationText was truncated before the JSON code field.
  if (isCyberPolicyCode(options?.code)) return "stop";
  // HTTP 410 is normally terminal. A model-specific lifecycle verdict is target-local,
  // however: another provider/model in the declared combo can still serve the request.
  // Require structured lifecycle code or explicit model+lifecycle prose so unrelated
  // application-level 410 responses remain fail-closed.
  if (isModelLifecycleGone(status, message, options?.code)) return "hop";
  const error = classifyError(status, "upstream_error", message);
  if (isCyberPolicyCode(error.code)) return "stop";
  // A local input-admission refusal (#1524) says "this candidate cannot fit the request",
  // not "the request is impossible": the next candidate may have a larger context window.
  //
  // This MUST be tested before the generic stop list below. Our own refusal message says
  // "context window" -- that is what it refuses on -- and the classifier remaps that phrase,
  // so checking the stop list first swallowed the signal and ended the chain. An UPSTREAM
  // `context_length_exceeded` carries no admission code and still falls through to stop.
  //
  // Matched on the STRUCTURED code only, which classifyError now preserves for our own
  // refusal. A raw substring test would additionally let any upstream override a terminal
  // verdict by echoing the token in prose we do not control.
  //
  // Precise about what this is NOT: an upstream can still SET this code deliberately, since
  // both extractors read the upstream error object. That is bounded rather than dangerous --
  // an upstream already controls other hop signals (429, 5xx), and traversal is finite: policy
  // tries each candidate once via `tried`, and combo excludes each attempted target. So this is
  // structured-code-only, not provably local.
  const failureCode = normalizedFailureCode(options?.code || error.code);
  const targetLocalCodes = new Set([
    "input_admission_refused",
    "context_length_exceeded",
    "tool_catalog_too_large",
    "cursor_root_envelope_limit",
    "kiro_profile_required",
    "target_incompatible",
    "model_not_found",
    "model_unavailable",
    "unsupported_model",
  ]);
  if (targetLocalCodes.has(failureCode)) return "hop";
  const lowerMessage = message.toLowerCase();
  if (/\b(?:model not found|model unavailable|unsupported model)\b/.test(lowerMessage)) return "hop";
  if (isProviderScopedQuotaCap(status, message, failureCode)) return "hop";
  if ([
    "permission_denied",
    "subscription_required",
    "invalid_api_key",
    "insufficient_quota",
    "payment_required",
    "billing_error",
    "insufficient_balance",
    "rate_limit_exceeded",
    "server_is_overloaded",
    "upstream_server_error",
    "provider_unavailable",
  ].includes(failureCode)) return "hop";
  if ([401, 402, 403, 404, 408, 410, 413, 425, 429].includes(status) || status >= 500) return "hop";
  if (["origin_rejected", "invalid_request_error"].includes(error.code ?? "")) return "stop";
  return "stop";
}
