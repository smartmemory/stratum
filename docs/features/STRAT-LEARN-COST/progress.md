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
