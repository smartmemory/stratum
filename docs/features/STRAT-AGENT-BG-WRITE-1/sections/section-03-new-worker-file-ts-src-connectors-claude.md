# Section 03 — New Worker File (`ts/src/connectors/claude-bg-worker.ts`)

**Task ID:** T3
**Depends on:** —
**Files:** background.ts, stream.jsonl

## Plan

**Depends on:** Task 2 (imports `T2F5_DONE_SENTINEL` from `background.ts`, imports `ClaudeConnector` from `claude.ts`)  
**File:** `ts/src/connectors/claude-bg-worker.ts` (new)

Worker Thread entry point. Receives `workerData`, runs `ClaudeConnector` with a query seam that normalizes SDK events to T2F5 JSONL format.

```typescript
import { appendFileSync, createWriteStream } from "node:fs";
import { workerData } from "node:worker_threads";
import type { ClaudeConnectorOptions } from "./claude.js";
import { ClaudeConnector } from "./claude.js";
import { T2F5_DONE_SENTINEL } from "./background.js";
```

Key behaviors:
- `writeLine(record)`: wraps `stream.write()` in a Promise
- `run()`: creates `ClaudeConnector` with a `query` option that wraps the real SDK `sdkQuery`; intercepts events to write:
  - Assistant text blocks → `{ type:"item.completed", item:{ type:"agent_message", text } }`
  - Result events → `{ type:"turn.completed", usage:{ input_tokens, output_tokens } }` (cumulative)
  - Yields original events to the connector's accumulator
- `run().then(() => writeLine({ [T2F5_DONE_SENTINEL]: 0 }))` — success sentinel
- `.catch(async (err) => { await writeLine({type:"error", message:msg}); await writeLine({[T2F5_DONE_SENTINEL]: 1}) })` — both best-effort; **also write err.message to `workerData.stderrPath`** using `appendFileSync` (synchronous avoids timing issues in the catch block)
- `.finally(() => stream.end())`
- `isRecord(v)` guard function at bottom

**Stderr plumbing (design.md:648 — "stream errors written to stderr, never crash worker"):**  
The worker receives `stderrPath` in `workerData`. On error in the catch block, after writing the error JSONL record to `stream.jsonl`, write the error message to `stderrPath`:
```typescript
.catch(async (err: unknown) => {
  const msg = err instanceof Error ? err.message.slice(0, 2000) : String(err);
  // Write error to stderr path (best-effort; never throw from catch)
  try { appendFileSync(workerData.stderrPath, `${msg}\n`, "utf8"); } catch {}
  await writeLine({ type: "error", message: msg });
  await writeLine({ [T2F5_DONE_SENTINEL]: 1 });
})
```
The `try/catch` wrapper around `appendFileSync` ensures a filesystem failure writing the `.err` file never causes the sentinel write to be skipped.

**Note on Worker seam for tests:** Functions cannot be passed via `workerData` (structured-clone rejects them). The implementer should choose one of:
- A `STRATUM_TEST_WORKER=1` env var that enables a stub query in the worker (avoids real SDK calls in tests)
- Integration tests that rely on a real (but cheap/mocked-at-API-layer) ClaudeConnector

Document the chosen approach in the file. For initial implementation, the env-var stub approach is recommended.

**Acceptance criteria:**
- [ ] File compiles with `tsc --noEmit` without errors
- [ ] `T2F5_DONE_SENTINEL` exported from `background.ts` and importable in worker without circular-import error
- [ ] No circular imports: worker imports background (for constant) and claude (for connector); background imports worker URL only at runtime via `new URL(...)` — not a TS import
- [ ] On successful run: `stream.jsonl` ends with `{"__t2f5_done__":0}` line
- [ ] On error: `stream.jsonl` ends with `{"__t2f5_done__":1}` line; `stream.end()` always called
- [ ] On error: error message written to `stderrPath` (the `.err` file); test asserts `stderrPath` is non-empty after simulated query failure
- [ ] `appendFileSync` write failure to `.err` file does NOT prevent sentinel write or crash the worker
- [ ] `scanStream` can parse the worker's JSONL output without changes (D2 invariant)

---
