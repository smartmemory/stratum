# STRAT-AGENT-INTERP-TS: TS successor to STRAT-AGENT-INTERP, which shipped in the Python engine (4651933) and was retired at the TS cutover: the TS IR declares agent as a literal enum (ts/src/ir/schema.ts:41,65) and both step and fanout-stage dispatch emit it verbatim (engine.ts). Let a step's agent and a fanout stage's agent resolve from recorded flow state: `${input.executor}`, a router step's output, or per fanout item `${item.agent}`, validated to a known agent before dispatch. Stays in the data plane (recorded state only; replay identical). First consumer: cross-provider per-item routing in compose COMP-FABLE-ASTRA (one wave mixing claude and codex workers), which today needs two fanout stages. Not required for per-item TIER routing, which compose resolves itself from the recorded item (STRAT-LOOP-CARRY). Standalone Tickets M medium

**Status:** PLANNED
**Created:** 2026-09-09

---

## Intent

TS successor to STRAT-AGENT-INTERP, which shipped in the Python engine (4651933) and was retired at the TS cutover: the TS IR declares agent as a literal enum (ts/src/ir/schema.ts:41,65) and both step and fanout-stage dispatch emit it verbatim (engine.ts). Let a step's agent and a fanout stage's agent resolve from recorded flow state: `${input.executor}`, a router step's output, or per fanout item `${item.agent}`, validated to a known agent before dispatch. Stays in the data plane (recorded state only; replay identical). First consumer: cross-provider per-item routing in compose COMP-FABLE-ASTRA (one wave mixing claude and codex workers), which today needs two fanout stages. Not required for per-item TIER routing, which compose resolves itself from the recorded item (STRAT-LOOP-CARRY). Standalone Tickets M medium

---

## Notes

_This is a seed design doc created by `compose feature`. The `compose build` pipeline will expand it into a full design, blueprint, and implementation plan._
