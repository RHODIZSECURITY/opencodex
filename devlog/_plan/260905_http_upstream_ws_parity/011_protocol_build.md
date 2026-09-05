# Protocol build evidence

The protocol slice is implemented; connection reuse remains the separate 020 cycle.

## Changes

- `src/codex/forward-transport-headers.ts`: one pure Lite/hint owner. Main checked the actual upstream formatter and corrected the worker's initial `;service_tier=` spelling to the native `;tier=` grammar before integration.
- `src/server/responses/codex-ws-request.ts`: copied canonical frame preparation and independent HTTP fallback init; Lite explicit-header precedence and final hint derivation do not mutate caller input.
- `src/adapters/openai-responses.ts`: canonical Lite forwarding and finalized-body routing hint; other destinations keep their own headers.
- `src/server/safe-response-headers.ts` / `ws-bridge.ts`: shared safe response projection with compatibility export retained.
- `src/server/responses/codex-ws-metadata.ts`: bounded prelude/header snapshots, typed native quota mapping, filtered provider header metadata, weak Response ownership and terminal-before-attachment replay.
- `src/server/responses/ws-upstream.ts`: canonical first-event header commitment and post-send errored-body settlement, existing one-shot lifetime and noncanonical behavior retained. The file remains above the generic 400-line guideline because it preserves one existing state machine; lifecycle extraction in 020 remains planned rather than mixing a second rewrite into this slice.
- `src/server/responses/core.ts`: immutable final account/generation capture, prelude then latest observation, and eager-relay cleanup detach.
- Existing metadata, transport, and account-label tests exercise real dispatch and account writers; no new test-layout entries are needed.
- Transport SoT and English architecture reference now distinguish prelude headers, late account-state observation, and the unchanged HTTP client default.

## Verification observed during B

- Metadata-prelude regression first failed: expected header `31`, got null. It passes after the transport change.
- Pool/main-pool final quota test passes; removing the observer integration made it fail with expected `20`, got `10`, then restoring it passed again. Both account modes and untouched-account isolation are asserted.
- Request-only worker tests observed the missing Lite/helper red state, then 16 pass / 0 fail. Main independently fixed hint grammar against upstream source rather than trusting matching implementation/test expectations.
- Combined metadata/transport/account files before the final six boundary tests: 64 pass, 1 existing skip, 0 fail, 430 assertions.
- Current `tests/responses/ws-upstream.test.ts`: 49 pass, 1 existing skip, 0 fail, 188 assertions. Includes actual HTTP adapter dispatch, metadata caps, family isolation, no-signal deadline and outer retry no-resend behavior.
- Adjacent WS endpoint/passthrough abort/core-Lab boundary files: 67 pass, 0 fail, 243 assertions.
- Direct installed-Bun typecheck passed. Privacy scan passed. Staged secret scan examined approximately 41.6 KB with no leaks; the earlier empty-commit-range scan examined zero bytes and is not evidence for this patch.
- Docs build via installed `astro/bin/astro.mjs`: 425 pages, exit 0; existing chunk-size and missing 404-content warnings remain.
- Local wire QA `.tmp/qa-protocol.ts`: actual ephemeral HTTP listener exercised success (200 with quota/etag headers and Lite on the upstream frame), metadata overflow (single 200 stream failure without resend), and malformed JSON (400 with no socket). Two fake upstream sockets closed; ephemeral listener stopped and isolated home removed. No paid provider call or live proxy change.

This is not a final C/CI/merge claim. Independent implementation review and exact-head full verification remain pending. The source and regression delta is larger than a five-line patch because it crosses HTTP header commitment and account observation; connection reuse remains excluded and separately reviewable.
