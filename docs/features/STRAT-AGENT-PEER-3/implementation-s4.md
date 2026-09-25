# Slice 4 implementation report — 2026-09-25

Implemented on the existing uncommitted Slice 3 production changes. AC04 is verified. AC01 and AC14 have passing selector/lifecycle evidence, but their successful peer-registration check remains sandbox-blocked; this slice is **not fully green**.

## Files changed by Slice 4

| File | Status | Change |
|---|---|---|
| `ts/src/connectors/background.ts` | existing | Background-only selector, pre-directory rejection, driver launch/release through existing metadata flow. Poll/cancel implementations unchanged. |
| `ts/src/connectors/codex-appserver-launch.ts` | new | 0600 config, detached Node driver, source/dist entry selection, bounded bootstrap acknowledgement and parent disconnect. |
| `ts/src/connectors/codex-appserver-driver.ts` | existing, atop S3 | Wait for metadata release, register sidecar from driver, durable parent-independent execution, deadline/evidence checks. Existing terminal-claim engine retained. |
| `ts/src/connectors/codex-appserver-ipc.ts` | existing, atop S3 | Expose sidecar PID for registration evidence; bounded abort/reap for registration timeout. Existing steering semantics retained. |
| `ts/tests/connectors/background-appserver.test.ts` | new | 13 selector, rejection, environment, poll, registration and process-group cases. |
| `ts/tests/connectors/background-appserver-launch.test.ts` | new | 8 source/dist/bootstrap/parent-exit/death/timeout cases. |
| `ts/tests/helpers/background-appserver-fixture.ts` | new | Local fake `codex` executable; no model calls. |
| `ts/tests/connectors/background-codex-lifecycle.test.ts` | existing | Metadata-write failure parameterized across exec and app-server; fake/missing executable ensures no paid launch. |
| `ts/tests/connectors/codex.test.ts` | existing | Foreground transport isolation regression. |
| `ts/tests/connectors/background-claude-peer.test.ts` | existing | Add launch module to isolated emitted-module list. |
| `docs/features/STRAT-AGENT-PEER-3/implementation-s4.md` | new | This report. |

Other pre-existing/concurrent changes were preserved. Neither `peer-sidecar-appserver.test.ts` nor `peer-sidecar-reservations.test.ts` was edited.

## Source-review adjustments and ownership

The S3 `owner-ready` IPC frame precedes socket registration, so it is not registration evidence. The driver checks the committed `peer.json` name and PID against the spawned sidecar before acknowledging a name. Timeout checks run again after asynchronous reads. A timed-out sidecar is disconnected, terminated and reaped, with SIGKILL escalation after one second. Late gate completion cannot spawn a sidecar.

The parent launches only the driver, writes metadata containing that driver's PID/start identity, then sends bootstrap release. The driver starts a non-detached app-server and an independently detached sidecar. Parent IPC serves bootstrap only; the sidecar IPC belongs to the driver. The two-second registration budget starts at release. Registration cannot delay the driver's terminal claim or sentinel.

The driver prompt is in the private launch configuration, not argv. Source uses strip-types; built launch and driver imports choose `.js` by their own module extension. Isolated dist tests copy the actual build into a package without `src` and provide only its dependency symlink.

## Per-AC test names

AC01 (`background-appserver.test.ts` unless noted):

- `AC01 selects %s with explicit replacement environment` — undefined, exec, app-server (3 cases).
- `AC01 defaults to exec and ignores foreground transport; command forces exec`.
- `AC01 invalid selector %j rejects before run directory or spawn` — invalid and empty string (2 cases).
- `AC01/AC14 registration %s preserves strict poll, prompt, audit and environment` — disabled and failure (2 cases).
- `AC01/AC14 successful registration proves label and independent sidecar group` — blocked below.
- `AC01 ambient environment keeps headless-shell defaults and scrubbing`.
- `AC01 foreground transport ignores the background strategy` (`codex.test.ts`).

AC04 (`background-appserver.test.ts`):

- `AC04 on-failure rejects before run directory or spawn` — spawn count zero and unchanged registry directory contents.
- `AC04 injected command keeps exec on-failure behavior` — opaque exec output contract retained.

AC14:

- The shared AC01/AC14 registration cases above.
- `AC14 persists driver group leader identity; cancellation reaps driver and server` (`background-appserver.test.ts`).
- `AC14 %s launch uses private config, no prompt argv, and waits for metadata release` — source and dist (2 cases).
- `AC14 %s driver survives MCP parent exit and registration failure` — source and dist (2 cases).
- `AC14 parent disconnect before release never starts app-server`.
- `AC14 driver death leaves no sentinel and app-server exits on stdin EOF`.
- `AC14 registration timeout during %s neither blocks completion nor leaks a late endpoint` — gate and sidecar (2 cases).
- `meta.json write failure kills the detached %s process group (no uncontrollable orphan)` — app-server case added alongside exec (`background-codex-lifecycle.test.ts`).

The launch cases above are in `background-appserver-launch.test.ts`. Source/dist parent-exit checks assert the host exits while driver/server remain alive, then release the fake turn and assert completion and both processes' disappearance. Cancellation checks verify the persisted start identity, driver PGID = driver PID, server PGID = driver PID, and existing cancelled/error poll behavior.

## Commands and counts

Only the authorized build, typecheck and S4 test command were run for validation. No full suite, commit, paid turn, or live gate.

```sh
npm --prefix ts run build
npm --prefix ts run typecheck
npm --prefix ts test -- tests/connectors/background-appserver.test.ts tests/connectors/background-appserver-launch.test.ts tests/connectors/background-codex-lifecycle.test.ts tests/connectors/background.test.ts tests/connectors/codex.test.ts tests/connectors/background-claude-peer.test.ts tests/connectors/background-claude.test.ts tests/connectors/background-claude-interleavings.test.ts
```

- Build: 3 invocations, all passed (initial dependency refresh and two implementation builds).
- Typecheck: 4 invocations, all passed.
- Exact targeted command: 3 serial invocations. Initial: 104 passed / 10 failed / 114 total. Second: 112 passed / 6 failed / 118 total. Final: **113 passed / 5 failed / 118 total**, 6 files passed / 2 failed, 26.00 seconds, exit 1.
- Earlier non-sandbox failures were test-harness defects: ESM spawn spying, reading the server marker before creation, and an exec test PATH without `sh`. They are fixed in the final run.
- `git diff --check`: passed.
- Final local log: `/tmp/stratum-s4-tests-final.log`.

## Exactly which tests remain sandbox-blocked

These tests were attempted, not skipped. They could not complete their registration assertions because Unix socket listening is denied. The new test exposes sidecar stderr: `listen EPERM: operation not permitted /tmp/p3s4-…/s/<pid>.sock`.

1. `background-appserver.test.ts` — `AC01/AC14 successful registration proves label and independent sidecar group`.
2. `background-claude-peer.test.ts` — `two real workers have independent peers and completion (cancel A=false)`.
3. `background-claude-peer.test.ts` — `two real workers have independent peers and completion (cancel A=true)`.
4. `background-claude-peer.test.ts` — `owner process death gives unavailable while durable poll reports missing sentinel`.
5. `background-claude-peer.test.ts` — `emitted JS worker runs with no sibling sources or loader hooks (peer=true)`.

No process-group tests were blocked by `ps`: the repository's existing macOS libproc identity path worked, and the driver/server group, cancellation, death and reaping assertions passed. Successful sidecar group separation still needs the socket-capable rerun above.

## Deviations

Added a shared fake-server fixture and a small IPC abort/reap method beyond the plan's named file list, to avoid duplicated process harnesses and make registration timeout cleanup explicit. Registration evidence uses the durable peer record, because S3 readiness is sent before registration. No selection, foreground transport, terminal-claim, cancellation, poll, or owner-decision semantics were changed beyond Slice 4's specified launch integration. Socket-capable validation remains required before declaring the slice green.
