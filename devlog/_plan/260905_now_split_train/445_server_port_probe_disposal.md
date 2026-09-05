# 445 — Temporary port-probe peer disposal

## Loop spec and authority

C3 bounded behavior-fix prerequisite, separate from pure-move WP450. User
authorization covers scoped verification repairs and stacked PR maintenance;
local suites remain prohibited. Work stays in the bound a2c0 checkout, on
`codex/fix-port-probe-peer-disposal`, base `dev` at
`a687eb735afc7307f902816972c2f8fb522ed2f3`. Main owns Git/FSM/remote checks;
gpt-6-astra high workers have bounded file ownership. No merges, deployment,
live proxy changes, dependency installation outside isolated remote checkouts,
credential changes, or unrelated cleanup work. Time/tokens are user-unbounded;
individual subprocesses and probes remain bounded.

Stop only when this repair has a reviewed PR, exact-head remote gates and CI
evidence. Then D returns to the suspended WP450 for its own re-plan/restack and
fresh verification. Its existing acceptance criteria are unchanged. Source
and receipt identity remain in the same checkout throughout each cycle.

## Problem and evidence

Both temporary TCP servers in `src/server/ports.ts` wait for `server.close()`
before resolving, but neither disposes connections accepted during the brief
bind probe. These listeners are not application servers and have no request
handler. An accepted peer can therefore hold selection open before startup
publishes runtime records.

Remote experiment on Bun1.4.0, unchanged actual CI merge tree: a concurrent
TCP peer held `isPortAvailable()` for2s; closing only that peer released the
promise. A second experiment used aborting HTTP readiness requests: after5s
all fetches had settled, yet the probe remained pending another2s. The
experiments establish the socket-lifetime defect. They do not alone prove
that every historical CI recovery failure has the same cause.

Competing hypotheses: H1 pre-bind wait; H2 early runtime failure with retained
handles; H3 probe/environment mismatch. The controlled peer-close toggle
rules out bind contention/permissions and runtime startup code for this
specific reproduction. The HTTP variant demonstrates that client abort is
not sufficient disposal. The prior CI instance has no live stack, so its
precise attribution remains unconfirmed until further evidence.

Unchanged head and CI merge-tree singleton/batch controls passed. Even the
complete original CI shard4/4 passed remotely with Bun1.4.0, isolate mode,
GUI built, and two-core affinity. This does not erase the failed hosted job.

## Search, ownership, and rejected alternatives

Main read the complete163-line ports module, its existing tests, reclaim
caller, and startup selection path. `isPortAvailable` is the primitive used
by availability/reclaim; `allocateEphemeralPort` repeats the same temporary
server lifetime for port0. Existing `setEphemeralPortAllocatorForTests`
bypasses the affected implementation and is unsuitable for regression proof.

Keep this resource lifecycle in its existing owner; no new module, dependency,
export, global setter, timer, socket registry, or cycle. Do not change retry
deadlines, bind-error interpretation, ephemeral fallback policy, or reserved
port handling. Premature resolve, `unref`, `end`, and a timeout race leave the
resource problem intact and are rejected. Fix both same-owner instances, not
the downstream recovery assertion. Recovery fixture cleanup is separate debt.

## Exact implementation scope

- MODIFY `src/server/ports.ts`: add a small private temporary-server factory
  (under15lines) whose connection listener is installed before listen. It
  registers a narrow socket-error disposal handler and immediately destroys
  each accepted socket. Use it at the two existing `createServer()` sites.
  Keep success inside the real server-close callback and preserve all existing
  signatures, bind-error handlers, and caller behavior.
- MODIFY `tests/server/ports.test.ts`: retain all original assertions. Add
  deterministic subprocess-isolated regression coverage of the real
  `isPortAvailable(port)` and `findAvailablePort(0)` implementations. Inside
  each disposable test subprocess, a `node:net` server-factory double delivers
  two accepted peers and only completes close after both are destroyed. Check
  socket error disposal, close-completion-before-result, and the independently
  specified selected port. Never mock `node:net` in the parent test process.
  Resolve source through `tests/helpers/repo-root.ts`; no new test file.
- MODIFY `structure/01_runtime.md`: add one ownership row describing temporary
  port-probe socket disposal; no authentication or server-composition changes.
- This plan and carried000/003 are the only other tracked changes.

Expected source change under25lines; test amendment under120lines; each file
remains below400lines. Main owns docs/SoT; worker owns only source/test files.
Any additional behavior or broader cleanup requires a separate P amendment.

## Audit and verification

Independent A review must verify both affected call sites, safe disposal before
listen, no premature close success, regression isolation, unchanged exports,
and exact scoped writes. An operational review checks the scheduling amendment:
new445before450,450suspendedpending with all evidence/criteria preserved.

Before code change, run the new regression remotely against unchanged source
and require failure in both paths. After correction require green. Revert only
disposal in a disposable remote clone and require the regression to fail again;
restore before final checks. Run the real socket and aborted-fetch experiments
against the corrected source; they must terminate without client cooperation.
Local inspection may use diff/AST/bash syntax only, never local tests/typecheck.

Final remote recipe follows003 and the already-reviewed WP450 recipe, with
this branch and explicit package Bun1.4.0 on PATH. From clean published head,
`cxc receipt test` must wrap local head/clean checks before and after SSH.
SSH creates a new `mktemp -d` clone; fetch/match the exact branch SHA; frozen
root+GUI install; build GUI; run typecheck; run focused
`tests/server/ports.test.ts`, `tests/server/port-reclaim.test.ts`,
`tests/update/update-stop-first.test.ts`, and
`tests/lab/core-lab-boundary.test.ts`; privacy; full `bun run test`; and final
HEAD/clean checks. Propagate all exits and preserve complete output. The
executable recipe is written and syntax-reviewed before A closes.

Acceptance: deterministic red/green/revert-red; real peer experiments settle;
all named focused checks, typecheck/privacy/full suite exit0; unchanged public
API and ownership boundary; independent C review; exact-head CI green; PR open
with every template section and actual evidence. Never count this support
repair as resolving another modularization ledger row.

## Stack map

| Layer | Branch | Base | Scope |
|---|---|---|---|
| WP450 / PR3633 | codex/split-cli-status | this repair after rebase | original pure-move status extraction only |
| WP445 / PR pending | codex/fix-port-probe-peer-disposal | dev | temporary probe peer disposal only |

Keep parent open until its child is retargeted appropriately; no merge is
authorized. WP450 needs fresh head-bound evidence after restacking. The old
4a71894 receipt remains historical proof, not the new head's acceptance.
