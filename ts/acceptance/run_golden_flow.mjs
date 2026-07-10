#!/usr/bin/env node
// STRAT-TS-PORT feature acceptance: live golden flow on the real binaries.
// spec -> codex task -> judged ensure -> gate -> engine-owned fanout -> audit.
// Drives the shipped stdio MCP server (src/mcp/bin.mjs) over a real SDK client;
// the codex task and both fanout items are real `codex exec` dispatches, and the
// judged ensure is a real model call (codex-OAuth judge backend when no
// OPENAI_API_KEY is present — see judgeBackend in src/mcp/server.ts).
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { parseDocument } from "yaml";

const here = new URL(".", import.meta.url);

function fail(message, payload) {
  console.error(`\nGOLDEN FLOW FAILED: ${message}\n${JSON.stringify(payload, null, 2)}`);
  process.exit(1);
}

const stateRoot = await mkdtemp(join(tmpdir(), "stratum-golden-state-"));
const workdir = await mkdtemp(join(tmpdir(), "stratum-golden-work-"));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [fileURLToPath(new URL("../src/mcp/bin.mjs", here))],
  // Force the codex-OAuth judge AND strip any platform key from the server so
  // the passing run proves the judge needs no OPENAI_API_KEY — not merely that
  // the codex backend label was selected.
  env: (() => { const env = { ...process.env, STRATUM_STATE_ROOT: stateRoot, STRATUM_JUDGE_BACKEND: "codex" }; delete env.OPENAI_API_KEY; return env; })(),
  stderr: "inherit",
});
const client = new Client({ name: "golden-flow-driver", version: "0.0.1" });
await client.connect(transport);

async function call(name, args) {
  const response = await client.callTool({ name, arguments: args });
  if (response.isError) fail(`${name} returned an MCP error`, response.content);
  const payload = response.structuredContent ?? JSON.parse(response.content[0].text);
  console.log(`== ${name} -> ${JSON.stringify(payload).slice(0, 300)}`);
  return payload;
}

const spec = parseDocument(await readFile(new URL("golden-flow.v1.yaml", here), "utf8"), { prettyErrors: false }).toJS();
const validated = await call("stratum_validate", { spec });
if (validated.status !== "valid") fail("spec did not validate", validated);

const input = { topic: "the moon", items: ["banana", "fir tree"] };
let state = await call("stratum_plan", { spec, input });
const runId = state.runId;
if (state.status !== "ready" || state.ready[0]?.id !== "gather") fail("expected gather ready", state);

// Client-driven codex task with engine-owned retry feedback, capped by spec attempts.
for (let attempt = 1; attempt <= 3; attempt += 1) {
  const ready = state.ready[0];
  let prompt = `${ready.do}\n\nRespond with ONLY a minified JSON object {"value": string}. No prose, no code fences.`;
  if (ready.previousFailure) prompt += `\n\nPrevious attempt failed: ${ready.previousFailure.reason}`;
  const dispatched = await call("stratum_agent_run", {
    agent: "codex", prompt, cwd: workdir, model: "gpt-5.3-codex-spark", sandboxMode: "read-only",
  });
  if (dispatched.status !== "complete") fail("codex task did not complete", dispatched);
  let output;
  try {
    output = JSON.parse(dispatched.text.trim().replace(/^```(?:json)?\n?|\n?```$/g, ""));
  } catch {
    fail("codex task did not return parseable JSON", dispatched);
  }
  state = await call("stratum_step_done", { runId, stepId: "gather", result: { output } });
  if (state.status === "ready" && state.ready[0]?.id === "gather") continue; // judged/expr ensure failed; retry with feedback
  break;
}
if (state.status === "failed" || state.status === "budget_exhausted") fail("gather did not pass its ensures", state);

// Human gate: approve routes to the fanout.
state = await call("stratum_gate_resolve", { runId, stepId: "review", decision: "approve" });

// Engine-owned fanout: the ENGINE dispatches both items via real codex exec. Poll the spine.
let cursor = 0;
const events = [];
const deadline = Date.now() + 15 * 60 * 1000;
while (!["completed", "failed", "budget_exhausted"].includes(state.status)) {
  if (Date.now() > deadline) fail("fanout did not reach a terminal state in 15 minutes", state);
  await new Promise((resolve) => setTimeout(resolve, 2000));
  state = await call("stratum_flow_poll", { runId, cursor });
  events.push(...state.events);
  cursor = state.nextCursor;
}
if (state.status !== "completed") fail("flow did not complete", state);

const audit = await call("stratum_audit", { runId });
if (audit.status !== "completed") fail("audit disagrees on terminal status", audit);
const kinds = new Set(audit.events.map((event) => event.type));
// Prove the behaviors the acceptance item names, not just event presence.
const judgedPass = audit.events.filter((event) => event.type === "judged" && event.stepId === "gather" && event.detail?.holds === true);
if (judgedPass.length === 0) fail("no passing judged verdict on gather", audit.events.filter((event) => event.type === "judged"));
const approvals = audit.events.filter((event) => event.type === "gate_resolved" && event.detail?.decision === "approve" && event.detail?.target === "fan");
if (approvals.length === 0) fail("gate was not approved into the fanout", audit.events.filter((event) => event.type === "gate_resolved"));
const expectedIndexes = input.items.map((_, index) => index);
const exactlyExpected = (set) => set.size === expectedIndexes.length && expectedIndexes.every((index) => set.has(index));
const dispatchedItems = new Set(audit.events.filter((event) => event.type === "fanout_item_dispatched").map((event) => event.detail?.itemIndex));
if (!exactlyExpected(dispatchedItems)) fail(`engine dispatched fanout items ${JSON.stringify([...dispatchedItems])}, expected exactly ${JSON.stringify(expectedIndexes)}`, [...dispatchedItems]);
// Exactly one success per item. Repeated dispatches are legal (engine retries
// carry attempt numbers), but a duplicated success would be an engine defect.
const successCounts = new Map();
for (const event of audit.events) {
  if (event.type !== "fanout_attempt_result" || event.detail?.success !== true) continue;
  successCounts.set(event.detail.itemIndex, (successCounts.get(event.detail.itemIndex) ?? 0) + 1);
}
if (successCounts.size !== expectedIndexes.length || !expectedIndexes.every((index) => successCounts.get(index) === 1)) {
  fail(`fanout success counts ${JSON.stringify([...successCounts])} — expected exactly one success per item ${JSON.stringify(expectedIndexes)}`, [...successCounts]);
}

const report = {
  runId,
  judgeBackend: "codex",
  terminal: state.status,
  output: audit.output,
  flowSpent: audit.flowSpent,
  eventTypes: [...kinds],
  judged: audit.events.filter((event) => event.type === "judged"),
  gate: audit.events.filter((event) => event.type === "gate_resolved"),
  fanoutEvents: audit.events.filter((event) => String(event.type).includes("fanout")).length,
  stateRoot,
};
const reportPath = fileURLToPath(new URL("golden-flow-result.json", here));
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);
console.log(`\nGOLDEN FLOW PASSED — report written to ${reportPath}`);
await client.close();
process.exit(0);
