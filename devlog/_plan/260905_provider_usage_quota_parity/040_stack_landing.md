# Verified bottom-up stack landing

Depends on all implementation layers. Execute as `landing`; no production patch planned.
Inherit resource/scope limits from 000. User explicitly authorizes no-verify pushes and admin merges only after CI succeeds.

## Actions

1. Inspect `git status --short`, `git worktree list`, each branch tip and `gh pr view --json headRefOid,baseRefName,statusCheckRollup,reviewDecision,mergeStateStatus`.
2. Inspect exact-head CI via `gh run list --commit <sha>` and failed job logs when necessary. An empty required-check list is not proof. Resolve correct review findings without suppressing tests.
3. Ensure every PR includes Summary, Verification and Checklist, a linked stack map, explicit no-local-suite note, and UI screenshot for UI changes. Record admin bypass authorization in the PR description.
4. Merge the bottom PR only when its exact head has successful full CI; prefer `gh pr merge --admin --merge --match-head-commit <sha>` to preserve stack ancestry. Do not delete lower branches.
5. Retarget the next child to `dev`; refresh checks at its exact head/base. If ancestry reconstruction is necessary, use only session-owned branches with clean working state, record parent and child commits, cascade all upper layers and use `--force-with-lease --no-verify`; no destructive worktree operations.
6. After each merge, `git fetch origin dev` then `git merge-base --is-ancestor <merge-sha> FETCH_HEAD`. Record PR, CI head, merge SHA and ancestry outcome in `041_delivery.md`.
7. Archive the completed unit from `_plan` to `_fin` only as an explicit final documented source change with its own remote checks if it alters a pending PR. Otherwise retain a terminal closure record without inventing extra unverified commits.

## Completion evidence

All exact-head CI jobs passed, original symptom and quota state matrix observed, no user history modified, no live service restarted, no local suite executed, every authorized stack layer on fetched dev. Final report distinguishes repository delivery from runtime deployment.

## Verifier and terminal conditions

Pre-merge review remediation: preserve the rejected selector in Chat/Messages early 404 logs
(`src/server/{chat-completions,claude-messages}.ts` and the existing policy surface regression),
and use null-prototype provider-keyed accumulators in the provider workspace with `__proto__`
and `constructor` regression rows. Record final roadmap audit closure and clearly mark the
superseded global-scheduler design in020. These remain the attribution layer's thesis; amend
the bottom branch, cascade every upper branch before pushing, then require renewed exact-head
CI. Credential-reader redirect controls belong to the already implemented API layer, not to
the attribution layer's executable scope.

Freeze the integration baseline at fetched `dev`55395a9dc. It adds Antigravity weekly and
Ollama Cloud quota support during this task. Preserve both implementations and the optional
reset observer while merging the baseline into the stack. Resolve the quota dispatch conflict
by retaining the shared key-reader selector and registering the incoming canonical Ollama
reader there; add a per-key Ollama regression. All layers must receive the integrated baseline
before publication and new exact-head CI. Do not chase unrelated later changes without a
concrete integration conflict or verifier requirement.

The integrated baseline's remote CI exposed three concrete quota-reset contract gaps:
an undeclared management route/lazy dispatch guard, a strict expected quota shape missing
`shortObservedAt`, and an HTTP webhook fixture rejected by the existing HTTPS schema.
Repair these integration gates in the bottom layer and cascade both children. Register the
existing `provider resets` command and route without an exemption, retain exact quota
assertions, and bridge only the test's HTTPS transport to its local receiver. Do not relax
HTTPS/SSRF protections or run local validation. Kant independently reviewed both the two-test
delta and the four-file route/capability delta: PASS, including explicit security review
of unchanged authentication, exact inner method/path guards and lazy imports. All three
new heads still require remote CI.

Concrete follow-on conflict: upstream PR #3622 landed the same quota-reset integration repairs,
followed by #3623's update-test diagnostic change, at `dev`1c1ca060a. Preserve both commits.
Use upstream's route/capability declarations and generated reference verbatim; retain this
unit's stricter observation-time and HTTPS-transport/privacy assertions without duplicate
properties or fixtures. This conflict resolution, not unrelated base chasing, advances the
frozen baseline. Cascade every child and require fresh exact-head CI.

CLI GitHub reads are bounded, at most one fresh rollup per meaningful head/state change. Capture C receipt using the exact-head CI verification command. DONE only with all ancestry proofs; wait for pending CI using bounded polling, never call pending CI a blocker.
