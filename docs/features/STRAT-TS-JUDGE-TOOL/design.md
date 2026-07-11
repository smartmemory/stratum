# STRAT-TS-JUDGE-TOOL — Judge surface parity on the TS engine (design)

**Status:** DESIGN (2026-07-11) · **Epic:** STRAT-PY-RETIRE Phase 2

## Related Documents

- Epic: `docs/plans/2026-07-11-strat-py-retire-roadmap.md` (Phase 2)
- Python reference: `stratum-mcp/src/stratum_mcp/server.py:2750-2898`
  (`stratum_judge` tool), `src/stratum/judge/kernel.py` (tier kernel),
  `verifier.py` (T2/T3), `predicates.py` (T1), `staging.py`, `result.py`
- TS side today: `ts/src/judge/judged.ts` + `codex_judged.ts`
  (per-predicate judged-ensure evaluators), `judgeBackend()` in
  `ts/src/mcp/server.ts:31-36`, engine judge seam `engine.ts:951-994`
- Contract: `compose/contracts/judge-result.json` (JudgeResult wire schema)
- Related: STRAT-PY-TRIAGE (goal kernel disposition decides the second
  consumer of `run_judge`)

## Problem — the roadmap line undersold this

The epic said "expose `stratum_judge` over the existing judged-predicate
backend." Recon (2026-07-11) shows that is a category error:

- **Python `stratum_judge`** is a tiered verification kernel: T1
  deterministic eval (sandboxed `file_exists`/`file_contains` over a
  staging tree), T2 Claude verifier (Read/Grep/Glob only, mandatory
  `artifacts/...:line` citations), T3 cross-model Codex cold-read
  (paranoid stakes only, read-jailed), turn budgets with monotonic
  `judge_history`, STRAT-IMMUTABLE gates (caller payload must byte-match
  the IR's `judge:` declaration), staging trees under
  `~/.stratum/judge/<flow>/<step>/turn-N/`, `turns.jsonl` audit, and
  JudgeResult validated against `judge-result.json` before persistence.
- **TS today** evaluates single `judged:` ensure predicates inside the
  engine (openai or codex backend, stakes-routed models, fail-closed) —
  no tiers, no staging, no citations, no turn history.

Porting full tier parity is a multi-week kernel port. The question is
whether anything still needs it after the cutover.

## Consumers of the Python kernel (measured)

1. `stratum_judge` MCP tool — serves **v0 `judge:` steps**. In v1 specs
   (what agents author after TS-2), judged verification happens via
   engine `ensures` — there is no `judge:` step to serve. This consumer
   evaporates with the v0 spec format.
2. `stratum_goal` — passes `run_judge` into the goal orchestrator. Fate
   decided by STRAT-PY-TRIAGE (goal kernel is in the triage set).
3. Nothing in compose invokes `stratum_judge` (grep 2026-07-11).

## Design

### Decision 1 — absorb, don't port (recommended)

`stratum_judge` as a standalone tool is **not ported**. The TS engine's
judged-ensure seam is the judge surface post-cutover. Rationale: its only
structural consumer is the v0 spec format being retired; goal-kernel
demand is speculative until triage says otherwise.

Consequences made explicit rather than lost silently:
- **What is kept (already shipped in TS):** stakes-routed models
  (cheap/default/paranoid), openai/codex backend selection, fail-closed
  errors, per-predicate `{holds, reason}` verdicts with usage accounting.
- **What is dropped, recorded as capability deltas:** T2 citation
  enforcement, T3 cross-model adversarial cold-read, staged evidence
  trees, per-(flow,step) turn budgets, `tier_disagreements`. Each becomes
  a row in a "judge capability delta" table in THIS doc, with a filed-on-
  demand follow-up code (STRAT-TS-JUDGE-TIERS) if real usage misses them.

### Decision 2 — the deltas, corrected by review (2026-07-11, both findings CONFIRMED)

- **Context bounding — reframed, not "declared artifacts only."** The
  original criterion ("judged prompt contains only declared artifacts")
  is unrepresentable: the v1 IR's judged predicate carries only
  `statement` + `stakes` (`ts/src/ir/schema.ts:14-19`) and the engine
  passes the step output + flow input as context
  (`engine.ts:961-962`) — there is no artifact-selection field. The
  ACTUAL property TS provides, now stated as the contract: **judged
  context is engine-constructed from flow state only (step output +
  flow input), never live workspace reads**, with injection hardening
  already present (`<<<JUDGE_INPUT>>>` separation + `<` escaping in
  `codex_judged.ts:55-63`). One contract test pins engine-constructed-
  only; the difference vs Python's staged-evidence model is a row in
  the capability-delta table. An IR artifact-selection field is NOT
  added here (scope growth with no consumer); it goes in the delta
  table as follow-up-on-demand.
- **Budget accounting — regression verification, NOT implementation.**
  The engine ALREADY debits judged usage into the ledger and fails
  closed on flow/subflow/task exhaustion (`engine.ts:989-1009`,
  verified 2026-07-11). Implementing "wiring" as originally written
  would double-debit every judged call. The work is a regression test
  asserting: usage debited once, exhaustion returns the three budget
  failure kinds, fanout items get per-item ledger events.

### Decision 3 — triage coupling

If STRAT-PY-TRIAGE dispositions the goal kernel as PORT, the goal design
must state which judge capabilities it needs; only then does
STRAT-TS-JUDGE-TIERS get filed with a real consumer. This design pre-
commits the interface point: a `JudgeRunner`-shaped callable
(`engine.ts:45-48`) is what any ported consumer receives — the same seam
the engine uses.

## Files

| File | Action | Purpose |
|---|---|---|
| `ts/tests/judge/*.test.ts` (existing) | modify | engine-constructed-context contract test |
| `ts/tests/engine/*.test.ts` (existing) | modify | judged budget regression tests (no-double-debit, exhaustion kinds) |
| `docs/features/STRAT-TS-JUDGE-TOOL/design.md` (this doc) | modify | capability-delta table appended at execution |

## Acceptance criteria

- [ ] Capability-delta table recorded (kept / dropped / follow-up code)
- [ ] No `stratum_judge` tool on the TS server; decision + rationale
      recorded in the epic (roadmap Phase 2 row updated from "expose the
      tool" to this absorb decision)
- [ ] Budget regression tests: usage debited exactly once; exhaustion
      returns the three budget failure kinds; per-item fanout ledger
      events (no new wiring — engine.ts:989-1009 already does this)
- [ ] Context contract test: judged context is engine-constructed from
      flow state only (step output + flow input), never live workspace
      reads
- [ ] Triage coupling recorded: goal-kernel disposition names its judge
      requirements or confirms none

## Open questions

- None blocking. STRAT-TS-JUDGE-TIERS is deliberately NOT filed — it
  exists only if triage or live usage produces a consumer.
