# Codex brief — STRAT-AGENT-PEER-1 slice 2 (Tasks 3, 4, 5 + one slice-1 fix)

Slice 1 (`ts/src/connectors/peer-registry.ts`, `ts/src/connectors/peer-sidecar.ts`, their tests) is implemented and committed. Read, in order:

1. `docs/features/STRAT-AGENT-PEER-1/design.md` — especially "Wiring", "Terminal retention window", "Socket protocol" (the **acceptance rule** bullet now stores `from_mode`), and the last section "Unproven assumptions" (the `from_mode` echo requirement, verified live).
2. `docs/features/STRAT-AGENT-PEER-1/blueprint.md` — File Plan rows 3-6, 8-11, grounding line refs, corrections table.
3. `docs/features/STRAT-AGENT-PEER-1/plan.md` — do **Task 3, Task 4 (golden flow + error harness driven through `startBackgroundRun`, + contract test), Task 5**.
4. The slice-1 code itself, so you extend it rather than duplicate it.

**Slice-1 fix, do this first (TDD):** `peer-sidecar.ts` must store the `from_mode` of each accepted `notify_when_idle` request and echo it verbatim as `from_mode` on the `peer_idle_notice` (and on the `peer_message_status` refusal). Verified 2026-09-15: without the echo the subscriber's Claude session does not admit the notice to its model. Add the assertion to the existing sidecar test that checks the notice frame.

Working directory for tests and typecheck: `ts/`. Run only targeted files (`npx vitest run tests/connectors/peer-*.test.ts tests/connectors/background*.test.ts tests/mcp*.test.ts` and whichever existing test covers `mcp-surface.json`/`assertToolResponse`; find it with `rg assertToolResponse tests`). Then `npm run typecheck` and `npm run build` (the build must succeed: `prepare-dist.mjs` gets the new entry). Do not run the full suite. Do not commit.

Constraints (non-negotiable):
- Unsandboxed run: create/modify only the files named in blueprint File Plan rows 3-6 and 8-11 plus the slice-1 fix. Tests use temp `sessionsDir`/`sockDir` only; never touch `~/.claude/sessions` or `/tmp/cc-socks`. `afterEach` SIGTERMs every sidecar and removes temp dirs.
- No mocks of `ps`, sockets, `spawn`, fs. Controlled-release child exactly as plan.md Task 4 describes, and remember `options.env` **replaces** the ambient env (pass `{ ...process.env, RELEASE }`).
- `cancelBackgroundRun` stays untouched. `meta.json` is never rewritten after spawn. Poll/cancel contract shapes change only by the additive optional `peer` field.
- `mcp-surface.json` is strict: add exactly the optional fields listed in plan.md Task 3; the contract test must show an undeclared key still throws.
- Match existing code style (ESM, `node:` imports, explicit types, WHY-comments). CHANGELOG and README edits in the same change set.

Deliverable: a report under 400 words with (a) files changed, (b) exact test commands and pass/fail counts, (c) typecheck and build results, (d) deviations from plan.md and why, (e) anything you could not verify. Do not claim anything you did not run.
