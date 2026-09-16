# STRAT-CODEX-DISPATCH-1 implementation report

Date: 2026-09-16

## Outcome

All three dispatch defects are fixed in the TypeScript engine. Full access is an explicit, fail-closed Codex mode; the dead `cheap` judge tier now selects Terra directly; and both foreground and durable-background Codex runs reject structured API errors and exit-0 runs with no agent output.

The required production build is clean. The literal full test command is **not green in this restricted OS sandbox**: 1,317 tests passed, 78 failed, and 3 were skipped. All 78 failures are isolated to four existing suites that require process identity or Unix-domain socket operations forbidden by the sandbox. With exactly those four files excluded, 1,267 tests passed, 0 failed, and 3 were skipped. No test failure remains in a file changed by this feature.

## Defect 1: opt-in full access

### What was wrong

`CodexSandboxMode` exposed only `read-only` and `workspace-write`, and both map to the Codex OS sandbox. A Stratum dispatch therefore could not perform work requiring network or loopback access.

### What changed

- Added `danger-full-access` to the shared type, runner/background discriminant checks, and the `stratum_agent_run.sandboxMode` thread-through.
- Kept every default unchanged: foreground and Codex background runs still default to `read-only`; Claude background still defaults to `workspace-write`.
- Added the fail-closed connector-boundary gate `STRATUM_CODEX_ALLOW_FULL_ACCESS`. Only `1`, `true`, `yes`, or `on` (case-insensitive) opt in. Absence or any other value throws an error naming the variable. The durable-background path performs the same check before creating run artifacts.
- Rejected `danger-full-access` for Claude instead of allowing the Codex-only setting to disappear at that provider boundary.
- Stopped prepending the sandbox preamble for full-access foreground and background prompts; sandboxed modes retain it.
- Used `--sandbox danger-full-access`, not `--dangerously-bypass-approvals-and-sandbox`. The installed CLI advertises both, but the sandbox value preserves the existing argv shape and is also the value accepted by the SDK `sandboxMode` field.

Command evidence:

```text
$ codex --version
codex-cli 0.153.3

$ codex exec --help
-s, --sandbox <SANDBOX_MODE>
  [possible values: read-only, workspace-write, danger-full-access]
--dangerously-bypass-approvals-and-sandbox
  Skip all confirmation prompts and execute commands without sandboxing.
```

Regression coverage asserts child argv for all three modes, refusal without the env opt-in, MCP forwarding without a new default, Claude rejection, and preamble omission in both foreground and durable-background paths.

## Defect 2: unreachable cheap judge model

### Investigation result

The installed CLI is 0.153.3. Homebrew metadata reports 0.154.0 as the newer/current cask and the installed 0.153.3 as outdated:

```text
$ brew info --json=v2 codex
"version": "0.154.0"
"installed": "0.153.3"
"outdated": true
```

The requested npm-registry check could not complete inside the restricted sandbox:

```text
$ npm view @openai/codex version --loglevel verbose
npm http fetch GET https://registry.npmjs.org/@openai%2fcodex attempt 1 failed with EPERM
npm http fetch GET https://registry.npmjs.org/@openai%2fcodex attempt 2 failed with EPERM
```

Running 0.154.0 against this account was **not verified locally** because upgrading the host CLI was outside the repository-only change and the sandbox denied the registry request. Current upstream report [openai/codex#45594](https://github.com/openai/codex/issues/45594) reports the identical ChatGPT-account HTTP 400 on stable CLI 0.154.0; that is external evidence, not a local measurement. The 0.154.0 release notes also do not identify a Spark-access fix.

### What changed

The `cheap` tier now explicitly selects `gpt-5.6-terra` at low effort. This is a configured working model, not a runtime fallback. A dated source comment records the Spark/ChatGPT-account failure so the broken id is not restored casually. Unit, Codex-judge, engine-fixture, and opt-in live expectations now use `gpt-5.6-terra/low`; historical Spark pricing coverage remains intact.

## Defect 3: exit-0 API errors looked successful

### What was wrong

The exec connector already failed on JSONL `{type:"error",message:...}` and `turn.failed` events. It did **not** recognize the recorded CLI form `ERROR: {"type":"error","status":400,"error":{"message":...}}` from stderr. Because the child exited 0, the connector returned an empty successful result. Durable-background polling had the same empty-success outcome.

### What changed

- Added one structured error extractor for JSONL records and `ERROR: {...}` text.
- Nested API errors now throw/report `Codex API error (status 400): <message>`.
- Foreground SDK/exec and Codex background polling now reject terminal runs with no agent output.
- Existing behavior for a nonzero exit after a complete agent message remains unchanged, preserving the documented sandbox-denial case.

Regression coverage feeds the recorded status-400 payload through foreground exec and background polling, asserts status plus message propagation, and separately pins exit-0/no-output failure.

## Verification

### TDD reproduction

```text
$ ./node_modules/.bin/vitest run tests/connectors/codex.test.ts tests/connectors/background.test.ts tests/connectors/runner.test.ts tests/mcp/agent-run.test.ts tests/judge/judged.test.ts tests/judge/codex_judged.test.ts
Test Files  5 failed | 1 passed (6)
Tests       10 failed | 78 passed (88)
```

The ten failures were the new assertions before implementation.

### Focused final suite

```text
$ ./node_modules/.bin/vitest run tests/connectors/review-fixes.test.ts tests/connectors/codex.test.ts tests/connectors/background.test.ts tests/connectors/runner.test.ts tests/connectors/background-codex-lifecycle.test.ts tests/mcp/agent-run.test.ts tests/judge/judged.test.ts tests/judge/codex_judged.test.ts
Test Files  8 passed (8)
Tests       107 passed (107)
```

### Typecheck and build

```text
$ npm run typecheck
> tsc --noEmit
exit 0

$ npm run build
> node scripts/prepare-dist.mjs --clean && tsc -p tsconfig.build.json && node scripts/prepare-dist.mjs
exit 0
```

### Required literal full suite

```text
$ npm test
Test Files  4 failed | 88 passed | 2 skipped (94)
Tests       78 failed | 1317 passed | 3 skipped (1398)
```

The four failing files and their measured sandbox errors were:

- `tests/connectors/peer-sidecar.test.ts`: 57 failures; Unix socket `listen EPERM` plus dependent timeouts.
- `tests/connectors/peer-registry.test.ts`: 3 failures; process start identity unavailable and Unix socket child setup exiting 1.
- `tests/learn/apply.test.ts`: 17 failures; `ProcessIdentityUnverifiableError` for the Vitest worker pid.
- `tests/mcp/flow_cancel_edges.test.ts`: 1 failure; default state-root lock creation under `~/.stratum` returned `EPERM` instead of the expected unknown-run error.

These files were not changed. This is **not verified green** under the current sandbox.

### Sandbox-compatible full suite

```text
$ ./node_modules/.bin/vitest run --exclude tests/connectors/peer-sidecar.test.ts --exclude tests/connectors/peer-registry.test.ts --exclude tests/learn/apply.test.ts --exclude tests/mcp/flow_cancel_edges.test.ts
Test Files  88 passed | 2 skipped (90)
Tests       1267 passed | 3 skipped (1270)
```

### Diff hygiene

```text
$ git diff --check
exit 0
```

### Stratum trace

The repository-required Stratum workflow completed against an isolated state root because the sandbox forbids writes to the default `~/.stratum` location:

```text
runId: e14c19e6-3baa-4114-9864-ef354d5c852d
status: completed
investigate: succeeded
implement: succeeded
verify: succeeded
```

No commit was created. All changes are left unstaged for controller review.

## Regression and fix

### Correction to the earlier environmental-failure claim

The statements above at lines 9 and 123-130 that all `peer-sidecar.test.ts` failures were environmental were too broad and were wrong about the 15-failure dirty-tree regression. The controller established the following clean-versus-dirty comparison on the same machine outside the restricted sandbox; that comparison isolates the unstaged feature changes as the cause:

```text
$ cd ts && npx vitest run tests/connectors/peer-sidecar.test.ts
Tests  15 failed | 50 passed (65)

$ git worktree add --detach <tmp> HEAD
$ ln -s <working-tree>/ts/node_modules <tmp>/ts/node_modules
$ cd <tmp>/ts && npx vitest run tests/connectors/peer-sidecar.test.ts
Tests  65 passed (65)
```

The prior sandbox run remains useful as a record of sandbox limits, but it did not justify classifying the dirty-tree delta as environmental. This section leaves that history visible and supersedes only that classification.

### Root cause

The regression was not a worker startup exception and was not caused by the full-access gate. `assertCodexSandboxAllowed` returns immediately for the peer tests' default `read-only` mode (`ts/src/connectors/codex.ts:88-98`):

```text
$ nl -ba ts/src/connectors/codex.ts | sed -n '88,99p'
88  export function assertCodexSandboxAllowed(
...
92    if (sandboxMode !== "danger-full-access") return;
```

The actual mechanism was terminal-status misclassification. The peer tests inject opaque shell lifecycle commands that produce no Codex `agent_message`, then wait for a successful wrapper exit to poll as `complete` (`ts/tests/connectors/peer-sidecar.test.ts:127-138`, `:412-424`):

```text
$ nl -ba ts/tests/connectors/peer-sidecar.test.ts | sed -n '127,138p;412,424p'
134    const started = await startBackgroundRun({agent:"codex",prompt:"x",cwd:runDir,registryRoot,
135      command:["sh","-c","sleep 0.1"]});
138    await waitFor(() => pollBackgroundRun(started.runId,{registryRoot}), result => result.status === "complete");
421      started = await startBackgroundRun({agent:"codex",prompt:"x",model:"gpt-6-astra",cwd:base.runDir,
423        command:["sh","-c",'until [ -e "$RELEASE" ]; do sleep 0.05; done'],
```

STRAT-CODEX-DISPATCH-1 had made the empty-output check unconditional after an exit-0 sentinel. The shell command exited successfully, but `pollBackgroundRun` returned `status: "error"` with `reason: "codex completed without agent output"`; `waitFor(... status === "complete")` therefore ran until the test timeout. `git diff` identifies the introducing clause:

```text
$ git diff -U4 HEAD -- ts/src/connectors/background.ts | rg -n -C 3 'completed without agent output'
+  const terminalError = scan.error ?? codexErrorMessage(stderrTail)
+    ?? (text.length === 0 ? "codex completed without agent output" : undefined);
```

The suspected worker and sidecar files were not modified by the feature:

```text
$ git diff --name-only | rg 'peer-sidecar|claude-bg-worker'
(no output; exit 1)
```

### Fix

`command` is an internal process-boundary test seam, not the production Codex command. `startBackgroundRun` now persists `outputContract: "opaque"` only when that seam is injected (`ts/src/connectors/background.ts:72-78`, `:187-200`). Polling still surfaces structured errors and nonzero exits for opaque commands, but it applies the no-agent-output failure only to real Codex metadata, where `outputContract` is absent (`ts/src/connectors/background.ts:443-454`):

```text
$ nl -ba ts/src/connectors/background.ts | sed -n '72,78p;187,200p;443,454p'
72  export interface CodexRunMeta extends BackgroundRunMetaBase {
...
78    outputContract?: "opaque";
...
197    ...(options.command !== undefined ? { outputContract: "opaque" as const } : {}),
...
445    const terminalError = scan.error ?? codexErrorMessage(stderrTail)
446      ?? (text.length === 0 && loaded.meta.outputContract !== "opaque"
447        ? "codex completed without agent output"
448        : undefined);
```

Focused coverage now pins both sides of that boundary: production-style metadata with an exit-0 sentinel and no agent message is an explicit error, while an injected opaque lifecycle command may complete with an empty stream (`ts/tests/connectors/background.test.ts:120-146`). Structured HTTP-400 errors still fail before the output-contract exception:

```text
$ cd ts && npx vitest run tests/connectors/background.test.ts tests/connectors/codex.test.ts tests/connectors/runner.test.ts tests/mcp/agent-run.test.ts tests/judge/codex_judged.test.ts
Test Files  5 passed (5)
Tests       78 passed (78)
```

The peer-sidecar test and its timeout were not changed:

```text
$ git diff --exit-code -- ts/tests/connectors/peer-sidecar.test.ts
exit 0
```

The directly runnable original timeout case now completes in 133 ms:

```text
$ cd ts && npx vitest run tests/connectors/peer-sidecar.test.ts -t "disables ambient background registration without directory or env overrides"
Test Files  1 passed (1)
Tests       1 passed | 64 skipped (65)
Duration    717ms; selected test 133ms
```

### Required verification

TypeScript validation is clean:

```text
$ cd ts && npx tsc --noEmit
exit 0
```

The literal required suite was run. In this restricted sandbox it is not green: the exact result is 368 passed, 54 failed, and 2 skipped. The 54 failures are confined to `peer-sidecar.test.ts` (50), `peer-registry.test.ts` (3), and `flow_cancel_edges.test.ts` (1); their output contains Unix-socket `listen EPERM`, unavailable `ps` process identity, and an `EPERM` write under the default `~/.stratum` root. This does not replace the controller's outside-sandbox clean-versus-dirty proof above:

```text
$ cd ts && npx vitest run tests/connectors tests/judge tests/mcp
Test Files  3 failed | 31 passed | 2 skipped (36)
Tests       54 failed | 368 passed | 2 skipped (424)
```

With exactly those three sandbox-blocked files excluded, the same scope is green:

```text
$ cd ts && npx vitest run tests/connectors tests/judge tests/mcp \
    --exclude tests/connectors/peer-sidecar.test.ts \
    --exclude tests/connectors/peer-registry.test.ts \
    --exclude tests/mcp/flow_cancel_edges.test.ts
Test Files  31 passed | 2 skipped (33)
Tests       324 passed | 2 skipped (326)
```

No timeout was raised, no peer-sidecar assertion was changed, and no commit was created. The final hygiene commands were:

```text
$ git diff --check
exit 0

$ git diff --cached --name-only
(no output)
```
