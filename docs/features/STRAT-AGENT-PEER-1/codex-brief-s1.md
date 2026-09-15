# Codex brief — STRAT-AGENT-PEER-1 slice 1 (Tasks 1-2 + their tests)

You are implementing slice 1 of a designed, blueprinted, planned feature in the stratum TypeScript engine. Read these three files first, in this order, and treat them as the spec; do not redesign:

1. `docs/features/STRAT-AGENT-PEER-1/design.md` (sections "Ground truth", "Design", "Socket protocol", "Cancellation and failure isolation")
2. `docs/features/STRAT-AGENT-PEER-1/blueprint.md` (file plan, grounding line refs, corrections table, boundary map)
3. `docs/features/STRAT-AGENT-PEER-1/plan.md` — **do Task 1 and Task 2 only**, plus the parts of Task 4 that test them (the `peer-registry.test.ts` unit tests and a first version of `peer-sidecar.test.ts` that drives the sidecar DIRECTLY via `spawnPeerSidecar(config)` against a fake `stream.jsonl` you write yourself, since Task 3 wiring is not in this slice).

Working directory for tests and typecheck: `ts/` (`npx vitest run <files>`, `npm run typecheck`). Do not run the full suite. Do not touch `background.ts`, `runner.ts`, `mcp-surface.json`, `prepare-dist.mjs`, `README.md`, or `CHANGELOG.md` in this slice. Do not commit (the controller commits).

Constraints that are not negotiable:
- You are running **without a sandbox** so that real `ps` and real Unix sockets work. Because of that: only create files under `ts/src/connectors/`, `ts/tests/connectors/`, and temp dirs under `/tmp/sp-*` or `os.tmpdir()`. Never write into `~/.claude/sessions` or `/tmp/cc-socks` — every test passes explicit `sessionsDir`/`sockDir` temp paths. Kill every sidecar you spawn in `afterEach` and remove the temp dirs.
- **No mocks** of `ps`, sockets, `spawn`, or fs. Tests use real processes and real sockets.
- TDD per checkbox: write the failing test, run it, implement, run it again.
- Match the repo style you see in `ts/src/connectors/background.ts` and `proc_identity.ts` (ESM, `node:` imports, explicit types, no default exports, comments that explain WHY).
- The sidecar entry must work both from source (`node --experimental-strip-types ts/src/connectors/peer-sidecar.ts`) and, later, from `dist/connectors/peer-sidecar.js`; resolve `.ts` first, `.js` fallback, as the blueprint says.
- `processIdentity` from `proc_identity.ts` is the ONLY way to decide the shadowed child is dead; never act on `"unknown"`.

Deliverable: when done, print a report with (a) the list of files created, (b) the exact test commands you ran and their pass/fail counts, (c) `npm run typecheck` result, (d) any place where you deviated from plan.md and why, (e) open questions for the controller. Keep the report under 400 words. Do not claim anything you did not run.
