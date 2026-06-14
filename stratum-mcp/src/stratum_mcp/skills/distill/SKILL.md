---
name: distill
description: Mine recent Claude Code session transcripts for repeated manual workflows and stage reusable-asset candidates (skill / subagent / command) for review. The success-pattern complement to stratum-learn. Triggers on "distill", "what workflows do I repeat", "package my repeated steps", "make a skill from what I keep doing".
---

# Distill — repeated workflow → staged asset

Mine your recent Claude Code transcripts for workflows you've **repeated**, and
stage high-confidence ones as new skills / subagents / commands for review.
Powered by the `stratum_distill` MCP tool (STRAT-DISTILL). **Staged, never
auto-applied** — you review and create the asset yourself.

## When to use

- After several sessions on a project — enough transcript history to find repeats.
- When you notice you keep doing the same multi-step thing by hand.

## How to run

Call the MCP tool (preferred):

```
stratum_distill(project_dir="", window_days=30, min_count=2)
```

- `project_dir` — defaults to this project's `~/.claude/projects/<hash>` dir; pass `--all` via the CLI to sweep every project.
- `min_count` — recurrence bar (default 2). A workflow counts only if it recurred at least this many times across at least two sessions.

Or the CLI:

```
python -m stratum.judge.distill top     --min-count 2     # preview repeats, no write
python -m stratum.judge.distill extract --min-count 2     # stage candidates to the sidecar
python -m stratum.judge.distill stats                     # summarize
```

Staged candidates land in `.stratum/postmortem/distill_candidates.jsonl` (own
`distill-1.0` schema; never the inline or canonical corpora).

## Discipline

- **≥2× bar, cross-session.** Only workflows that genuinely recurred (default: across ≥2 sessions) are surfaced.
- **Create nothing is a valid result.** If nothing repeated, say so — never
  manufacture an asset to justify the run.
- **Smallest form.** A recurring single command → a `command`; a multi-step
  procedure → a `skill`; a read-only investigation → a `subagent`.
- **Staged, not applied.** Candidates are *described* suggestions. Review, edit,
  then create the asset yourself — the tool never writes to your working tree.

## Output

Present the result as:
- **Shortlist** — the repeated workflows considered, with frequency + evidence sessions.
- **Created / staged** — candidates written to the sidecar, with intended path + form.
- **Skipped** — what you deliberately did not package, and why.
- **Nothing to distill** — if no workflow cleared the bar (a complete, successful result).
