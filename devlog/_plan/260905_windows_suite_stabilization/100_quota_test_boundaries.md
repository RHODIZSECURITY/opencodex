# 100 — Portable quota child processes and bounded fixture setup

Class C3 after the quota route-registration finding; spec-satisfaction repair.
Trigger: run 33941712300 jobs 101240599941
and 101240599984. Goal: preserve cold-process/durable-restart and hard-cap
assertions on Windows. Non-goals: production store changes, larger timeouts,
skips, retries, ACL bypasses. Owner: main; agents read-only unless the plan is
amended. Stop on contrary child stderr or changed store semantics and re-plan.

## MODIFY tests/usage/quota-reset-seen-store.test.ts

At the real-second-process test, replace the URL pathname with a native path:

```diff
+import { fileURLToPath } from "node:url";
-const storeUrl = new URL("../../src/quota/reset-seen-store.ts", import.meta.url).pathname;
+const storeUrl = fileURLToPath(new URL("../../src/quota/reset-seen-store.ts", import.meta.url));
-const proc = Bun.spawn(["bun", script], {
+const proc = Bun.spawn([process.execPath, script], {
```

Keep JSON.stringify around the generated import path. Replace stdout-only wait
with Promise.all of proc.exited, stdout.text and stderr.text; assert exitCode=0
with stdout/stderr in the assertion message, then return trimmed stdout. Keep
the sequential true/false assertions and OPENCODEX_HOME unchanged.

Replace the 2000-call hard-ceiling setup with this boundary probe (no mock):

```ts
const now = Date.now();
const future = now + 365 * DAY;
const path = join(getConfigDir(), "quota-reset-state.json");
const seeded = Object.fromEntries(Array.from({ length: 1_023 }, (_, index) => [
  `live-${index}`, { at: now, resetAt: future + index },
]));
writeFileSync(path, JSON.stringify({ version: 1, claims: seeded, events: [] }));
resetQuotaResetStoreForTests();
expect(claimCountForTests()).toBe(1_023);
expect(claimQuotaReset("boundary", now, future + 1_023)).toBe(true);
expect(claimCountForTests()).toBe(1_024);
expect(claimQuotaReset("nearer", now, future - 1)).toBe(true);
expect(claimCountForTests()).toBe(1_024);
expect(hasSeenQuotaReset("boundary")).toBe(false);
const expected = { ...seeded, nearer: { at: now, resetAt: future - 1 } };
expect(JSON.parse(readFileSync(path, "utf8")).claims).toEqual(expected);
expect(claimQuotaReset("furthest", now, future + 2_000)).toBe(false);
expect(hasSeenQuotaReset("furthest")).toBe(false);
expect(claimCountForTests()).toBe(1_024);
expect(JSON.parse(readFileSync(path, "utf8")).claims).toEqual(expected);
resetQuotaResetStoreForTests();
expect(claimCountForTests()).toBe(1_024);
expect(hasSeenQuotaReset("nearer")).toBe(true);
expect(hasSeenQuotaReset("boundary")).toBe(false);
expect(hasSeenQuotaReset("furthest")).toBe(false);
```

Hydration does not prune. Only a real insertion crosses 1024; the future dates
exclude age/settled pruning. Disabling insertion's prune must fail at 1025.
Disk equality and rehydration prove the retained claim is persisted, not merely
left in memory. This replaces 1024 setup writes with two production writes.

## MODIFY tests/usage/quota-reset-observation.test.ts

Add fileURLToPath import, wrap the existing helper URL with it, and spawn with
process.execPath. Collect exit/stdout/stderr concurrently and include stderr in
the zero-exit assertion. Keep the fresh child home and empty-event assertion.
Clean that private temp home only after the child exits, using the existing
test cleanup helper if teardown is added. No helper source change.

## Acceptance and verification

- Focused command: `bun test tests/usage/quota-reset-seen-store.test.ts tests/usage/quota-reset-observation.test.ts`.
- Typecheck: `bun run typecheck`. No local full suite.
- Original Windows red is captured in 009.1. Final integration uses existing
  ci.yml workflow_dispatch lane=all on a fixed task branch, never a moving dev ref.
- Mutant: temporarily omit claimQuotaReset's prune call; run only the hard-cap
  case, require failure at 1025, then restore source exactly. This is a local
  focused test, not a full suite. No mutant is committed or pushed.
- The initial test-only slice leaves store/schema untouched; the amendment below
  also repairs existing route/capability inventories and their generated reference. Existing
  corpus case covers the path issue; add this occurrence only after Windows proof.
- Verifiers name direct files and the production prune owner. CI commands were
  observed in the baseline logs; local focused command is executed during B/C.

## Quota integration inventory amendment (same newly merged feature)

Windows job101240600060 also fails management-route-registry reconciliation:
GET /api/quota-resets is absent; the dispatcher wrapper is unresolved. This is
platform-independent integration debt introduced with quota reset, not an OS
timing defect. The route and CLI implementation already exist. Extend wp8's
scope to the following four metadata/dispatch/derived-reference files; no
store, authentication, authorization or handler behavior changes.

MODIFY `src/server/management/route-registry.ts`: add beside the negated routes:

```ts
{ method: "GET", path: "/api/quota-resets", module: "server/management/quota-reset-routes", mutates: false, mechanism: "negated-guard" },
```

MODIFY `src/server/management-api.ts`: use the existing lazy namespace mount
pattern (routing profiles and Lab use the same helper):

```diff
-if (ctx.url.pathname !== "/api/quota-resets") return null;
+if (!pathInManagementNamespace(ctx.url.pathname, "/api/quota-resets")) return null;
```

The real handler keeps exact path and GET guards. Child paths now import that
handler before falling through; prefix collisions still do not load it. This
small lazy-load scope change is explicit, not disguised as no behavior change.
No route scanner exemption, duplicate owner entry, or assumed method is added.

MODIFY `src/cli/capabilities.ts`: declare the already-implemented command:

```ts
{
  command: ["provider", "resets"],
  summary: "Show recently detected quota resets.",
  routes: [{ method: "GET", path: "/api/quota-resets" }],
  flags: [
    { name: "--limit", value: "number", summary: "Maximum events to return." },
    { name: "--json", value: "boolean", summary: "Emit the API payload as JSON." },
  ],
  mutates: false,
  json: "payload",
},
```

MODIFY `skills/ocx/references/01_management_surface.md` mechanically via
`bun run skill:surface`, which renders the capability registry. No new command
implementation and no CLI-parity exemption: provider-runtime.ts already sends
the request. The value chain is declaration -> capability consumers and surface
renderer -> generated Markdown checked by skill-ocx.test.ts; no new type/enum.

Extra focused verification: management-route-registry.test.ts,
cli-capabilities.test.ts, skill-ocx.test.ts, quota-reset-notify.test.ts,
quota-reset-core-boundary.test.ts. Check exact GET, invalid limit, non-GET,
child path, prefix collision and lazy core boundary. Audit the dispatch diff
explicitly for auth bypass/import exposure; no workflow changes are planned.

## Roadmap audit

Independent gpt-6-astra/high reviewer: VERDICT PASS; no blocking issues. Auth
precedes dispatch; child/prefix fallthrough and the inert registry stay intact.
Main baseline focused registry+capability check: 27 pass / 3 fail (registry
reconciliation only), exit 1, matching Windows. This approves the design, not
implementation. The two superseded scope descriptions were synchronized.
