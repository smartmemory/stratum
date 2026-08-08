# STRAT-NARRATIVE-1 — Stratum Public Narrative

**Status:** PLANNED · promoted 2026-08-08 from smart-memory-docs ideabox IDEA-1201.
**Source:** Escepine teardown ([escepine.vercel.app](https://escepine.vercel.app/), 2026-08-06) —
a waitlist-only landing page (no code, docs, or team) marketing Stratum's exact
reasoning/execution-split thesis better than Stratum does. Category signal: "deterministic
layer under the agent" is congealing into a recognized category (Escepine, prime-agent,
DeerFlow/Pi.dev/OpenClaw); Stratum has years of shipped substance and near-zero public
narrative. Marketing work, not engineering — nothing here changes the engine.

**Related:** `docs/VISION.md` (invisible spec rails — the mechanism framing this feature
translates into buyer language), forge-top ROADMAP breadcrumb row, ideabox IDEA-1201.

## Deliverable

Three artifacts, shippable independently, in value order:

### S1 — Decide/execute one-liner + README hero (smallest, do first)

- [ ] README.md (existing) opens with the division-of-labor one-liner: "Your agent
  decides. Stratum verifies." (or a workshopped variant) before any mechanism talk
- [ ] Hero paragraph states the split in buyer language (reasoning layer plans; the
  runtime checks every step) and only then introduces spec rails / MCP mechanics
- [ ] Names the reasoning layers it sits under (Claude Code, Codex CLI, ...) the way
  Escepine does — interop posture, not competition

### S2 — Compound-reliability (Lusser's Law) exhibit

- [ ] README section (existing file) with the formula `R_sys = R_step^n` and a small
  table: per-step 96% → step 5 / 10 / 20 system reliability (81% / 66% / 44%),
  closing with the point: every `ensure`-checked step multiplies a ~1.0 back in
- [ ] Interactive version (slider over R_step and n) only if/when a public site exists
  to host it — a static page under `blog/` (existing dir) is the fallback; decide at
  build time, do not block S1/S3 on it
- [ ] Numbers must be reproducible from the formula shown — no unsourced benchmark claims

### S3 — Failure-vector → mechanism table

- [ ] README/docs table mapping production failure vectors to the SHIPPED Stratum
  mechanism that kills each: cascading unverified steps → `ensure` postconditions +
  judge; no execution traces → `stratum_audit`; guardrails dropped mid-workflow →
  server re-checks every step regardless of what the model remembers (STRAT-IMMUTABLE);
  ungoverned writes → guard authorized transitions + tamper-evident ledger
- [ ] Vectors we do NOT yet cover are omitted or marked planned honestly (runaway-loop
  budgets → COMP-ITER-BUDGET is compose-side and PLANNED; context bloat is not our
  claim) — the table's credibility is the product
- [ ] Each row links to the doc/tool for the mechanism, not just prose

## Constraints

- External prose rules apply (README, blog, landing copy): no em dashes, no semicolons
  in the published text.
- Honest-gate discipline extends to marketing: claim only what a reader can verify by
  running the tool or reading the audit trace.

## Files

- `README.md` (existing) — S1 hero, S2 table, S3 table
- `blog/` (existing dir) — optional S2 interactive/static exhibit
- `docs/VISION.md` (existing) — unchanged; source material for S1 language
