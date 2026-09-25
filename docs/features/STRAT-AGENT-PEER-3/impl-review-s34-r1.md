NOT CLEAN

1. **Medium — S4 tests do not protect the registration-evidence requirement.** `ts/tests/connectors/background-appserver.test.ts:69-77` checks only a successful, correctly generated peer record; `ts/tests/connectors/background-appserver-launch.test.ts:83-100` checks delayed registration with no record. Neither supplies a record with the expected name but a different PID. Consequently, removing the name/PID checks at `ts/src/connectors/codex-appserver-driver.ts:371` goes undetected.

   **Confirmed mutation:** in a scratch copy under `/tmp/peer3-s34-evidence-mutant`, replace `!expired() && record.name === config.peer.name && record.pid === handle.pid` with `!expired()` in source and emitted driver. Both S4 suites still pass **21/21**, exit 0 (`/tmp/peer3-s34-evidence-mutant.log`).

   **Confirmed consequence:** a separate fake-server probe delayed sidecar startup and seeded `peer.json` with the expected name and PID `99999999`. Current code returned no peer name; the mutant claimed `expected-peer` without registration by that process:

   ```json
   {"variant":"original-dist","forgedPid":99999999,"returnedPeerName":null}
   {"variant":"dist","forgedPid":99999999,"returnedPeerName":"expected-peer"}
   ```

   Evidence: `/tmp/peer3-s34-forged-record.mjs`, `/tmp/peer3-s34-forged-record.log`. These probes used only a local fake app-server.

   **Suggested fix:** add negative registration-evidence fixtures for a matching name/wrong PID and wrong name/matching PID, holding back the legitimate record. Assert no peer claim or attachment, bounded registration cleanup, and unaffected terminal output. Verify that removing either identity check makes its corresponding test fail.

Validation: build and `git diff --check` passed. The final exact requested ten-file Vitest command passed **240/240, zero skips**, exit 0, in 67.92 seconds (`/tmp/peer3-s34-tests-rerun.log`). The first run was 239/240: successful registration returned an undefined peer name; that case passed in isolation and in the final run. Its root cause was not established (`/tmp/peer3-s34-tests.log`, `/tmp/peer3-s34-registration-rerun.log`).

The missing-bootstrap nonzero-exit checks passed for source/dist with no IPC, disconnect, and run-ID mismatch. The reviewed selector, ownership, registration cleanup, and S3 steering/authentication/reservation paths yielded no confirmed production defect. NOT CLEAN is based on the demonstrated acceptance-test gap above.

No repository source, test, or documentation files were edited. Only the authorized build wrote normal generated output; scratch artifacts are under `/tmp`. No socket-skip flag, full suite, or paid model calls were used.
