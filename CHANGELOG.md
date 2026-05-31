# Changelog

## [Unreleased]

### stratum — feat(STRAT-WORKFLOW-BG): server-driven background flow execution (v1 linear driver)

- **What:** a `_background_flow_advance` loop drives a flow through `function`/`inline` steps **autonomously** — dispatching each step's agent itself via `stratum_agent_run` — instead of the consumer round-tripping every step via `stratum_step_done`. Start with `stratum_flow_run_bg(flow_id)` (the session is then free), poll with `stratum_flow_bg_poll`, cancel with `stratum_flow_cancel_bg`. Closes the STRAT-WORKFLOW epic (ticket 6 of 6). The "largest architectural item / lands with the TS port" framing was outdated: advancement was a turn-driven state machine, and BG just wraps the existing `get_current_step_info`→`process_step_result` spine — no new engine.
- **Scope (ship-narrow v1):** the loop drives `function`/`inline` steps, **pauses** at gates (`paused_gate`), and **hands off** (never mis-executes) at `judge`/`flow`/`parallel_dispatch`/`pipeline` steps (`handoff:<mode>`) and any unrecognized dispatch shape. Autonomous parallel/pipeline execution + mid-parallel restart-reattach (the design's riskiest surface) are deferred to `STRAT-WORKFLOW-BG-PARALLEL`; judge/flow to `STRAT-WORKFLOW-BG-NESTED`; driver auto-restart to `STRAT-WORKFLOW-BG-RESUME`. Default-off — a flow runs consumer-driven exactly as before unless BG is started. No IR/schema change.
- **Dispatch parity:** `_bg_dispatch_step` reuses `stratum_agent_run` wholesale (budget debit, streaming, structured-output schema), extracts the envelope's `result`, and feeds it to `process_step_result` — the same schema/guardrails/ensure/retries a consumer-reported result gets. A connector `parseError`/non-dict result is routed through `process_step_result` as `{}`, consuming a **real, persisted** `state.attempts` under the step's retry cap (durable across resume).
- **Exactly one driver per flow:** a live `_BG_FLOWS` task makes `stratum_step_done` and `stratum_resume` return `bg_owned`; a second `stratum_flow_run_bg` is refused. Closes the dual-driver race (the per-flow lock serializes persistence, not in-memory `FlowState` mutation).
- **Cancel vs shutdown are distinct:** explicit cancel marks the flow in `_BG_CANCEL_REQUESTED` before `task.cancel()` → terminal `cancelled`; a shutdown drain (`_BG_SHUTTING_DOWN` set before cancel, mirroring T2-F5's detach-don't-kill) persists a **resumable** in-progress snapshot — a restart must not look like a user cancel. The marker is cleared in both the loop's and the tool's `finally` so a cancel-vs-finish race leaves no stale bit. Any unexpected exception finalizes a durable resumable `error` snapshot — never an orphaned `running` flow.
- **State:** `FlowState.flow_mode`/`bg_status`/`bg_pause_reason` (persist/restore round-trip; old flows default `consumer_turn`); BG `finalize` persists a **terminal snapshot** (not delete) so `stratum_flow_bg_poll` stays accurate after completion.
- **Tests:** new `test_workflow_bg_e2e.py` (15 — autonomous advance to complete with 0 `step_done`, bad-dispatch durable retries → error, gate pause, parallel handoff, budget halt, `bg_owned` on step_done+resume, cancel-terminal, cancel-authoritative-under-shutdown-race, connector-exception → durable error, shutdown-drain resumable). Full `stratum-mcp/tests/` **1304 passed, 2 skipped**. Codex review 3 rounds → REVIEW CLEAN (R1: unfinalized-exception-exit + non-durable bad-dispatch retry + resume-race [2×High,1×Med]; R2: cancel-tool stale-marker race [Med]; R3: docs). `docs/features/STRAT-WORKFLOW-BG/{design,blueprint,plan,report}.md`.

### stratum — feat(STRAT-WORKFLOW-RESUME): content-addressed result cache — an unchanged prefix replays instead of re-dispatching

- **What:** opt-in `cache: true` on a side-effect-free `compute` **function step**. When you re-run or iterate a flow, an unchanged prefix step returns its prior **validated** output from a content-addressed store instead of re-dispatching the agent — "same workflow + same inputs → 100% cache hit," the governed, cross-model answer to dynamic-workflow result caching. A hit dispatches no agent and debits no budget, and is recorded as `cache_hit` so the audit never passes a replay off as a fresh run. Ticket 4 of 6 of the STRAT-WORKFLOW epic; **orthogonal sibling** to `T2-F5-RESUME` (live-process reparenting), not a dependency — the forge-top row's "depends on / extends `T2-F5-RESUME`" clause was stale (`T2-F5-RESUME` is merged `2101cc4`; they compose but neither needs the other).
- **Scope (ship-narrow):** opt-in, default-off, `compute` function steps only. The parser **rejects `cache: true` at parse time** (fail-closed) on a gate/judge/`parallel_dispatch`/`pipeline`/inline step, an iteration-loop step (`max_iterations`/`exit_criterion`/`score_expr`), an accumulator step (`accumulate`), or a routing step (`next`) — gating the **effective** enablement (`step.cache OR fn.cache`), so a function-level `cache: true` can't smuggle an ineligible step past the validator. The author asserts the step's `output` is its whole effect; the cache replays the *result*, not any file writes/commits (documented caveat). Caching side-effecting steps, `parallel`/`pipeline` results, `next:` routing, and a shared/remote cache are named follow-ups.
- **Content-addressed key (per-step, NOT whole-flow):** `sha256(CACHE_VERSION ‖ flow_name ‖ step_id ‖ _step_fingerprint(step) ‖ _fn_fingerprint(step.function) ‖ canonical_json(resolved_input))`. The key folds **only this step's own** fingerprint and **its function's** fingerprint — deliberately not the global `spec_checksum` — so editing a *later* step changes only that step's key; the unchanged prefix still hits, and the edited step's suffix misses via the resolved-input cascade. A changed flow input cascades the same way from step 1. Non-JSON-serializable resolved input → forced miss, never an exception.
- **Checksum-helper extraction (single source of truth):** `_step_fingerprint`/`_fn_fingerprint` promoted from nested closures of `compute_spec_checksum` to module level so the **cache key and whole-flow tamper detection share the exact same fingerprints**. The fingerprints now also cover load-bearing fields they previously omitted — `step_guardrails`, function `guardrails`, `cache`, `step.output_schema`, and the function `output_contract` + its resolved contract field shape — so a guardrail/schema/contract edit invalidates a cached result **and** is tamper-detected (closes a pre-existing checksum gap for those fields too).
- **Store:** `~/.stratum/cache/results/<key>.json`, content-addressed (shared across `flow_id`s and sessions). Atomic tmp + `os.replace`; corrupt/version-skew record → miss, never crash; age+count eviction sampled off the hot path. Kill switch `STRATUM_DISABLE_RESULT_CACHE=1` forces every step to miss. Only `ensure`-passing results are ever written; the hit path re-validates the cached output against the current schema/guardrails/ensure before trusting it (belt-and-suspenders behind the key). `StepRecord.cache_hit`/`cache_key` round-trip through persist/restore; `stratum_audit` adds a `cache_hits` count.
- **Tests:** 5 new files (47 tests) — `result_cache` store unit (round-trip/corrupt/skew/atomic/evict/disable), IR parse + checksum (guardrail-edit invalidation), validator eligibility (both gates incl. function-level-cache bypass), key composition (intent/contract/schema/input sensitivity + prefix property), and the e2e golden flow (identical re-run → 4 hits / 0 dispatches; edit a late step → prefix hits; flow-input change → full cascade; kill switch; only-successes-cached; persist/restore round-trip). Full `stratum-mcp/tests/` **1289 passed, 2 skipped**. Codex review 3 rounds → REVIEW CLEAN (R1: function-level-cache validator bypass [High]; R2: fingerprints omitted output_schema/output_contract → contract/schema staleness [Medium]; R3: clean). `docs/features/STRAT-WORKFLOW-RESUME/{design,blueprint,plan,report}.md`.

### stratum — feat(T2-F5-RESUME): live-process reparenting — server-dispatched codex survives a restart

- **What:** a server-dispatched **codex** task in a `parallel_dispatch`/`pipeline` step now **survives an MCP server restart mid-run**. Previously `resume_interrupted_parallel_tasks` flipped every in-flight `running` task to `failed` on boot — a 20-minute codex run 90% done at restart was thrown away. Now the codex child is spawned **detached** and writes to a **durable file it owns**, so it keeps running after the server dies; on restart the task is re-classified `reparenting` and a fresh reader tails the durable stream to completion and recovers the full result. **No engine rewrite** — a spawn-site change + a durable-stream reader, proven by a feasibility spike (darwin incl. `kill -9`).
- **Scope (settled, ship-narrow):** **codex + server-dispatch only.** claude is in-process (no child to reparent), opencode isn't server-dispatchable, `stratum_agent_run` has no durable record — all named follow-ups. Unblocks the forge-top `STRAT-WORKFLOW-RESUME` (content-addressed replay, a different mechanism that *extends* this).
- **Durable spawn (S1, `connectors/codex.py`):** when the executor passes a `stream_path`, codex is spawned under a `setsid`-less POSIX-shell wrapper — `'"$@" >"$T2F5_OUT" 2>"$T2F5_ERR" <"$T2F5_IN"; rc=$?; printf {"__t2f5_done__":%d} "$rc" >>"$T2F5_OUT"; exit "$rc"'` — `start_new_session=True`, std fds `DEVNULL`, prompt fed from `$T2F5_IN`. The wrapper wraps the **final** `_build_codex_cmd` argv, so it composes **outside** the read-jail wrapper. The wrapper-written **sentinel** (NOT the connector's in-memory result) is the durable completion signal. A stateless `_emit_for_codex_event` maps codex JSONL records to events for **both** the live PIPE loop and the durable file tailer (`_tail_stream`, partial-trailing-line safe). `stream_path=None` (every existing caller) → today's PIPE behavior byte-for-byte.
- **Detach-don't-kill (S3/S6):** on shutdown the server sets `executor._detaching=True` on every live `_PARALLEL_EXECUTORS` instance **before** cancelling, and the codex connector's durable `finally` no longer kills the child (only an explicit `interrupt()` does, via `killpg` of the wrapper's group). `_run_one`'s WHOLE finalizer (terminalize / done-event / budget debit / worktree-remove) is bypassed for a reparentable task being detached — it stays `running` with its handle persisted. A genuine require/budget cancel keeps the full destructive teardown.
- **Restart classify + reattach (S4):** `classify_interrupted_parallel_tasks` (the boot hook, retargeted from `resume_interrupted_parallel_tasks`) flips a `running` task to `reparenting` iff it's `reparentable` AND its persisted pid is alive AND `proc_start_time` matches (strict PID-reuse guard, `proc_identity.py`); else `failed`. A `ReattachReader` (single-flight per task via `_REATTACH_READERS`, lazily started by `stratum_parallel_poll`/`stratum_resume`) binds the canonical `_flows[flow_id]`, tails `stream_path` to the sentinel without being the child's parent (verdict from sentinel rc ∪ `{"type":"error"}` event ∪ `$T2F5_ERR`), and **reproduces the `_run_one` finalizer accounting** (`finished_at`, `elapsed_s`, `tokens`, `dollars_recorded`, the one-time dispatch debit guarded by `dispatch_debited`, `budget_exhausted`, worktree removal). It also reproduces the restart-time **sibling cascade** (require-unsatisfiable / budget-exhaust → killpg the sibling reparented children).
- **Handle (S2):** 7 Optional fields on `ParallelTaskState` (`child_pid` = the wrapper/session leader, `stream_path`, `stderr_path`, `proc_start_time`, `stream_offset`, `reparentable`, `dispatch_debited`) — JSON round-trip + back-compat (old persisted states load with the not-reparentable defaults).
- **`reparenting` surfaces (S5):** treated as non-terminal/in-flight everywhere a terminal set is special-cased — `_item_counts`, `_require_unsatisfiable`, poll summary + `all_terminal`, `stratum_parallel_advance` terminal gate, `stratum_parallel_start` re-start reject, `stratum_resume` poll-not-dispatch. Durable `streams/` dir removed on flow delete; per-task terminal removes its own files **after** the terminal snapshot is persisted (crash-safe recovery window).
- **Tests:** 5 new files (42 tests) incl. the **E2E survival golden flow** — a real detached child survives `shutdown_all` and a fresh `ReattachReader` recovers the result it wrote *after* the executor was torn down. Full suite **1242 passed, 2 skipped**. Codex: design 5 rounds + blueprint 3 rounds + plan review 1 round + impl review 2 rounds (stranded-terminal-task, persist-before-delete, restart sibling cascade) → REVIEW CLEAN. `docs/features/T2-F5-RESUME/`.

### stratum — feat(STRAT-WORKFLOW-PIPELINE-FANOUT): bounded data-driven map-reduce for pipelines (split → lanes → join)

- **What:** a pipeline can now **fan out** — a stage marked `fanout: {max: K, require: …}` emits a list, the next stage(s) run **once per element** in ≤K parallel lanes, and a stage marked `join: true` **reduces** the surviving lane outputs into one result. True `pipeline()`-style map-reduce over a list the pipeline discovers at runtime. The *split* half of the filed `-PIPELINE-FANOUT` row; fixed-count replicate (best-of-N) and unbounded fan-out are deferred follow-ups.
- **No engine change.** K lanes are pre-materialized on the existing static grid (`item{i}::stage{j}::lane{k}`); lanes past the runtime list length ride the `-PIPELINE-ROUTE` **`skipped`** primitive (an unfilled lane is just a skipped task — zero new task state). The one genuinely new primitive is the **multi-predecessor join**: the engine's first task with >1 dependency, binding `{prevs}`/`{prevs_raw}` = the list of surviving (complete, filled) lane outputs.
- **Split-output contract:** the split stage's result is a native `list` (used as-is) or a JSON-array string (parsed); a non-array string or any non-list result **fails the split stage** with a clear message. Enforced in a split-role validation branch in `_run_one` (after cert, before terminal commit), which also caps `len(L) ≤ K` (over-cap → split fails — the honest boundary of *bounded*) and memoizes the list so lanes read a resolved, validated `L` via a single `_effective_lane_input` resolver.
- **Lane bindings:** a per-lane stage's `{item}` is the lane element `L[k]`; `{source}`/`{source_raw}` is the original source item (so a lane can reference both, e.g. `summarize {item[title]} of {source[id]}`); the first per-lane stage's `{prev}` is the lane element.
- **Two require scopes (both reuse `all|any|N`):** **lane-require** (`fanout.require`) — how many *filled* lanes must complete for the join to run; a failed lane drops from `{prevs}` and the join runs over survivors (`require: any`/`N`) or the item fails (`require: all`). Evaluated in a **new join-specific dep-gate** that waits for all lanes terminal, then gates on survivors (uniform empty-list rule: 0 filled satisfies `all` → join runs with `{prevs}=[]`, fails `any`/`N`). **item-require** (step `require`) — unchanged. `_item_counts` learns that a failed *lane* is not itself an item failure (the join's complete-vs-cancelled state carries the lane verdict).
- **Server:** `_collapse_pipeline_items` emits one `items[].stages` entry per **per-item** stage (split/join/pre/post) and **none** for per-lane indices (lane detail lives in the trace); the full lane-id graph is enumerated so the require-bypass guard holds. Fill is read from lane **status** (`skipped` ⇒ unfilled — sound because route predicates are banned in-region), no list re-resolution. Fan-out is **server-dispatched only**: a fanned-out pipeline via `stratum_parallel_done` is rejected (the status-fill inference is trusted only on executor-produced traces).
- **Validation:** exactly one `fanout` + one `join`, `join` after `fanout`, ≥1 per-lane stage between, `max ≥ 1`, `require ∈ {all,any,int≥1}`; `when`/`exit_when` banned inside the region **and** pre-fanout `exit_when` banned (it would skip the whole region and the join would misread the early-exit skips as unfilled lanes). All parse-time.
- **Tests:** new `test_pipeline_fanout.py` (33 — spec shape/region validation, desugar lane grid + multi-dep join edge, executor fill/skip/survivors/require/`len>K`/non-list/empty-list, server collapse + `_done` rejection). Combined suite (`tests/ stratum-mcp/tests/`, e2e + docker-live excluded): 1879 passed, 2 skipped. Codex: design 5 rounds (split-output contract + `_run_one` hook, route-predicate ban in-region, uniform empty-list require, two-part lane helper, status-fill scope), impl 2 rounds (pre-fanout `exit_when` × fanout-region interaction) → REVIEW CLEAN. `docs/features/STRAT-WORKFLOW-PIPELINE-FANOUT/design.md`.

### stratum — feat(STRAT-WORKFLOW-PIPELINE-ROUTE): conditional stage routing for pipelines (`when` / `exit_when`)

- **What:** a pipeline `stage` may now carry two optional predicates: **`when`** (evaluated before the stage dispatches — if falsy the stage is *skipped* and the previous stage's output flows through unchanged) and **`exit_when`** (evaluated after the stage completes, over its own output — if truthy the item *early-exits* and its remaining stages skip). Per-item, server-evaluated, on the existing static N×S grid. The conditional-routing half of the filed `-PIPELINE-FANOUT` row (the actual 1→many split stays deferred — it needs a variable task graph the fixed-at-construction executor can't grow mid-run).
- **No new engine, no grid-shape change.** Routing is a new terminal task state `skipped` layered on the `-PIPELINE` desugar. The crux: a skipped task reports `skipped` but the downstream dependency gate (`parallel_exec.py`) treats a `skipped` predecessor as *proceed* (not cancel) and threads its passthrough result as `{prev}` — so the chain continues transparently. A skipped stage never acquires a concurrency slot and never counts as a budget dispatch.
- **Two binding contracts (they fire at different times):** `when` binds `{item, prev, prev_raw}` (the input; stage 0 → `{item}` only); `exit_when` binds `{item, result, result_raw}` (this stage's own output; all stages). Both compile through the existing ensure jail (`compile_predicate`) with an **AST free-name validation pass** at parse time — allowed = the predicate's bindings ∪ `_ENSURE_BUILTINS` (so `len(item['tags'])>0` validates; a stage-0 `when` referencing `prev`, or any unknown name, is a spec error). `any`/`all` added to the jail builtins. Comprehension/lambda-bound names are excluded from the free-name check.
- **Degrades safely:** a malformed `when` fails *open* (runs the stage), a malformed `exit_when` fails *closed* (no exit); both log a warning rather than writing the failure-semantic `ParallelTaskState.error`. `exit_when` is evaluated only on a terminal-`complete` task (after cert), so an invalid output that cert flips to `failed` can't trigger an early-exit.
- **`skipped` recognized everywhere a terminal state is special-cased** (the `-BUDGET` pattern): `_item_counts` (settled-non-failure → an early-exited/skipped tail reads complete; `require: all` satisfied), `_collapse_pipeline_items` (item complete iff every stage complete-or-skipped; `missing`≠complete bypass guard intact), restart-rejection, poll summary, `all_terminal`, `stratum_parallel_advance` terminal check, and both `ParallelTaskState→task_results` serializers (via `_serialized_task_status`). **Scoped regression fix:** the failed-partition treats `skipped` as non-failure *only* for pipelines — plain `parallel_dispatch` keeps `failed = status != complete`, so a client can't submit `status:"skipped"` to bypass `require: all`.
- **Scope:** predicate evaluation is **server-dispatched only** (the executor evaluates them); the client-dispatched `stratum_parallel_done` path doesn't, and that's a documented limitation. No IR/schema change beyond the two optional stage keys (checksum already fingerprints stages wholesale).
- **Tests:** new `test_pipeline_route.py` (27 — predicate compiler/AST validation, spec-level when/exit_when validation incl. stage-0 rejection, executor skip/early-exit/passthrough/isolation/degradation, server-side collapse+evaluate incl. the non-pipeline bypass guard). Combined suite (`tests/ stratum-mcp/tests/`, e2e + docker-live excluded): 1846 passed, 2 skipped. Codex: design 6 rounds (gate-clobber, server-surface enumeration, AST-vs-jail name validation, exit_when binding contract), impl 1 round (non-pipeline require bypass) → REVIEW CLEAN.

### stratum — feat(STRAT-WORKFLOW-BUDGET-DOLLARS): promote run-budget `usd` from recorded-only to enforced

- **What:** the flow run-budget `usd` axis is now an **enforced** cutoff on the MCP path, not just recorded. A `budget: {usd: 5.00}` flow halts (`terminal_status=budget_exhausted`) once accumulated dollar cost crosses the cap. Closes the deliberate deferral in the parent `STRAT-WORKFLOW-BUDGET` ("recorded-not-enforced; mechanism absent").
- **Why it was deferred:** connectors emit token counts but no dollars (codex hardcodes `cost_usd=0`, claude omits it), and `litellm.completion_cost` lives only in the library executor — `stratum-mcp` has no litellm dep. So there was no token→price mechanism on this path.
- **Mechanism:** a static, hand-maintained `MODEL_PRICING` table (`pricing.py`, USD per 1M tokens, seeded for the claude-4.x and gpt-5.x/codex families) with `cost_from_tokens(model, in, out)` pricing input/output separately and stripping the codex `/effort` suffix. Unknown model → `$0` (degrade, never block a flow) with a one-time warning when a `usd` cap is in effect. Patch/extend prices without a release via the `STRATUM_MODEL_PRICING_JSON` env override (merged over the built-in table; malformed JSON degrades silently).
- **Wiring:** `accumulate_usage` (`run_budget.py`) derives dollars from token counts when no positive `cost_usd` is reported (trusts a real `cost_usd` if present — future-proof), so **both** server-dispatched debit sites (`stratum_agent_run`, parallel `_run_one`) price dollars for free; `budget_exhausted` enforces the `usd` axis; `init_budget_state` (`executor.py`) now yields a ledger for a `usd`-only budget. All token/dollar inputs are sanitized (`nonneg_int`/`nonneg_float`): negative/NaN/inf/non-numeric → 0 so a bad value can neither credit the ledger nor poison `usd` enforcement (`nan >= cap` is always False); non-string model ids degrade to `$0` rather than raising.
- **Consumer-reported usage:** `stratum_step_done` gains an optional `usage` param (`{input_tokens, output_tokens, model}` or pre-priced `{tokens, dollars}`) so the common *sequential* consumer path debits too — charged **after `process_step_result` validation** (a stale/wrong-step call is rejected uncharged) but **across all outcomes** (ok + every retry status), so a retry storm can't evade the cap; on exhaustion it tears down any child flow then halts. No `dispatches` charge (a consumer step isn't a server-dispatched agent).
- **Scope:** client-dispatched parallel work (`stratum_parallel_done`) carries no usage field in v1 (server-dispatched parallel IS covered); deferred. No IR/schema change — `usd` already existed as a budget key.
- **Tests:** new `test_pricing.py` (12) + `test_workflow_budget_dollars.py` (13, incl. usd exhaustion via agent_run and via step_done, retry-storm halt, unpriced/negative/NaN/non-string-model/unhashable-model robustness); `test_run_budget.py` + `test_workflow_budget_state.py` updated for the inverted `usd`-enforced contract. Combined suite (`tests/ stratum-mcp/tests/`, e2e + docker-live excluded): 1819 passed, 2 skipped. Codex: design 3 rounds (retry-storm bypass, debit placement vs validation, child-flow orphan on hard-stop), impl 4 rounds (untyped/negative/NaN coercion, non-string model in pricing chokepoint, unhashable model in the unpriced set) → REVIEW CLEAN.

### stratum — feat(STRAT-WORKFLOW-PIPELINE-STAGEOPTS): per-stage cert + timeout for pipeline steps

- **What:** a pipeline `stage` may now declare its own `task_reasoning_template` (cert) and `task_timeout`, overriding the step-level defaults — so a fast `claude` clean stage and a slow `codex` verify stage can have different timeouts, and a stage that must emit structured output can carry its own cert while a free-text stage carries none. Follow-up to `-PIPELINE` (shipped same day, `bc8182d`), which only supported per-stage `agent`/`intent_template`.
- **Precedence (one rule, presence-based):** for any field, *stage value if `is not None`, else step value, else default*. A stage `task_reasoning_template: {}` inherits the default sections (`_apply_cert_defaults` now runs per stage in `_build_step`, same as step-level) rather than being treated as absent.
- **Cert *instructions* now injected, not just validated** (the non-obvious half): the parallel path historically only *validated* a cert post-hoc and never injected its instructions into the prompt — so an explicit per-stage cert would have failed (the agent was never told to produce it). `ParallelExecutor._render_prompt` now appends the effective cert's instructions via `inject_cert_instructions` (pipeline-only, graceful-degrade on a malformed template), so per-stage certs actually instruct the agent.
- **Agent-gate rule:** an *explicit per-stage* cert applies unconditionally (explicit beats heuristic — a codex stage with its own cert is validated + instructed); a *step-level fallback* cert keeps the claude-agent-gate (preserves `-PIPELINE` behavior). One shared `executor.effective_pipeline_task_cert(stage, step, agent)` helper drives all three pipeline cert sites (`_run_one` validate, `_render_prompt` inject, `server._evaluate_parallel_results` validate) so they can't drift.
- **Zero non-pipeline regression:** the helper is **pipeline-only**. The two *non-pipeline* `parallel_dispatch` cert paths are intentionally asymmetric (`_run_one` validates unconditionally, `_evaluate_parallel_results` is claude-gated) and a single helper can't represent both — so each call site keeps `if is_pipeline:` → helper, `else:` → its existing branch verbatim, and injection only fires for pipelines. `parallel_dispatch` prompt construction is byte-identical.
- **Wiring:** `spec.py` (stage schema gains `task_reasoning_template`/`task_timeout`; pipeline validation widens allowed stage keys; per-stage cert defaults/validation in `_build_step`); `executor.py` (`expand_pipeline_tasks` stamps `_task_timeout`/`_task_reasoning_template`; new `effective_pipeline_task_cert`); `parallel_exec.py` (per-task timeout in `_run_one`; effective cert in `_run_one` + `_render_prompt` injection); `server.py` (per-task effective cert in `_evaluate_parallel_results`). Checksum needs no change — the `stages` fingerprint already serializes each stage dict.
- **Tests:** 13 new in `stratum-mcp/tests/test_pipeline.py` (STAGEOPTS section). Combined suite (`tests/ stratum-mcp/tests/`, e2e + docker-live excluded): 1780 passed, 2 skipped. Codex: design 3 rounds (caught the prompt-injection gap + the non-pipeline cert asymmetry), impl 1 round → CLEAN.

### stratum — feat(STRAT-WORKFLOW-PIPELINE): `pipeline` step type — no-barrier stage staggering

- **What:** a new `pipeline` IR step type runs a `source` list through an ordered `stages` list with **no inter-stage barrier** — item A can be in stage 2 while item B is still in stage 0, so wall-clock is the slowest single-item chain, not the sum of per-stage maxima. The cross-client, governed, cross-model analogue of Claude Code's `pipeline()` dynamic-workflow primitive. Epic STRAT-WORKFLOW ticket 3 of 6 (after `-NAMING`/`-IMPERATIVE`/`-BUDGET`).
- **Approach (desugar, no new engine):** a `pipeline` step compiles (`source × stages`) into the existing `depends_on` task graph and reuses `ParallelExecutor` verbatim. Staggering is an emergent property of the existing `asyncio.Semaphore` + dependency waiters that *don't hold concurrency slots*. v1: linear stages, 1:1 per item.
- **Surface:** `stages: [{intent_template, agent?}, …]`; per-stage `agent` enables cross-model pipelines (a claude stage then a codex stage in one flow). Stage *j*'s prompt threads stage *j-1*'s output via `{prev}` (JSON-stringified) and `{prev_raw}` (raw object field access). Step-level `task_timeout`/`task_reasoning_template` apply uniformly across stages in v1 (per-stage variants deferred to `-PIPELINE-STAGEOPTS`).
- **Semantics:** `require` is **item-scoped** (an item is complete iff its full chain completes); a single item's failure drops only that item's downstream stages — siblings continue unless item-scoped `require` is already unsatisfiable (`require: all` → first item failure cascade-cancels; `any`/`N` → siblings run on). Consumer reads a per-item `items: [{item, status, result, stages}]` aggregate (canonical step result; `ensure` uses bracket access on the plain-dict elements, e.g. `result.items` then `i['status']`).
- **Wiring:** `spec.py` (stages field + JSON schema + pipeline validation branch + two-site stray-`stages` rejection on every non-pipeline step type); `executor.py` (`_step_mode` maps `pipeline → parallel_dispatch`; shared `expand_pipeline_tasks` consumed by both the dispatch resolver and `get_current_step_info` so advertised surface == dispatched graph; checksum `+stages`); `parallel_exec.py` (`is_pipeline` flag; per-task `_intent_template` + `{prev}`/`{prev_raw}`; per-stage `_agent`; pipeline-scoped per-task cert agent-gate; item-scoped `_require_unsatisfiable`); `server.py` (desugar in `_resolve_dispatch_tasks`; pipeline-aware `_evaluate_parallel_results` + `_collapse_pipeline_items`; `parallel_advance` raw gate widened to a mode check).
- **Safety / correctness:** `_collapse_pipeline_items` enumerates the **full desugared graph** (not the reported task subset) as source of truth, so the client-dispatched `stratum_parallel_done` path cannot satisfy `require: all` by omitting an item's tasks (missing stages count as `incomplete`); `require: all` means *every item complete*, not merely no-failures. Non-pipeline `parallel_dispatch` behavior is byte-identical (`is_pipeline` defaults off; regression-tested).
- **Tests:** `stratum-mcp/tests/test_pipeline.py` — 27 tests incl. a timing-overlap staggering proof, per-item isolation, the require-bypass guard, and `ensure`-over-items. Combined suite (`tests/ stratum-mcp/tests/`, e2e + docker-live excluded): 1767 passed, 2 skipped. Codex: design 6 rounds, blueprint 4 rounds (caught a 2nd live cert path + a 2-site validation gap), impl 2 rounds (caught the require-bypass + an empty-string hole) → all REVIEW CLEAN.

### stratum — fix(#1): CI green on a hermetic stratum-only checkout (judge + isolation + platform fixes)

The combined-suite CI (`test.yml`, added in 4d55522) ran the whole corpus against a bare checkout and failed; only the first failure was visible because of `-x`. Root-caused and fixed the whole cascade:

- **Judge production bug:** `_validate_judge_result` (server.py) loaded the judge-result contract schemas from a sibling `compose/contracts` checkout and a broad `except` turned a *missing schema file* into `schema_validation_failed`. Any `pip install stratum-mcp` (where `__file__` is in site-packages, no compose tree) or stratum-only CI checkout therefore failed **every** `stratum_judge` call. The runtime check is a best-effort result-shape regression catcher, not a correctness gate — it now degrades to a skip (one-time stderr warning) when the schemas can't be located, raising only on a genuine mismatch. Regression test `test_judge_succeeds_when_contract_schemas_absent`.
- **Judge log isolation leak:** `judge/logging.py` did `from .staging import JUDGE_ROOT`, freezing the root at import time — so `append_turn_log` wrote `turns.jsonl` to the real `~/.stratum/judge/` even after the root was reconfigured (e.g. in tests). Now resolves `staging.JUDGE_ROOT` at call time (staging is the single source of truth). Caught by `test_goal_e2e`'s no-home-writes assertion, which had been passing only on leftover local state.
- **Cross-repo contract tests** (`test_goal_state`, `test_judge_schema`, `test_judge_corpus`, `test_goal_tool`) read `compose/contracts/*.json` directly; they now `skipif` the contracts dir is absent (run locally where compose is a sibling, skip in stratum-only CI). Also fixed a hardcoded absolute `/Users/...` contracts path in `test_goal_tool`.
- **Platform:** `test_judge_sandbox::test_profile_realresolves_paths` exercised the macOS `/tmp`→`/private/tmp` symlink canonicalization (Seatbelt is macOS-only) — now `skipif sys.platform != "darwin"`.
- **CI (`test.yml`):** kept a single hermetic job (both packages in one process, preserving the cross-package contamination guard), dropped `-x` so the full failure set is visible. Contract tests skip without compose; live Docker/model judge gates skip without `OPENAI_API_KEY`. Hermetic CI sim (no compose, no keys): 1677 passed, 67 skipped.

### stratum — feat(#1): `stratum-mcp doctor` install/environment diagnostics

- **What:** new `stratum-mcp doctor` CLI subcommand that surfaces the common first-run failure modes behind `compose init` leaving Stratum disabled (smartmemory/stratum#1). Checks: Python version vs. the `>=3.11` floor (with the exact running version + interpreter path), whether `stratum-mcp` is installed (`importlib.metadata`, with version + location), whether a `stratum-mcp` console script resolves on PATH (`shutil.which`), and whether the active `python` differs from the interpreter that owns the package. Exit 0 = healthy, 1 = problems; every failure carries an actionable `fix:` line.
- **Shadow detection:** distinguishes "not installed" from "installed but no binary on PATH" (pyenv-shim / PATH mismatch) from "installed but declares no console script" — the last being the vendored-kernel-shadow footgun the issue calls out. Each maps to a different remediation (`pip install` / `ln -sf` / `pip uninstall && pip install`).
- **Wiring:** `src/stratum_mcp/doctor.py` (pure `evaluate(Probe) -> DoctorReport` + `gather_probe()` + `render()` so logic is testable without touching the environment); dispatched in `server.main()`, listed in `_cmd_help`. `tests/test_doctor.py` — 10 tests covering each branch + live `gather_probe`/`_cmd_doctor` smoke. Full `stratum-mcp/tests/` 1055 passed, 2 skipped.

### stratum — fix(#4): cover `score_expr` in `compute_spec_checksum`

- `_step_fingerprint` hashed `max_iterations`/`exit_criterion`/`accumulate`/`accumulate_key` but not `score_expr`, leaving a tamper-detection gap (a live flow's score expression could be altered mid-run undetected). Added `score_expr` to the fingerprint; regression test `test_spec_checksum_covers_score_expr`. Found during STRAT-WORKFLOW-IMPERATIVE.

### stratum — feat(STRAT-WORKFLOW-IMPERATIVE): governed accumulator + loop-until-dry for the iteration loop

- **What:** a per-step iteration loop can now declare `accumulate` (an expression extracting the iteration's item list from `result`) and optional `accumulate_key` (a per-item dedup-key expression binding `item`). Items are deduped across iterations into `FlowState.iteration_accumulator`, and `exit_criterion` additionally sees `accumulator` / `accumulated_count` / `new_count` / `dry_streak`. Loop-until-dry is expressed as a predicate — `exit_criterion: "dry_streak >= K"` (K consecutive zero-new rounds) — with no new construct, no new MCP tool, no new outcome verb. Epic STRAT-WORKFLOW ticket 3 of 6.
- **Scope reconciled (verify-first):** the ROADMAP framing ("the IR cannot express `while (count < N)`, loop-until-dry, or in-flow dedup") was substantially stale — **STRAT-ENG-4 already ships** the counted loop (`max_iterations`) + until-guard (`exit_criterion` with `iteration`/`best_score`/`prior_scores`) + K-window stagnation. The genuine residual was the accumulator + a dry-predicate distinct from identical-fingerprint stagnation. 6th confirmed stale-forge-top-row instance.
- **Wiring:** `accumulate`/`accumulate_key` IR fields (`spec.py`, schema v0.2+v0.3, `_build_step`); validation (require `max_iterations`/`accumulate`, dunder guards, rejected on gate + `decompose`/`parallel_dispatch` steps); included in `compute_spec_checksum` (STRAT-IMMUTABLE tamper-detection). New `compile_value_expr(expr, bind)` mirrors `compile_score_expr` (value-returning, dunder-guarded, parameterized binding). `report_iteration` dedups (canonical-JSON keys, non-hashable-safe) and folds accumulator kwargs into a single unified `exit_criterion` eval. `process_step_result` merges `accumulated`/`accumulated_count` into the authoritative step output **after** validation; accumulator cleared in every terminal/restart path (success, all 4 failure routes, `_clear_from`, server retry-reset).
- **Safety:** a malformed `accumulate`/`accumulate_key` is an `accumulate_error` that **freezes `dry_streak`** — a broken extractor can never manufacture a false dry exit. Fingerprint-stagnation is **suppressed for accumulator loops** so a `dry_streak >= K` predicate with `K > _STAGNATION_WINDOW` isn't preempted.
- **Review:** 2 Codex design-gate rounds (4 findings: authoritative-output path, false-dry-streak, retry-reset, key-hashability/checksum) + 1 blueprint round (3 findings: merge-after-validation, on_fail cleanup, compile-once key expr) + 3 implementation rounds (ensure-path cleanup miss, parallel-step validation hole, stagnation preemption) → REVIEW CLEAN. 20 new tests; full `stratum-mcp/tests/` 1044 passed, 2 skipped. `docs/features/STRAT-WORKFLOW-IMPERATIVE/{design,blueprint,report}.md`.

### stratum — feat(STRAT-WORKFLOW-BUDGET): flow-execution-wide run budget ceiling

- **What:** a flow may declare a run budget; every **server-dispatched** agent debits it; when an enforced axis is exhausted the flow is marked terminal (`budget_exhausted`) and in-flight parallel siblings are cascade-cancelled. Closes the gap where `parallel_exec` enforced only a per-task `timeout` and `BudgetCaps` was scoped to a single `stratum_judge` run. Promotes parked `idea_budget_ceilings`. Epic STRAT-WORKFLOW ticket 2 of 6.
- **Enforced axes:** `ms` (wall-clock, as cumulative active-dispatch compute-seconds — resume-safe, parallel-aware), `max_agent_dispatches`, `max_tokens`. Declared by extending the **existing** flow-level `budget:` block (`IRBudgetDef`/`BudgetDef` gain two optional integer fields — no collision, no new key). `usd` is **recorded-not-enforced** (dollars aren't computable on the MCP path: connectors emit tokens, codex hardcodes `cost_usd=0`; `litellm.completion_cost` exists only in the library executor). The ROADMAP's "dollars + wall-clock, gap is scope not mechanism" premise was **verified wrong for dollars** on this path — follow-up `STRAT-WORKFLOW-BUDGET-DOLLARS` filed for a token→USD pricing table.
- **Wiring:** usage captured in both connector shapes (claude `kind="step_usage"` / codex `metadata.type="usage"` / `run()` `type="usage"`); debited at the two server chokepoints — `ParallelExecutor._run_one` and `stratum_agent_run` (attributed via `correlation_id`). New `run_budget.py` (pure helpers: `accumulate_usage`/`debit_budget`/`budget_exhausted`). `FlowState.budget_state` threaded through **both** persistence paths (`executor.persist/restore_flow` + `goal/orchestrator.py`'s synthetic-flow serializer, which always carries `None`). Run budget added to `compute_spec_checksum` (STRAT-IMMUTABLE tamper-detection).
- **Hard cutoff is durable across restart:** `budget_exhausted` set **before** persist (parallel) / in the `finally` (agent_run, so error/cancel still charges and marks terminal). Recognized at every advancement + status surface: `stratum_step_done`, `_advance_after_parallel` (covers `parallel_poll`/`advance`), `stratum_parallel_done`, `stratum_gate_resolve`, `stratum_parallel_start` (pre-fanout gate), `stratum_check_timeouts`, `stratum_skip_step`, `stratum_resume`, `_flow_status`, `_build_audit_snapshot`.
- **Contract change (additive):** `status` enum in `flow-state.v1.schema.json` + `query-flows.v1.schema.json` gains `budget_exhausted` (same shape `killed` already had).
- **Known v1 limitation (documented):** judge-internal T2/T3 dispatches are governed by the judge's own `BudgetCaps`, not the run-wide budget (the verifier carries no `correlation_id`); deferred. No behavior change for flows without a `budget:` block.
- **Review:** 2 Codex design-gate rounds (5+2 findings) + 3 implementation-review rounds (4→1→0 — error-path debit, four missing advancement gates, non-durable terminal status, dropped partial usage — all wiring bugs the happy-path tests missed). Full `stratum-mcp/tests/` 1024 passed; 44 new tests. `docs/features/STRAT-WORKFLOW-BUDGET/{design,blueprint,report}.md`.

### stratum — docs(STRAT-WORKFLOW-NAMING): formalize the two-tier workflow/flow vocabulary

- **Wrote down a distinction the code already encoded.** Stratum splits *workflow* (authored definition — a `.stratum.yaml` spec with a `workflow:` block, discoverable via `stratum_list_workflows`) from *flow* (the executable DAG definition: `flows:`, `@flow`) and *flow execution* (a single run — a `FlowState` with a `flow_id`). The boundary existed structurally but was never documented, risking vocabulary drift. **No rename** — the definition/instance split is intentional (Temporal/Airflow model); a rename would be ~20 files of churn for zero behavior gain.
- **SPEC.md** gains a "Terminology: Workflow vs Flow" section (three-layer glossary table + `git diff`-vs-`flow_id` rule of thumb). **README.md** gains a matching "Workflow vs Flow" Core Concepts entry plus a positioning note framing Stratum as **governed, portable, cross-model workflows** — the cross-client answer to single-vendor in-context orchestrators.
- **Docstrings** (narrow scope, 3 load-bearing public symbols) now carry the distinction: `stratum_list_workflows` (lists *definitions*, not runs), `@flow` (*defines* a flow; invoking it *creates* a flow execution), `FlowState` (runtime state of *one* flow execution). No behavior, signature, or API change — purely documentary.
- Codex doc-review gate caught two real internal inconsistencies in the initial drafts (prose calling a flow "the execution unit and its running instance," contradicting the table that separates flow from flow execution; and "### Flows" implying only YAML defines flows, omitting the `@flow` library track) — both tightened, re-review **REVIEW CLEAN**. First of 6 tickets in the STRAT-WORKFLOW epic. `docs/features/STRAT-WORKFLOW-NAMING/design.md`.

### stratum — fix: test-hygiene follow-ups from STRAT-TEST-EVENTLOOP-HYGIENE

- **`.githooks/pre-push` self-perpetuating bump loop.** The pre-push hook auto-commits `chore: bump to 0.2.N` when pushing to `main`, but a commit created during pre-push can never be part of *that* push — it lands unpushed and the next push re-triggers the hook, forever (`0.2.47`→`0.2.48`→…). Added a loop guard: capture the main ref's local/remote oids and skip bumping when every commit in `remote..local` is already a `chore: bump` commit (nothing real changed since the last bump). Real-work pushes still bump exactly once; the bump path itself is unchanged. Verified live: bump-only push now prints `skipping bump (loop guard)`, exits 0, creates no commit.
- **`test_judge_corpus.py` mutated a tracked fixture every run.** `test_kernel_runs_on_10_corpus_candidates` unconditionally rewrote `tests/fixtures/judge_corpus_smoke.json` (whose `candidate_id`s vary with corpus regen — a human diff aid, not an assertion oracle). Guarded the write behind `STRATUM_UPDATE_CORPUS_FIXTURE=1`; a normal run no longer touches the tracked file. No equality assertion added (would be flaky); the per-candidate behavioural asserts are unchanged. Verified: test passes, fixture stays clean post-run.

### stratum — fix(STRAT-TEST-EVENTLOOP-HYGIENE): combined-suite event-loop pollution

- Running `tests/` + `stratum-mcp/tests/` in one pytest process produced ~64 order-dependent failures (`65 failed, 1024 passed` in the bounded repro) — 9 `stratum-mcp/tests/integration/` files each defined an identical `def _run(coro): return asyncio.get_event_loop().run_until_complete(coro)` bridge that drove the **process-global** loop, which a prior `tests/` test leaves closed under pytest-asyncio `asyncio_mode = "auto"`. Per-directory runs were green only by ordering luck; no production code implicated (library `run()` was already loop-hardened in `a875ba7`).
- **Fix:** all 9 `_run` helper bodies → `asyncio.run(coro)` (private per-call loop, immune to prior loop state). Signature unchanged → **zero call-site edits**; diff is 9 files × 1 line. The ticket's larger `@pytest.mark.asyncio` migration alternative was intentionally not done (unnecessary to close the defect).
- **Verified:** same bounded repro post-fix `1 failed, 1088 passed` — the sole residual is the unrelated, pre-existing, environment-dependent `test_judge_jail_docker.py::test_live_gate_A_real_model_turn_through_connector` (real Docker+model), explicitly out of scope. Regression guard: full `stratum-mcp/tests/` standalone `982 passed, 0 failed`. `docs/bugs/STRAT-TEST-EVENTLOOP-HYGIENE/{description,repro,diagnosis,report}.md`.
- Follow-ups filed in report (not fixed here, out of scope): a test mutating committed fixture `tests/fixtures/judge_corpus_smoke.json` as a side-effect; pre-existing `tests/test_e2e.py` hangs; optional combined-run CI guard.

### stratum — feat(STRAT-JUDGE-v2-slice2): decomposer modes (`auto` + two-phase `hybrid`; `ask` skill-only)

- **Closes the `user`-only decomposer cut** (design.md v1 cut #2). `run_judge` gains a trailing defaulted `decomposer_mode: str = "user"` param threaded into the single `JudgeKernelMeta` stamp site (was a hardcoded literal); every existing caller is byte-for-byte unaffected. `GoalState` gains an additive `decomposer_mode` field (old state files load as `"user"`) made immutable on resume via a third `restore_goal_state` check mirroring the `mode` check.
- **Two-phase, stateless surface (no kernel state machine).** `stratum_goal` gains `decomposer ∈ {user,auto,hybrid}` (validated at the MCP boundary *before* predicate parsing → deterministic `invalid_decomposer`; `ask` is a skill-layer concept, rejected). `auto` decomposes the prompt **once on a fresh goal** via the reused, fail-open `LiteLLMDecomposer` (litellm `claude-haiku-4-5`), `asyncio.to_thread`-wrapped; resumes reuse persisted predicates. New stateless `stratum_decompose` tool returns a draft `{predicates,applied,reason,model}` for the `hybrid` flow (caller presents → user edits → passes back).
- **Resume safety (Codex-review-hardened).** `_resolve_predicates` substitutes persisted predicates **only** when caller is `auto`+empty-list **and** the persisted goal was itself `auto`; every other resume falls through to the `predicates_hash`/`mode`/`decomposer_mode` immutability gate (raises `GoalImmutabilityError`) — no silent provenance/predicate coercion. `auto`+`cheap` with any non-deterministic resolved predicate is surfaced as structured `auto_cheap_mismatch` **before** the loop (not swallowed mid-run as budget burn) on both fresh and auto-resume paths.
- Typed `GoalError` subclasses (`DecomposeFailed`/`AutoPredicatesConflict`/`AutoCheapMismatch`/`InvalidDecomposerError`) carry `error_type` snake_case strings, mapped explicitly *before* the generic `except GoalError` (which would emit PascalCase). Output `JudgeKernelMeta.decomposer_mode` Literal **unchanged** (4-value; `ask` a permanently-unproduced reserved member — contract back-compat). Design gate 2 Codex rounds + blueprint 3 rounds + impl 2 rounds → REVIEW CLEAN. 686 (`tests/`) + 965 (`stratum-mcp/tests/`) green (e2e excluded — no model in env); 30+ new tests. `docs/features/STRAT-JUDGE/{design.md §v2 slice 2,blueprint-v2-decomposer.md,plan-v2-decomposer.md,report.md}`.

### stratum — feat(STRAT-JUDGE-T3-READJAIL-CODEXNEST): non-nesting Docker read-jail — `codex_jailed` is now real (live gate PASSED)

- **The non-nesting primitive.** The parent's live gate falsified `sandbox-exec`-wrapping `codex exec` (codex self-applies Seatbelt; Seatbelt can't nest). This ships a `JailDriver` seam in `sandbox.py` (`SandboxExecJailDriver` retained inert as the proven `/bin/cat` regression substrate; `DockerJailDriver` is v1) and runs the T3 adversary in an ephemeral container whose **only readable host path is the `:ro`-bound staged turn tree**. codex runs `--dangerously-bypass-approvals-and-sandbox` inside because the container *is* the externally-enforced sandbox (the officially-sanctioned pattern). Fresh container per call → zero cross-predicate state bleed.
- **Blocking live gate PASSED for real** (`test_judge_jail_docker.py`; Docker 29.4.3, codex-cli 0.130.0, Darwin 25.5): (A) a real `codex exec` gpt-5.4 turn through the **real connector path** read an unguessable planted token out of the jailed staged tree; (B) `/bin/cat`-grade proof that the container namespace denies the sibling `turns.jsonl` and the host repo. Verification is **host-scoped** (`_docker_readjail_verified()`: True on Darwin where the gate ran, or explicit `STRATUM_DOCKER_READJAIL_VERIFIED=1` opt-in) — NOT a global constant that would over-claim on an unverified Linux/CI host (distinct from the permanently-`False` Seatbelt `_CODEX_READJAIL_VERIFIED` — two flags so one never conflates two primitives). `read_jail_available()` now reflects driver selection; **`verifier.py`/`kernel.py` unchanged** — `codex_jailed` provenance is genuine end-to-end.
- **Seven defects only a real `codex exec` could surface** (the session thesis): duplicate `--skip-git-repo-check`; read-only rootfs/no writable HOME; `CODEX_HOME` refused under `/tmp`; no stdin into the container (`-i`); no CA bundle in `node:slim` (TLS fail); codex 0.130 dropped `--api-key` (in-container `codex login --with-api-key` then `exec codex`); `-C` must stay on the evidence dir. All fixed; each documented in the report.
- **Vendored pinned image** `judge/jail/Dockerfile` (node:22-slim + `ca-certificates` + `@openai/codex@0.130.0`, non-root), content-addressed tag, lazy `_ensure_image` (build-fail → `JailUnavailableError`, never a silent fallback or public-image pull); shipped as wheel package data.
- **Auth path locked + truth-corrected:** env-injected `OPENAI_API_KEY` (no `~/.codex` host mount — that would add a second readable host path). `RESIDUAL_CODEX_JAILED` rewritten for the env-key model; `compose/contracts/judge-result.json` ll.32/108 descriptions corrected `sandbox-exec`→container-namespace (enum/field **shape frozen** — no consumer moves).
- **Failure routing unchanged, verifier-owned:** static absence → `claude_cold_fallback`; operational failure of the *selected* jail (build/daemon/auth/turn error) → `codex_jailed_error`, never silently downgraded. Exactly 4 tests retargeted (invariants preserved verbatim on their new owners); all frozen anchors incl. the entire `test_judge_t3.py` honesty set green unmodified. Codex review CLEAN across design/blueprint/plan gates. Follow-up **STRAT-JUDGE-T3-READJAIL-LINUX** still open (run the same gate on Linux/CI before claiming it). `docs/features/STRAT-JUDGE-T3-READJAIL-CODEXNEST/{design,blueprint,plan,report}.md`.

### stratum — feat(STRAT-JUDGE-T3-READJAIL): read-jail machinery + honest-degrade (live gate falsified the premise)

- **Connector read-jail capability (shipped, verified for ordinary processes).** New `stratum/src/stratum/judge/sandbox.py`: `build_seatbelt_profile` (deny-default, real-path-resolved, single staged-tree read-allow + `~/.codex` for auth), `materialize_profile`, probe. `read_jail` threaded `stratum_agent_run → make_agent_connector → CodexConnector`; spawn wrapped in `sandbox-exec -f <profile>` at both `codex.py` callsites; `_cleanup_jail` terminates+awaits the child *before* unlinking the profile on every path; `--ephemeral` inserted after `exec`. OS enforcement **proven** (`test_judge_readjail.py`: confined `/bin/cat` reads the staged tree, is denied the sibling `turns.jsonl` and the repo).
- **Live gate run — and it falsified the core premise.** Real `codex exec` EPERMs at startup under a deny-default Seatbelt profile regardless of every file/non-file allowance and codex's own bypass flag (`codex --version` runs jailed; `codex exec` does not). Strong inference: codex exec self-applies Apple Seatbelt and Seatbelt cannot be nested — `sandbox-exec` is the wrong primitive for jailing codex, not a tunable profile gap.
- **Honest re-scope (not a false guarantee).** `read_jail_available()` is gated `False` (`_CODEX_READJAIL_VERIFIED=False` ∧ sandbox-exec present). `paranoid` T3 honestly degrades to the in-process Claude cold-read, per-predicate `PredicateResult.t3` = `claude_cold_fallback` with `RESIDUAL_CLAUDE_FALLBACK` stated verbatim (never rounded to "confined"). `codex_jailed`/`codex_jailed_error` lanes are dead-but-tested, one flag-flip from active when a non-nesting primitive lands.
- **`T3Provenance`** (`result.py`): `mode`/`guarantee`/`model_id`/`residual`, optional on `PredicateResult` (additive superset); `make_t3_provenance` pure map; `meta.model_id` documented as T1/T2-lane only (T3 model authoritative in `t3.model_id`); `meta.t3_summary` a per-predicate rollup, never a flattened label. `evaluate_t3` branches jailed-Codex vs Claude-fallback with a machine `[t3:<mode>]` reason tag; jailed-error vs fallback-error never conflated.
- **Honest-absence contract:** no adversary run ⇒ `t3=None`, `ran_t3=False`, no `T3` in summary, no fabricated `tier_disagreements`, `degraded_judged=True`, T2 stands — every surface agrees.
- `compose/contracts/judge-result.json`: additive optional per-predicate `t3`; `meta`/`stakes` descriptions reconciled. New `test_judge_sandbox.py` (10) + `test_judge_readjail.py` (8) + 11 `test_judge_t3.py`; 659 suite green (excl. standing live-inference `test_e2e`). 8 Codex rounds (3 design + 1 blueprint + 4 impl) → CLEAN; live gate caught the `--ephemeral`-after-`exec` bug `--version` never would. Follow-ups filed: **STRAT-JUDGE-T3-READJAIL-CODEXNEST**, **STRAT-JUDGE-T3-READJAIL-LINUX**.

### stratum — feat(STRAT-JUDGE-v2-slice1): T3 cold-read adversary (paranoid-only)

- **`paranoid` stakes is live.** Every interpretive `met` is cross-checked by a T3 adversary asked to falsify it. `default`/`cheap` unchanged (byte-for-byte v1). `spec.py` stakes Literal + both JSON-schema enums admit `paranoid`; the kernel no longer raises `StakesNotAvailableError`.
- **`evaluate_t3`** (`verifier.py`): cold by signature — does not accept the T2 `TierRecord`/`Evidence`; adversary/falsifier prompt; Claude, Read/Grep/Glob only, Bash disallowed, `cwd=staging_root`; reuses T2 citation/parse discipline; fail-safe `ambiguous`/`t3_no_staged_evidence` on empty staging (never fabricates `met`).
- **Disagreement:** T2 `met` + T3 `not_met`/`ambiguous` → final `ambiguous` + a `tier_disagreements` record (T4 quorum deferred — surfaced, never a silent pick). T2 `met` + T3 `met` → `met`.
- **`degraded_judged`** redefined: "a `judged` predicate did not receive adversarial (T3) verification" — `False` once T3 ran.
- **Cold-read isolation is best-effort, stated honestly** (three Codex rounds killed two isolation overclaims): the connector stack provides no filesystem read-jail. Real guarantee = T3 is not *handed* prior reasoning (structural) + per-predicate tier rows are buffered and flushed in a `finally` *after* T3 (closes the shared-`turns.jsonl` side channel for the same predicate; preserves audit completeness on mid-predicate exception). Accepted residual + hard read-jail tracked as STRAT-JUDGE-T3-READJAIL.
- 11 new `tests/test_judge_t3.py`; 3 stale-contract tests updated; contract docs (`compose/contracts/judge-result.json`, MCP tool descriptions) reconciled. 6 Codex rounds (3 design + 3 impl) → CLEAN.

### stratum — feat(STRAT-JUDGE-POSTMORTEM-v2.2): corpus-quality fixes + replay harness

- **#2 acceptance/topic-shift discrimination** (`signals.py`): `_is_genuine_acceptance` gates the acceptance signal behind `_FORWARD_PIVOT_PATTERNS` + a symmetric `_token_overlap` check — "thanks, now let's Y" is a pivot, not acknowledgement. Conservative: only softens `true_met→ambiguous`, never flips a label.
- **#3 predicate decomposition** (`decompose.py`, new): `LiteLLMDecomposer` back-decomposes `request_text` into `result.Predicate` lists in the kernel's real `deterministic|verified|judged` taxonomy. Mirrors the `llm_gate` seam — litellm-routed, pydantic-validated, fail-open = empty list (never fabricates predicates). CLI `--decompose`; schema **1.1 → 1.2** additive `predicates` key.
- **#4 replay harness** (`replay.py`, new + `replay` CLI subcommand): runs a faithful judge subset over the corpus at moment-of-claim, scoring per-tier false-met/false-not-met vs ground truth. Taxonomy-faithful routing (deterministic→T1 only if transcript-decidable & not a result/output claim; verified→T2 only with a post-claim `tool_result`; else `unreplayable`); moment-of-claim respected (T1 reads work-span tools only); empty/all-unreplayable → explicit unscorable (never `all([])→true_met`); abstention + coverage first-class; sha1 20% holdout with smoke-only caveat; schema-versioned scorecard JSON.
- **65 postmortem tests**; full core-lib suite 629 passed (14 pre-existing `test_e2e` live-inference timeouts only). 3 Codex implementation-review rounds → CLEAN.

### stratum — feat(STRAT-JUDGE-POSTMORTEM-v2.1): LLM-augmented segmenter gate

- **New `stratum.judge.postmortem.llm_gate`:** opt-in request↔claim same-task gate that runs after the regex segmenter (recall) as a precision pass. `SegmenterGate` Protocol, pure `build_gate_prompt`/`parse_gate_response`, concrete `LiteLLMGate`, `GateVerdict`, `SegmentStats`.
- **Routed through the declared `litellm` dependency** (not the undeclared `anthropic` SDK); default model `claude-haiku-4-5`.
- **Fail-open contract:** any gate error, malformed JSON, semantically-invalid output (pydantic `StrictBool` + `[0,1]` confidence), or non-string `message.content` keeps the candidate (`applied=False`) — a calibration corpus never silently shrinks.
- **`segment()`** gains keyword-only `gate`/`gate_threshold`/`stats`; `Candidate.gate_verdict`; `gate=None` preserves pre-v2.1 segmenter behavior. Removed dead `_last_assistant_text_before`.
- **CLI:** `extract --llm-gate`, `--gate-model`, `--gate-threshold` (range-validated to `[0,1]`); summary reports `checked`/`rejected`.
- **Schema 1.0 → 1.1:** additive `gate` key on each candidate record (null when off).
- **25 tests** in `tests/test_postmortem_gate.py`. 3 Codex review rounds → CLEAN.

### stratum-mcp — feat(STRAT-GOAL-V1): goal orchestrator with 4 MCP tools

- **4 new MCP tools:** `stratum_goal`, `stratum_goal_status`, `stratum_goal_decide`, `stratum_goal_archive`
- **New `stratum.goal` package:** orchestrator with mode matrix (shadow-driven, shadow-observed, advisory, autonomous), worker dispatch with M17 Codex driven-mode safety guard, autonomy resolution with SmartMemory DI
- **`FlowState.synthetic` field:** when `True`, `delete_persisted_flow` skips judge-tree cleanup (PRD M14) so the orchestrator can inspect judge audit artifacts after the synthetic flow completes; `stratum_goal_archive` handles teardown instead
- **`delete_persisted_flow(*, synthetic=False)` guard:** STRAT-GOAL-aware signature; synthetic flows skip deletion of flow JSON and judge tree in `stratum_gate_resolve`, instead persisting terminal state for `stratum_goal_status` reads
- **New schema fields:** `flow-state.v1.schema.json` and `query-flows.v1.schema.json` both add `synthetic: bool` so that Compose and external query consumers can distinguish goal-driven synthetic flows from real user flows
- **Adversarial corpus (7 cases):** `tests/fixtures/goal-adversarial.jsonl` + `tests/test_goal_adversarial.py` for shadow-mode regression detection
- **Tests:** `test_goal_kernel.py`, `test_goal_state.py`, `test_goal_prompts.py`, `test_goal_worker.py`, `test_goal_adversarial.py`, `test_goal_coverage_sweep.py`, `test_goal_e2e.py`, `test_goal_tool.py`
- See `docs/features/STRAT-GOAL/` for full design

### stratum-mcp — feat(STRAT-JUDGE-V1): tiered self-correction judge

- **New `stratum.judge` package:** kernel, predicates, staging, verifier, errors, result — T1 + T2 tier dispatch with confidence-gated verdict normalization
- **New MCP tool: `stratum_judge`** — STRAT-IMMUTABLE integrity checks enforce that predicate/stakes/budget payload matches the IR-declared `judge:` block; spec-level checksum verified before every invocation
- **T1/T2 tier dispatch:** T1 evaluates deterministic predicates against staged artifacts; T2 dispatches a Claude verifier with read-only tools and citation-format enforcement
- **Judge tree at `~/.stratum/judge/<flow_id>/`** — per-turn staging with `record_judge_turn` accumulating `judge_history` and `judge_outcome` on `FlowState`; cleared atomically with `delete_persisted_flow`
- **Checksum coverage:** `compute_spec_checksum` includes `judge:` block (predicates, stakes, budget) so live flows can't have gate config altered mid-run undetected
- **`get_current_step_info` judge mode:** returns caller-driven dispatch envelope so the executor never invokes MCP tools itself
- **Tests:** `test_judge_kernel.py`, `test_judge_predicates.py`, `test_judge_schema.py`, `test_judge_staging.py`, `test_judge_verifier.py`, `test_judge_corpus.py`, `test_executor_judge.py`, `test_server_judge.py`, `test_spec_judge.py`
- See `docs/features/STRAT-JUDGE/` for full design

### stratum-mcp — fix(setup): probe + reorder for atomic install (STRAT-SETUP-ATOMIC)

- **`_cmd_setup` reordered to fail-fast before any project mutation.** New order: root detection → `_probe_setup_preconditions()` → `_copy_hook_scripts` (raise on per-script failures) → `.claude/mcp.json` → `CLAUDE.md` → skills sync → `_register_hooks_in_settings`. Previously `.claude/mcp.json`, `CLAUDE.md`, and `~/.claude/skills/` were written first; if `_install_hooks` then raised (missing bundled hook source or unwritable `~/.stratum/hooks/`), the project was left in a partial state.
- **New `_probe_setup_preconditions()` helper** — checks every bundled hook source file in `_HOOK_SCRIPTS` exists; runs `_STRATUM_HOOKS_DIR.mkdir(parents=True, exist_ok=True)` as a writability test. Raises `OSError` with named missing paths on failure. Silent on success.
- **`_install_hooks` function definition unchanged.** Still composes copy + register and raises on copy failures; still exercised by the existing `TestInstallHooksFailFast` regression. Just no longer called from `_cmd_setup` (which now invokes `_copy_hook_scripts` and `_register_hooks_in_settings` directly).
- **New `_SKILLS_HOME` module-level constant** — extracted from a local resolution inside `_cmd_setup` so the new `isolated_skills_home` test fixture can monkeypatch it cleanly.
- **Surviving non-atomic registration paths documented** — `_register_hooks_in_settings` can still raise mid-call (legacy-copy cleanup at server.py:2023, settings.json write at :2072). Deferred to potential STRAT-SETUP-ATOMIC-V2 if it surfaces in practice.
- **Tests** — 9 new tests in `tests/integration/test_setup.py` covering probe behavior (silent on happy path, raises on missing source, error names paths, creates `~/.stratum/hooks/`) and atomic-ordering invariants (probe failure leaves mcp.json / CLAUDE.md / skills untouched; copy failure mid-stream leaves project untouched). **907 passing, 2 skipped.**

### stratum-mcp — fix(codex): raise stdout buffer ceiling (STRAT-MCP-CHUNK-SIZE)

- **`CodexConnector` now passes `limit=4 MiB` to `asyncio.create_subprocess_exec`** in both `run()` and `stream_events()`. The asyncio default 64 KiB `StreamReader` buffer was too small for codex's `--json` preamble (resolved model config, sandbox profile, cwd, full prompt echo), causing the first `proc.stdout.readline()` to raise `LimitOverrunError` ("Separator is not found, and chunk exceed the limit") before any agent event reached the caller. `mcp__stratum__stratum_agent_run(type="codex")` would deterministically fail before the agent ran.
- **Env knob `STRATUM_CODEX_STREAM_LIMIT_BYTES`** — overrides the 4 MiB default, clamped to a 64 KiB floor so a misconfigured value can't silently re-enable the bug.
- **Graceful failure path** — if a line still exceeds the configured limit, `run()` yields an `{"type":"error", message:...}` envelope and `stream_events()` raises `RuntimeError`. Both messages name the env knob so callers can self-recover. Python 3.12's `readline()` wraps `LimitOverrunError` as `ValueError` with the original message — both paths are matched via a small message-text helper.
- **Tests** — new `tests/test_codex_chunk_size.py` (9 cases): constant defined, env override honored, floor clamp, real-subprocess 200 KiB line read OK, asyncio default sanity-repro of original bug, graceful-failure messages on both code paths. **898 passing, 2 skipped.**

### stratum-mcp — feat(STRAT-PAR-STREAM): stream_events rolled out to all connectors

- **`AgentConnector.stream_events()`** added to base — default impl yields nothing so subclasses (opencode) don't raise `AttributeError`.
- **`ClaudeConnector.stream_events()`** added — yields `ConnectorEvent` per assistant block / tool call for parallel-dispatch consumers. Adds `thinking` and `effort` constructor params.
- **`CodexConnector.stream_events()`** added — parallel JSONL driver, marked for de-dup under `STRAT-DEDUP-AGENTRUN-V3`.
- **`make_agent_connector`** now accepts `allowed_tools` / `disallowed_tools` / `thinking` / `effort` for Claude.
- **Server + parallel-exec wiring** — `_emit` envelope path consumes per-connector streams without breaking the legacy envelope contract.
- **Drop `tests/test_codex_connector_sync.py`** — STRAT-DEDUP cross-repo drift guard retired now that codex's connector is being rewritten upstream.

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
