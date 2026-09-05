# Stack CI and parent review follow-up

Runtime7043e2b42 addresses the maintainer's raw-range and monthly-provenance findings; independent review and static checks passed. UI cascaded to a7a0ab832; Reserve replayed cleanly to380966e5f. `git range-diff` proves all three Reserve commits unchanged by the cascade. Every resulting head needs fresh CI; earlier green runs are historical evidence only.

Reserve run33938170402 at76affe17c failed test4/4 job101230129450 in five auth fixture cases. The fixture reused the same account/token between tests but reset only lifecycle tracking, leaving a valid process-local Reserve authorization. Consequently later fixtures used the legitimate cache instead of their new WHAM response; assertions saw zero reads or the previous grant. Add the existing clearMainAccountInfoCache invalidation in beforeEach/afterEach. This fixes fixture ownership without adding a test-only production reset or weakening assertions. The expected WHAM and refusal assertions remain exact. Other job results are still being collected; no failure is labeled a flake.

Fresh C adversarial source audit by Nash found no cross-lane blocker on76affe17c. Cascade integration re-review is pending. No local suites, account changes or live-service mutations.
