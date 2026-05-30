# T2-F5-RESUME — Spike Findings (reparent primitive)

**Date:** 2026-05-30 · **Platform run:** macOS (darwin 25.5.0) · **Verdict: ✅ PRIMITIVE FEASIBLE**

## Question

Today's connectors spawn children with `stdout=PIPE` (in-memory, server-owned) and no
`start_new_session`, so a server restart orphans the child and loses its output —
`resume_interrupted_parallel_tasks` honestly flips interrupted `running→failed`
(`parallel_exec.py:1039`, docstring defers "real reparenting" to T2-F5-RESUME). **Can a child
instead survive the server's death and have a fresh process re-attach and recover the complete
result?**

## What was tested

`reparent_spike.py selftest [--kill9]` — a self-verifying harness:
1. A **spawner** subprocess launches a detached child (`start_new_session=True`) that streams JSONL
   to a **durable file it opens itself** (no pipe), fsync per line, then writes a result sentinel.
2. The spawner **exits / is SIGKILLed mid-run** (the realistic "server died" case) while the child
   is still writing.
3. A **fresh process** reads the persisted handle `{pid, output_path, token, start_time, offset}`,
   re-opens the file from the offset, tails to the sentinel, with a **pid-liveness + process-start-
   time + token identity guard** (PID-reuse defense).

## Result — both cases PASS

| Claim | Graceful exit | SIGKILL (`-9`) |
|---|---|---|
| child survived parent death (output grew after parent gone) | ✅ | ✅ |
| fresh process recovered ALL chunks | ✅ | ✅ |
| result sentinel recovered | ✅ | ✅ |
| status = complete | ✅ | ✅ |

Observed: after the spawner died, `child_alive=True` and the output file kept growing
(55→110, 110→220 bytes), and the fresh `resume()` reconstructed the full result.

## The proven mechanism (what the real feature does)

1. **Spawn detached:** connectors add `start_new_session=True` to `create_subprocess_exec`
   (`codex.py:259/434`, `claude.py`, `opencode.py:94`).
2. **Durable output instead of PIPE:** redirect the child's `stdout` to an append-mode **jsonl file**
   (the child inherits the fd and keeps writing after the server dies — no server-owned pipe).
3. **Persist a handle in `FlowState`:** `{pid, output_path, identity_token, start_time, next_offset}`
   per in-flight server-dispatched task.
4. **Re-attach on restart:** instead of `running→failed`, re-open the file at `next_offset`, tail to
   the connector's terminal/result event, gated by the identity guard. Drop to `failed` only if the
   child is genuinely dead with no result.

This is a spawn-site change + a durable-stream reader; it does **not** require a new concurrency
engine. The connector child already writes its whole stream to stdout — redirecting that stdout from
a PIPE to a file is a drop-in at the spawn point.

## Residuals / implementation notes discovered

- **Partial trailing line.** A naive `read()+splitlines()` can surface a half-written final line
  (parent died mid-write). The reader MUST consume only up to the last `\n` and carry the remainder
  to the next read. (The spike's reads happened to align; the real reader needs this guard. Low risk,
  known fix.)
- **Linux.** Run here was darwin only. All primitives are POSIX-standard: `setsid`/
  `start_new_session`, append+fsync, `os.kill(pid, 0)`, and a process-start-time identity token
  (`/proc/<pid>/stat` field 22 on Linux is an even cleaner token than `ps -o lstart=`). Confirm in CI;
  no expected blocker.
- **PID reuse.** Defended by comparing the persisted process-start-time against the live pid's; a
  mismatch ⇒ `pid_reused`, do not trust. Token-in-stream is a second check.
- **Completion detection.** The new process is NOT the child's parent (it's reparented to
  init/launchd), so it can't `waitpid()`. Completion is detected via the **result sentinel in the
  stream** + **pid-liveness** (gone + no sentinel ⇒ died incomplete). Proven in the spike.
- **Idempotent budget/debit.** A re-attached task must not double-count budget/usage already debited
  before the restart — the handle should carry a "debited" marker or the reader reconciles from the
  persisted task state.

## Conclusion

The literal T2-F5-RESUME ("resume an executor against a live child process") is **achievable** via
detached-spawn + durable-stream re-attach — no engine rewrite. Cleared to proceed to the full design.
The spike code (`reparent_spike.py`) is a throwaway reference for the reader/handle shapes; it is not
shipped.
