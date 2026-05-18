# Report — STRAT-TEST-EVENTLOOP-HYGIENE

## Summary

Combined-suite (`pytest tests/ stratum-mcp/tests/`) produced ~64 order-dependent
failures because 9 `stratum-mcp/tests/integration/` files each drove coroutines through
`def _run(coro): return asyncio.get_event_loop().run_until_complete(coro)` — the
process-global loop, which a prior `tests/` test (under pytest-asyncio `asyncio_mode =
"auto"`) leaves closed. Fixed by swapping every helper body to `asyncio.run(coro)`, which
owns a private loop per call and is immune to any prior test's loop state. Signature
unchanged → **zero call-site edits**.

## Delivered vs Planned

Exactly the ticket's primary prescription ("replace the integration `_run` helper with
`asyncio.run`"), minimal-diff variant: 9 files, 1 line each, no call-site churn. The
larger `@pytest.mark.asyncio` migration the ticket lists as an alternative was
deliberately **not** done — unnecessary for closing the defect; far larger blast radius.

## Verification

| Run (bounded; `--ignore=tests/test_e2e.py --timeout=15`) | Result |
|---|---|
| `tests/ stratum-mcp/tests/integration/` — pre-fix | **65 failed**, 1024 passed |
| `tests/ stratum-mcp/tests/integration/` — post-fix | **1 failed**, 1088 passed |
| `stratum-mcp/tests/` standalone (per-directory convention) | **982 passed**, 0 failed |

The single residual failure —
`tests/test_judge_jail_docker.py::test_live_gate_A_real_model_turn_through_connector` —
is a real-Docker+real-model live gate, environment-dependent, pre-existing, and untouched
by this change. Explicitly out of scope.

## Files Changed

`stratum-mcp/tests/integration/`: `test_routing.py`, `test_flow_composition.py`,
`test_parallel_executor.py`, `test_guardrails.py`, `test_list_workflows.py`,
`test_iterations.py`, `test_inline_steps.py`, `test_policy_skip.py`, `test_score_expr.py`
— each `_run` body `asyncio.get_event_loop().run_until_complete(coro)` → `asyncio.run(coro)`.

## Known Issues & Tech Debt / Follow-ups

1. **`tests/fixtures/judge_corpus_smoke.json` is mutated by a test run as a side-effect**
   (clean at session start; modified after running `tests/`). A test writing into a
   committed fixture is its own latent hygiene defect — **not fixed here** (out of scope),
   left unstaged, flagged for a separate ticket.
2. `tests/test_e2e.py` retains the repo's known pre-existing long hangs (excluded from the
   bounded repro via `--ignore`); orthogonal to this fix.
3. No CI step runs the suites combined (repo convention is per-directory; CI has no test
   step). The fix makes `_run` order-independent so the latent footgun is structurally
   removed, but a combined-run CI guard would prevent silent reintroduction — deferred as
   scope creep beyond this bounded ticket.

## Lessons Learned

- Root-cause class: **test-isolation / shared-global-event-loop pollution**. `asyncio.run`
  per call is the correct modern idiom for sync→async test bridges; `get_event_loop()` is
  both deprecated and order-fragile.
- Repro hygiene: never run a hang-prone suite through `| tail` (buffers, hides progress);
  scope the repro to trigger-source + victims and `--ignore` known-irrelevant hangs.
