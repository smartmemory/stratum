// ts/src/connectors/claude-bg-worker.ts
// Worker thread entry point for claude background runs.
// Receives workerData from background.ts, runs ClaudeConnector, writes normalized
// JSONL to the shared stream file in the same format as the Codex shell wrapper.
// This lets scanStream() parse both without branching per agent type (D2).
import { appendFileSync, createWriteStream } from "node:fs";
import { workerData } from "node:worker_threads";
import type { ClaudeConnectorOptions } from "./claude.js";
import { ClaudeConnector } from "./claude.js";
import { T2F5_DONE_SENTINEL } from "./background.js";

interface WorkerInput {
  prompt: string;
  connectorOptions: ClaudeConnectorOptions;
  streamPath: string;
  // stderrPath: where to write error messages on catch (design.md:648).
  stderrPath: string;
}

const { prompt, connectorOptions, streamPath } = workerData as WorkerInput;
const stream = createWriteStream(streamPath, { flags: "a", encoding: "utf8" });
// A WriteStream 'error' with no listener is an uncaught exception that kills the
// worker outside the run() catch path. Individual write failures already reject
// their writeLine promises (routed to the catch block); this listener only stops
// the duplicate crash path.
stream.on("error", () => { /* handled per-write via writeLine callbacks */ });

function writeLine(record: Record<string, unknown>): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(JSON.stringify(record) + "\n", (err) => (err ? reject(err) : resolve()));
  });
}

async function run(): Promise<void> {
  // STRATUM_TEST_WORKER=1: bypass real SDK and emit a synthetic response immediately.
  // Tests set this env var to avoid real API calls. The `.then()` continuation writes
  // the rc=0 sentinel after run() returns. Do not set this in production.
  if (process.env.STRATUM_TEST_WORKER === "1") {
    await writeLine({ type: "item.completed", item: { type: "agent_message", text: "stub response" } });
    await writeLine({ type: "turn.completed", usage: { input_tokens: 1, output_tokens: 1 } });
    return;
  }
  // STRATUM_TEST_WORKER=fail: simulate run() throwing before any sentinel is written.
  // The .catch() block writes the error message to workerData.stderrPath via appendFileSync,
  // then writes the rc=1 sentinel. Used by background-claude.test.ts (Step 7c) to drive
  // the stderr-plumbing assertion without mocking the Worker constructor.
  if (process.env.STRATUM_TEST_WORKER === "fail") {
    throw new Error("STRATUM_TEST_WORKER=fail: simulated run() failure");
  }
  // STRATUM_TEST_WORKER=stream-error: write one record, then destroy the stream with
  // an error mid-run. Exercises the stream 'error' listener (absorbs the emitted
  // error instead of crashing the worker) and the catch containment path: the
  // sentinel writeLine rejects, the catch writes stderr, and the parent exit
  // handler commits the rc=1 sentinel via writeSentinelIfAbsent.
  if (process.env.STRATUM_TEST_WORKER === "stream-error") {
    await writeLine({ type: "item.completed", item: { type: "agent_message", text: "before stream failure" } });
    stream.destroy(new Error("simulated stream failure"));
    return;
  }

  let inputTokens = 0;
  let outputTokens = 0;
    let cacheRead = 0;
    let cacheCreation = 0;
  let costUsd = 0;

  // Inject a query seam that intercepts SDK events and writes normalized JSONL
  // before yielding them to the connector's accumulator.
  const connector = new ClaudeConnector({
    ...connectorOptions,
    query: async function* ({ prompt: p, options }) {
      const { query: sdkQuery } = await import("@anthropic-ai/claude-agent-sdk");
      for await (const raw of sdkQuery({ prompt: p, options } as Parameters<typeof sdkQuery>[0])) {
        const r = raw as Record<string, unknown>;
        // Normalize assistant text blocks → item.completed records (D2)
        if (r.type === "assistant" && isRecord(r.message) && Array.isArray((r.message as Record<string, unknown>).content)) {
          for (const block of (r.message as Record<string, unknown>).content as unknown[]) {
            if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
              await writeLine({ type: "item.completed", item: { type: "agent_message", text: block.text } });
            }
          }
        }
        // Normalize result → turn.completed
        if (r.type === "result" && isRecord(r.usage)) {
          inputTokens += Number(r.usage.input_tokens) || 0;
          outputTokens += Number(r.usage.output_tokens) || 0;
          cacheRead += Number(r.usage.cache_read_input_tokens) || 0;
          cacheCreation += Number(r.usage.cache_creation_input_tokens) || 0;
          // Provider-reported price rides along so agent_poll can surface it
          // (Codex r2: background Claude cost was silently dropped).
          costUsd += Math.max(0, Number(r.total_cost_usd) || 0);
          await writeLine({ type: "turn.completed", usage: { input_tokens: inputTokens, output_tokens: outputTokens, cache_read_input_tokens: cacheRead, cache_creation_input_tokens: cacheCreation, total_cost_usd: costUsd } });
        }
        yield raw;
      }
    },
  });

  await connector.run(prompt);
}

run()
  .then(() => writeLine({ [T2F5_DONE_SENTINEL]: 0 }))
  .catch(async (err: unknown) => {
    // Write an error record then the sentinel. Both writes are best-effort:
    // if the stream is broken, the parent exit handler fires and writes the sentinel.
    const msg = (err instanceof Error ? err.message : String(err)).slice(0, 2000);
    // Stderr plumbing (design.md:648): write error message to .err file so the MCP server
    // can surface it via tailText(stderrPath). appendFileSync is used synchronously to avoid
    // timing races in the catch block. The try/catch wrapper ensures a filesystem failure
    // writing the .err file never prevents the sentinel write below.
    try { appendFileSync((workerData as WorkerInput).stderrPath, `${msg}\n`, "utf8"); } catch { /* best-effort */ }
    await writeLine({ type: "error", message: msg }).catch(() => { /* stream broken */ });
    await writeLine({ [T2F5_DONE_SENTINEL]: 1 }).catch(() => { /* stream broken */ });
  })
  .finally(() => { stream.end(); });

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
