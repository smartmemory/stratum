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
import os
import sys
import time
from pathlib import Path
from typing import Any, Callable, Optional

from .connectors.base import AgentConnector, SENSITIVE_ENV_VARS
from .connectors.factory import make_agent_connector
from .executor import (
    FlowState,
    ParallelTaskState,
    persist_flow,
    validate_certificate,
)
from .worktree import capture_worktree_diff, create_worktree, remove_worktree

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
    ) -> None:
        self.state = state
        self.step_id = step_id
        self.tasks = tasks
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

        # Handle + connector registries for cascade cancel.
        self._task_handles: dict[str, asyncio.Task] = {}
        self._connectors: dict[str, AgentConnector] = {}

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
        """Render the spec's ``intent_template`` using the task dict as kwargs.

        Falls back to the raw template when ``str.format`` can't find a field —
        a template with no placeholders is valid and common.
        """
        try:
            return self.intent_template.format(**task)
        except (KeyError, IndexError):
            return self.intent_template

    async def _persist(self) -> None:
        """Persist the FlowState under the per-flow lock."""
        async with _lock_for(self.state.flow_id):
            self._persist_callable(self.state)

    def _require_unsatisfiable(self) -> bool:
        """True when the ``require`` policy can no longer be satisfied.

        - ``require == "all"`` — any failure/cancel makes the step unsatisfiable.
        - ``require == "any"`` — unsatisfiable only after *every* task settled
          and none completed.
        - ``require`` integer N — unsatisfiable when ``complete + still_active < N``.
        """
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

    async def _consume(
        self,
        connector: AgentConnector,
        prompt: str,
        cwd: Optional[str],
        env: dict[str, str],
    ) -> Any:
        """Drive ``connector.run()`` to completion, returning the final payload.

        We prefer the last ``result`` envelope's ``output`` field, falling back
        to ``content`` for real-connector compatibility. ``error`` events raise
        a ``RuntimeError`` — matches ``server.stratum_agent_run`` semantics.
        """
        final: Any = None
        async for event in connector.run(prompt=prompt, cwd=cwd, env=env):
            if not isinstance(event, dict):
                continue
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
                    connector_type = _connector_type_from_agent(self.agent)
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

                # ---------- run + terminal-state resolution ----------
                try:
                    result = await asyncio.wait_for(
                        self._consume(connector, prompt, cwd, env),
                        timeout=self.task_timeout,
                    )
                except asyncio.TimeoutError:
                    try:
                        connector.interrupt()
                    except Exception:
                        pass
                    ts.state = "failed"
                    ts.error = f"timeout after {self.task_timeout}s"
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
                    if self.task_reasoning_template:
                        vios = validate_certificate(
                            self.task_reasoning_template, result or {},
                        )
                        if vios:
                            ts.state = "failed"
                            ts.cert_violations = vios
                            ts.error = "certificate validation failed"
                        else:
                            ts.state = "complete"
                    else:
                        ts.state = "complete"
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
