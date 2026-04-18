# Changelog

## [Unreleased]

### stratum-mcp — fix(codex): port JS codex-connector rewrite to Python (removes opencode dep)

- **`CodexConnector` no longer inherits from `OpencodeConnector`.** Spawns `codex exec --json` directly, parses the CLI's own JSONL event stream (`item.completed` → `agent_message` / `command_execution` / `file_change` / `reasoning`; `turn.completed` → usage). Ports `compose/server/connectors/codex-connector.js` (commit `f552c7f`, 2026-04-18) to Python — that rewrite was applied to the JS side only, leaving `stratum_agent_run type="codex"` shelling out to `opencode run` indefinitely since we stopped using opencode for codex. Every codex review through the MCP tool hung waiting for events that couldn't arrive.
- **Model-ID effort suffix** — `<model>/<effort>` (e.g. `gpt-5.4/high`) is split: base model goes to `-m`, effort becomes `-c model_reasoning_effort="<effort>"`. Matches JS.
- **Env scrubbing deviates from opencode** — `ANTHROPIC_API_KEY`, `CLAUDE_API_KEY`, `CLAUDECODE` are scrubbed; `OPENAI_API_KEY` is **kept** because codex uses it as fallback auth when OAuth credentials are absent. Opencode's connector still scrubs all four because opencode's OAuth path doesn't want the raw key.
- **Interrupt is SIGTERM-only** (no grace+SIGKILL dance) — matches JS `codex-connector.js:217-222`. Simpler process model; the CLI terminates cleanly.
- **Stall detection preserved** — warns via stderr every 30s after 120s silence. Does not kill; caller can `interrupt()` if needed.
- **Tests refactored** — dropped `test_codex_inherits_opencode_interrupt` and `test_codex_override_forwards_env_to_super` (both asserted the now-gone opencode inheritance). Added `_translate_codex_event` event-taxonomy tests, direct-subprocess env-forwarding test, `OPENAI_API_KEY`-kept / cross-provider-creds-scrubbed test, `codex` binary-missing friendly-error test. **872 passing, 2 skipped.** Live smoke confirmed against real `codex exec --json` on 2026-04-19 — round-trip ~5s, events stream correctly.

### stratum-mcp — test: cross-repo drift guard for codex connector (STRAT-DEDUP-AGENTRUN interim)

- **New test `tests/test_codex_connector_sync.py`** asserts Python and Compose's JS codex connectors stay aligned until STRAT-DEDUP-AGENTRUN v3 ships. Two checks: (1) JS side still uses direct `codex exec` (not opencode), (2) `CODEX_MODEL_IDS` sets are identical across languages.
- **Skipped when Compose isn't adjacent** so stratum-only clones and partial-repo CI don't fail. In normal dev trees (both repos as siblings under `forge/`) the guard runs every `pytest` invocation.
- **Why now:** the 2026-04-19 codex hang was caused by the JS connector migrating to direct `codex exec --json` while the Python connector stayed on opencode. That class of drift would have been caught in seconds by this guard. Band-aid until the final v3 refactor eliminates the two-trees invariant. Retire this file when v3 lands. **874 passing, 2 skipped.**

### stratum-mcp — T2-F5-DEPENDS-ON

- **`ParallelExecutor` now respects `task.depends_on`** at dispatch time. Previously ignored — all tasks fanned out immediately under `asyncio.gather`. Now: dependent tasks wait on per-task `asyncio.Event`s until their upstreams reach a terminal state. Dep-wait happens outside the semaphore (waiting tasks don't consume concurrency slots) but inside the outer `try` (early returns on unknown-dep or upstream-failure unwind through the existing finally, invoking `_require_unsatisfiable` / `_cancel_siblings` correctly).
- **Upstream failure → dependent cancels** with `state="cancelled"` and an error naming the upstream task and its terminal state. Under `require: "all"`, this cascades via the existing unsatisfiable check.
- **Cycle detection via DFS** (`_detect_dependency_cycle`, WHITE/GRAY/BLACK) runs before `asyncio.gather`. Direct or transitive cycles fail all tasks with `error="dependency cycle detected: A -> B -> A"`; no task handles are created. Unknown task_id references in `depends_on` (typos, stale decompose output) are NOT flagged as cycles — they're caught at wait-time with a clearer per-task error.
- **Event-set placement is load-bearing**: `_task_done[tid].set()` fires at the top of the outer `finally`, immediately after state normalization, BEFORE any await that might raise `CancelledError` (diff capture via `asyncio.to_thread`, persist under per-flow lock). Downstream waiters always unblock, even if we're cancelled mid-cleanup.
- **12 new tests** covering linear chains, diamonds, direct + transitive cycles, unknown-deps-aren't-cycles, cascade-on-dep-failure (require:all), and semaphore-starvation regression (max_concurrent=1 linear chain). **855 total passing.**
- **Out of scope (by design):** cross-worktree state propagation. A dependent task that needs an upstream's filesystem output still gets a fresh worktree from HEAD; it won't see the upstream's changes without explicit diff application by the consumer (Compose does this via T2-F5-DIFF-EXPORT + client-side topological merge).

### stratum-mcp — T2-F5-DEFER-ADVANCE

- **`defer_advance: bool` IR field on `parallel_dispatch` steps** — opt-in, default false. When true, `stratum_parallel_poll` returns a sentinel `{status: "awaiting_consumer_advance", aggregate: {...}}` on terminal instead of auto-advancing. Validator rejects non-bool at parse time via `IRValidationError`.
- **`stratum_parallel_advance(flow_id, step_id, merge_status)` MCP tool** — consumer-driven advance. Feeds `merge_status` ('clean' | 'conflict') into `_evaluate_parallel_results` before calling `_advance_after_parallel`, then pops `(flow_id, step_id)` from `_RUNNING_EXECUTORS`. STRAT-IMMUTABLE-gated (mirrors `stratum_parallel_done` / `stratum_step_done`). Idempotent — returns minimal `{status: "already_advanced", step_id}` if the flow moved past. Enumerated errors: `flow_not_found`, `unknown_step`, `wrong_step_type`, `advance_not_deferred`, `invalid_merge_status`, `step_not_dispatched`, `tasks_not_terminal`, plus the existing `spec_modified` integrity envelope on tampered specs.
- **`_step_fingerprint` fixed** — now covers `capture_diff` (pre-existing gap) and `defer_advance`. Both fields gate consumer input into `process_step_result`, so a spec tamper flipping either between plan and advance must invalidate the integrity check. No baseline-hash test updates needed (existing fixtures don't set either flag so their checksums are unchanged via `getattr(..., False)` defaults). **Migration note:** any flow that was *persisted with* `capture_diff: true` under the old schema will get a different checksum after this change; drain in-flight flows or re-plan before upgrading if production runs use the field. Fresh flows planned after the upgrade are unaffected.
- **Unblocks T2-F5-CONSUMER-MERGE-STATUS-COMPOSE** — Compose consumer extension that routes `isolation: "worktree"` + `capture_diff: true` through defer-advance, reporting merge_status back properly and fixing the `buildStatus='complete'` regression from T2-F5-COMPOSE-MIGRATE-WORKTREE W1.
- **14 new tests** (3 schema + 3 poll-sentinel + 2 fingerprint + 9 advance-tool including STRAT-IMMUTABLE tamper detection), **843 total passing**. 2 rounds of design review, 0 blockers at implementation.

### stratum-mcp — T2-F5-DIFF-EXPORT

- **`capture_diff: bool` field on `parallel_dispatch` steps** — opt-in per-task diff capture for server-dispatched parallel steps. Default `false`; silently ignored when `isolation: "none"` (gated in `stratum_parallel_start` with `cur_step.capture_diff and isolation == "worktree"`). Rejected at parse time if non-bool (JSON schema layer fires `IRValidationError` before `_build_step`'s defense-in-depth guard).
- **`ParallelTaskState.diff` / `.diff_error`** — new fields on the terminal state dataclass. `diff` is `None` when not requested or when the worktree was already gone; `""` when captured with no changes; non-empty unified-diff text otherwise. `diff_error` carries a short `{ExceptionType}: {message}` string when capture raised, kept separate from `error` so a successful task whose diff capture fails doesn't look "failed" to consumers. Both auto-serialize through `dataclasses.asdict()` in `persist_flow`.
- **`capture_worktree_diff(path)`** in `worktree.py` — runs `git -c core.hooksPath=/dev/null add -A` then `git -c core.hooksPath=/dev/null diff --cached HEAD` in the worktree, 30s timeout each, `errors="replace"` decode for binary-safe output. Hooks-path override prevents parent-repo pre-commit hooks from firing in the ephemeral worktree. `.gitignore` is respected (no `node_modules`, no `.env` leaks into flow state JSON).
- **Capture site in `_run_one` finally** — `await asyncio.to_thread(capture_worktree_diff, worktree_path_obj)` runs before `remove_worktree` when `self.capture_diff` is truthy. Exceptions are swallowed into `diff_error`. Sibling tasks aren't blocked because the subprocess runs in a thread.
- **Connector-setup failure path fix** — `worktree_path_obj = None` after the inline `remove_worktree` so the finally block skips its capture attempt on a deleted path (previously would have populated a spurious `diff_error` on every pre-execution failure when `capture_diff=True`).
- **Unblocks T2-F5-COMPOSE-MIGRATE for `isolation: "worktree"` paths.** Compose will read `tasks[task_id].diff` from the poll response and hand it to its existing topological-merge logic; the Compose consumer extension ships as a separate follow-up feature.
- 13 new tests (5 `test_worktree.py` unit tests including binary + gitignore behavior, 3 `test_parallel_schema.py` accept/default/reject tests, 5 `test_parallel_exec.py` integration tests including the connector-setup-failure-is-clean case). **825 total passing, 2 skipped.**

### stratum-mcp — T2-F5-ENFORCE

- **`stratum_parallel_start` / `stratum_parallel_poll` MCP tools** — server-side dispatch for `parallel_dispatch` steps. `_start` schedules a `ParallelExecutor` via `asyncio.create_task`, registers the handle in `_RUNNING_EXECUTORS`, and returns immediately with a task list. `_poll` returns per-task state, summary counts, `require_satisfied`, `can_advance`, and advances the flow idempotently when all tasks are terminal. The legacy `stratum_parallel_done` path is preserved byte-identically via the extracted `_evaluate_parallel_results(state, step, task_results)` helper shared by both paths.
- **`ParallelExecutor`** (`stratum_mcp/parallel_exec.py`) — drives N tasks concurrently bounded by `Semaphore(max_concurrent)`, per-task `asyncio.wait_for(task_timeout)`, optional git-worktree isolation, per-task cert validation, and a per-flow `asyncio.Lock` around `persist_flow`. Cascade cancel on unsatisfiable require (`all`/`any`/integer): failing tasks trigger `.cancel()` + `connector.interrupt()` on siblings. Uses `asyncio.gather(return_exceptions=True)` rather than `TaskGroup` so `_run_one` owns its own exception handling and always reaches a terminal state.
- **`connectors/factory.py`** — `make_agent_connector(agent_type, model_id, cwd)` extracted from `server.py` so `server.py` and `parallel_exec.py` share a single factory without a circular import. Server-dispatch v1 supports `claude` and `codex` only; `opencode` is explicitly rejected with a pointer to roadmap **T2-F5-OPENCODE-DISPATCH**. Opencode agent strings remain valid for legacy consumer-dispatch.
- **`SENSITIVE_ENV_VARS`** (`connectors/base.py`) — `("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CLAUDE_API_KEY", "CLAUDECODE")`. Previously only `CLAUDECODE` was stripped by claude and `OPENAI_API_KEY` by opencode; the rest leaked through. Claude/opencode/codex connectors now all scrub the full list at the connector layer (defense-in-depth), and `ParallelExecutor._task_env` scrubs again before dispatch while injecting `STRATUM_FLOW_ID`, `STRATUM_STEP_ID`, `STRATUM_TASK_ID`.
- **`AgentConnector.run(..., env=None)`** — trailing keyword-only parameter so the parallel path can hand each concurrent task its own env dict without mutating `os.environ`. `None` preserves legacy behavior.
- **`OpencodeConnector.interrupt()`** — sends `SIGTERM`, schedules `SIGKILL` after a 5-second grace period via a background asyncio task. Idempotent against missing/exited processes. `CodexConnector` inherits. `ClaudeConnector.interrupt()` stays no-op (tracked as **T2-F5-CLAUDE-CANCEL** — the claude-agent-sdk has no cancel API today).
- **`worktree.py`** — `create_worktree(flow_id, task_id, base_cwd) -> Path` runs `git worktree add --detach <target> HEAD` under `~/.stratum/worktrees/<flow_id>/<task_id>`, deliberately outside the source repo. `remove_worktree(path, force=True)` best-efforts via git then falls back to `shutil.rmtree(ignore_errors=True)`. `Path.home()` is resolved lazily so tests can monkeypatch it.
- **`task_timeout` field** on `parallel_dispatch` steps — v0.3 schema gains `{"type": ["integer","null"], "minimum": 1}`, additive with no IR version bump. `IRStepDef.task_timeout` reaches the executor via `_build_step`. `_parallel_dispatch_only` now also gates `task_timeout` AND `max_concurrent` — the latter was parallel-only in practice but never gated; blueprint review surfaced the gap.
- **`FlowState.parallel_tasks` / `FlowState.cwd`** — `ParallelTaskState` dataclass (`task_id`, `state`, `started_at`, `finished_at`, `result`, `error`, `cert_violations`, `worktree_path`; states `pending|running|complete|failed|cancelled`) persists and restores via `dataclasses.asdict` + targeted reconstruction. `stratum_plan` captures `os.getcwd()` so the parallel path can anchor worktrees to the caller's repo. Legacy flows deserialize with sane defaults (no migrate.py change).
- **Shutdown + resume lifecycle** — `shutdown_all(_RUNNING_EXECUTORS)` wired into a `try/finally` around `mcp.run()` cancels in-flight executor tasks cleanly. On startup, `resume_interrupted_parallel_tasks(flow_root)` flips any persisted `state='running'` entries to `state='failed'` with `error='server restart interrupted task'` so interrupted work is observable. Full subprocess reparenting is tracked as **T2-F5-RESUME**.
- **Documented deferrals** (all on roadmap): T2-F5-OPENCODE-DISPATCH, T2-F5-BRANCH (`isolation: branch` rejected at dispatch with a clear error), T2-F5-DEPENDS-ON (`depends_on` edges not respected — tasks run concurrently), T2-F5-STREAM (no event streaming — consumer polls), T2-F5-CLAUDE-CANCEL, T2-F5-RESUME, T2-F5-COMPOSE-MIGRATE, T2-F5-LEGACY-REMOVAL.
- **No `migrate.py` edits.** Legacy `stratum_parallel_done` integration behavior is byte-identical.
- 70 new tests (`test_connector_factory`, `test_connectors_env`, `test_connectors_interrupt`, `test_spec_task_timeout`, `test_worktree`, `test_flowstate_parallel`, `test_parallel_exec`, `test_parallel_server_dispatch`). **812 total passing, 2 skipped.**

### stratum-mcp — T2-PAR-5

- **`stratum-mcp migrate <file>` CLI** — upgrades a `.stratum.yaml` spec from its declared IR version to the latest registered version (or `--to VERSION` to pin). Preview-and-confirm by default; `--yes` to skip the prompt, `--dry-run` to preview only, `--interactive` to prompt per opportunistic upgrade.
- **Transform registry architecture** — versioned `Transform` + optional `Upgrade` dataclasses in `stratum_mcp/migrate.py`. Registry is a graph of `from_version → to_version`; `walk_registry` does BFS with `UnknownVersion` / `NoTransformPath` distinguishing "version outside SCHEMAS" from "valid version, no migration chain". Numeric tuple version ordering (`0.10 > 0.9`).
- **Today's only registered transform:** `0.2 → 0.3` as a pure version-string bump (v0.3 is a backward-compatible superset of v0.2). Framework is ready to accept structural transforms and opportunistic upgrades when v0.4+ lands — one registry entry + tests, no CLI changes.
- **Formatting preserved** — uses `ruamel.yaml` in round-trip mode with source-derived indent detection (`_detect_sequence_style`, `_detect_mapping_indent`) so comments, blank lines, quote style, and both mapping and sequence indentation survive the migration. Tested against 4/2-indented and 2/0-indented specs, 2-space and 4-space mapping indent.
- **`--output PATH`, `--backup`, `--force`** — divert the write to a new path, save a `.bak` next to the original, or allow overwriting an existing `--output` target. Atomic write (tempfile + `os.replace`) avoids partial writes on crash.
- **Exit-code contract:** `0` success/no-op, `1` validation or I/O failure or flag misuse, `2` user declined, `3` unknown version or no transform path. Manual `argv` parsing to keep exit codes under control (stdlib `argparse` would exit 2 on flag misuse).
- **Shape guard** handles non-mapping YAML roots (`[]`, scalars) and non-string `version` fields without leaking `AttributeError` from `parse_and_validate`.
- **Dependency added:** `ruamel.yaml>=0.18` (side-by-side with `pyyaml`, no conflict).
- 41 new tests (`tests/test_migrate.py`), 742 total passing.

### stratum-mcp — T2-F5

- **`stratum_agent_run` MCP tool** — dispatches prompts to claude or codex with a Node-compatible contract (`modelID`, `parseError`, errors raised as exceptions rather than wrapped in payloads). Schema mode injects JSON-Schema into the prompt and extracts the last ```json block from the response.
- **`stratum_mcp.connectors` package** — new Python connectors ported from the Node.js originals:
  - `AgentConnector` ABC with `inject_schema()` helper (byte-for-byte matches the Node `injectSchema()` output)
  - `ClaudeConnector` — wraps `claude-agent-sdk` `query()`. Uses `{type: "preset", preset: "claude_code"}` tools by default so default behavior matches the Node connector's `claude_code` preset. Strips `CLAUDECODE` env var for nested execution.
  - `OpencodeConnector` — spawns `opencode run --format json` asynchronously. Parses `text`, `tool_use`, and `step_finish` events into the shared envelope. Handles rate-limit/auth errors on stderr and stall detection on 120s silence. Yields a friendly error event when the `opencode` binary is missing.
  - `CodexConnector` — extends `OpencodeConnector`, validates against `CODEX_MODEL_IDS` at both construction and run time.
- **`claude-agent-sdk>=0.1.56,<0.2`** added to dependencies.
- 27 new tests (connector unit + MCP tool integration + opt-in live smoke behind `STRATUM_LIVE_AGENT_TESTS=1`). 676 total passing.

### stratum-mcp — STRAT-CERT-PAR

- **`task_reasoning_template` IR field** on `parallel_dispatch` steps — per-task certificate validation template. CERT-1 restriction on `reasoning_template` (step-result validator) preserved; use `task_reasoning_template` for per-task validation.
- **`_apply_cert_defaults()` refactor** — accepts `field_name` parameter so the same defaulting/validation logic handles both `reasoning_template` and `task_reasoning_template`.
- **`_parallel_dispatch_only` tuple** — `task_reasoning_template` added, automatically forbidden on decompose and legacy step types.
- **Claude-agent gate alignment** — 4 sites updated from exact-match `in ('claude', '')` to `startswith('claude')` so profile agents (e.g. `claude:read-only-reviewer`) are consistently validated, have certs injected, and pass on_fail viability checks:
  - `executor.py` inline cert injection
  - `executor.py` decompose cert injection
  - `executor.py` inline cert validation in `process_step_result`
  - `spec.py` `on_fail` viability check
- **`validate_certificate()` reasoning fallback** — reads from `result["artifact"]`, falls back to `result["reasoning"]` for consumer compatibility.
- **Per-task cert validation in `stratum_parallel_done`** — runs before require/merge evaluation, flips cert-failed tasks to `status="failed"` so they count against the require threshold naturally. Violations collected once and merged into every failure-response path (require-fail, merge-conflict, ensure-failed on aggregate, on_fail_routed, retries_exhausted).
- 18 new tests, 647 total passing.

### stratum-mcp — STRAT-SCORE

- **`score_expr` field on `IRStepDef`**: optional numeric scoring expression for iteration loops (requires `max_iterations`)
- Validation: rejected on gate steps, decompose/parallel_dispatch steps, and when missing `max_iterations`; dunder guard applied

### stratum-mcp — STRAT-PAR (T2-PAR-1 through T2-PAR-4)

- **IR v0.3 schema**: `decompose` and `parallel_dispatch` step types. Backward-compatible superset of v0.2.
- **`decompose` step**: agent-executed step emitting TaskGraph (`files_owned`, `files_read`, `depends_on`)
- **`parallel_dispatch` step**: concurrent execution with `max_concurrent`, `isolation`, `require`, `merge`, `intent_template`
- **`no_file_conflicts` ensure builtin**: validates no two independent tasks share `files_owned`; transitive dependency aware
- **`stratum_parallel_done` MCP tool**: batch result reporting with require semantics (all/any/N), merge conflict detection
- **Semantic validation**: decompose requires agent+intent+output_contract; parallel_dispatch requires source+intent_template
- 30 new tests (479 total passing)

### stratum-py

- `@pipeline` / `@phase` decorators — pipeline authoring model; metadata capture and IR compilation separate from MCP execution mode
- `Capability` and `Policy` enums — capability tiers for connector routing and policy overrides
- `stratum.toml` project config — policy overrides, capability mapping, connector routing
- Run workspace convention — `.stratum/runs/{run-id}/{phase-id}.json` output passing between phases
- File-based gate protocol — `.gate` / `.gate.approved` / `.gate.rejected` files for human approval checkpoints
- Pipeline runtime loop — `run_pipeline()` drives `@pipeline` classes through phases via `Connector`

**Bug fixes**

- `run()` now detects closed event loops and creates a fresh one instead of raising `RuntimeError: Event loop is closed` — resolves e2e test failures after first loop close
- `run()` closes the passed coroutine before raising on a running-loop path — eliminates "coroutine never awaited" warning
- `run()` drains pending async tasks (both on normal return and exception paths) before closing the loop — prevents dropped telemetry callbacks (e.g. litellm `async_success_handler`)
- Anthropic (claude-*) models now receive `cache_control: {type: ephemeral}` blocks on system message, user message, and tool definition — restores prompt caching behavior that reduces cost and latency
- `datetime.utcnow()` replaced with `datetime.now(timezone.utc)` throughout — clears Python 3.12 deprecation warnings

**Testing**

- T1-11: 17-test end-to-end suite (`tests/test_e2e.py`) runs against a real LLM (gpt-4o-mini via OpenAI) — validates `@infer`, `@compute`, `@flow`, `ensure` postconditions, `PostconditionFailed`, `TraceRecord` fields, trace accumulation, `clear_traces`, and `stratum.run()` sync shim

### stratum-mcp

**New MCP tools**

- `stratum_commit` — checkpoint the current flow state under a named label; label recorded in audit trace
- `stratum_revert` — roll back flow state to a named checkpoint; revert event recorded in trace

**MCP server improvements**

- FlowState persistence — flows survive MCP server restarts; state written to `~/.stratum/flows/{flow_id}.json` after each step
- `output_schema` validation in `stratum_step_done` — JSON Schema checked before `ensure` expressions; returns `schema_failed` with violations if invalid
- `ensure` file-aware builtins — `file_exists(path)` and `file_contains(path, substring)` available in postcondition expressions
- `stratum-mcp validate <file>` CLI — validates a `.stratum.yaml` file from the command line
- `stratum-mcp compile <tasks-dir>` CLI — compiles `tasks/*.md` acceptance criteria into `.stratum.yaml` IR (task compiler)

**Skills (ten total)**

- `/compose` — full feature lifecycle skill; emits `.stratum.yaml`, drives spec-kit phases through `stratum_plan` loop
- `/stratum-speckit` — bridge skill; drives spec-kit phases through Stratum, emits compiled flow
- `/stratum-build` — compiles `tasks/` → `.stratum.yaml` and drives execution via `stratum_plan` loop
- Memory sections added to all skills — read project `MEMORY.md` before writing spec; write new patterns after `stratum_audit`

**Memory & Hooks (Tier 1 — MEMORY.md)**

- `SessionStart` hook — auto-injects relevant `MEMORY.md` entries at session open
- `Stop` hook — auto-appends session summary to `MEMORY.md` at session close
- `PostToolUseFailure` hook — auto-records `ensure` failures and tool errors

**Memory (Tier 2 — SmartMemory lite, opt-in)**

- `SessionStart` hook — `memory.search()` for project-relevant context
- `Stop` hook — `memory.ingest()` session summary as episodic memory
- `PostToolUseFailure` hook — `memory.ingest()` failures as observation memory
- Skills use `memory.search()` instead of `MEMORY.md` when lite backend configured (`pip install smartmemory[lite]`)

**Track 3 — Compose + Stratum + spec-kit**

- Task→step compiler — `tasks/*.md` acceptance criteria → `.stratum.yaml` `ensure` expressions
- Compose skill adopts spec-kit artifact format — design phases produce `spec.md`, `plan.md`, `tasks/` under `.specify/`
- Compose web app (Vision Surface) integration:
  - Startup seed from `.specify/` — work items created from spec-kit directories on load, updated on file change
  - Live stratum flow sync — 15s poller maps bound flows to Vision items; detects `running`, `blocked` (retries exhausted = ensure violations), `paused`; clears stale violation evidence on recovery
  - Audit trace surfaced in item evidence panel — `stratum_audit` trace stored in `evidence.stratumTrace`; item transitions to `complete` on flow completion

**Testing:** 211 tests passing (up from 79 at 0.1.3)

**IR v0.2 — Gate / Round / Skip primitives**

- `mode: gate` on functions — gate steps return `await_gate` instead of `execute_step`; `stratum_step_done` rejects gate steps; `stratum_gate_resolve` required
- `stratum_gate_resolve` MCP tool — resolves gate steps with `approve | revise | kill`; `resolved_by: human | agent | system`; GateRecord written to trace
- `stratum_check_timeouts` MCP tool — auto-kills gate steps that exceed their `timeout` (seconds); fires with `resolved_by: system`
- Round archiving — `revise` archives the active round into `state.rounds`; resets active trace; increments `state.round`; `stratum_audit` returns `rounds: [{round, steps}]` unconditionally
- `max_rounds` on flow definitions — `resolve_gate` returns `max_rounds_exceeded` error when round limit reached; GateRecord written but not archived
- `skip_if` / `skip_reason` on steps — Boolean expression evaluated before dispatch; `$.steps.X.output.field` refs resolved inline; SkipRecord written, output set to None; downstream refs propagate None
- `on_approve` / `on_revise` / `on_kill` routing — null = default terminal behaviour; named = route to that step; kill routing sets `terminal_status = "killed"` regardless of named cleanup step
- `terminal_status` on FlowState — `stratum_audit` returns `status: killed` when set; `stratum_step_done` complete path uses `terminal_status or "complete"`

**IR v0.2 semantic validation (enforced at parse time)**

- Gate functions: `ensure`, `budget`, `retries` forbidden
- Gate steps: `skip_if` forbidden; `on_approve` and `on_kill` must be explicitly declared (even if null); `on_revise` must be non-null, must not self-reference, must target a topologically-earlier step
- Non-gate steps: `on_approve`, `on_revise`, `on_kill` forbidden
- `declared_routing: frozenset` tracks which routing fields were explicitly present in YAML (distinguishes absent from null)
- `retries_explicit: bool` tracks whether `retries` was explicitly declared
- `_topo_positions()` computes topological execution order for `on_revise` ordering invariant
- YAML `true` / `false` / `null` recognised in `skip_if` expressions in addition to Python-style literals
- All server tool paths call `get_current_step_info()` before `persist_flow()` — skip mutations durable across restarts

**Testing:** 305 tests passing (+94); new files: `test_gate_api.py` (9 contract tests), `test_gate_revise.py` (6 integration tests); `test_ir_schema.py` +12 v0.2 semantic invariant tests

**STRAT-ENG-1: IR v0.2 inline steps, workflow declarations, flow composition**

- `workflow:` block — self-registering workflow declaration with name, description, input schema
- `stratum_list_workflows` MCP tool — scans a directory for `*.stratum.yaml` files with `workflow:` blocks; returns name/description/input/path; detects duplicate names
- Inline steps — `intent:` + `agent:` on steps (mutually exclusive with `function:` and `flow:`); step-level `ensure`, `retries`, `output_contract`, `model`, `budget`
- `flow:` composition — `flow_ref` on steps for sub-workflow invocation (parsed and validated; execution deferred to STRAT-ENG-5)
- `on_fail` / `next` routing on non-gate steps — `on_fail` requires `ensure`; `on_fail` without `ensure` rejected on both inline and flow_ref steps
- `policy` / `policy_fallback` on gate steps — parsed and validated (`policy_fallback` requires `policy`); evaluation deferred to STRAT-ENG-3
- Mode exclusion validation — exactly one of `function`, `intent`, `flow` required per step
- Workflow input validation — `workflow.input` keys must exactly match entry flow input keys

**Testing:** +33 tests; new files: `test_ir_v02_extensions.py` (29 tests), `test_list_workflows.py` (4 tests)

**STRAT-ENG-2: Executor — state model, agent passthrough, inline step execution**

- `_step_mode()` helper — returns `"function"` or `"inline"`; raises `MCPExecutionError` for `flow_ref` (deferred to STRAT-ENG-5)
- `StepRecord` extended — `agent: str | None` and `step_mode: str` fields with backward-compatible defaults
- `get_current_step_info` restructured — mode-branched dispatch; function steps use `fn_def.ensure/retries`, inline steps use `step.step_ensure/step_retries`; `fn_def` lookup moved after `skip_if` evaluation
- `process_step_result` restructured — mode-branched for ensure/retries/output_schema; `_make_record()` helper for StepRecord creation
- `stratum_step_done` gate guard updated — handles inline steps (`function=""`)
- `MCPExecutionError` handling — all `get_current_step_info` call sites wrapped in server.py (3 locations)
- `retries_exhausted` response enriched — includes `step_mode` and `agent` fields

**Testing:** +27 tests; new file: `test_inline_steps.py` (27 tests)

**STRAT-ENG-3: Executor — gate policy evaluation, explicit skip**

- `PolicyRecord` — new audit trace type (`type: "policy"`) for auto-resolved gates; `_record_from_dict` updated for persistence
- `apply_gate_policy()` — evaluates `step.policy ?? "gate"`; `skip`/`flag` auto-approve with PolicyRecord and on_approve routing; does NOT call `resolve_gate` (no GateRecord for auto-approved gates)
- `_apply_policy_loop()` — server-layer loop handling chained auto-approved gates with visited-set cycle detection
- `skip_step()` — extracted helper from `get_current_step_info` skip_if path; gate steps rejected
- `stratum_skip_step` MCP tool — explicit step skipping with reason; gate steps return error
- Policy loop wired into `stratum_plan`, `stratum_step_done`, `stratum_gate_resolve`, `stratum_check_timeouts`

**Testing:** 349 tests passing (+44 from ENG-1/2/3); new file: `test_policy_skip.py` (29 tests)

**STRAT-ENG-4: Executor — per-step iteration tracking**

- `max_iterations` and `exit_criterion` on steps — counted sub-loops with automatic exit on criterion met or max reached; semantic validation (gate steps forbidden, `exit_criterion` requires `max_iterations`, dunder guard)
- `start_iteration()` / `report_iteration()` / `abort_iteration()` — executor functions for iteration lifecycle; `compile_ensure`-based criterion evaluation; append-only history in `state.iterations`
- `stratum_iteration_start` / `stratum_iteration_report` / `stratum_iteration_abort` MCP tools — full tool interface for iteration control
- `iteration_outcome` handoff — persists between iteration exit and `stratum_step_done` for ENG-5 routing; consumed on step completion, cleared on revise
- `archived_iterations` — parallel list to `rounds[]` preserving iteration history across gate revise cycles without breaking `rounds[]` shape
- Persistence — iteration state included in `persist_flow`, `restore_flow`, `commit_checkpoint`, `revert_checkpoint`
- `stratum_audit` — returns `iterations` and `archived_iterations` in audit output
- Inline steps support iteration (agent-based steps with `max_iterations`)

**Testing:** 378 tests passing (+29); new file: `test_iterations.py` (24 tests); `test_ir_v02_extensions.py` +5 contract tests

**STRAT-ENG-5: Executor — routing and flow composition**

- `on_fail` routing — when a step exhausts retries (ensure or schema failure), routes to the named recovery step instead of terminating; failed step output preserved via `_clear_from(preserve=)` for downstream access
- `next` routing — overrides linear step advancement on success; enables review→fix→review loops; target step's attempts cleared for fresh execution
- `on_fail` validator fix — now accepts function-level `fn_def.ensure` and `output_schema` as valid triggers (previously only checked `step_ensure`)
- `_find_step_idx` / `_clear_from` helpers — extracted from `resolve_gate` on_revise; reused by `on_fail`, `next`, and flow composition; `_clear_from` clears attempts, outputs, iteration state, and `active_child_flow_id`
- `flow:` sub-execution — `_step_mode` returns `"flow"` for `flow_ref` steps; `get_current_step_info` creates child FlowState, returns `execute_flow` status; idempotent (reuses existing child); stale child recovery (clear and re-create)
- Result unwrapping — server extracts `result.get("output")` from child payload before calling `process_step_result`; `None` on child failure triggers parent ensure/on_fail chain
- Child audit snapshots — `_build_audit_snapshot` helper captures full child state (trace, rounds, iterations) before deletion; accumulated in `FlowState.child_audits[step_id]` across retries
- `StepRecord.child_flow_id` — set for flow_ref steps; persisted and restored
- FlowState fields — `parent_flow_id`, `parent_step_id`, `active_child_flow_id`, `child_audits`; included in persist/restore and checkpoint commit/revert
- `stratum_step_done` — `on_fail_routed` branch (same as `"ok"` + routing metadata); flow_ref child cleanup on all completion paths (ok, retries_exhausted, ensure_failed, on_fail_routed)
- `stratum_audit` — includes `child_audits` in response

**Testing:** 414 tests passing (+36); new files: `test_routing.py` (13 tests), `test_flow_composition.py` (20 tests); `test_ir_v02_extensions.py` +2 contract tests; `test_inline_steps.py` updated for flow_ref

**STRAT-ENG-6: Contract freeze**

- Frozen contract document — `docs/features/STRAT-ENG-6/design.md` covers spec shape (IR v0.2), MCP tool signatures, flow state (persisted JSON), and audit output
- Normalized error envelope — all error responses now use `error_type` consistently; `resolve_gate()` errors and inline server errors previously used `code`
- `stratum_audit` flow-not-found — now returns `status: "error"` (previously omitted)
- CLI gate handler — updated to read `error_type` from executor return dicts (was `code`)

**STRAT-ENG-HOOKS: Centralized hook installation**

- Hook scripts install to `~/.stratum/hooks/` — single copy shared across projects (was per-project `.claude/hooks/`)
- Absolute paths in settings.json — `bash /abs/path/to/script.sh` (was relative `bash .claude/hooks/script.sh`)
- Migration — `stratum-mcp install` auto-cleans old per-project copies and replaces relative-path settings entries
- Mixed entry safety — migration and uninstall filter individual commands from hook entries, preserving colocated non-Stratum hooks

**Testing:** 418 tests passing (+4)

---

## [0.1.3] — 2026-02-23

### Added

- `stratum-mcp uninstall` CLI command — removes Stratum config from a project: deletes `stratum` entry from `.claude/mcp.json` (removes file if empty), strips `## Stratum Execution Model` block from `CLAUDE.md` (removes file if empty), removes installed skills from `~/.claude/skills/`; `--keep-skills` flag preserves user-customized skill files
- 13 new tests for `uninstall` (mcp.json removal, CLAUDE.md removal, skill removal, `--keep-skills`, roundtrip setup→uninstall→setup, idempotency messaging) — 79 total passing

### Added

**MCP server (Track 2) — `stratum-mcp`**

- `stratum_validate` — validates a `.stratum.yaml` IR spec; returns `{valid, errors}`
- `stratum_plan` — validates a spec, creates in-memory flow execution state, returns the first step to execute with resolved inputs and output contract details
- `stratum_step_done` — accepts a completed step result from Claude Code, checks `ensure` postconditions, returns next step or flow completion; handles retries and exhaustion
- `stratum_audit` — returns per-step execution trace (attempts, duration) for an active or completed flow
- MCP controller model: Claude Code is the executor; the server manages plan state and enforces contracts — no sub-LLM calls, no separate API billing
- `FlowState` — in-memory execution state per flow: ordered steps, accumulated outputs, attempt counts, dispatch timestamps, step records
- `ensure` expressions evaluated by the server against Claude Code's reported output (Python expressions, dunder-blocked, SimpleNamespace-wrapped for dict access)
- `$.input.<field>` and `$.steps.<id>.output[.<field>]` reference resolution for chaining step outputs
- Kahn's topological sort on explicit `depends_on` + implicit `$.steps.*` ref dependencies
- `stratum-mcp install` — one-command project configuration: writes `.claude/mcp.json` (MCP server registration), appends execution model block to `CLAUDE.md`, and installs seven Claude Code skills to `~/.claude/skills/`; idempotent, finds project root via `.git` or `CLAUDE.md`
- Nine Claude Code skills installed by `setup`: `stratum-onboard` (read codebase cold, write `MEMORY.md` from scratch), `stratum-plan` (design feature, present for review — no implementation), `stratum-review` (three-pass code review), `stratum-feature` (read → design → implement → test), `stratum-debug` (hypothesis formation and elimination), `stratum-refactor` (extraction order planning, no broken intermediate states), `stratum-migrate` (rewrite bare LLM calls as `@infer` + `@contract`), `stratum-test` (write test suite for existing code — golden flows, error-path harness), `stratum-learn` (extract patterns from session transcripts into `MEMORY.md`)
- Each skill contains a spec template Claude adapts internally — YAML never shown to the user; Claude narrates in plain English
- All skills include a `## Memory` section: read project `MEMORY.md` before writing spec (incorporate `[stratum-<skill>]` tagged patterns); write new patterns after `stratum_audit`
- CLI triple-mode: `stratum-mcp install`, `stratum-mcp validate <file>`, stdio MCP transport
- 66 passing tests across contracts, invariants, and integration suites

**Dependencies:** `mcp>=1.0`, `jsonschema>=4.20`, `pyyaml>=6.0` — no stratum library dependency

### Architecture decision

The MCP server does not use the Track 1 stratum library at runtime. Executing infer steps via the library (litellm) would spawn separate billed API calls outside the Claude Code subscription. The MCP controller model keeps all execution inside the running Claude Code session: Claude Code writes the spec, reports step results, and the server tracks state and enforces contracts.

---

## [0.1.0] — 2026-02-23

### Added

**Core library (Track 1)**

- `@contract` — registers a pydantic `BaseModel` subclass as a typed contract; generates JSON Schema via `model_json_schema()`, stores a 12-char content hash for drift detection
- `@infer` — LLM-backed inference step; async-first, typed return, structured retry on `ensure` failure, budget enforcement, session cache, OTLP trace records
- `@compute` — deterministic step marker; function executes normally, composes identically with `@infer` at call sites
- `@flow` — async flow wrapper; injects `flow_id` + `Budget` clone into a `ContextVar` so nested `@infer` calls inherit them without explicit passing; session cache scoped per flow execution
- `@refine` — convergence loop stacked on `@infer`; iterates with feedback context until `until(result)` passes or `max_iterations` exhausted → `ConvergenceFailure`
- `parallel(require=)` — `"all"` / `"any"` / N / `0` modes using `asyncio.TaskGroup`; `require=0` returns `list[Success | Failure]`
- `race()` — alias for `parallel(require="any")`
- `debate()` — multi-agent structured argumentation with rebuttal rounds and a synthesizer step
- `await_human()` — HITL gate; suspends flow until a `ReviewSink` resolves a `PendingReview`; supports `timeout` and `on_timeout`
- `quorum=` on `@infer` — runs N parallel calls, asserts `threshold` agreement on `agree_on` field, returns highest-confidence agreeing result
- `stable=False` on `@infer` — return type becomes `Probabilistic[T]`; caller must call `.most_likely()`, `.sample()`, or `.assert_stable()`
- `stable=True` test mode — when `stratum.configure(test_mode=True)` is set, samples `sample_n` times and raises `StabilityAssertionError` if outputs are not unanimous
- `Probabilistic[T]` — wraps a sample of LLM outputs; `.most_likely()`, `.sample()`, `.assert_stable(threshold)`
- `Budget(ms=, usd=, tokens=)` — time + cost + token envelope; enforced via `asyncio.timeout` and LiteLLM cost tracking
- OTLP trace export — built-in emitter posts spans over HTTP/JSON to any OTLP endpoint; no OTel SDK dependency; `traceId` derived from `flow_id` so all `@infer` spans in a flow share a trace
- `opaque[T]` annotation — marks fields excluded from the tool-call schema (present in output but not constrained)

**Exceptions**

- `StratumCompileError` — static violations at decoration time
- `PreconditionFailed` — `given` condition false before LLM call
- `PostconditionFailed` — `ensure` violations after all retries
- `ParseFailure` — LLM output cannot be parsed against contract schema
- `BudgetExceeded` — time or cost budget exceeded
- `ConvergenceFailure` — `@refine` exhausted `max_iterations`
- `ConsensusFailure` — `quorum` could not reach `threshold` agreement
- `ParallelValidationFailed` — `parallel` `validate` callback returned False
- `HITLTimeoutError` — `await_human` wall-clock timeout with `on_timeout="raise"`
- `StabilityAssertionError` — `Probabilistic[T].assert_stable()` below threshold

### Dependencies

- `litellm>=1.0` — LLM client, multi-model routing, cost tracking
- `pydantic>=2.0` — required; `@contract` requires `BaseModel`
- Python 3.11+ — `asyncio.TaskGroup`, `asyncio.timeout`
