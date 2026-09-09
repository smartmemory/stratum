# STRAT-LOOP-CARRY: Loop-carried flow value for revise loops. A fanout whose `over:` references a step downstream of it is a ROUTING_CYCLE (output references are dependency edges, ir/validate.ts), and a gate revise resets the target and every descendant, deleting their outputs (engine.ts resetFrom), so no preset can re-fan over a re-planned task list. Add a declared `carry:` block at flow level: each variable has an `initial` expression (materialised when its source step succeeds) and optional per-gate `on_revise` expressions. On a revise the engine evaluates the declared expression under the gate token BEFORE the reset, persists the new value with provenance (gate id, gate token, source epoch) in the run record, then resets; gates that declare nothing leave the value unchanged, so a merge retry re-fans over the same persisted list. `${wave}` is a flow-value reference, not a step reference, so it creates no dependency edge. Also expose the resolved fanout item on the consumer descriptor beside itemIndex so consumers have an authoritative binding. Resume, replay and audit read the value from the run record like any step input. First consumer: compose COMP-FABLE-ASTRA (D1). Reviewed shape: Codex sol/high 2026-09-09 confirmed evaluate-under-token, reset, persist-once preserves the existing invariants. Standalone Tickets M high

**Status:** PLANNED
**Created:** 2026-09-09

---

## Intent

Loop-carried flow value for revise loops. A fanout whose `over:` references a step downstream of it is a ROUTING_CYCLE (output references are dependency edges, ir/validate.ts), and a gate revise resets the target and every descendant, deleting their outputs (engine.ts resetFrom), so no preset can re-fan over a re-planned task list. Add a declared `carry:` block at flow level: each variable has an `initial` expression (materialised when its source step succeeds) and optional per-gate `on_revise` expressions. On a revise the engine evaluates the declared expression under the gate token BEFORE the reset, persists the new value with provenance (gate id, gate token, source epoch) in the run record, then resets; gates that declare nothing leave the value unchanged, so a merge retry re-fans over the same persisted list. `${wave}` is a flow-value reference, not a step reference, so it creates no dependency edge. Also expose the resolved fanout item on the consumer descriptor beside itemIndex so consumers have an authoritative binding. Resume, replay and audit read the value from the run record like any step input. First consumer: compose COMP-FABLE-ASTRA (D1). Reviewed shape: Codex sol/high 2026-09-09 confirmed evaluate-under-token, reset, persist-once preserves the existing invariants. Standalone Tickets M high

---

## Notes

_This is a seed design doc created by `compose feature`. The `compose build` pipeline will expand it into a full design, blueprint, and implementation plan._

## Proposed spec shape (from COMP-FABLE-ASTRA design, 2026-09-09)

```yaml
carry:
  wave:
    initial: ${plan.output.tasks}
    on_revise:
      assess_gate: ${assess.output.tasks}
```

- `${wave}` is a flow-value reference: legal in `fanout.over` (single reference rule
  unchanged), creates no dependency edge, so `plan -> execute -> ... -> assess -> assess_gate
  (on_revise: execute)` validates.
- Revise transaction: under the gate token, evaluate the declared expression, write the new
  value plus provenance `{gate, gateToken, sourceEpoch}` into the run record, run `resetFrom`,
  persist once. A gate with no declaration for the variable leaves it unchanged.
- Consumer descriptor gains `item` (the resolved fanout element) beside `itemIndex`, persisted
  in the run record. This is a first-class deliverable with two compose consumers: D4
  (`files_owned` enforcement at merge) and D6 (per-item tier resolution, so Fable assigns
  `critical | standard | fast` per task). The stage `agent` literal is unchanged; provider
  stays per stage. Cross-provider per-item routing is STRAT-AGENT-INTERP-TS (the
  STRAT-AGENT-INTERP row marked COMPLETE in compose's roadmap describes the retired Python
  engine; the TS IR has `agent: z.enum(["claude","codex"])` at `ts/src/ir/schema.ts:41,65`).
- Codex sol/high round-2 review of COMP-FABLE-ASTRA confirmed this transaction preserves
  resume, replay and audit invariants given the existing gate lock and single persistence
  boundary (engine.ts gate resolution, `resetFrom`).

Compose consumer: `compose/docs/features/COMP-FABLE-ASTRA/design.md`, dependency D1.
