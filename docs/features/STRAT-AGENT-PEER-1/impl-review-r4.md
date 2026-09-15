# Implementation review r4 (Codex gpt-5.6-sol/high, run 8a10eda1854c, 2026-09-15)

1. should-fix — `ts/src/connectors/peer-registry.ts:127` — Record-unlink failure is ignored before deleting dependents; an undeletable stale record is swept repeatedly and can later unlink a replacement socket at its recorded endpoint.

2. should-fix — `ts/src/connectors/background.ts:366` — The guarded `peer.json` read remains a check/use race; replacing the regular file with a writerless FIFO between `lstat` and `readFile` hangs `pollBackgroundRun()`.

3. should-fix — `ts/src/connectors/peer-sidecar.ts:249` — Cleanup verifies record/key content before a pathname-based unlink, while socket verification precedes asynchronous `server.close`; a replacement installed after either check can still be unlinked.

4. should-fix — `ts/src/connectors/peer-sidecar.ts:108` — The five-second callback timeout starts only after `readPeerToken`; a raced FIFO or sufficiently expensive key scan can occupy all eight slots, causing shutdown to exit before queued idle notices are attempted.

5. should-fix — `ts/src/connectors/peer-sidecar.ts:380` — Without recorded start time, liveness is PID-only; if the wrapper exits without a sentinel and its PID is reused before the probe, the unrelated process keeps the peer falsely busy indefinitely.



## Controller adjudication

1, 2, 4, 5: fixed in fix 5. 3: accepted limitation — unlink is by pathname, so a same-user process racing the identity check can still have its replacement removed; the window is microseconds, the attacker must already own the user account, and the files at risk are in a directory Claude Code itself treats the same way. Documented in design.md "Safety" and report.md Known issues.
