# Reserve compatibility verification

Stack base: UI080878d5d on runtimef42d86fca. Runtime exact-head Cross-platform CI33936759594 and all status checks passed; UI exact-head CI33937014820 remains in progress at this checkpoint. No local suites were run.

Implemented the explicit main-only authless compatibility contract: manual qualified catalog entry; capability-aware bounded owned usage read; exact credential/observation-generation binding; private nontransferable proof; passive revocation-only reads; independent Reserve cooldown; main admission retained; final HTTP/WS dispatch guard after pacing and through retries; unsupported native helper use refused without inference. Public English/Korean guide describes activation and limits.

Independent source reviews: Jason availability PASS; Dewey quota/passive-producer scope PASS; Herschel auth and actual-dispatch PASS; Copernicus helper closure PASS. Catalog finalization re-review is pending and must pass before publication. Detailed pre-publication security analysis remains in ignored scratch, not this public record.

Static checks: root TypeScript; focused TypeScript over availability/auth/scope/passive/helper/dispatch/WS/catalog/lifecycle tests; privacy scan; diff check. All completed checks passed; changes after their check require proportionate refresh. The tests are authored and typechecked, not executed locally. Public docs build passed425pages before the helper-limit copy amendment; rebuild remains required.

Upstream root metadata compatibility is source-verified: reference protocol/src/openai_models.rs762 derives Deserialize for ModelsResponse without deny_unknown_fields; core/src/config/mod.rs2052 directly deserializes that type, requiring nonempty models. The root opencodex_reserve_source retains genuine metadata only, independent of picker emission; it is not an authorization or credential.

No Reserve-active live account was used. Capability/grant/credential/dispatch scenarios and full catalog lifecycle are synthetic CI fixtures. Installed Desktop source establishes the authless picker gate and Reserve/Luna metadata adaptation, not live entitlement. Existing eight settings screenshots remain the UI evidence; this layer has no dashboard visual change. No installed app, live10100 service, account reset, release or deployment was changed.
