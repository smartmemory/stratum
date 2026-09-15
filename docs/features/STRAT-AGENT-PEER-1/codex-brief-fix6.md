# Codex brief — STRAT-AGENT-PEER-1 fix 6 (racy cleanup assertions in two tests)

Two tests in ts/tests/connectors/peer-sidecar.test.ts fail deterministically on the controller's machine but passed on yours:
- "reports exited and cleans up a dead background child without a recorded start time"
- "registers an already dead child without a start identity as exited immediately"

Failure: `expected true to be false` on `expect(existsSync(<sessionsDir>/<pid>.json)).toBe(false)` right after `await waitFor(() => existsSync(registered.sock), v => !v)`. Cleanup unlinks the three files sequentially; the test waits for the SOCKET to vanish and then asserts the RECORD and KEY are already gone. That is a race the test introduced, not a product defect.

Fix (test-only unless you find otherwise): in every test that asserts post-cleanup file removal, wait for all three paths (record, key, socket) with `waitFor` instead of asserting two of them synchronously. Check the whole file for the same pattern (`existsSync(...)).toBe(false)` immediately after a single-file waitFor) and fix each occurrence. Do not change cleanup ordering in the sidecar unless the design requires it (it does not specify an order).

Also review the fault-injection preamble in "bounds slow token lookup and drains queued idle notices": it monkeypatches `fs.open` inside the launched sidecar. If the slow lookup can be produced with a REAL slow filesystem object instead (e.g. a key candidate that is a writerless FIFO in the sessions dir, which the sidecar's own guarded open will time out on), prefer that and remove the monkeypatch; if not feasible within the 5 s deadline semantics, keep it but add a comment explaining it is process-local fault injection over real FIFO I/O, not a mock of the seam.

Run from `ts/`: `npx vitest run tests/connectors/peer-sidecar.test.ts` three times in a row; all three must be fully green. Then `npm run typecheck`. Do not commit. Report under 150 words.
