# Reproduction — STRAT-TEST-EVENTLOOP-HYGIENE

**Command (bounded, faithful — excludes the unrelated pre-existing `tests/test_e2e.py` hang):**
```bash
cd /Users/ruze/reg/my/forge/stratum
uv run pytest tests/ stratum-mcp/tests/integration/ --ignore=tests/test_e2e.py -q --timeout=15
```

**Result (pre-fix):** `65 failed, 1024 passed, 2 skipped in 26.62s` (exit 1).

- ~64 failures are the loop-pollution set — every test routed through the `_run()` helper
  in the 9 `stratum-mcp/tests/integration/` files (`test_routing`, `test_flow_composition`,
  `test_parallel_executor`, `test_guardrails`, `test_list_workflows`, `test_iterations`,
  `test_inline_steps`, `test_policy_skip`, `test_score_expr`). Both directories pass when
  run alone — the failure is purely cross-directory order pollution.
- 1 unrelated failure: `tests/test_judge_jail_docker.py::test_live_gate_A_real_model_turn_through_connector`
  — a live gate requiring real Docker + model; pre-existing, environment-dependent, **out of scope**.

Confirms the diagnosis: a `tests/` test leaves the process-global event loop closed;
`_run()`'s `asyncio.get_event_loop().run_until_complete()` then drives a closed loop.
