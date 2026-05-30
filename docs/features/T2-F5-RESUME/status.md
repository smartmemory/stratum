# T2-F5-RESUME — Status (resume point)

**Phase reached:** Blueprint (Phase 4-5) — COMPLETE & gate-clean. **Next: Phase 7 (TDD implement).**
**Branch:** `t2-f5-resume` (2 commits: `d86f765` spike+design, `baad20d` blueprint). No code yet.
**Stopped:** 2026-05-31, deliberately (`/compose build … then stop`) — implementation is its own
focused session.

## First action on resume
Start Phase 7 TDD from `blueprint.md` **slice S1** (codex durable-stream mode), test-first. Do NOT
re-design — design + blueprint are gate-clean. Re-verify the `parallel_exec.py` line anchors against
disk first (they shifted once already this session from a sibling merge — the blueprint's verification
table has the current numbers, but confirm before editing).

## What's done (don't redo)
- **Spike PASSED** (`spike/spike-findings.md`, `spike/reparent_spike.py`): detached child
  (`start_new_session=True`) + durable file (child opens it) + fresh-process re-attach recovers the full
  result, proven on darwin incl. `kill -9`. The primitive is real; no engine rewrite.
- **Design gate-clean** (`design.md`, 5 Codex rounds). **Blueprint gate-clean** (`blueprint.md`, 3
  Codex rounds) — 6 ordered slices S1–S6 with verified touchpoints + TDD test plan.

## Load-bearing scope decisions (settled — don't relitigate)
- **codex + parallel-dispatch ONLY.** claude is in-process (`claude.py:114`, no child); opencode is
  rejected on the server path (`parallel_exec.py:67`); `stratum_agent_run` has no durable record. All
  three are named follow-ups.
- **Durable contract = a `setsid`-less `sh -c '"$@" >OUT 2>ERR <IN; printf {__t2f5_done__:rc} >> OUT'`
  wrapper** around the FINAL `_build_codex_cmd` argv (composes with the jail driver), spawned
  `start_new_session=True`. The wrapper-written sentinel — NOT the connector's in-memory `_result` — is
  the durable completion signal.
- **Two codex failure channels:** `rc != 0` AND JSONL `{"type":"error"}` (`codex.py:565`) — both
  honored by the live tailer and the reattach reader.
- **Detach-don't-kill must bypass the WHOLE outer finally** (`parallel_exec.py:936-1018`), gated on a
  new `executor._detaching` flag set by `shutdown_all`; durable-mode connector `finally` also skips
  `_cleanup_jail`'s kill. Kill is `killpg`-interrupt-only.
- **Handle handoff** via a synthetic `durable_spawned` first event (spawn lives inside the connector;
  `_run_one` never sees it directly) → `_consume_streaming` stamps + persists the handle before any
  codex output.
- **Budget idempotency:** persisted `dispatch_debited` marker so re-attach charges delta tokens, never
  the dispatch.
- **Reattach runtime:** `ReattachReader` + `_REATTACH_READERS` registry, single-flight, bound to
  canonical `_flows[flow_id]`, persists under `_lock_for`. Shutdown owns reader cancellation via a
  `shutdown_readers(_REATTACH_READERS)` call after `shutdown_all`.

## Landmines
- `parallel_exec.py` line anchors shift when sibling features merge — re-verify before editing (the
  blueprint's first draft was stale for exactly this reason).
- `_emit_for_codex_event` is NOT a pure extract — the caller keeps `agent_started`/`text_parts` state;
  durable mode's "record error, fail after sentinel" is an intentional behavior change.
