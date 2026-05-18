# Diagnosis — STRAT-TEST-EVENTLOOP-HYGIENE

## Root cause

Nine files under `stratum-mcp/tests/integration/` each define a **byte-identical** sync bridge:

```python
def _run(coro):
    return asyncio.get_event_loop().run_until_complete(coro)
```

`asyncio.get_event_loop()` returns the *process-global* loop. Under `asyncio_mode = "auto"`,
pytest-asyncio creates and **closes** a fresh function-scoped loop around every `async def`
test. Once any earlier test (commonly in `tests/`, run first in a combined invocation) has
left the global loop closed/replaced, the next `_run()` call drives a **closed loop** →
`RuntimeError: Event loop is closed` (plus the `DeprecationWarning: There is no current
event loop`). Per-directory runs avoid it only by luck of ordering — it is an order-dependent
test-isolation defect, not a behavior bug.

The library itself was already hardened against this exact failure in commit `a875ba7`
(`src/stratum/__init__.py` `run()` detects a closed loop and creates a fresh one). The test
helpers were never brought in line — so **no production code is implicated**.

## Affected files (helper definition line)

| File | Line |
|---|---|
| `stratum-mcp/tests/integration/test_routing.py` | 17 |
| `stratum-mcp/tests/integration/test_flow_composition.py` | 24 |
| `stratum-mcp/tests/integration/test_parallel_executor.py` | 19 |
| `stratum-mcp/tests/integration/test_guardrails.py` | 26 |
| `stratum-mcp/tests/integration/test_list_workflows.py` | 12 |
| `stratum-mcp/tests/integration/test_iterations.py` | 47 |
| `stratum-mcp/tests/integration/test_inline_steps.py` | 26 |
| `stratum-mcp/tests/integration/test_policy_skip.py` | 34 |
| `stratum-mcp/tests/integration/test_score_expr.py` | 671 |

## Fix approach (chosen)

Replace each helper **body** with `return asyncio.run(coro)`. `asyncio.run` creates a
private loop, runs the coro to completion, and closes it — full per-call isolation, immune
to any prior test's loop state. Signature `_run(coro)` is unchanged, so **no call site is
touched** (~9 one-line edits total). This is the ticket's primary prescription and mirrors
the library's own a875ba7 philosophy.

**Rejected:** migrating ~50 test functions to `@pytest.mark.asyncio` + `await` — correct
but a far larger blast radius for a bounded hygiene fix; deferrable, not required to close
the defect.

**Risk:** Low. `asyncio.run` raises if called with a running loop, but these are *sync*
test functions calling `_run(some_coro())` — there is no enclosing running loop. No shared
loop state is relied upon across `_run` calls in these files (verified: helpers are
standalone module-level, no module/loop fixtures feed them).

## Verification plan

1. Repro confirmed: `uv run pytest tests/ stratum-mcp/tests/` fails (~64) pre-fix.
2. Post-fix: same combined command is green.
3. Regression guard: `uv run pytest tests/` and `uv run pytest stratum-mcp/tests/`
   each still green independently.

## Outcome (verified)

- **Fix applied:** 9 identical edits — `_run` helper body `asyncio.get_event_loop().run_until_complete(coro)` → `asyncio.run(coro)`. Zero call-site changes. `git diff --stat` = 9 files, 9 insertions, 9 deletions.
- **Repro command, pre-fix:** `65 failed, 1024 passed` (~64 loop-pollution + 1 unrelated Docker live-gate).
- **Same command, post-fix:** `1 failed, 1088 passed` — only the out-of-scope `test_judge_jail_docker.py::test_live_gate_A_real_model_turn_through_connector` (real Docker+model, environment-dependent, pre-existing, untouched by this fix). All ~64 loop-pollution failures resolved.
- **Regression:** full `stratum-mcp/tests/` standalone re-run (per-directory convention) — see report.md.
