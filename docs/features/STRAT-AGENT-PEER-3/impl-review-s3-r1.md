NOT CLEAN

1. **Medium — AC11 does not protect the r3 routing rule or refusal-slot release.** Evidence: `ts/tests/connectors/peer-sidecar-reservations.test.ts:112-127` waits for all eight callbacks to reach the recipient before shutdown; the stale-turn refusal has already left the queue. The pending variant produces only dropped/unknown results. The release test at `:133-143` exercises only delivered with a failed callback.

   Confirmed by mutation in `/tmp/peer3-s3-mutant`: replace `results.push(entry.callback); pumpCallbacks();` in sidecar settlement with an expired-status branch that calls `sendControl(entry.callback.to, entry.callback.frame)` and returns. This deliberately routes admitted refusals through the discardable queue and loses their reservation-release association. Both new files still pass: **27/27**, exit 0 (`/tmp/peer3-s3-mutant-tests.log`). Thus the central r3 regression and an expired-result slot leak survive the new tests.

   Suggested fix: occupy all eight callback workers with held pre-admission traffic, then admit steers and return outcomes including a server-side stale-turn refusal while their callbacks must remain queued. Saturate the best-effort queue, enqueue 32 idle notices, and shut down. Assert exactly one physical callback attempt for every admitted message and all notices. Separately release callbacks and refill all eight admission slots for each outcome (delivered, refused, unknown), including late duplicate results, to verify release and capacity recovery.

2. **Medium — automatic EPERM skips can make the socket acceptance gate green without running it.** Evidence: `ts/tests/connectors/peer-sidecar-appserver.test.ts:61-71` and `ts/tests/connectors/peer-sidecar-reservations.test.ts:61-69,101`. Any probe-level EPERM becomes a skip, with no explicit restricted-environment opt-in or CI prohibition. EPERM alone does not establish that skipping is intentional; an unexpected CI security policy or environment regression is hidden. An actual fixture socket failure after a successful probe is not caught by this skip.

   Confirmed against the original checkout using `/tmp/peer3-s3-probe-eperm.cjs`, which injects EPERM only for the probe socket: **12 passed / 15 skipped, exit 0** (`/tmp/peer3-s3-eperm-tests.log`).

   Suggested fix: fail on EPERM by default. Permit these skips only through an explicit local restricted-environment flag, reject that flag in CI/acceptance runs, and require zero skipped socket cases for Slice 3 acceptance. Keep other socket errors fatal.

Validation: `npm --prefix ts run build` passed. The exact requested six-file Vitest command passed **197/197 tests, zero skips**, exit 0, in 65.86 seconds. Logs: `/tmp/peer3-s3-build.log`, `/tmp/peer3-s3-tests.log`. No full suite was run.

Production inspection found no confirmed violation of design sections 5–6: admitted outcomes share idempotent reserved settlement, reservations release after callback completion, delivered requires the matching returned turn ID, ambiguous outcomes are not retried, and first-frame authentication remains mandatory only for app-server user frames. The targeted auth, owner compatibility, and driver-isolation tests passed. NOT CLEAN is based on the two acceptance-test defects above, not a demonstrated production failure.

No repository source/test/document files were edited. The authorized build generated its normal output; all review and mutation artifacts are under `/tmp`.
