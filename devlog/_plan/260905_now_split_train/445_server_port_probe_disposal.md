# 445 — Runtime verification prerequisite

## Scope and workflow

C3 independent runtime-maintenance prerequisite for the modularization train.
PR #3640 uses branch `codex/fix-port-probe-peer-disposal`, base `dev`.
Its production and test diff is the review surface. Investigation, negative
controls, failure analysis and reproduction records remain in ignored scratch,
not public devlog. Publication of the final retrospective waits for release.

Bound session: `01a06e97-b9d8-7250-8204-bb788338c288`; same a2c0 checkout
owns implementation, persisted PABCD and receipts. Main owns Git/PR/CI.
Delegation uses gpt-6-astra high with disjoint source/test ownership.
No merge, release, live-service change or repository-wide setting change.

## Planned files and acceptance

- `src/server/ports.ts`: bounded existing-owner maintenance; preserve public
  exports, caller interfaces, error handling and selection policies.
- `tests/server/ports.test.ts`: scoped regression coverage; preserve the
  original test cases and isolate test doubles from the parent process.
- `structure/01_runtime.md`: ownership row only.
- This public scope record and the carried000/003 workflow documents.

Keep source/tests below400lines and added functions below50lines. Do not
weaken assertions, alter verification thresholds or mark a failed check passed.

All runtime verification is remote. Use the reviewed source-bound receipt
recipe stored in ignored evidence: check clean expected HEAD before/after
SSH, create a fresh isolated clone, match fetched branch SHA, frozen dependency
setup, explicit package Bun1.4.0, build, typecheck, focused subsystem/boundary
tests, privacy, full suite, and final clean HEAD. Preserve full output and
actual exits. No local suites or typecheck; no shared-checkout reset.

Independent review, exact-head remote gates and hosted CI must pass. A prior
head's results do not establish a later head. Detailed verification records
are kept with private receipt evidence; no completion is inferred from a plan.

## Continuation and coordination

This work does not close a modularization ledger row. D resumes suspended
WP450 for its own P/A, restack and fresh verification; do not count it done.
PR #3633 remains independent until that controlled restack is performed.

The user requires conversational one-at-a-time non-Windows CI coordination.
Windows-owner work remains excluded. Changes that start CI, including pushes,
retargeting and landing, require the scheduled slot. Code/static review may
continue while waiting. Scope authority is already granted; a queue wait is
not a request for more user permission.

## Review disposition

A reviewer identified that the previous version mixed investigation records
with this public scope document. Those details were moved to ignored scratch
and removed from the current public document. Earlier published commits may
still be accessible; this change is not a history-purge claim. The actual
source/test review and all verification requirements remain unchanged.
