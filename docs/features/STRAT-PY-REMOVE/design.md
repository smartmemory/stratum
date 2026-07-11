# STRAT-PY-REMOVE — Deprecate and delete the Python engine (design)

**Status:** DESIGN (2026-07-11) · **Epic:** STRAT-PY-RETIRE Phase 5

## Related Documents

- Epic: `docs/plans/2026-07-11-strat-py-retire-roadmap.md` (Phase 5; decisions D3, D6)
- Upstream: STRAT-PY-SWEEP design (entry gate), STRAT-PY-TRIAGE design
  (park records must be extracted before deletion)
- PyPI publishing: memory `project_pypi_trusted_publisher` (stratum-mcp
  publishes via Trusted Publisher / API token as `ruze`)

## Entry gates (all hard)

1. STRAT-PY-SWEEP complete + **2 consecutive weeks** TS-only (clock date
   recorded in the sweep doc; zero Python spawns observed).
2. External-consumer check re-run within a week of removal: pypistats for
   BOTH packages + GitHub code search (`from stratum import`,
   `from stratum_mcp`, `stratum-mcp install`) outside the smartmemory org.
   Any hit → pause, assess, decide notice period; record either way.
3. Park records from triage extracted into their own docs (nothing parked
   lives only in Python docstrings).

## Design

### Step 1 — Deprecation releases (both packages, same day)

For `stratum-mcp` and `stratum-py`:
- Final version bump with: README deprecation banner (what replaced it:
  the TS engine's npm package + install command), `Development Status ::
  7 - Inactive` classifier, and a one-line `DeprecationWarning` on import
  (warn, never break — installed environments keep working).
- No yanking of prior versions: existing pins must keep resolving.
- CHANGELOG final entry points here and at the epic.
- After publish: retire the Trusted Publisher config / API tokens so
  nothing can accidentally publish later.

### Step 2 — Repo removal (one commit)

- Record in THIS doc first: removal SHA-to-be, final suite result
  (expected 1517 passed / 2 skipped), final package versions.
- Delete: `stratum-mcp/`, `src/stratum/`, root `pyproject.toml`,
  `uv.lock`, Python-only CI jobs / hooks / Makefile targets.
- Same commit: CHANGELOG entry + README rewrite (repo identity becomes
  the TS engine; install/quickstart sections replaced), CLAUDE.md repo
  layout section updated.
- Git history is the archive — no archive branch, no tarball (repo
  precedent: never delete implementation reports; those stay).

### Step 3 — Bin claim (D3, separate commit after removal)

- TS package adds the `stratum-mcp` bin name (alias of the TS stdio
  server entry) so stale muscle memory and docs keep working.
- Also claims `stratum` cleanly (the miniconda shadow problem dies with
  the Python env dependency, but PATH docs get a note).
- Verify: `stratum-mcp --help` and `stratum --help` resolve to TS on a
  clean PATH; node >= 26 works (stratum#6 fixed back in Phase 2).

### Rollback posture

Before Step 2, rollback = config (sweep rows flip back). After Step 2,
rollback = `git revert` of one commit plus re-publishing nothing (PyPI
packages still exist, deprecated but functional). There is no state
migration to unwind (epic D1: drain-and-cutover).

## Files

| File | Action | Purpose |
|---|---|---|
| `stratum-mcp/**`, `src/stratum/**`, `pyproject.toml`, `uv.lock` (existing) | delete | the removal |
| `CHANGELOG.md`, `README.md`, `CLAUDE.md` (existing) | modify | same-commit identity update |
| `ts/package.json` (existing) | modify | `stratum-mcp` + `stratum` bin claims |
| `docs/features/STRAT-PY-REMOVE/design.md` (this doc) | modify | removal record (SHA, suite, versions) |

## Acceptance criteria

- [ ] Entry gates 1–3 verified and recorded here with dates
- [ ] Both PyPI packages: deprecation release published; import warns;
      prior versions still installable
- [ ] Publisher configs/tokens retired
- [ ] Removal commit lands with CHANGELOG/README/CLAUDE.md in the same
      commit; removal record (SHA, final suite numbers, versions) in this doc
- [ ] TS bins claim `stratum-mcp` and `stratum`; verified on clean PATH
- [ ] Epic roadmap Phase 5 checkboxes ticked; epic marked COMPLETE

## Open questions

- None. Timing derives from the sweep clock, not the calendar.
