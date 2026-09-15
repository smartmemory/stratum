# Implementation review r3 (Codex gpt-5.6-sol/high, run 3d34aeeea2a1, 2026-09-15)

1. must-fix — `ts/src/connectors/peer-sidecar.ts:208` — Nonterminal startup/runtime failure fabricates an `idle` notice; if a record rewrite fails after subscription while Codex remains busy, cleanup tells the parent the run finished.

2. should-fix — `ts/src/connectors/background.ts:364` — Reading optional `peer.json` is unbounded and may block; a FIFO named `peer.json` with no writer makes `pollBackgroundRun()` hang instead of preserving prior poll semantics.

3. should-fix — `ts/src/connectors/peer-sidecar.ts:191` — `owned` records pathnames, not file identities; if a registry record, key, or socket pathname is replaced during linger, cleanup unlinks the replacement it never created.

4. should-fix — `ts/src/connectors/peer-registry.ts:127` — Dead-peer sweeping deletes keys by prefix and a socket from the current `sockDir`, without correlating them to the record; changing socket directories can leave the actual stale socket while deleting an unrelated `<deadPid>.sock` in the new directory.

5. should-fix — `ts/src/connectors/peer-sidecar.ts:285` — Missing `childProcStartTime` makes `processIdentity(pid, "")` permanently `unknown`; if that wrapper is killed without a sentinel, the sidecar, watchers, intervals, registry row, and socket survive indefinitely.

6. should-fix — `ts/contracts/mcp-surface.json:1123` — The strict contract widens `peer?: "pending"` to any string; a regression returning `peer:"failed"` passes `assertToolResponse`, and the contract test never checks rejection of non-`pending` values.

