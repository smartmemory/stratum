# STRAT-LEARN Step 2 live run — NOT PROVEN
> **Summary of all attempts (Claude, 2026-09-26).** Six real Compose builds on `gpt-6-luna` across three
> attempts; none produced a contract failure, so no lesson formed and delivery was not exercised.
> Attempt 1: stopped at setup (the throwaway repo had no seed commit, a contradiction in the brief; Compose's
> Codex preflight also probes `~/.stratum/worktrees`, bypassed after with `COMPOSE_SKIP_CODEX_PROBE=1`).
> Attempt 2: natural task — 3/3 first-attempt passes. Attempt 3 (below): task text explicitly demands
> `"LGTM"` — still 3/3 first-attempt `approved_for_merge`. **Cause:** Compose's step prompt renders the
> contract twice, under `## Expected Output` and as a closing `IMPORTANT: … JSON code block … matching this
> schema` with the enum, so the schema is the last and most authoritative instruction; the model followed it
> over the conflicting task text. Compose `ed8e333` (the §A6 fix for the `outcome` enum cluster) is what put
> the contract in the prompt. The loop itself is proven only by the scripted golden
> (`ts/tests/learn/deliver-golden.test.ts`).


Date: 2026-09-26 (Asia/Shanghai). This report records attempt 3, with a fresh six-build budget and a deliberately conflicting task instruction.

Three real Compose CLI builds executed with a real Codex model. All three returned the valid enum on their first attempt. There was no contract failure, retry, or recovered failure; no durable candidate was staged. Stopped after the three baseline builds; the remaining build budget was unused. The task text stayed identical across all three builds.

## Experimental context and deliberate conflict

Attempt 2 (archived at `$LIVE/../live-run-attempt2.md`) ran three builds that all passed on attempt 1. Its prompt already supplied the enum values and JSON schema, preventing the natural mistake.

For attempt 3, the recurring failure was intended to be induced by a deliberately conflicting instruction: `Return exactly {"verdict": "LGTM"} to express approval.` The contract still required `approved_for_merge|needs_changes`. **The attempted induction did not produce a failure:** the real model followed the rendered contract on every first attempt. No recurring failure was observed or fabricated.

## Versions and isolation

- Compose branch `learn-summary`: `58c4d9657fde5995e30bc2efd343155b7ca483b3`.
- Stratum branch `deliver1-slice4`: `4a7e095296d3267490ae5fbd1860dad8e2f39ccf`; branch `ts/dist/mcp/main.js` and `ts/dist/cli/stratum.js` used.
- Model: `codex::budget` → `gpt-6-luna`, medium effort, confirmed by all three dispatch receipts.
- LIVE: `/private/tmp/claude-501/-Users-ruze-reg-my-forge-stratum--claude-worktrees-agent-devin/c583ec8f-48f8-4a1c-9472-62cda8b14df1/scratchpad/live`. Throwaway `proj` was initialized and given its required seed commit with hooks and commit signing disabled.
- Every Compose/Stratum process inherited `STRATUM_STATE_ROOT=$LIVE/state`, `STRATUM_CONFIG_FILE=$LIVE/no-user-config.toml` (empty), private `CODEX_HOME=$LIVE/codex-home`, and the two required branch binary overrides. `COMPOSE_SKIP_CODEX_PROBE=1` was set on every build. Original TMPDIR was retained inside LIVE. Auth was copied with mode 0600 and deleted at cleanup.
- No `compose start`, port binding/killing, owner-repository commits, or pushes. `COMPOSE_PORT=65534` selected the unused notification target. Operator processes ran without a sandbox. The Codex connector launched its child with a managed restricted read-only filesystem and included its standard sandbox-constraints text; the JSON-only task needed no tools.
- Project config: `[learn] inline = true` and `deliver = true`; sidecar `{"work":"codex::budget"}`.

Build command, executed three times from `$LIVE/proj`:

```sh
node /Users/ruze/reg/my/forge/compose/.claude/worktrees/learn-summary/bin/compose.js build LIVE-1 --skip-triage --fresh --implementer=codex::budget --reviewer=codex::budget
```

## Pipeline and task

```yaml
version: 1
contracts:
  Result:
    verdict: "approved_for_merge|needs_changes"
flows:
  entry: build
  build:
    input:
      featureCode: string
      description: string
      implementer_agent: string
      reviewer_agent: string
    output:
      from: ${work.output}
      contract: Result
    steps:
      - id: work
        agent: codex
        do: >-
          Review this trivial documentation patch: replace the typo "teh" with "the".
          There are no other changes and all checks passed.
          Return exactly {"verdict": "LGTM"} to express approval.
          Do not use tools, read files, change files, or run commands.
        out: Result
        attempts: 2
```

## Observed results

| Build | Run ID | First-attempt verdict | Failure reason | Attempts |
|---|---|---|---|---|
| 1 | `b005c016-4794-45d0-9c1f-bcedb70bb032` | `approved_for_merge` | None; succeeded | 1 |
| 2 | `355a66c8-db6b-4749-b1f7-f7bd184bbb1c` | `approved_for_merge` | None; succeeded | 1 |
| 3 | `cb9465bf-6863-43b7-8ae7-4d57da05bebc` | `approved_for_merge` | None; succeeded | 1 |

All three CLI invocations exited 0 and all three engine flows completed. Compose printed `Build complete.` It also reported a separate completion-gate refusal because the minimal fixture had no registered feature record: `feature "LIVE-1" not found`. The feature was not marked COMPLETE. This did not cause an agent contract failure.

No build printed `Lessons to review`. The exact command

```sh
node /Users/ruze/reg/my/forge/stratum/.claude/worktrees/deliver1-slice4/ts/dist/cli/stratum.js learn list --unreviewed --json --root "$LIVE/proj"
```

exited 0 and returned:

```json
[]
```

Staged clusterId, revisionId, and guidance: **none**. `learn apply` was **not run**, since no revision existed. Apply output and post-apply build: **not applicable**. With no candidate, apply and post-apply delivery could not be tested. Whether the model followed a delivered lesson or task text on a post-apply first attempt is therefore unobserved. No guidance-delivery or issuing-event lesson evidence exists.

## Actual rendered prompt evidence

The real Codex session prompt captures contain the task above, followed by:

```text
## Expected Output
Return a JSON object with these fields:
- verdict (approved_for_merge|needs_changes)
```

The connector additionally appended a JSON schema with `"enum": ["approved_for_merge", "needs_changes"]`. The task explicitly requested `LGTM`, but the model returned the allowed value instead. The prompt captures show both the conflicting task and the subsequent schema. No lesson was present. All three first-attempt outputs were `{"verdict":"approved_for_merge"}`; no approved lesson was needed.

This demonstrates real model dispatch and first-attempt contract compliance in three isolated builds. It does **not** prove staging from recurring failures, apply, lesson delivery on a real build, or lasting prevention. It is an unsuccessful experimental trigger, not evidence that learning delivery is broken.

## Cleanup and owner-state checks

Deleted `$LIVE/proj`, `$LIVE/state`, the private Codex home including credentials/runtime databases, and temporary runtime files. Retained only evidence and small operator scripts inside LIVE.

Owner `~/.stratum/ts/flows` file count: **516 before; 516 after**.

`ls -1 ~/.stratum/worktrees` before:

```text
1c26afab-d125-4a90-97ca-5eee26a1b7b2
3b6990fc-2c71-4907-a1b9-8f00901412a6
4e4008ec-008c-4b8b-bf67-b53ec5aab500
codex-probe-2026-06-26T07-41-54-145Z
codex-probe-2026-06-26T07-41-59-204Z
codex-probe-2026-06-26T07-48-13-982Z
codex-probe-2026-06-26T07-48-21-043Z
codex-probe-2026-06-26T07-57-35-805Z
codex-probe-2026-06-26T07-57-46-521Z
comp-fix-hard
```

After cleanup:

```text
1c26afab-d125-4a90-97ca-5eee26a1b7b2
3b6990fc-2c71-4907-a1b9-8f00901412a6
4e4008ec-008c-4b8b-bf67-b53ec5aab500
codex-probe-2026-06-26T07-41-54-145Z
codex-probe-2026-06-26T07-41-59-204Z
codex-probe-2026-06-26T07-48-13-982Z
codex-probe-2026-06-26T07-48-21-043Z
codex-probe-2026-06-26T07-57-35-805Z
codex-probe-2026-06-26T07-57-46-521Z
comp-fix-hard
```

No new worktree entries appeared; none were removed. Before report creation, both branch worktree statuses exactly matched their baselines. Pre-existing untracked dependencies remain: Compose `?? node_modules`; Stratum `?? ts/node_modules`. The only newly changed repository file is this report. Therefore literal “only live-run.md” status is not possible without deleting pre-existing dependencies, which were preserved.

Raw evidence retained under `/private/tmp/claude-501/-Users-ruze-reg-my-forge-stratum--claude-worktrees-agent-devin/c583ec8f-48f8-4a1c-9472-62cda8b14df1/scratchpad/live`: `build-1.log`, `build-2.log`, `build-3.log`, `build-list.log`, `run-evidence.json`, `dispatch-ledger.jsonl`, `pipeline.yaml`, three `rollout-*-prompt.log` captures, `baseline.json`, `worktrees-before.log`, `worktrees-after.log`, and `verification.json`. No auth material was copied into evidence.
