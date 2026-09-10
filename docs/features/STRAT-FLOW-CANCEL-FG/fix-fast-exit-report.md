# 0.5.1 fast-exit registration fix — 2026-09-10

The foreground registry no longer turns a successfully exited agent into
`REGISTRY_WRITE_FAILED` merely because process identity capture lost the race
with exit. The native macOS regression failed against the original implementation
at `src/mcp/server.ts:340` and passes with this patch.

## Files and changed lines

Paths below are relative to the repository root; line numbers refer to the final files.

| File:lines | Change |
| --- | --- |
| `ts/src/connectors/foreground_registry.ts:219-243,252-254` | Central registration identity helper, retry contract, and omission of positively gone children. |
| `ts/src/mcp/server.ts:335-337` | Accept the registry's positively gone outcome; leave identified groups on the existing admission/cancellation path. |
| `ts/tests/mcp/flow_cancel_fast_exit.test.ts:1-114` | Six regressions through the real dispatcher registration link. |
| `ts/tests/mcp/agent_registry.test.ts:8-10,23,341-351` | Correct the existing missing-identity fixture to use a live child with a stubbed probe; restore the spy after the test. |
| `ts/package.json:3` | Package version 0.5.1. |
| `ts/server.json:10,15` | MCP registry version and npm package version 0.5.1. |
| `ts/CHANGELOG.md:1-3` | Requested dated patch section and one fix entry. |
| `ts/docs/features/STRAT-FLOW-CANCEL-FG/fix-fast-exit-report.md:1` | This report. |

## Helper and registry contract

`registrationStartTime(pid)` is private to `foreground_registry.ts` and is the
single place that distinguishes missing identity from confirmed process exit.

1. Read `procStartTime(pid)`. A captured token follows the existing registration path.
2. If missing, probe **positive** `pid` with `process.kill(pid, 0)`. Only `ESRCH`
   permits returning `undefined`. Success, `EPERM`, and unfamiliar errors do not.
3. If still unresolved, wait 25 ms, then repeat both probes once. This gives Node
   an opportunity to reap a macOS zombie that initially answers signal 0 successfully.
4. If identity remains missing without ESRCH, throw the unchanged code/message:
   `REGISTRY_WRITE_FAILED: could not capture process start time; agent would be uncancellable`.
   Invalid PIDs also fail closed without probing a process group.

There are at most two identity probes and one 25 ms delay, not an unbounded poll.
The existing darwin identity probe retains its 5,000 ms subprocess timeout per attempt.
No libproc fallback or signalling gate was relaxed.

`recordForegroundGroup` preserves its existing return type. A returned
`{ childPid }` without `procStartTime` now means **positively gone and not appended**.
No schema or exited marker is introduced. The durable entry and any previous groups
remain unchanged; an immediate single-child run goes from `starting` with `groups: []`
to `settled` in the dispatcher's existing finally. A live/opaque missing-identity
failure also appends nothing, aborts the controller, and fails the tool call.

## Related-path and version audits

Before the patch, `rg -n 'procStartTime === undefined' ts/src` found only
`ts/src/mcp/server.ts:339`. Background/dispatch inspection found no equivalent
unconditional registration throw: `ts/src/connectors/background.ts:176-186`
captures an optional start time and persists background metadata, while
`ts/src/connectors/runner.ts:20-23,68-98` forwards onSpawn only to foreground
connectors. No background change was needed for this defect.

The version search excluded CHANGELOG, docs, and node_modules. Each original
`0.5.0` occurrence was updated:

```text
ts/package.json:3:  "version": "0.5.0",
ts/server.json:10:  "version": "0.5.0",
ts/server.json:15:      "version": "0.5.0",
```

The final search, including ignored/hidden files, returned no matches (exit 1):

```sh
rg -n --hidden --no-ignore '0\.5\.0' ts/ \
  -g '!**/node_modules/**' -g '!**/docs/**' -g '!**/CHANGELOG*'
```

There is no `ts/package-lock.json`; `ts/pnpm-lock.yaml` contains no duplicated
project version. MCP serverInfo already reads the package manifest.

## Tests

New names in `tests/mcp/flow_cancel_fast_exit.test.ts`:

- `preserves the real immediate child's agent result through onSpawn (native darwin)`
- `preserves the real immediate child's agent result through onSpawn (probe after exit)`
- `preserves the real immediate child's agent result through onSpawn (zombie window)`
- `fails closed when identity is missing and the pid is alive`
- `fails closed when identity is missing and the pid is EPERM`
- `fails closed when identity is missing and the pid is unknown`

The success cases run the real `runAgent`, Codex connector, onSpawn callback,
registry, and dispatcher. Only the external Codex command is replaced with a real
`sh` child that emits an agent message and immediately exits 0. The native darwin
case uses unmodified process probes; the portable race case waits for real exit
before the real identity lookup, and the zombie case additionally forces the first
signal-0 check to succeed. They assert the agent text, complete tool result, exit
code 0, and settled metadata with no groups. The native case is skipped off darwin.

Existing `T-S02-0c2: a missing procStartTime is a registration failure, not a degraded
success` used a departed PID as its missing-identity fixture. That contradicts the
new contract and caused a timeout because its fake agent waited forever for abort.
Its fixture now spawns a real live writer and stubs only that child's identity
probe. Existing failure/settlement assertions are retained. All pre-existing
`flow_cancel*.test.ts` files are unchanged.

## Commands and outputs

All npm/Vitest commands below ran from `ts/` on darwin. Full local logs are in
`/private/tmp/stratum-051-*.log`.

Before changing production code:

```text
$ ./node_modules/.bin/vitest run tests/mcp/flow_cancel_fast_exit.test.ts
Test Files  1 failed (1)
     Tests  3 failed | 3 passed (6)
Caused by: Error: could not capture process start time; agent would be uncancellable
  src/mcp/server.ts:340:41
Serialized Error: { code: 'REGISTRY_WRITE_FAILED' }
```

After the fix, the same command exited 0:

```text
Test Files  1 passed (1)
     Tests  6 passed (6)
Duration  1.15s
```

```text
$ npm run typecheck
> @smartmemory/stratum@0.5.1 typecheck
> tsc --noEmit
tests/guard/store.test.ts(111,35): error TS2307: Cannot find module '../../src/guard/store.js?env-override-cachebust' or its corresponding type declarations.
Exit: 2

$ npm run build
> @smartmemory/stratum@0.5.1 build
> node scripts/prepare-dist.mjs --clean && tsc -p tsconfig.build.json && node scripts/prepare-dist.mjs
Exit: 0
```

Typecheck was rerun after the existing fixture correction and reported the same
single error. An isolated `git archive HEAD` source/test snapshot at commit
`6e4a68c8affa5bab37c7e4f9b78dd68f0345d66d`, using the installed dependencies,
reproduced the same TS2307 at line 111 (exit 2).

First full run, before correcting the obsolete fixture and redirecting default state:

```text
$ npm test
Test Files  3 failed | 86 passed | 2 skipped (91)
     Tests  19 failed | 1264 passed | 3 skipped (1286)
Duration  54.76s
Exit: 1
```

Failures: 17 in `tests/learn/apply.test.ts` (guard identity uses sandbox-blocked
`ps`), the obsolete T-S02-0c2 fixture timeout, and one flow-cancel edge test whose
default state root attempted a forbidden write under `/Users/ruze/.stratum`.

The unchanged flow-cancel and connector suites passed after redirecting the
default state root to a writable temporary directory:

```text
$ STRATUM_STATE_ROOT=$(mktemp -d /private/tmp/stratum-051-state.XXXXXX) ./node_modules/.bin/vitest run tests/mcp/flow_cancel.test.ts tests/mcp/flow_cancel_edges.test.ts tests/mcp/flow_cancel_fast_exit.test.ts tests/engine/flow_cancel.test.ts tests/engine/flow_cancel_edges.test.ts tests/engine/flow_cancel_golden.test.ts tests/connectors
Test Files  20 passed | 1 skipped (21)
     Tests  214 passed | 1 skipped (215)
Duration  54.59s
Exit: 0

$ ./node_modules/.bin/vitest run tests/mcp/agent_registry.test.ts tests/mcp/flow_cancel_fast_exit.test.ts
Test Files  2 passed (2)
     Tests  16 passed (16)
Duration  20.95s
Exit: 0
```

The isolated unmodified HEAD snapshot also reproduced exactly the 17 learn/apply
failures, with `cannot acquire guard lock: process identity for pid ... is
unverifiable` (17 failed, 13 passed, exit 1). This path uses the separate
`src/guard/lock.ts:85-92` ps-based identity probe, which this patch does not touch.

Final full run after correcting the fixture, with a writable default state root:

```text
$ STRATUM_STATE_ROOT=$(mktemp -d /private/tmp/stratum-051-final-state.XXXXXX) npm test
> @smartmemory/stratum@0.5.1 test
> vitest run
Test Files  1 failed | 88 passed | 2 skipped (91)
     Tests  17 failed | 1266 passed | 3 skipped (1286)
Duration  54.86s
Exit: 1
```

Only `tests/learn/apply.test.ts` fails in this final run. All existing flow-cancel
suites, the corrected registry fixture, and all six new regression cases pass.
Full final output: `/private/tmp/stratum-051-test-final.log`.

`git diff --check` exited 0 with no output. Final review confirmed the production
change is confined to registration; all existing group signalling gates remain intact.

## Deviations and limits

- The requested blueprint actually lives at
  `docs/features/STRAT-FLOW-CANCEL-FG/blueprint.md`; that is the version inspected.
- Neither `ts/CHANGELOG.md` nor `ts/docs/` existed. Both requested artifacts were
  created at the specified paths; the existing repository-root CHANGELOG was left alone.
- The obsolete `agent_registry.test.ts` fixture required correction as described
  above. No existing flow-cancel suite was edited.
- Typecheck and the complete test suite cannot be reported green in this sandbox;
  the baseline failures are recorded above rather than changing unrelated guard code.
- No commit, push, GUI launch, dependency change, or publication was performed.
