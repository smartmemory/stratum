# P6 reference parity report

The references are deliberately hand-authored in both IRs. This comparison
uses terminal state plus ensure/gate outcomes only; it does not compare
step-by-step traces or require structural IR equivalence.

| Flow | TypeScript v1 fake connector | Python v0.x manual fake/test seam | Comparison |
|---|---|---|---|
| linear + gate | `completed`; ensures passed; gate `approve` | `complete`; ensures passed; gate `approve` | PASS — both terminally successful (the engines use different success labels) |
| fanout | `completed`; stage ensures passed; no gate | `complete`; aggregate ensure passed; no gate | PASS — both terminally successful |
| subflow | `completed`; ensures passed; no gate | `complete`; ensures passed; no gate | PASS — both terminally successful |

Commands run on 2026-07-10:

```sh
cd ts
pnpm vitest run tests/migrate/check.test.ts tests/parity/p6.test.ts
../stratum-mcp/.venv/bin/python parity/run_python_parity.py
```

The Python runner imports `stratum-mcp` and the core package read-only, drives
the existing public manual-test APIs (`stratum_plan`, `stratum_step_done`,
`stratum_gate_resolve`, and `stratum_parallel_done`), and uses a temporary
flow-state directory. It does not alter Python source or emit rewritten YAML.

The authoring-cost specimen is `linear-gate.v1.yaml`: 5 task steps and 250
`cl100k_base` tokens, measured from its file bytes only. The Vitest assertion
sets the CI limit at 400 tokens and asserts the specimen has exactly 5 task
steps.
