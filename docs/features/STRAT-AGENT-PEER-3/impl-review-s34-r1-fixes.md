# Slices 3+4 review follow-up

Only tests and their fixture helper were changed for this follow-up. No production source changes, no production budget changes, no commit.

## Registration evidence

`background-appserver-launch.test.ts` now supplies (1) the expected name with a wrong PID and (2) the actual sidecar PID with a wrong name. An isolated sidecar fixture withholds legitimate registration indefinitely. Both tests require no returned peer name, no bootstrap peer claim, no attachment IPC, sidecar death within the 2s registration budget plus bounded abort/reaping allowance, empty session/socket directories, and preserved terminal text with exactly one successful sentinel. The injected foreign record is not treated as an owned registration artifact.

Mutation checks operated on the emitted driver copied by these tests; production source was never mutated. Each check removed only one half of the identity condition, and the emitted driver was restored in `finally`, then rebuilt from source:

- Remove `record.pid === handle.pid`: wrong-PID case fails (exit 1), receiving `expected-peer` instead of undefined. Log: `/tmp/peer3-s34-mutation-pid.log`.
- Remove `record.name === config.peer.name`: wrong-name case fails (exit 1) on the raw bootstrap claim assertion. The launcher's name filter hides the bad name from its return value, so inspecting only that return would miss this mutation. Log: `/tmp/peer3-s34-mutation-name.log`.
- Restored condition: both cases pass, including cleanup and terminal assertions.

## Startup timing investigation

A controlled sidecar waits 3000ms before publishing a valid record. Stderr markers bracket this delay. With the unmodified 2000ms deadline, only the start marker appears, no name is claimed, and no late registration appears. With a 15000ms deadline in a disposable test package, both markers appear and registration succeeds. Both variants preserve completed output. This fixture deliberately avoids sockets to isolate deadline behavior from sandbox permissions.

This establishes a deadline-driven reproduction of the symptom, not a discovered production race. The original review log does not retain the sidecar stderr needed to conclusively attribute the historical occurrence. No claim is made that its exact cause was recovered.

The real successful-registration test now uses the same isolated emitted-package helper with a 15000ms budget and a 25000ms test timeout. All existing label, independent process-group, completion, and sidecar cleanup assertions remain. The helper checks and replaces both launcher deadline and parent timeout only in the disposable copy. There is no environment knob or production read path. Default-budget timeout coverage remains intact.

## Validation

- `npm --prefix ts run build`: pass.
- `npm --prefix ts run typecheck`: pass.
- Requested three-file Vitest command: **87 passed, 1 failed, zero skips** (88 tests). Log: `/tmp/peer3-s34-fix-tests-final.log`.
- The sole failure is `AC01/AC14 successful registration proves label and independent sidecar group`: sidecar stderr reports `listen EPERM: operation not permitted .../s/<pid>.sock`. Real socket registration cannot be verified in this sandbox. No skip flags were used.
- Both new negative cases and both controlled deadline cases pass in that final run.
- `git diff --check`: pass.
