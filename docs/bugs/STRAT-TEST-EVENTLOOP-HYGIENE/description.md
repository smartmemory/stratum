# STRAT-TEST-EVENTLOOP-HYGIENE

**Symptom:** Running `tests/` + `stratum-mcp/tests/` in a single pytest process produces ~64 failures concentrated in `stratum-mcp/tests/integration/` (e.g. `test_routing.py`, `test_score_expr.py`). Each directory passes cleanly when run alone.

**Repro steps:**
```bash
cd /Users/ruze/reg/my/forge/stratum
uv run pytest tests/ stratum-mcp/tests/   # ~64 failures
uv run pytest tests/                       # green
uv run pytest stratum-mcp/tests/           # green
```

**Expected:** Combined run is green (or at least no event-loop-state failures); test outcome must not depend on cross-directory execution order.

**Actual:** ~64 failures with `RuntimeError: Event loop is closed` / `DeprecationWarning: There is no current event loop`, raised from the integration suite's `_run()` helper.

**Environment:** stratum repo, Python, pytest + pytest-asyncio (`asyncio_mode = "auto"` in both `pyproject.toml`). Repo convention is per-directory test runs; CI has no combined-run step.

**Root-cause hypothesis (pre-confirmed by investigation):** 9 integration test files each define an identical sync helper
`def _run(coro): return asyncio.get_event_loop().run_until_complete(coro)`.
A prior test (in `tests/`) closes or replaces the process-global event loop; subsequent `_run()` calls then operate on a closed loop. The library `run()` was already hardened for this in commit `a875ba7`; the **test** helpers were not. Bounded test-hygiene only — no production-code correctness gap.

**Filed:** 2026-05-18 (forge-top ROADMAP, from STRAT-JUDGE v2 slice 2 verification). Owning repo: stratum.
