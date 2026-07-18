# CLAUDE.md

## What This Repo Is

**Stratum** — headless execution kernel for AI-driven development. One shipped component:

- **`ts/`** — TypeScript engine (`@smartmemory/stratum`): IR validation, flow execution,
  MCP server (`stratum_plan`, `stratum_step_done`, `stratum_audit`, guard/gate/bg-agent
  surfaces), CLI. This is the ONLY engine (surface 9) since the 2026-07 TS cutover.

The Python library (`src/stratum/`, PyPI `stratum-py`) and Python MCP server
(`stratum-mcp/`, PyPI `stratum-mcp`) were retired with the STRAT-PY-RETIRE epic.
Their last python-bearing commit is archived on the `python-legacy` branch (642dda3) —
recovery is `git show python-legacy:<file>`. Never delete that branch.

UI and pipeline monitoring live in **Compose** (`/Users/ruze/reg/my/forge/compose/`),
which drives stratum via the TS CLI/MCP contract.

## Repo Layout

```
ts/                    — TypeScript engine (sole engine)
  src/
    engine/            — flow state, execution, ensure postconditions
    mcp/               — MCP server surface
    cli/               — CLI bins (node ≥24; erasable-syntax type stripping)
    guard/ judge/ parallel/ connectors/ speckit/ ir/ ...
docs/                  — Stratum-level docs
  plans/               — Implementation plans + epic ledgers
  features/            — Feature specs
  app/                 — Archived coder-compose docs (brainstorm, PRD, decisions, journal)
ROADMAP.md             — Canonical roadmap (all tracks)
```

## Development

```bash
cd ts && ./node_modules/.bin/vitest run   # full TS suite; pnpm not on PATH — use ./node_modules/.bin/
                                          # NEVER two concurrent full runs
```

**Compose app (standalone project):**
```bash
cd /Users/ruze/reg/my/forge/compose && npm install && npm run dev   # starts Vite + Express on port 3001
```

## Key Docs

- `ROADMAP.md` — all tracks (T1 Python lib → T5 MCP → Evaluation)
- **GitHub issues** (`gh issue list --repo smartmemory/stratum`) — filed follow-ups and deferred
  features live HERE in addition to ROADMAP.md (e.g. #18 workspace-write bg agent mode,
  #19 deterministic test-judge backend). Check BOTH when looking for
  pending/deferred work. File new follow-ups as issues (authored as smartmem-dev).
- `docs/plans/2026-07-11-strat-py-retire-progress.md` — TS-cutover epic ledger (full trail)
- `docs/app/` — full Compose design history: brainstorm, PRD, discovery, decisions, journal

## Stratum Execution Model

For non-trivial tasks, use Stratum internally:
1. Write a `.stratum.yaml` spec — never show it to the user
2. Call `stratum_plan` to validate and get the first step
3. Narrate progress in plain English as you execute each step
4. Call `stratum_step_done` after each step — the server checks your work
5. If a step fails postconditions, fix it silently and retry
6. Call `stratum_audit` at the end and include the trace in the commit
