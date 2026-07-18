# Plan-gate review round 7 (codex gpt-5.6-terra/high) — REVISE (wording only)

Step 3 fail path, 7c stderr assertion, File Change Summary all verified consistent. TWO literal wording edits remain — apply exactly, change nothing else:

1. blueprint.md:921 — replace the "this file only" scoping phrase with "real-Worker test files (7c background-claude.test.ts and 7d agent-run.test.ts)".
2. blueprint.md:998 and :1053 — change the 7e prohibition from "STRATUM_TEST_WORKER=1 must not be set" to "STRATUM_TEST_WORKER must not be set at all (any value)".
