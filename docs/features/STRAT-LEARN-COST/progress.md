# STRAT-LEARN-COST — progress ledger

Resume map: this file + `git log --oneline -- docs/features/STRAT-LEARN-COST ts/src/engine ts/src/learn`.
Stratum flow run: `63047068-c50e-4ef3-8314-4cbe30e72a95` (step `implement` open, dispatchToken `9dbb8d6f-4af7-49d0-b403-f799dbba7cfc`).

| When | What | Commit / verdict |
|---|---|---|
| 2026-08-30 | Design gate: 4 Codex sol/xhigh rounds (8/9/6/9); carrier pivoted r3; guarantees made explicit r4; APPROVED by user | `25b5cbe` |
| 2026-08-30 | Blueprint; Boundary Map 0 violations | `93c025d` |
| 2026-08-30 | Plan approved (ExitPlanMode) | plan.md |
| 2026-08-30 | T1+T2 (S01) dispatched to Codex sol/high | pending |
| 2026-08-30 | S01 implemented by Codex sol/high (run e4b2337606c0); controller re-ran 17 sandbox-failed apply tests locally: green | uncommitted |
| 2026-08-30 | Controller fix: legacy `usdSource` was "reported" (fabricated provenance) → `"legacy"`, reserved from clients | uncommitted |
| 2026-08-30 | S01 review r1 (929b47e6c7f3): 2 must-fix + 2 should-fix (legacy: namespace collision; judged `dispatches` dropped; invented attempt; invariant gap) — all fixed by controller, 124 tests green | uncommitted |
| 2026-08-30 | S05 compose producer dispatched to Codex sol/high (6020c008c4d5) in parallel | pending |
| 2026-08-30 | S01 review r2 dispatched (targets the fixes) | pending |
| 2026-08-30 | S01 review r2 (ea73fcabc3b1): 1 must-fix + 2 should-fix (judged per-item event lost dispatches; consumer item `ready`; empty judge model) — fixed, 105 green; r3 (cb882a468e9f): REVIEW CLEAN | see commit below |
| 2026-08-30 | S01 committed | `d52cdf0` |
| 2026-08-30 | S02 implemented by Codex (4114ad983416); review r1 (ef204e30ba41) 1 must-fix: revert zeroed legacy spend → controller fix max(snapshot,spine); r2 (00302468bfe2) 1 must-fix: hybrid upgraded-mid-run undercount → flowSpent monotonic (live pre-revert, spine floor); r3 (a49b2f647895) CLEAN | see commit below |
| 2026-08-30 | S05 compose producer implemented (6020c008c4d5); controller local run 51/51; review r1 (acf4192bf765) 2 must-fix (raw-shape timeout usage lost receipt; tests bypass runBuild) → fix dispatched (7107d1ef2f9f) | pending |
| 2026-08-30 | S02 committed | `c4b2217` |
| 2026-08-30 | S05 review r2 (1607d1ae2c27): 2 P1 + 2 P2 (runAgentText hook in dispatch try; GSD rejection usage lost; local-Claude price dropped; census read events) → fixes (1b7c59a10c79), controller 40/40; r3 review dispatched (cb51a6f9ffeb) | pending |
| 2026-08-30 | S03 implemented (bf56e9af53c8); controller 106 green + gated golden skipped; review r1 (09b5676829d1): 4 must-fix + 3 should-fix (no drain trigger on legacy/fanout/judged; drainer loads own run copy → races pinned active run; policy creds enable egress; verify inexact; global backoff/unbounded chain; engine: prefix forgeable; tests bypass real seam) → fixes dispatched (6273d7f86e50). DECISION: egress default OFF, opt-in STRATUM_LEARN_EGRESS=1 (design §3.1b/Q5 updated) | pending |
| 2026-08-30 | S05 review r3 (cb51a6f9ffeb): 2 findings (census sidecar cleared at finalization; local-Claude rejection drops usd_source) — fixed by controller, 24/24, no r4 (cap). S05 COMMITTED in compose | compose 44e54cf |
| 2026-08-30 | S03 fixes r2 (6273d7f86e50): all 7 landed; controller 138 green, flake probe 5/5. Review r2 (1f3a6e884d80): 1 must (engine-source rows / usage rows lack event detail on the wire) + 1 pre-existing test race (flowPoll vs terminal save) → fixes dispatched (r3, cap) | pending |
| 2026-08-30 | S03 fixes r3 (7a0109a88d94): receipt.detail + real revise/revert wire tests + durable waitForTerminal; review r3 (f3189f2e8224): 1 medium (usage rows' detail partial) → controller unified event/receipt detail, 111 green, no r4 (cap). S03 + S04 docs COMMITTED | see commit below |
