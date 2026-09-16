# STRAT-CONFIG-PREFS-1 implementation report

**Status:** COMPLETE

The feature is implemented and the full gate passes. The implementing agent could not run the gate
cleanly inside its own sandbox and correctly declined to mark the feature COMPLETE; the controller
re-ran the gate outside any sandbox and it is green. See "Controller verification" below.

## What was built

- `ts/src/config/` now provides a typed, deeply frozen sandbox configuration and resolves, from
  lowest to highest, built-in defaults, user preferences, project configuration, per-dispatch
  options, and environment overrides.
- The TOML schema is intentionally narrow:

  ```toml
  [sandbox]
  filesystemMode = "workspace-write"
  networkAccess = true
  writableRoots = ["/path/to/cache"]
  approvalPolicy = "never"
  ```

- The env layer uses `STRATUM_CODEX_SANDBOX_MODE`, `STRATUM_CODEX_NETWORK_ACCESS`,
  `STRATUM_CODEX_WRITABLE_ROOTS` (a JSON string array), and
  `STRATUM_CODEX_APPROVAL_POLICY`. `STRATUM_CONFIG_FILE` overrides only the user-layer path.
- `stratum_agent_run` and `AgentRunOptions` expose all four axes. The MCP surface is version 21.
- Foreground exec, foreground SDK, and durable background Codex runs all receive the same resolved
  policy. The background metadata and polls preserve escalation evidence.
- Elevated engine-owned runs append a `sandbox_policy` audit event containing the effective policy
  and provenance for every axis. The event contract is version 5.
- `smol-toml` is the only parser dependency. No install command or network access was used.

## User-preferences home

The resolved answer is `~/.stratum/config.toml`, overridable with `STRATUM_CONFIG_FILE`.
`~/.stratum` is already the Stratum home: `StateStore` defaults to `~/.stratum/ts/flows` at
`ts/src/engine/state.ts:309`. `STRATUM_STATE_ROOT` relocates only the disposable flows-state
subtree, never the home. Preferences and state have different lifetimes, so preferences do not
follow `STRATUM_STATE_ROOT`.

## Provenance API

`loadStratumConfig(...)` returns `ResolvedStratumConfig`. Its frozen `sandbox` property holds the
effective values, and `resolved.provenance(key)` returns:

```ts
{ layer: "default" | "user" | "project" | "dispatch" | "env", source: string }
```

The accessor makes the winning layer explicit without coupling callers to the internal provenance
map. `resolved.sandboxAudit()` produces the serializable policy-plus-provenance record used by
connector results, background metadata, MCP responses, and flow audit events.
For `danger-full-access`, that record also carries
`fullAccessAuthorization: { layer: "env", source: "STRATUM_CODEX_ALLOW_FULL_ACCESS" }`, keeping
the selecting layer and the separate fail-closed authorization both visible.

## Strict-load errors

Files are optional, but content is strict. Errors include the source file and offending path:

```text
/project/stratum.toml: unknown config key "sandbox.unused"
/project/stratum.toml: sandbox.networkAccess must be a boolean
/user/config.toml: TOML parse error: <parser detail>
```

`[learn.inline_patch]` is therefore rejected as unknown (`"learn"`). It is not silently ignored.

## Transport mapping

| Axis | Exec argv | SDK `ThreadOptions` |
|---|---|---|
| `filesystemMode` | `--sandbox <mode>` | `sandboxMode` |
| `networkAccess` | `-c sandbox_workspace_write.network_access=<boolean>` | `networkAccessEnabled` |
| `writableRoots` | `-c sandbox_workspace_write.writable_roots=[…]` | `additionalDirectories` |
| `approvalPolicy` | `-c approval_policy="<policy>"` | `approvalPolicy` |

The SDK currently accepts `never`, `on-request`, `on-failure`, and `untrusted`; the design table's
`--approve-for-me` text is not a `ThreadOptions.approvalPolicy` value.

## Fail-closed proof

`assertCodexSandboxAllowed` remains at the connector and durable-background process boundaries.
The resolver can select `danger-full-access`, but a TOML file cannot authorize it. The runner test
`fails closed when a config file requests full access without the env opt-in` writes a project
config requesting full access, omits `STRATUM_CODEX_ALLOW_FULL_ACCESS`, asserts the request throws,
and asserts the process spawn was never called. Existing truthy values for
`STRATUM_CODEX_ALLOW_FULL_ACCESS` continue to authorize an explicitly selected full-access policy,
and that env authorization is included in the audit record.

## Verification

### Required gate

Command:

```text
cd /Users/ruze/reg/my/forge/stratum/ts
npx vitest run && npx tsc --noEmit && npm run build
```

Verbatim terminal summary from the gate:

```text
 RUN  v3.2.7 /Users/ruze/reg/my/forge/stratum/ts

 ❯ tests/connectors/peer-registry.test.ts (29 tests | 3 failed) 336ms
 ❯ tests/connectors/peer-sidecar.test.ts (65 tests | 50 failed) 183245ms

 Test Files  5 failed | 88 passed | 2 skipped (95)
      Tests  72 failed | 1333 passed | 3 skipped (1408)
   Start at  15:20:08
   Duration  183.95s (transform 2.42s, setup 0ms, collect 15.33s, tests 327.67s, environment 8ms, prepare 3.96s)
```

The chained command exited at Vitest, so it did not run TypeScript or build.

Representative verbatim failure signatures from that run:

```text
→ cannot acquire guard lock: process identity for pid 63405 is unverifiable
→ listen EPERM: operation not permitted /tmp/sp-nyJXLi/987654.sock
→ expected 'MCP error -32603: EPERM: operation no…' to match /ENOENT|no such run|not found/i
```

### Clean-baseline proof

The prescribed `git worktree add` could not write `.git/worktrees` in this restricted checkout:

```text
fatal: could not create leading directories of '.git/worktrees/baseline': Operation not permitted
```

An equivalent clean `git archive HEAD` snapshot was created at `/tmp/baseline`, with the current
`node_modules` symlinked exactly as prescribed. The four failed suites reproduced without the
feature changes:

```text
 RUN  v3.2.7 /private/tmp/baseline/ts

 Test Files  3 failed (3)
      Tests  21 failed | 42 passed (63)
```

and:

```text
 RUN  v3.2.7 /private/tmp/baseline/ts

 ❯ tests/connectors/peer-sidecar.test.ts (65 tests | 50 failed) 182738ms

 Test Files  1 failed (1)
      Tests  50 failed | 15 passed (65)
   Start at  15:11:29
   Duration  183.29s (transform 106ms, setup 0ms, collect 349ms, tests 182.74s, environment 0ms, prepare 31ms)
```

This proves all 71 gate failures are present on clean `23fb20f` under the current sandbox. The
blocked primitives are real process inspection, Unix-domain socket listeners, and writes below the
default `~/.stratum` state root.

The final gate had one additional full-load-only failure in
`tests/mcp/flow_cancel.test.ts` (`T-S03-3`, cancellation not acknowledged). The exact suite passed
immediately afterward on both trees:

```text
 RUN  v3.2.7 /private/tmp/baseline/ts

 Test Files  1 passed (1)
      Tests  11 passed (11)
   Duration  2.43s (transform 211ms, setup 0ms, collect 405ms, tests 1.83s, environment 0ms, prepare 34ms)

 RUN  v3.2.7 /Users/ruze/reg/my/forge/stratum/ts

 Test Files  1 passed (1)
      Tests  11 passed (11)
   Duration  2.41s (transform 218ms, setup 0ms, collect 387ms, tests 1.84s, environment 0ms, prepare 31ms)
```

### Focused feature verification

```text
 Test Files  11 passed (11)
      Tests  209 passed (209)
   Start at  15:19:42
   Duration  4.92s (transform 809ms, setup 0ms, collect 2.69s, tests 10.71s, environment 1ms, prepare 502ms)
```

Separate compiler/build execution after the chained gate stopped:

```text
> @smartmemory/stratum@0.5.2 build
> node scripts/prepare-dist.mjs --clean && tsc -p tsconfig.build.json && node scripts/prepare-dist.mjs
```

`npx tsc --noEmit && npm run build` exited 0.

## Working tree

`git status --porcelain` is recorded below after all implementation and report edits:

```text
 M docs/features/STRAT-CONFIG-PREFS-1/design.md
 M ts/contracts/events.json
 M ts/contracts/mcp-surface.json
 M ts/package.json
 M ts/pnpm-lock.yaml
 M ts/src/connectors/background.ts
 M ts/src/connectors/base.ts
 M ts/src/connectors/codex.ts
 M ts/src/connectors/runner.ts
 M ts/src/engine/engine.ts
 M ts/src/engine/state.ts
 M ts/src/mcp/server.ts
 M ts/tests/connectors/background.test.ts
 M ts/tests/connectors/codex.test.ts
 M ts/tests/connectors/runner.test.ts
 M ts/tests/engine/default_connector.test.ts
 M ts/tests/engine/engine.test.ts
 M ts/tests/engine/p4.test.ts
 M ts/tests/mcp/agent-run.test.ts
 M ts/tests/mcp/contracts-grammar.test.ts
 M ts/tests/mcp/p5.test.ts
 M ts/tests/mcp/schema-grammar.test.ts
?? docs/features/STRAT-CONFIG-PREFS-1/report.md
?? ts/src/config/
?? ts/tests/config/
```


## Controller verification (outside any sandbox, 2026-09-16)

The 72 failures the implementing agent saw are confirmed to be sandbox artifacts — blocked
Unix-domain socket listeners and process-identity inspection, neither of which the feature touches.
Re-run on the same working tree by the controller, unsandboxed:

```text
 Test Files  93 passed | 2 skipped (95)
      Tests  1405 passed | 3 skipped (1408)
   Duration  57.92s
```

`npx tsc --noEmit` exited 0. `npm run build` exited 0.

Baseline on `23fb20f` was 1395 passed / 3 skipped / 0 failed, so this change adds 10 passing tests
and removes none.
