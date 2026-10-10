# STRAT-JUDGE-JEV-1 — Jev backend for `stakes: cheap` judged predicates (design)

**Status:** PLANNED (filed 2026-10-10; no work started). **Value spike:** PENDING
**Origin:** forge survey `scratch/2026-10-10-jev-fit/report.md` (forge root), Jev context in SmartMemory
`scratch/2026-10-10-maya-jev-intent/REPORT.md`.

## Related Documents

- Survey: `/Users/ruze/reg/my/forge/scratch/2026-10-10-jev-fit/report.md` (existing)
- Judge surface: `docs/features/STRAT-TS-JUDGE-TOOL/design.md` (existing)
- Judge code: `ts/src/judge/judged.ts` (existing), `ts/src/judge/codex_judged.ts` (existing),
  `ts/src/mcp/server.ts` (existing, `judgeBackend()` at :83-100, `defaultEngine()` :94+)
- Tier config: `ts/src/config/models.default.toml` (existing, `[judge]` at :20-24)
- Roadmap row: `docs/plans/COMPOSE-ROADMAP.md` (existing)

## Problem

Judged ensure predicates return `{holds, reason}` (`judged.ts:32-43`). `stakes: cheap` runs on
`gpt-6-luna/low` (`models.default.toml:22`). Many cheap predicates are bounded yes/no decisions where a typed
decision service (Jev: Choice/Noul/Score with probabilities) could be faster and cheaper than an LLM call.
Unverified: whether Jev agrees with the reference as often as luna does. Hence a spike first.

## Scope

- [ ] Add a `jev` value to `judgeBackend()` (`ts/src/mcp/server.ts:83`, return type now `"openai" | "codex" | "fixture"`)
- [ ] Jev is used ONLY for `stakes: cheap`. `default` (gpt-6.1-sol/high) and `paranoid` (gpt-6-astra/high) stay on LLMs.
- [ ] Off by default. Opt in by env (name decided at build; selecting `jev` explicitly via `STRATUM_JUDGE_BACKEND`
      is not enough alone, since that switch is global and Jev must not serve non-cheap stakes).
- [ ] On Jev error or timeout: log WARNING and fall back to the existing luna path for that call. Never fail the predicate.
- [ ] Credential: env var `JEV_API_KEY` (lives in `smart-memory-core/.env`). Name only, never copy the value into this repo.
- [ ] New adapter `ts/src/judge/jev_judged.ts` (new), returning `JudgedResult` (`holds`, `reason`, `stakes`, `model`, `usage`).

## Out of scope

- Any build before the value spike passes.
- Changing `default` or `paranoid` tiers.
- The follow-up candidates below.

## Options for `reason`

`judgedResultSchema` requires `reason: z.string().min(1)` (`judged.ts:40-43`), but Jev returns typed decisions, not prose.

| Option | What | Cost |
|---|---|---|
| A. Template | Build reason from the decision: `jev: <label> (p=<prob>) for "<statement>"` | No schema change. Reason is less informative than an LLM's, but is deterministic and greppable. |
| B. Relax | Make `reason` optional for Jev results | Touches the shared schema and every consumer of `reason`, and weakens it for LLM tiers. |

**Recommendation: A (template).** It leaves the strict schema and all consumers untouched, and the reason still carries
the label and probability, which is the evidence a reviewer needs.

## Value spike (run BEFORE any build)

**Status:** PENDING. Bar is pre-registered here, before any run; do not edit it after results exist.

- **Method:** collect a fixed set of real judged predicates (statement + context) from past flow traces, with their
  `stakes: cheap` usage. Freeze the set (file + hash) before running. Run each through (1) `gpt-6.1-sol/high` as
  the reference, (2) current cheap `gpt-6-luna/low`, (3) Jev. Record agreement with reference, p95 latency, cost per call.
  Report the sample size, and how many predicates were bounded yes/no.
- **Pre-registered bar:** Jev agreement with the reference >= luna agreement AND Jev p95 latency < 1 s.
- **Outcome:** pass → build under this ticket. Fail → mark KILLED with the numbers.
- Spike artifacts go in a dated scratch folder with a README. Keep `JEV_API_KEY` out of all logs and reports.

## Acceptance criteria

- [ ] Value spike run, results recorded here against the pre-registered bar
- [ ] `judgeBackend()` / engine wiring selects Jev only for `stakes: cheap`, default off
- [ ] `reason` handled per the chosen option, `judgedResultSchema` still passes
- [ ] Jev error and timeout each produce a WARNING and a luna-path result (table-driven test over both)
- [ ] `default` and `paranoid` never call Jev (test)
- [ ] No Jev key value in code, logs, fixtures or docs
- [ ] CHANGELOG entry in the same commit as the code

## Follow-up candidates (NOT in scope, file separately if the spike passes)

Paths verified 2026-10-10:

- `compose/lib/gate-prompt.js:49` (existing): `hasIssue` keyword regex with negation lookbehinds, decides approve/revise default in `buildRecommendation()`.
- `compose/server/vision-utils.js:35` (existing): `ERROR_PATTERNS`, 7 tool-error buckets. A copy lives at `stratum/app/server/vision-server.js:700` (existing).
- Medium candidates from the survey: `compose/lib/triage.js:297`, `compose/lib/step-validator.js:25` (not re-verified here).
