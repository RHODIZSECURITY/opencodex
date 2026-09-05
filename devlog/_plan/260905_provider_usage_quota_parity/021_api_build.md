# Account quota API build record

Layer: `codex/provider-account-quota-api`, parent `9a9ad98b8` / PR #3582.
Main owns existing management route projection, route-level regression file and test-layout
registration. Euclid owns credential-scoped quota readers, key cache, shared fields and provider
regressions. No local test, typecheck, build, lint or scan commands run in this layer.

Route projection now advertises capability on cheap lists, enriches only opt-in supported
credentials, preserves active selection, clears prior failure flags on success, and checks
private identity guards immediately before serializing safe quota fields. Passive reads remain
cache-only. Internal callbacks and credential identities are never spread into response DTOs.

Kant's scoped route review found one missing activation test: replacing an environment key
inside fetch proves worker rejection but not the final route guard. Accepted and added a
completed non-null quota fixture with `isCurrent() === false`, one callback invocation and
null/unavailable JSON expectation. Same final-projection scenario added for OAuth rows.
Re-review of the key guard delta: PASS, static only. Full independent review and remote CI pending.
