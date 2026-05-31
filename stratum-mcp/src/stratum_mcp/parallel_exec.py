"""Parallel task executor for parallel_dispatch steps (T2-F5-ENFORCE T10/T11/T12).

This module owns the server-side execution of a parallel_dispatch step:
  - fan-out across a task list bounded by ``max_concurrent``;
  - per-task isolation via ``worktree.create_worktree``;
  - connector dispatch via ``connectors.factory.make_agent_connector``;
  - per-task timeout + cancellation (T6 interrupt + asyncio cancel);
  - certificate validation on the result (T8);
  - require-policy-driven cascade cancel (T11);
  - scrubbed env with STRATUM_* injected (T12);
  - serialized FlowState persistence via a per-flow asyncio.Lock registry.

Event envelope:
  The connector contract (``connectors.base.Event``) defines a ``result`` event
  with a ``content`` field for the final text. Tests drive this module with a
  stub that produces ``{"type": "result", "output": <payload>}`` because the
  parallel path wants to hand a structured result payload back to the caller
  without re-parsing text. ``_consume`` accepts either key — prefer ``output``
  when present, else fall back to ``content``.
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import signal
import sys
import time
from pathlib import Path
from typing import Any, Callable, Optional

from .connectors.base import AgentConnector, SENSITIVE_ENV_VARS
from .connectors.codex import (
    T2F5_DONE_SENTINEL,
    CodexConnector,
    _CODEX_ERROR_KIND,
    _emit_for_codex_event,
    _read_text_file,
)
from .connectors.factory import make_agent_connector
from .events import (
    INTERNAL_RESULT_KIND,
    BuildStreamEvent,
    TaskSeqCounter,
    now_iso,
)
from .executor import (
    EnsureCompileError,
    FlowState,
    ParallelTaskState,
    compile_predicate,
    effective_pipeline_task_cert,
    flow_streams_dir,
    inject_cert_instructions,
    persist_flow,
    validate_certificate,
)
from .run_budget import (
    BUDGET_EXHAUSTED,
    accumulate_usage,
    budget_exhausted,
    debit_budget,
    new_usage_acc,
)
from .pricing import _maybe_warn_unpriced
from .proc_identity import pid_alive, proc_start_time
from .worktree import capture_worktree_diff, create_worktree, remove_worktree

logger = logging.getLogger(__name__)

DEFAULT_TASK_TIMEOUT = 1800  # seconds

# Per-flow persistence lock registry. Module-level so that concurrent writers
# (e.g., the executor's per-task persist + a sibling poll path) coexist without
# clobbering each other's FlowState snapshot.
_FLOW_LOCKS: dict[str, asyncio.Lock] = {}


def _lock_for(flow_id: str) -> asyncio.Lock:
    lock = _FLOW_LOCKS.get(flow_id)
    if lock is None:
        lock = asyncio.Lock()
        _FLOW_LOCKS[flow_id] = lock
    return lock


def _remove_stream_files(ts: "ParallelTaskState") -> None:
    """T2-F5-RESUME: remove a reparentable task's durable stream/stderr/prompt
    files once it reaches a terminal state (kept until then for re-attach).
    Best-effort and idempotent; a no-op for non-durable tasks (paths are None).
    """
    paths: list[str] = []
    if ts.stream_path:
        paths.append(ts.stream_path)
        paths.append(ts.stream_path + ".in")
    if ts.stderr_path:
        paths.append(ts.stderr_path)
    for p in paths:
        try:
            os.remove(p)
        except (FileNotFoundError, OSError):
            pass


def _connector_type_from_agent(agent: Optional[str]) -> str:
    """Parse the spec ``agent`` string into a concrete connector type.

    - Strips any ``"prefix:profile"`` suffix (e.g., ``claude:reviewer`` → ``claude``).
    - Falls back to ``STRATUM_DEFAULT_AGENT`` when ``agent`` is falsy; defaults
      that env var to ``claude`` so every flow resolves to *something*.
    - Rejects ``opencode`` with a roadmap pointer (T2-F5-OPENCODE-DISPATCH) —
      server-dispatch doesn't wire opencode yet.
    - Rejects unknown prefixes with a clear error.
    """
    if not agent:
        agent = os.environ.get("STRATUM_DEFAULT_AGENT", "claude")
    head = agent.split(":", 1)[0].strip()
    if head == "opencode":
        raise ValueError(
            f"parallel_dispatch agent '{agent}' uses opencode, which is not "
            "yet supported in server-side dispatch (see roadmap "
            "T2-F5-OPENCODE-DISPATCH). Use 'claude' or 'codex', or keep "
            "consumer-side dispatch for this step."
        )
    if head not in ("claude", "codex"):
        raise ValueError(
            f"parallel_dispatch agent '{agent}' has unknown connector prefix; "
            "expected 'claude' or 'codex'"
        )
    return head


def _task_env(flow_id: str, step_id: str, task_id: str) -> dict[str, str]:
    """Build a scrubbed env dict for the task subprocess.

    Starts from ``os.environ``, drops every var listed in
    :data:`SENSITIVE_ENV_VARS` (defense-in-depth — the connector also scrubs),
    and injects ``STRATUM_FLOW_ID`` / ``STRATUM_STEP_ID`` / ``STRATUM_TASK_ID``
    so the child agent can tag its activity.
    """
    env = {k: v for k, v in os.environ.items() if k not in SENSITIVE_ENV_VARS}
    env["STRATUM_FLOW_ID"] = flow_id
    env["STRATUM_STEP_ID"] = step_id
    env["STRATUM_TASK_ID"] = task_id
    return env


def _detect_dependency_cycle(tasks: list[dict[str, Any]]) -> Optional[list[str]]:
    """Return the first cycle found as an ordered list of task_ids, or None.

    Uses DFS with WHITE/GRAY/BLACK coloring. Unknown dep references (task_ids
    that don't appear in the task list) are skipped — they're caught at
    wait-time with a clearer per-task error.
    """
    WHITE, GRAY, BLACK = 0, 1, 2
    color: dict[str, int] = {t["id"]: WHITE for t in tasks}
    edges: dict[str, list[str]] = {t["id"]: (t.get("depends_on") or []) for t in tasks}

    def dfs(node: str, path: list[str]) -> Optional[list[str]]:
        color[node] = GRAY
        path.append(node)
        for dep in edges.get(node, []):
            if dep not in color:
                continue  # unknown dep — skip; not a cycle
            if color[dep] == GRAY:
                i = path.index(dep)
                return path[i:] + [dep]
            if color[dep] == WHITE:
                cycle = dfs(dep, path)
                if cycle:
                    return cycle
        path.pop()
        color[node] = BLACK
        return None

    for t in tasks:
        if color[t["id"]] == WHITE:
            cycle = dfs(t["id"], [])
            if cycle:
                return cycle
    return None


class ParallelExecutor:
    """Run a parallel_dispatch step's task list to completion."""

    def __init__(
        self,
        *,
        state: FlowState,
        step_id: str,
        tasks: list[dict],
        max_concurrent: int,
        isolation: str,               # "worktree" | "none"
        task_timeout: int,            # seconds
        agent: Optional[str],
        intent_template: str,
        task_reasoning_template: Optional[dict],
        require: Any,                 # "all" | "any" | int
        model_id: Optional[str] = None,
        persist_callable: Optional[Callable[[FlowState], None]] = None,
        capture_diff: bool = False,
        is_pipeline: bool = False,
        ctx: Any = None,
    ) -> None:
        self.state = state
        self.step_id = step_id
        self.tasks = tasks
        # STRAT-WORKFLOW-PIPELINE: when True, require/cascade are item-scoped and
        # the per-task cert gate keys on the resolved per-stage agent.
        self.is_pipeline = is_pipeline
        self.max_concurrent = max(1, int(max_concurrent))
        self.isolation = isolation
        self.task_timeout = task_timeout if task_timeout is not None else DEFAULT_TASK_TIMEOUT
        self.agent = agent
        self.intent_template = intent_template or ""
        self.task_reasoning_template = task_reasoning_template
        self.require = require
        self.model_id = model_id
        self._persist_callable = persist_callable or persist_flow
        self.capture_diff = capture_diff
        self._ctx = ctx
        self._seq_counter = TaskSeqCounter()
        self._emit_failed: dict[str, bool] = {}
        self.events: asyncio.Queue[BuildStreamEvent] = asyncio.Queue(maxsize=1000)
        self._dropped_warned = False

        # Handle + connector registries for cascade cancel.
        self._task_handles: dict[str, asyncio.Task] = {}
        self._connectors: dict[str, AgentConnector] = {}
        # STRAT-WORKFLOW-BUDGET: per-task usage accumulator, read in _run_one.
        self._task_usage: dict[str, dict] = {}

        # T2-F5-DEPENDS-ON: per-task done-events + terminal-state record
        self._task_done: dict[str, asyncio.Event] = {
            t["id"]: asyncio.Event() for t in self.tasks
        }
        self._task_terminal_state: dict[str, str] = {}
        # STRAT-WORKFLOW-PIPELINE-ROUTE: per-item early-exit marker. When a stage's
        # `exit_when` fires, maps the item index → the stage it exited at; later
        # stages of that item then skip. Mutated in the single-flow async context.
        self._item_exited: dict[Any, int] = {}
        # STRAT-WORKFLOW-PIPELINE-FANOUT: memoized split-stage list per split task id.
        # Populated by the split-role validation branch in _run_one when the split
        # completes; read by _lane_is_filled / _effective_lane_input. Same single
        # async context, no lock.
        self._fanout_lists: dict[str, list] = {}
        # T2-F5-RESUME: set True by the server shutdown hook (via S6) before it
        # cancels the executor tasks. When True, a reparentable (codex durable-
        # stream) task is DETACHED, not killed — _run_one's cancel/finally paths
        # skip interrupt/terminalize/worktree-remove and leave it `running` with
        # its handle persisted, so restart-classify can re-attach to the live
        # child. A genuine cascade/budget cancel (this stays False) keeps the
        # full destructive teardown.
        self._detaching = False

        # Seed per-task state so pollers see "pending" from the start.
        for t in tasks:
            tid = t["id"]
            if tid not in state.parallel_tasks:
                state.parallel_tasks[tid] = ParallelTaskState(task_id=tid)

    # ------------------------------------------------------------------
    # public surface
    # ------------------------------------------------------------------

    async def run(self) -> None:
        """Fan out all tasks and wait for them to settle.

        Each task runs under a shared semaphore bounded by ``max_concurrent``.
        Cascade cancel (triggered when a task finishes in a way that makes the
        ``require`` policy unsatisfiable) calls ``handle.cancel()`` on siblings
        — the cancellation path inside ``_run_one`` handles cleanup.
        """
        # T2-F5-DEPENDS-ON: cycle check before fan-out
        cycle = _detect_dependency_cycle(self.tasks)
        if cycle is not None:
            msg = f"dependency cycle detected: {' -> '.join(cycle)}"
            for t in self.tasks:
                tid = t["id"]
                ts = self.state.parallel_tasks[tid]
                ts.state = "failed"
                ts.error = msg
                ts.finished_at = time.time()
                self._task_terminal_state[tid] = "failed"
                self._task_done[tid].set()
            await self._persist()
            return

        sem = asyncio.Semaphore(self.max_concurrent)
        tasks = [asyncio.create_task(self._run_one(sem, t)) for t in self.tasks]
        for t, handle in zip(self.tasks, tasks):
            self._task_handles[t["id"]] = handle
        # ``gather`` with return_exceptions swallows per-task exceptions so one
        # raising task doesn't prevent the rest from finishing their cleanup.
        # Per-task state already records failure mode; see _run_one's except
        # arms.
        await asyncio.gather(*tasks, return_exceptions=True)

    # ------------------------------------------------------------------
    # internals
    # ------------------------------------------------------------------

    def _render_prompt(self, task: dict) -> str:
        """Render the step/stage ``intent_template`` using the task dict as kwargs.

        STRAT-WORKFLOW-PIPELINE: a pipeline task carries its own stage template in
        ``_intent_template`` (preferred over the executor-wide ``intent_template``),
        and — when it has exactly one ``depends_on`` predecessor — binds that
        predecessor's result as ``{prev}`` (string; JSON-encoded if not already a
        str) and ``{prev_raw}`` (raw object). Falls back to the raw template when
        ``str.format`` can't find a field (a template with no placeholders is valid).
        """
        def _as_str(v):
            return v if isinstance(v, str) else json.dumps(v, default=str, ensure_ascii=False)

        template = task.get("_intent_template") or self.intent_template
        kwargs = dict(task)
        deps = task.get("depends_on") or []
        role = task.get("_pipeline_role") if self.is_pipeline else None

        if role == "lane":
            # STRAT-WORKFLOW-PIPELINE-FANOUT: {item} = the lane element L[k] (via the
            # single resolver); {source}/{source_raw} = the original source item
            # (the lane task's own `item` field). First per-lane stage's {prev} = the
            # lane element; subsequent per-lane stage's {prev} = single-dep result.
            lane_input = self._effective_lane_input(task)
            src = task.get("item")
            kwargs["source_raw"] = src
            kwargs["source"] = _as_str(src)
            kwargs["item"] = lane_input
            if len(deps) == 1 and deps[0] == task.get("_fanout_split_id"):
                kwargs["prev_raw"] = lane_input
                kwargs["prev"] = _as_str(lane_input)
            elif len(deps) == 1:
                dep_ts = self.state.parallel_tasks.get(deps[0])
                if dep_ts is not None:
                    kwargs["prev_raw"] = dep_ts.result
                    kwargs["prev"] = _as_str(dep_ts.result)
        elif role == "join":
            # {prevs}/{prevs_raw} = surviving (complete, filled) lane results; a
            # skipped (unfilled) or failed lane is excluded. {source} = source item.
            survivors = [
                self.state.parallel_tasks[d].result
                for d in deps
                if self._task_terminal_state.get(d) == "complete"
                and self.state.parallel_tasks.get(d) is not None
            ]
            kwargs["prevs_raw"] = survivors
            kwargs["prevs"] = json.dumps(survivors, default=str, ensure_ascii=False)
            src = task.get("item")
            kwargs["source_raw"] = src
            kwargs["source"] = _as_str(src)
        elif len(deps) == 1:
            dep_ts = self.state.parallel_tasks.get(deps[0])
            if dep_ts is not None:
                raw = dep_ts.result
                kwargs["prev_raw"] = raw
                kwargs["prev"] = (
                    raw if isinstance(raw, str)
                    else json.dumps(raw, default=str, ensure_ascii=False)
                )
        try:
            rendered = template.format(**kwargs)
        except (KeyError, IndexError):
            rendered = template
        # STRAT-WORKFLOW-PIPELINE-STAGEOPTS: inject the effective cert's INSTRUCTIONS
        # into the prompt (pipeline only) so an explicit per-stage cert actually
        # instructs the agent, not just post-hoc validates. Same precedence + gate as
        # validation, so the agent is told to produce exactly what gets checked.
        if self.is_pipeline:
            eff_cert = effective_pipeline_task_cert(
                task.get("_task_reasoning_template"),
                self.task_reasoning_template,
                task.get("_agent") or self.agent,
            )
            if eff_cert is not None:
                # Degrade gracefully: a malformed cert template must not crash the
                # task at render time — validation still runs on the result.
                try:
                    rendered = inject_cert_instructions(rendered, eff_cert)
                except Exception:
                    pass
        return rendered

    def _predecessor_result(self, task: dict) -> Any:
        """The single-dependency predecessor's result (None if not stage>0)."""
        deps = task.get("depends_on") or []
        if len(deps) == 1:
            dep_ts = self.state.parallel_tasks.get(deps[0])
            if dep_ts is not None:
                return dep_ts.result
        return None

    def _route_skip(self, task: dict) -> tuple[bool, Any]:
        """STRAT-WORKFLOW-PIPELINE-ROUTE: decide whether to skip this stage before
        dispatch, and the passthrough result to carry if so.

        Skip iff (a) this item already early-exited at an earlier stage, or (b)
        the stage's `when` predicate is present and falsy. A malformed `when`
        fails OPEN (runs the stage) and is logged, never written to the
        failure-semantic `ts.error`. The passthrough result is the predecessor's
        result (stage>0) or the source item (stage 0), so downstream `{prev}` and
        the item aggregate stay coherent.
        """
        item_idx = task.get("_pipeline_item")
        stage_j = task.get("_pipeline_stage", 0)
        prev_result = self._predecessor_result(task)
        passthrough = prev_result if (task.get("depends_on") or []) else task.get("item")
        # (a) earlier early-exit on this item
        exited_at = self._item_exited.get(item_idx)
        if exited_at is not None and exited_at < stage_j:
            return True, passthrough
        # STRAT-WORKFLOW-PIPELINE-FANOUT: an over-cap (unfilled) lane skips — it
        # carries no data (passthrough None) and is excluded from the join's
        # {prevs}. Route predicates are banned in-region, so a `skipped` lane is
        # unambiguously "unfilled".
        if task.get("_pipeline_role") == "lane" and not self._lane_is_filled(task):
            return True, None
        # (b) `when` predicate
        when = task.get("_when")
        if when:
            allowed = {"item"} if stage_j == 0 else {"item", "prev", "prev_raw"}
            bindings: dict[str, Any] = {"item": task.get("item")}
            if stage_j != 0:
                bindings["prev_raw"] = prev_result
                bindings["prev"] = (
                    prev_result if isinstance(prev_result, str)
                    else json.dumps(prev_result, default=str, ensure_ascii=False)
                )
            try:
                run_it = compile_predicate(when, allowed)(**bindings)
            except EnsureCompileError as exc:
                logger.warning(
                    "STRAT-WORKFLOW-PIPELINE-ROUTE: task %s `when` raised (%s); "
                    "failing open (running the stage)", task["id"], exc,
                )
                run_it = True
            if not run_it:
                return True, passthrough
        return False, passthrough

    def _check_exit_when(self, task: dict, result: Any) -> None:
        """STRAT-WORKFLOW-PIPELINE-ROUTE: after a stage completes, evaluate its
        `exit_when` over this stage's own result; if truthy, mark the item exited
        at this stage so later stages skip. Malformed `exit_when` fails CLOSED
        (no exit) and is logged. Called only when the task is terminal-`complete`.
        """
        exit_when = task.get("_exit_when")
        if not exit_when:
            return
        bindings = {
            "item": task.get("item"),
            "result_raw": result,
            "result": (
                result if isinstance(result, str)
                else json.dumps(result, default=str, ensure_ascii=False)
            ),
        }
        try:
            do_exit = compile_predicate(
                exit_when, {"item", "result", "result_raw"}
            )(**bindings)
        except EnsureCompileError as exc:
            logger.warning(
                "STRAT-WORKFLOW-PIPELINE-ROUTE: task %s `exit_when` raised (%s); "
                "failing closed (not exiting)", task["id"], exc,
            )
            return
        if do_exit:
            self._item_exited[task.get("_pipeline_item")] = task.get("_pipeline_stage", 0)

    # ------------------------------------------------------------------
    # STRAT-WORKFLOW-PIPELINE-FANOUT: bounded map-reduce helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _fanout_require_satisfied(complete: int, filled: int, require: Any) -> bool:
        """Lane-require over FILLED lanes (unfilled/skipped lanes don't count).
        Empty (filled == 0) falls out uniformly: `all` → satisfied, `any`/`N` → not.
        """
        if require == "any":
            return complete >= 1
        if isinstance(require, int) and not isinstance(require, bool):
            return complete >= require
        # "all" (default / unknown) → every filled lane must have completed
        return complete == filled

    def _resolve_fanout_list(self, split_id: str) -> list:
        """Resolve a split task's result to the fan-out list `L` (design §2 contract):
        a native list is used as-is; a JSON-array string is parsed; anything else
        raises. Raises propagate to the split-role validation branch, which turns
        them into a split-task failure.
        """
        raw = self.state.parallel_tasks[split_id].result
        if isinstance(raw, list):
            return raw
        if isinstance(raw, str):
            parsed = json.loads(raw)
            if not isinstance(parsed, list):
                raise ValueError("fanout stage result is not a JSON array")
            return parsed
        raise ValueError("fanout stage result is not a list")

    def _lane_is_filled(self, task: dict) -> bool:
        """A lane is filled iff its index < the resolved split list length.
        Reads the memoized list (populated when the split completed)."""
        L = self._fanout_lists.get(task.get("_fanout_split_id"))
        if L is None:
            return False
        return task.get("_fanout_lane", 0) < len(L)

    def _effective_lane_input(self, task: dict) -> Any:
        """The lane's element L[k] — the single resolver of a lane's input, used by
        `_render_prompt` for `{item}` and the first-lane `{prev}`. Only called on a
        filled lane (the index is always in range)."""
        L = self._fanout_lists[task["_fanout_split_id"]]
        return L[task["_fanout_lane"]]

    async def _await_join_deps(self, task: dict, ts: "ParallelTaskState") -> bool:
        """Join-specific dep-gate (design §4): wait for ALL K lane predecessors to
        reach a terminal state, then evaluate lane-require over the FILLED lanes
        (skipped = unfilled, excluded). Returns True to proceed (dispatch the join
        over survivors), or sets the join terminal-`cancelled` and returns False
        when lane-require is unsatisfiable. Distinct from the single-dep gate, which
        cancels on the first non-complete predecessor.
        """
        deps = task.get("depends_on") or []
        for dep_id in deps:
            evt = self._task_done.get(dep_id)
            if evt is None:
                ts.state = "failed"
                ts.error = f"depends_on references unknown task_id '{dep_id}'"
                ts.finished_at = time.time()
                return False
            await evt.wait()
        filled = [d for d in deps if self._task_terminal_state.get(d) != "skipped"]
        complete = [d for d in filled if self._task_terminal_state.get(d) == "complete"]
        require = task.get("_fanout_require", "all")
        if not self._fanout_require_satisfied(len(complete), len(filled), require):
            ts.state = "cancelled"
            ts.error = (
                f"fanout require={require!r} not satisfied: "
                f"{len(complete)}/{len(filled)} lanes completed"
            )
            ts.finished_at = time.time()
            return False
        return True

    async def _persist(self) -> None:
        """Persist the FlowState under the per-flow lock."""
        async with _lock_for(self.state.flow_id):
            self._persist_callable(self.state)

    def _item_counts(self) -> tuple[int, int, int]:
        """Collapse pipeline stage tasks into (complete, failed, in_flight) ITEM counts.

        Groups ``self.tasks`` by ``_pipeline_item``. Per item:
          - ``failed`` iff any of its stage tasks is "failed"/"cancelled";
          - ``complete`` iff every stage task is settled into "complete"/"skipped"
            (STRAT-WORKFLOW-PIPELINE-ROUTE: a `when`-skipped stage or an
            early-exited tail is settled-non-failure, so the prior "highest-stage
            must be complete" rule — which a skipped tail breaks — is replaced by
            "no task still pending/running");
          - else still in flight (some task pending/running).
        Failure takes precedence (can't both happen, but ordering is defensive).
        """
        items: dict[Any, list[dict]] = {}
        for t in self.tasks:
            items.setdefault(t.get("_pipeline_item"), []).append(t)
        complete = failed = in_flight = 0
        for _item, group in items.items():
            # STRAT-WORKFLOW-PIPELINE-FANOUT: a failed LANE is not itself an item
            # failure — lane-require governs whether the join still runs, and the
            # join's own terminal state (complete vs cancelled) carries that verdict.
            # So failure is judged over non-lane tasks only; lanes still gate
            # in-flight (an item isn't complete until its lanes settle).
            non_lane = [t for t in group if t.get("_pipeline_role") != "lane"]
            if any(self.state.parallel_tasks[t["id"]].state in ("failed", "cancelled")
                   for t in non_lane):
                failed += 1
            elif any(self.state.parallel_tasks[t["id"]].state
                     in ("pending", "running", "reparenting")  # T2-F5-RESUME
                     for t in group):
                in_flight += 1
            else:
                complete += 1
        return complete, failed, in_flight

    def _require_unsatisfiable(self) -> bool:
        """True when the ``require`` policy can no longer be satisfied.

        - ``require == "all"`` — any failure/cancel makes the step unsatisfiable.
        - ``require == "any"`` — unsatisfiable only after *every* task settled
          and none completed.
        - ``require`` integer N — unsatisfiable when ``complete + still_active < N``.

        STRAT-WORKFLOW-PIPELINE: in pipeline mode the unit of work is the *item*,
        not the individual stage task. An item is ``complete`` iff its final-stage
        task completed, ``failed`` iff any of its stage tasks failed/cancelled, else
        still in flight. A single item's failure thus only makes the policy
        unsatisfiable under ``require: all`` (matching parallel_dispatch, item-scoped).
        """
        if self.is_pipeline:
            complete, failed_or_cancelled, pending_running = self._item_counts()
        else:
            states = [self.state.parallel_tasks[t["id"]].state for t in self.tasks]
            complete = sum(1 for s in states if s == "complete")
            failed_or_cancelled = sum(1 for s in states if s in ("failed", "cancelled"))
            # T2-F5-RESUME: `reparenting` is in-flight (re-attaching), not settled.
            pending_running = sum(
                1 for s in states if s in ("pending", "running", "reparenting")
            )

        if self.require == "all":
            return failed_or_cancelled > 0
        if self.require == "any":
            return complete == 0 and pending_running == 0
        if isinstance(self.require, int):
            remaining_possible = complete + pending_running
            return remaining_possible < self.require
        # Unknown require policy — treat as "all" for safety.
        return failed_or_cancelled > 0

    def _cancel_siblings(self) -> None:
        """Interrupt + cancel every still-active sibling.

        Calls ``connector.interrupt()`` (SIGTERM→SIGKILL for subprocess-backed
        connectors) so the OS-level process actually dies, then cancels the
        asyncio task handle so the consume loop exits promptly. Swallowed
        exceptions — best-effort.
        """
        for tid, handle in self._task_handles.items():
            ts = self.state.parallel_tasks.get(tid)
            if ts is None:
                continue
            if ts.state in ("pending", "running") and not handle.done():
                conn = self._connectors.get(tid)
                if conn is not None:
                    try:
                        conn.interrupt()
                    except Exception:
                        pass
                # If the sibling hasn't entered _run_one yet (still blocked on
                # the semaphore), cancelling its handle short-circuits the
                # coroutine before any state transition happens. Mark it
                # cancelled here so the terminal state is recorded regardless.
                if ts.state == "pending":
                    ts.state = "cancelled"
                    ts.finished_at = time.time()
                handle.cancel()

    def _mint(
        self, task_id: str, kind: str, metadata: dict[str, Any]
    ) -> BuildStreamEvent:
        return BuildStreamEvent(
            flow_id=self.state.flow_id,
            step_id=self.step_id,
            task_id=task_id,
            seq=self._seq_counter.next(self.state.flow_id, self.step_id, task_id),
            ts=now_iso(),
            kind=kind,
            metadata=metadata,
        )

    async def _emit(self, task_id: str, envelope: BuildStreamEvent) -> None:
        # STRAT-PAR-STREAM transport: enqueue on the executor's bounded buffer.
        # The poll handler drains this queue under its own live ctx — the
        # parallel_start request that constructed this executor has long since
        # returned and its ctx is dead.
        try:
            self.events.put_nowait(envelope)
        except asyncio.QueueFull:
            try:
                self.events.get_nowait()
            except asyncio.QueueEmpty:
                pass
            try:
                self.events.put_nowait(envelope)
            except asyncio.QueueFull:
                pass
            if not self._dropped_warned:
                self._dropped_warned = True
                print(
                    f"stratum-mcp: warning: event queue overflow on "
                    f"flow={self.state.flow_id} step={self.step_id}; "
                    f"dropping oldest events.",
                    file=sys.stderr,
                )

    async def _consume_streaming(
        self,
        connector: AgentConnector,
        task_id: str,
        prompt: str,
        cwd: Optional[str],
        env: dict[str, str],
    ) -> Any:
        """Drain ``connector.stream_events()`` and forward to ``ctx.report_progress``.

        The agent_started envelope is minted by the caller before invocation.
        Connector-yielded ``_result`` (INTERNAL_RESULT_KIND) events carry the
        final agent text and are NOT pushed to the wire.
        """
        # STRAT-WORKFLOW-BUDGET: register the accumulator BEFORE consuming so
        # partial usage survives an error/timeout/cancel mid-stream — the dict
        # holds the reference and accumulate_usage mutates it in place, so the
        # _run_one finally always sees whatever was charged before the fault.
        acc = new_usage_acc()
        self._task_usage[task_id] = acc
        stream = getattr(connector, "stream_events", None)
        if stream is None:
            return await self._consume(connector, prompt, cwd, env, acc=acc, task_id=task_id)
        final: Any = None
        produced_event = False
        produced_result_sentinel = False
        async for ev in stream(prompt=prompt, cwd=cwd, env=env):
            produced_event = True
            accumulate_usage(acc, ev)
            # T2-F5-RESUME (review #2): the connector emits `durable_spawned` as
            # its FIRST event — the handle handoff. Stamp the reparent handle on
            # the task and persist it immediately (under the per-flow lock),
            # BEFORE any codex output, so a crash between spawn and first output
            # is still reparentable. Not forwarded to the wire (internal handle).
            if ev.kind == "durable_spawned":
                ts = self.state.parallel_tasks[task_id]
                ts.child_pid = ev.metadata.get("child_pid")
                ts.stream_path = ev.metadata.get("stream_path")
                ts.stderr_path = ev.metadata.get("stderr_path")
                ts.proc_start_time = ev.metadata.get("proc_start_time")
                ts.reparentable = True
                await self._persist()
                continue
            if ev.kind == INTERNAL_RESULT_KIND:
                produced_result_sentinel = True
                final = ev.metadata.get("content")
                continue
            envelope = self._mint(task_id, ev.kind, dict(ev.metadata))
            await self._emit(task_id, envelope)
        if not produced_event:
            return await self._consume(connector, prompt, cwd, env, acc=acc, task_id=task_id)
        if not produced_result_sentinel:
            raise RuntimeError(
                "connector stream_events() yielded events but no _result sentinel; "
                "task output is unrecoverable"
            )
        return final

    async def _consume(
        self,
        connector: AgentConnector,
        prompt: str,
        cwd: Optional[str],
        env: dict[str, str],
        acc: Optional[dict] = None,
        task_id: Optional[str] = None,
    ) -> Any:
        """Drive ``connector.run()`` to completion, returning the final payload.

        We prefer the last ``result`` envelope's ``output`` field, falling back
        to ``content`` for real-connector compatibility. ``error`` events raise
        a ``RuntimeError`` — matches ``server.stratum_agent_run`` semantics.

        STRAT-WORKFLOW-BUDGET: usage events are folded into ``acc`` (created here
        if not supplied) and recorded under ``task_id`` for the run-budget debit.
        """
        if acc is None:
            acc = new_usage_acc()
        # Register early so partial usage survives an error mid-run() (see
        # _consume_streaming). Idempotent if the caller already registered acc.
        if task_id is not None:
            self._task_usage[task_id] = acc
        final: Any = None
        async for event in connector.run(prompt=prompt, cwd=cwd, env=env):
            if not isinstance(event, dict):
                continue
            accumulate_usage(acc, event)
            etype = event.get("type")
            if etype == "result":
                if "output" in event:
                    final = event["output"]
                elif "content" in event:
                    final = event["content"]
                else:
                    final = event
            elif etype == "error":
                raise RuntimeError(event.get("message", "unknown connector error"))
        return final

    async def _run_one(self, sem: asyncio.Semaphore, task: dict) -> None:
        tid = task["id"]
        ts = self.state.parallel_tasks[tid]
        worktree_path_obj: Optional[Path] = None
        connector: Optional[AgentConnector] = None

        try:
            # T2-F5-DEPENDS-ON: wait for upstream dependencies before acquiring
            # semaphore. Waiters don't hold concurrency slots. Early-returns here
            # unwind through the existing finally, which runs cascade-cancel via
            # _require_unsatisfiable.
            deps = task.get("depends_on") or []
            # STRAT-WORKFLOW-PIPELINE-FANOUT: a join task takes a distinct dep-gate —
            # wait for ALL lanes terminal, then require over survivors (design §4).
            if self.is_pipeline and task.get("_pipeline_role") == "join":
                if not await self._await_join_deps(task, ts):
                    return
            else:
                for dep_id in deps:
                    done_evt = self._task_done.get(dep_id)
                    if done_evt is None:
                        ts.state = "failed"
                        ts.error = f"depends_on references unknown task_id '{dep_id}'"
                        ts.finished_at = time.time()
                        return
                    await done_evt.wait()
                    # STRAT-WORKFLOW-PIPELINE-ROUTE: a `skipped` predecessor is a
                    # transparent passthrough — proceed (its result flows into {prev}),
                    # do NOT cancel. Any other non-complete terminal state cancels.
                    if self._task_terminal_state.get(dep_id) not in ("complete", "skipped"):
                        ts.state = "cancelled"
                        ts.error = (
                            f"upstream task '{dep_id}' did not complete "
                            f"(state={self._task_terminal_state.get(dep_id)!r})"
                        )
                        ts.finished_at = time.time()
                        return

            # STRAT-WORKFLOW-PIPELINE-ROUTE: routing skip is decided AFTER deps
            # resolve (so `when` sees the predecessor result) but BEFORE acquiring
            # a concurrency slot — a skipped stage never dispatches and never
            # counts as a budget dispatch (started_at stays None). The finally
            # records terminal_state="skipped"; the downstream dep-gate treats that
            # as proceed and reads this task's passthrough result as {prev}.
            if self.is_pipeline:
                skip, passthrough = self._route_skip(task)
                if skip:
                    ts.state = "skipped"
                    ts.result = passthrough
                    ts.finished_at = time.time()
                    return

            async with sem:
                # ---------- worktree setup (isolation="worktree" only) -----
                try:
                    if self.isolation == "worktree":
                        worktree_path_obj = create_worktree(
                            self.state.flow_id, tid, self.state.cwd,
                        )
                        ts.worktree_path = str(worktree_path_obj)
                    cwd = ts.worktree_path or (self.state.cwd or None)
                except Exception as exc:
                    ts.state = "failed"
                    ts.error = f"worktree setup failed: {exc}"
                    ts.finished_at = time.time()
                    await self._persist()
                    return

                ts.state = "running"
                ts.started_at = time.time()
                await self._persist()

                # ---------- connector dispatch ----------
                try:
                    # STRAT-WORKFLOW-PIPELINE: per-stage agent override (falls back
                    # to the step-level agent for non-pipeline / agent-less stages).
                    connector_type = _connector_type_from_agent(
                        task.get("_agent") or self.agent
                    )
                    # T2-F5-RESUME: codex is the only reparentable server-dispatch
                    # connector. Give it a durable stream file (the child owns it),
                    # so a server restart mid-run can re-attach instead of losing
                    # the work. claude is in-process (nothing to reparent) and is
                    # built with the verbatim 3-arg call (keeps non-codex paths and
                    # their tests untouched).
                    if connector_type == "codex":
                        sdir = flow_streams_dir(self.state.flow_id)
                        sdir.mkdir(parents=True, exist_ok=True)
                        connector = make_agent_connector(
                            connector_type, self.model_id, cwd,
                            stream_path=str(sdir / f"{tid}.jsonl"),
                            stderr_path=str(sdir / f"{tid}.err"),
                        )
                    else:
                        connector = make_agent_connector(
                            connector_type, self.model_id, cwd,
                        )
                    self._connectors[tid] = connector
                except Exception as exc:
                    ts.state = "failed"
                    ts.error = str(exc)
                    ts.finished_at = time.time()
                    if worktree_path_obj is not None:
                        try:
                            remove_worktree(worktree_path_obj)
                        except Exception:
                            pass
                        worktree_path_obj = None  # T2-F5-DIFF-EXPORT: prevent finally from touching deleted path
                    await self._persist()
                    return

                env = _task_env(self.state.flow_id, self.step_id, tid)
                prompt = self._render_prompt(task)

                # STRAT-PAR-STREAM: agent_started is sourced from the
                # connector's stream_events() (which knows the resolved model).
                # Synthetic mint here would emit a duplicate with empty model.

                # ---------- run + terminal-state resolution ----------
                # STRAT-WORKFLOW-PIPELINE-STAGEOPTS: per-stage task_timeout override
                # (presence-based; schema floor is >=1 so a present value is valid).
                _eff_timeout = (
                    task["_task_timeout"]
                    if task.get("_task_timeout") is not None
                    else self.task_timeout
                )
                try:
                    result = await asyncio.wait_for(
                        self._consume_streaming(connector, tid, prompt, cwd, env),
                        timeout=_eff_timeout,
                    )
                except asyncio.TimeoutError:
                    try:
                        connector.interrupt()
                    except Exception:
                        pass
                    ts.state = "failed"
                    ts.error = f"timeout after {_eff_timeout}s"
                except asyncio.CancelledError:
                    # T2-F5-RESUME (review #1): detach-don't-kill. On a shutdown
                    # cancel of a reparentable task, do NOT interrupt (would kill
                    # the durable child) and do NOT terminalize — leave it
                    # `running` with its persisted handle so restart-classify can
                    # re-attach. Re-raise either way so cancellation propagates.
                    if not (self._detaching and ts.reparentable):
                        try:
                            connector.interrupt()
                        except Exception:
                            pass
                        ts.state = "cancelled"
                    raise
                except Exception as exc:
                    ts.state = "failed"
                    ts.error = str(exc)
                else:
                    ts.result = result
                    # STRAT-WORKFLOW-PIPELINE(-STAGEOPTS): pipeline mode resolves the
                    # effective cert (stage override → claude-gated step fallback) via
                    # the shared helper; non-pipeline parallel_dispatch keeps its
                    # historical UNCONDITIONAL step-cert validation byte-for-byte.
                    if self.is_pipeline:
                        eff_cert = effective_pipeline_task_cert(
                            task.get("_task_reasoning_template"),
                            self.task_reasoning_template,
                            task.get("_agent") or self.agent,
                        )
                    else:
                        eff_cert = self.task_reasoning_template
                    if eff_cert is not None:
                        vios = validate_certificate(
                            eff_cert, result or {},
                        )
                        if vios:
                            ts.state = "failed"
                            ts.cert_violations = vios
                            ts.error = "certificate validation failed"
                        else:
                            ts.state = "complete"
                    else:
                        ts.state = "complete"
                    # STRAT-WORKFLOW-PIPELINE-ROUTE: evaluate `exit_when` only on a
                    # terminal-`complete` task (after cert resolves) — so an invalid
                    # output that cert flips to `failed` can't early-exit the item.
                    # Set the marker BEFORE the finally fires the done-event, so the
                    # immediate downstream task observes it and skips.
                    if self.is_pipeline and ts.state == "complete":
                        self._check_exit_when(task, result)
                    # STRAT-WORKFLOW-PIPELINE-FANOUT: a split task validates its list
                    # output (design §2 contract + the `len > K` cap) AFTER cert and
                    # BEFORE terminal commit. On violation it becomes `failed` (lanes
                    # then auto-cancel via the dep-gate); on success the list is
                    # memoized so lanes read a resolved, validated `L`.
                    if (self.is_pipeline and ts.state == "complete"
                            and task.get("_pipeline_role") == "split"):
                        try:
                            L = self._resolve_fanout_list(tid)
                        except (ValueError, json.JSONDecodeError) as exc:
                            ts.state = "failed"
                            ts.error = f"fanout split: {exc}"
                        else:
                            cap = task.get("_fanout_max")
                            if cap is not None and len(L) > cap:
                                ts.state = "failed"
                                ts.error = (
                                    f"fanout list length {len(L)} exceeds max {cap}"
                                )
                            else:
                                self._fanout_lists[tid] = L
        except asyncio.CancelledError:
            # Cascade cancel arrived while we were blocked on the semaphore,
            # the initial _persist, or connector setup — still register a
            # terminal state so pollers see "cancelled" rather than "running".
            # T2-F5-RESUME (review #1): except for a reparentable task on
            # shutdown — leave it `running` and don't kill the durable child.
            if not (self._detaching and ts.reparentable):
                if ts.state in ("pending", "running"):
                    ts.state = "cancelled"
                if connector is not None:
                    try:
                        connector.interrupt()
                    except Exception:
                        pass
            raise
        finally:
            # T2-F5-RESUME (review #1): detach-don't-kill — bypass the WHOLE
            # destructive finalizer for a reparentable task being shut down.
            # Persist the handle, leave state `running`, and let the in-flight
            # CancelledError keep propagating (no return → not swallowed). The
            # re-attach reader (S4) later reproduces terminalize / done-event /
            # budget debit / worktree-remove from the durable stream.
            #
            # Codex review #1 (round 1): only detach a task that is STILL
            # in-flight. If it already reached a terminal state in the try-body
            # (codex finished just as shutdown arrived), fall through to the
            # normal finalizer so it is charged, its done-event fires, its
            # worktree/streams are cleaned, and the TERMINAL state is persisted —
            # otherwise a `complete`/`failed` task would be stranded (restart
            # classify only re-attaches `running` tasks, never re-finalizing it).
            if (self._detaching and ts.reparentable
                    and ts.state in ("pending", "running")):
                try:
                    await self._persist()
                except asyncio.CancelledError:
                    raise
            else:
                if ts.state in ("pending", "running"):
                    # Defensive: a task should never exit _run_one still
                    # pending/running. Mark it failed so the terminal state is
                    # observable.
                    ts.state = "failed"
                    ts.error = ts.error or "unexpected exit without terminal state"
                if ts.finished_at is None:
                    ts.finished_at = time.time()
                # T2-F5-DEPENDS-ON: commit terminal state + unblock waiters BEFORE
                # any await that could raise CancelledError. Downstream tasks must
                # always unblock, even if we're cancelled mid-cleanup.
                self._task_terminal_state[tid] = ts.state
                self._task_done[tid].set()
                # STRAT-WORKFLOW-BUDGET: record per-task consumption and debit it
                # to the flow's run budget. A task counts as one agent dispatch
                # only if it actually started (started_at set) — a sibling
                # cancelled while still pending never reached the connector.
                # T2-F5-RESUME: guard the dispatch debit on `dispatch_debited` so
                # a re-attach (which charges the dispatch itself) never
                # double-charges; set it here once the live path charges.
                usage = self._task_usage.get(tid, {})
                if ts.started_at is not None and ts.finished_at is not None:
                    ts.elapsed_s = ts.finished_at - ts.started_at
                ts.tokens = int(usage.get("tokens", 0))
                ts.dollars_recorded = float(usage.get("dollars", 0.0))
                if ts.started_at is not None and not ts.dispatch_debited:
                    debit_budget(
                        self.state,
                        dispatches=1,
                        tokens=ts.tokens,
                        wall_s=ts.elapsed_s,
                        dollars=ts.dollars_recorded,
                    )
                    ts.dispatch_debited = True
                    # STRAT-WORKFLOW-BUDGET-DOLLARS: warn on models the table
                    # couldn't price (they contributed $0, under-counting a usd cap).
                    bs = getattr(self.state, "budget_state", None)
                    if bs:
                        _has_usd = bs["caps"].get("usd") is not None
                        for _m in usage.get("unpriced_models", ()):
                            _maybe_warn_unpriced(_m, _has_usd)
                # Mark terminal BEFORE the persist below so the persisted snapshot
                # carries budget_exhausted (survives restart / query / resume).
                if budget_exhausted(self.state) and not self.state.terminal_status:
                    self.state.terminal_status = BUDGET_EXHAUSTED
                if worktree_path_obj is not None:
                    # T2-F5-DIFF-EXPORT: capture diff before cleanup (opt-in).
                    # CancelledError is caught here so cascade-cancel / shutdown
                    # cannot leak the worktree — cleanup must always run.
                    cancelled_during_capture = False
                    if self.capture_diff:
                        try:
                            ts.diff = await asyncio.to_thread(
                                capture_worktree_diff, worktree_path_obj,
                            )
                        except asyncio.CancelledError:
                            ts.diff = None
                            ts.diff_error = "cancelled during diff capture"
                            cancelled_during_capture = True
                        except Exception as exc:
                            ts.diff = None
                            stderr = getattr(exc, "stderr", None)
                            if isinstance(stderr, (bytes, bytearray)):
                                detail = stderr.decode("utf-8", errors="replace").strip()
                            elif isinstance(stderr, str):
                                detail = stderr.strip()
                            else:
                                detail = ""
                            ts.diff_error = (
                                f"{type(exc).__name__}: {exc}"
                                + (f" | stderr: {detail}" if detail else "")
                            )
                    try:
                        remove_worktree(worktree_path_obj)
                    except Exception:
                        pass
                    if cancelled_during_capture:
                        # Re-raise so cancellation still propagates after cleanup ran.
                        raise asyncio.CancelledError()
                # T2-F5-RESUME (Codex review #2): persist the TERMINAL snapshot
                # BEFORE removing the durable replay files. If the order were
                # reversed and the process died in between, both recovery sources
                # would be gone (no stream to re-tail, no persisted terminal
                # result). Persist-then-delete leaks at most a stream file on a
                # crash (cleaned on flow delete), never the result.
                try:
                    await self._persist()
                except asyncio.CancelledError:
                    # If we were cancelled while persisting, record locally and
                    # re-raise so cancellation propagates cleanly.
                    raise
                if ts.state in ("complete", "failed", "cancelled", "skipped"):
                    _remove_stream_files(ts)

                # Cascade cancel siblings when the require policy becomes
                # unsatisfiable in light of this task's terminal state.
                if self._require_unsatisfiable():
                    self._cancel_siblings()

                # STRAT-WORKFLOW-BUDGET: hard cutoff — once this task's debit tips
                # the flow over its run budget, cascade cancel any still-active
                # siblings (reuses the require-cancel path). terminal_status was
                # already set above (pre-persist) so it is durable across restart.
                if self.state.terminal_status == BUDGET_EXHAUSTED:
                    self._cancel_siblings()


# ---------------------------------------------------------------------------
# T14 — lifecycle hooks: startup resume + shutdown cancel
# ---------------------------------------------------------------------------

RESUME_INTERRUPTED_ERROR = "server restart interrupted task"


def _classify_interrupted_task(t: dict) -> str:
    """Decide a single interrupted (``running``) task's restart fate.

    Returns ``"reparenting"`` if the task is a live, identity-matched codex
    durable-stream child that a fresh reader can re-attach to; otherwise
    ``"failed"`` (today's behavior — consumer re-runs). The identity guard is
    strict: the persisted pid must be alive AND its current start-time must
    exactly match the persisted one (a live pid with a different start time is a
    reused pid → a DIFFERENT process → treated as dead).
    """
    if not t.get("reparentable"):
        return "failed"
    pid = t.get("child_pid")
    if not isinstance(pid, int) or not pid_alive(pid):
        return "failed"
    persisted_start = t.get("proc_start_time")
    now_start = proc_start_time(pid)
    if persisted_start and now_start and now_start == persisted_start:
        return "reparenting"
    return "failed"


def classify_interrupted_parallel_tasks(flow_root: Path | str) -> None:
    """Walk persisted flows on startup and classify interrupted parallel tasks.

    Each ``state == "running"`` task is either re-attachable (a live codex
    durable-stream child) → flipped to ``state="reparenting"`` (the poll/resume
    driver then lazily starts a :class:`ReattachReader` to tail it to
    completion), or not → flipped to ``state="failed"`` with
    ``error="server restart interrupted task"`` (today's behavior) so the
    consumer observes the interruption instead of a stuck status.

    Best-effort: missing/empty flow roots are no-ops, and corrupt JSON files are
    skipped rather than raising. Writes a warning to stderr for each unreadable
    file. The server continues starting regardless of what's found here.
    """
    root = Path(flow_root)
    if not root.exists():
        return
    for path in sorted(root.glob("*.json")):
        try:
            payload = json.loads(path.read_text())
        except (json.JSONDecodeError, OSError) as exc:
            print(
                f"stratum-mcp: warning: could not read persisted flow "
                f"'{path.name}' during resume: {exc}",
                file=sys.stderr,
            )
            continue
        if not isinstance(payload, dict):
            continue
        parallel_tasks = payload.get("parallel_tasks")
        if not isinstance(parallel_tasks, dict) or not parallel_tasks:
            continue
        now = time.time()
        touched = False
        for tid, t in parallel_tasks.items():
            if isinstance(t, dict) and t.get("state") == "running":
                fate = _classify_interrupted_task(t)
                if fate == "reparenting":
                    t["state"] = "reparenting"
                else:
                    t["state"] = "failed"
                    t["error"] = RESUME_INTERRUPTED_ERROR
                    if t.get("finished_at") is None:
                        t["finished_at"] = now
                touched = True
        if touched:
            try:
                path.write_text(json.dumps(payload, indent=2))
            except OSError as exc:
                print(
                    f"stratum-mcp: warning: could not persist resume fixup "
                    f"for '{path.name}': {exc}",
                    file=sys.stderr,
                )


# Back-compat alias: the historical name still flips non-reparentable running
# tasks to failed (its original contract), now via the classifier. The server
# startup hook is retargeted to classify_interrupted_parallel_tasks directly.
resume_interrupted_parallel_tasks = classify_interrupted_parallel_tasks


class ReattachReader:
    """Tails a `reparenting` task's durable stream to completion after a restart.

    The fresh server is NOT the child's parent (it reparented to init), so the
    reader cannot ``waitpid`` — it derives the verdict purely from the durable
    stream: the ``__t2f5_done__`` sentinel rc, any ``{"type":"error"}`` record,
    and the ``$T2F5_ERR`` file, with pid-liveness as the "died with no sentinel"
    backstop. It binds the CANONICAL ``FlowState`` instance (the same object
    poll/resume cache) and persists every mutation under the per-flow lock, so a
    concurrent poll/resume can't race it.

    Reproduces the per-task accounting the ``_run_one`` finalizer owns and that
    the detach path skipped (Codex review #4): ``finished_at``, ``elapsed_s``,
    ``tokens``, ``dollars_recorded``, the one-time dispatch debit (guarded by
    ``dispatch_debited``), ``budget_exhausted`` terminalization, and worktree
    removal — so audit/budget state matches a live completion.

    v1 persists ``stream_offset`` + the budget debit + the result ATOMICALLY at
    the terminal flip. A reader cancelled mid-tail (shutdown) persists nothing
    new and leaves the task ``reparenting``; the next boot re-attaches from the
    persisted offset and rebuilds — never double-charging, never losing result
    text.
    """

    def __init__(
        self,
        state: FlowState,
        step_id: str,
        task_id: str,
        *,
        persist_callable: Optional[Callable[[FlowState], None]] = None,
        model_id: Optional[str] = None,
        cert: Optional[dict] = None,
        require: Any = None,
        sibling_task_ids: Optional[list[str]] = None,
    ) -> None:
        self.state = state
        self.step_id = step_id
        self.task_id = task_id
        self._persist_callable = persist_callable or persist_flow
        self.model_id = model_id
        self.cert = cert
        # T2-F5-RESUME (Codex review #3): after a restart there is no executor to
        # run _run_one's cascade-cancel, so the reader reproduces it. `require` +
        # the step's task-id set let it decide when this task's terminal state
        # makes the step's require policy unsatisfiable (or tips the budget),
        # and kill the sibling reparented children so their readers terminalize.
        self.require = require
        self.sibling_task_ids = sibling_task_ids or []

    async def _persist(self) -> None:
        async with _lock_for(self.state.flow_id):
            self._persist_callable(self.state)

    async def run(self) -> None:
        ts = self.state.parallel_tasks.get(self.task_id)
        if ts is None or ts.state != "reparenting" or not ts.stream_path:
            return
        pid = ts.child_pid
        conn = CodexConnector(stream_path=ts.stream_path)
        text_parts: list[str] = []
        acc = new_usage_acc()
        error_message: Optional[str] = None
        sentinel_rc: Optional[int] = None
        final_offset = ts.stream_offset or 0

        async for rec, consumed in conn._tail_stream(
            ts.stream_path, ts.stream_offset or 0,
            is_alive=lambda: pid_alive(pid) if isinstance(pid, int) else False,
        ):
            final_offset = consumed
            if isinstance(rec, dict) and T2F5_DONE_SENTINEL in rec:
                sentinel_rc = rec[T2F5_DONE_SENTINEL]
                break
            for emitted in _emit_for_codex_event(
                rec, model=self.model_id or "", prompt="",
            ):
                if emitted.kind == _CODEX_ERROR_KIND:
                    if error_message is None:
                        error_message = emitted.metadata["message"]
                    continue
                if (emitted.kind == "agent_relay"
                        and emitted.metadata.get("role") == "assistant"):
                    text_parts.append(emitted.metadata["text"])
                accumulate_usage(acc, emitted)

        await self._finalize(
            ts, text_parts, acc, sentinel_rc, error_message, final_offset,
        )
        self._maybe_cascade_cancel_siblings()

    def _require_unsatisfiable_over_siblings(self) -> bool:
        """Mirror ParallelExecutor._require_unsatisfiable, but over the persisted
        states of THIS step's tasks (no live executor after a restart)."""
        states = [
            self.state.parallel_tasks[t].state
            for t in self.sibling_task_ids
            if t in self.state.parallel_tasks
        ]
        complete = sum(1 for s in states if s == "complete")
        failed = sum(1 for s in states if s in ("failed", "cancelled"))
        in_flight = sum(
            1 for s in states if s in ("pending", "running", "reparenting")
        )
        req = self.require
        if req == "any":
            return complete == 0 and in_flight == 0
        if isinstance(req, int):
            return complete + in_flight < req
        # "all" / unknown
        return failed > 0

    def _maybe_cascade_cancel_siblings(self) -> None:
        """T2-F5-RESUME (Codex review #3): reproduce _run_one's cascade-cancel
        after a restart. If this task's terminal state tips the run budget OR
        makes the step's require policy unsatisfiable, kill the still-in-flight
        sibling reparented children (killpg the wrapper = group leader). Each
        sibling's own reader then sees its child die with no sentinel and
        terminalizes it as failed — no cross-reader handle coordination needed.
        """
        if not self.sibling_task_ids:
            return
        exhausted = self.state.terminal_status == BUDGET_EXHAUSTED
        if not exhausted and not self._require_unsatisfiable_over_siblings():
            return
        for tid in self.sibling_task_ids:
            if tid == self.task_id:
                continue
            sib = self.state.parallel_tasks.get(tid)
            if sib is None or sib.state not in ("running", "reparenting"):
                continue
            pid = sib.child_pid
            if not isinstance(pid, int) or not pid_alive(pid):
                continue
            try:
                os.killpg(os.getpgid(pid), signal.SIGTERM)
            except (ProcessLookupError, PermissionError, OSError):
                pass

    async def _finalize(self, ts, text_parts, acc, sentinel_rc, error_message,
                        final_offset) -> None:
        full_text = "".join(text_parts)
        if sentinel_rc is None:
            # Tail ended (pid died) with no sentinel → interrupted/incomplete.
            ts.state = "failed"
            ts.error = error_message or RESUME_INTERRUPTED_ERROR
        elif error_message is not None:
            ts.state = "failed"
            ts.error = error_message
        elif sentinel_rc != 0 and not full_text:
            ts.state = "failed"
            ts.error = (
                _read_text_file(ts.stderr_path) if ts.stderr_path else ""
            ) or f"codex exited with code {sentinel_rc}"
        else:
            result = full_text or None
            # Cert parity with _run_one: an invalid output flips complete→failed.
            if self.cert is not None:
                vios = validate_certificate(self.cert, result or {})
                if vios:
                    ts.state = "failed"
                    ts.cert_violations = vios
                    ts.error = "certificate validation failed"
                else:
                    ts.result = result
                    ts.state = "complete"
            else:
                ts.result = result
                ts.state = "complete"

        # --- accounting parity with the _run_one finalizer (review #4) ---
        if ts.finished_at is None:
            ts.finished_at = time.time()
        if ts.started_at is not None:
            ts.elapsed_s = ts.finished_at - ts.started_at
        delta_tokens = int(acc.get("tokens", 0))
        delta_dollars = float(acc.get("dollars", 0.0))
        ts.tokens = int(ts.tokens or 0) + delta_tokens
        ts.dollars_recorded = float(ts.dollars_recorded or 0.0) + delta_dollars
        # The dispatch is charged exactly once across the whole task lifetime;
        # the detach path skipped it, so the reader charges it here (delta tokens
        # + the dispatch). A re-run (dispatch_debited already set) charges only
        # delta tokens, never the dispatch again.
        dispatches = 0 if ts.dispatch_debited else 1
        debit_budget(
            self.state,
            dispatches=dispatches,
            tokens=delta_tokens,
            wall_s=ts.elapsed_s if dispatches else 0.0,
            dollars=delta_dollars,
        )
        ts.dispatch_debited = True
        if budget_exhausted(self.state) and not self.state.terminal_status:
            self.state.terminal_status = BUDGET_EXHAUSTED
        ts.stream_offset = final_offset
        # Worktree was kept alive for the detached child; remove it now.
        if ts.worktree_path:
            try:
                remove_worktree(Path(ts.worktree_path))
            except Exception:
                pass
        # Codex review #2: persist the terminal snapshot BEFORE deleting the
        # durable replay files, so a crash in between never loses both the
        # stream and the persisted result.
        await self._persist()
        _remove_stream_files(ts)


def shutdown_all(
    registry: dict[tuple[str, str], asyncio.Task] | None = None,
) -> None:
    """Cancel every registered parallel-executor task.

    Called from the stdio server shutdown path (signal handler or
    try/finally around ``mcp.run``) to make sure pending parallel work
    doesn't leak across restart. Idempotent — already-done tasks are
    left alone, and repeated calls after all tasks finish are no-ops.

    The registry argument is the caller's ``dict`` of
    ``(flow_id, step_id) -> asyncio.Task``. It's taken as a parameter
    rather than imported to keep this module free of a dependency on
    ``server.py`` (which is where the registry lives).
    """
    if not registry:
        return
    for handle in list(registry.values()):
        if handle is None:
            continue
        if handle.done():
            continue
        try:
            handle.cancel()
        except Exception:
            # Best-effort — a failed cancel on one task must not prevent
            # cancellation of the others.
            pass


def shutdown_readers(
    registry: dict[tuple[str, str], asyncio.Task] | None = None,
) -> None:
    """Cancel every registered ReattachReader task (T2-F5-RESUME S6).

    Called from the server shutdown path right after :func:`shutdown_all`.
    Readers only read the durable stream and persist at terminal, so a cancel
    loses at most the un-persisted tail — the next boot re-attaches from the
    persisted ``stream_offset`` (or re-reads from the start) and rebuilds.
    Idempotent; mirrors :func:`shutdown_all`'s contract (registry passed in to
    keep this module free of a server.py dependency).
    """
    if not registry:
        return
    for handle in list(registry.values()):
        if handle is None or handle.done():
            continue
        try:
            handle.cancel()
        except Exception:
            pass
