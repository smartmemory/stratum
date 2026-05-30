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
import sys
import time
from pathlib import Path
from typing import Any, Callable, Optional

from .connectors.base import AgentConnector, SENSITIVE_ENV_VARS
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
        template = task.get("_intent_template") or self.intent_template
        kwargs = dict(task)
        deps = task.get("depends_on") or []
        if len(deps) == 1:
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
            states = {t["id"]: self.state.parallel_tasks[t["id"]].state for t in group}
            if any(s in ("failed", "cancelled") for s in states.values()):
                failed += 1
            elif any(s in ("pending", "running") for s in states.values()):
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
            pending_running = sum(1 for s in states if s in ("pending", "running"))

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
        except asyncio.CancelledError:
            # Cascade cancel arrived while we were blocked on the semaphore,
            # the initial _persist, or connector setup — still register a
            # terminal state so pollers see "cancelled" rather than "running".
            if ts.state in ("pending", "running"):
                ts.state = "cancelled"
            if connector is not None:
                try:
                    connector.interrupt()
                except Exception:
                    pass
            raise
        finally:
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
            # STRAT-WORKFLOW-BUDGET: record per-task consumption and debit it to
            # the flow's run budget. A task counts as one agent dispatch only if
            # it actually started (started_at set) — a sibling cancelled while
            # still pending never reached the connector.
            usage = self._task_usage.get(tid, {})
            if ts.started_at is not None and ts.finished_at is not None:
                ts.elapsed_s = ts.finished_at - ts.started_at
            ts.tokens = int(usage.get("tokens", 0))
            ts.dollars_recorded = float(usage.get("dollars", 0.0))
            if ts.started_at is not None:
                debit_budget(
                    self.state,
                    dispatches=1,
                    tokens=ts.tokens,
                    wall_s=ts.elapsed_s,
                    dollars=ts.dollars_recorded,
                )
                # STRAT-WORKFLOW-BUDGET-DOLLARS: warn on models the table couldn't
                # price (they contributed $0, under-counting a usd cap).
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
            try:
                await self._persist()
            except asyncio.CancelledError:
                # If we were cancelled while persisting, record locally and
                # re-raise so cancellation propagates cleanly.
                raise

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


def resume_interrupted_parallel_tasks(flow_root: Path | str) -> None:
    """Walk persisted flows and mark interrupted parallel tasks as failed.

    On stdio server startup, any flow whose ``parallel_tasks`` contains
    entries with ``state == "running"`` has those entries flipped to
    ``state="failed"`` with ``error="server restart interrupted task"``
    and ``finished_at`` set to the current wall-clock time. This makes
    interrupted tasks observable to consumers rather than leaving them
    stuck in the running state across a restart.

    Real reparenting (resuming an executor against a live child process)
    is tracked separately as T2-F5-RESUME.

    Best-effort: missing/empty flow roots are no-ops, and corrupt JSON
    files are skipped rather than raising. Writes a warning to stderr
    for each file that couldn't be read. The server continues starting
    regardless of what's found here.
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
