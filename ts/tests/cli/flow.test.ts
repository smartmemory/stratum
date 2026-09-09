import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../../src/cli/stratum.js";
import { projectStatus } from "../../src/cli/query_gate.js";
import type { ForegroundRunMeta } from "../../src/connectors/foreground_registry.js";
import { StratumEngine, type EngineConnector } from "../../src/engine/engine.js";
import { StateStore, type PersistedRun } from "../../src/engine/state.js";
import { createEvaluator } from "../../src/eval/expr.js";
import { tokenEchoingEngine, type TokenEchoingEngine } from "../helpers/token_echoing_engine.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function captureMain(argv: string[]) {
  let stdout = "";
  let stderr = "";
  const out = process.stdout.write;
  const err = process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => { stdout += String(chunk); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { stderr += String(chunk); return true; }) as typeof process.stderr.write;
  return main(argv).then((code) => ({ code, stdout, stderr })).finally(() => { process.stdout.write = out; process.stderr.write = err; });
}

async function withEnv<T>(values: Record<string, string | undefined>, action: () => Promise<T>): Promise<T> {
  const previous: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(values)) {
    previous[key] = process.env[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try { return await action(); } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

const simpleFlow = {
  version: 1,
  contracts: { Result: { value: "string" } },
  flows: { entry: "main", main: {
    input: { name: "string" },
    output: { from: "${build.output}", contract: "Result" },
    steps: [{ id: "build", do: "build ${input.name}", out: "Result" }],
  } },
};

async function planned(): Promise<{ root: string; runId: string; engine: TokenEchoingEngine; store: StateStore }> {
  const root = await mkdtemp(join(tmpdir(), "stratum-cli-flow-"));
  roots.push(root);
  const connector: EngineConnector = async ({ prompt }) => ({ output: { value: prompt } });
  const engine = tokenEchoingEngine(new StratumEngine({ stateRoot: root, evaluator: createEvaluator(), connector }));
  const start = await engine.plan(simpleFlow, { name: "Ada" });
  return { root, runId: start.runId, engine, store: new StateStore(root) };
}

/** A live registry entry with no pid: the sweep can never call it gone, so the teardown
 *  verdict is deterministic rather than timing-dependent. */
async function unresolvedEntry(registryRoot: string, flowRunId: string): Promise<void> {
  const id = randomUUID().replaceAll("-", "").slice(0, 12);
  await mkdir(join(registryRoot, id), { recursive: true });
  const record: ForegroundRunMeta = {
    runId: id, foreground: true, state: "starting", agent: "codex", cancellationId: randomUUID(),
    serverPid: process.pid, flow: { runId: flowRunId }, cwd: process.cwd(),
    createdAt: new Date().toISOString(), groups: [],
  };
  await writeFile(join(registryRoot, id, "meta.json"), JSON.stringify(record), "utf8");
}

describe("STRAT-FLOW-CANCEL-FG `stratum flow cancel`", () => {
  it("T-S03-6: exit 0 on a running flow, exit 0 again on the second cancel", async () => {
    const subject = await planned();
    const registryRoot = await mkdtemp(join(tmpdir(), "stratum-cli-flow-reg-"));
    roots.push(registryRoot);
    await withEnv({ STRATUM_STATE_ROOT: subject.root, STRATUM_AGENT_FG_ROOT: registryRoot }, async () => {
      const first = await captureMain(["flow", "cancel", subject.runId]);
      expect(first.code).toBe(0);
      expect(JSON.parse(first.stdout)).toEqual({
        _schema_version: "1", ok: true, flow_id: subject.runId, status: "cancelled",
        flowSettled: true, acknowledged: true,
        agents: { signalled: 0, reaped: 0, gone: 0, unreachable: 0, alreadySettled: 0, unresolved: 0, unsettled: 0, unreaped: 0 },
      });
      expect((await subject.store.load(subject.runId)).status).toBe("cancelled");

      // A second cancel is idempotent, NOT a conflict: exit 2 maps to {conflict:true} in
      // compose's mutation client and would make every repeated abort look like a failure.
      const second = await captureMain(["flow", "cancel", subject.runId]);
      expect(second.code).toBe(0);
      expect(JSON.parse(second.stdout)).toMatchObject({
        ok: true, status: "cancelled", flowSettled: true, acknowledged: true, detail: "already_cancelled",
      });
    });
  });

  it("T-S03-6: an already-completed flow is a success, and an unknown flow id is exit 2", async () => {
    const subject = await planned();
    const registryRoot = await mkdtemp(join(tmpdir(), "stratum-cli-flow-reg-"));
    roots.push(registryRoot);
    const ready = await subject.engine.plan(simpleFlow, { name: "Ada" });
    await subject.engine.stepDone(ready.runId, "build", { output: { value: "v" } });
    await withEnv({ STRATUM_STATE_ROOT: subject.root, STRATUM_AGENT_FG_ROOT: registryRoot }, async () => {
      const done = await captureMain(["flow", "cancel", ready.runId]);
      expect(done.code).toBe(0);
      expect(JSON.parse(done.stdout)).toMatchObject({
        ok: true, status: "completed", flowSettled: false, acknowledged: false, detail: "already_completed",
      });

      const missing = await captureMain(["flow", "cancel", "run-does-not-exist"]);
      expect(missing.code).toBe(2);
      expect(JSON.parse(missing.stdout)).toEqual({
        _schema_version: "1", conflict: true, flow_id: "run-does-not-exist", detail: "flow_not_found",
      });
    });
  });

  it("T-S03-6: an unresolved teardown is exit 1 with the structured envelope", async () => {
    const subject = await planned();
    const registryRoot = await mkdtemp(join(tmpdir(), "stratum-cli-flow-reg-"));
    roots.push(registryRoot);
    await unresolvedEntry(registryRoot, subject.runId);
    await withEnv({
      STRATUM_STATE_ROOT: subject.root, STRATUM_AGENT_FG_ROOT: registryRoot, STRATUM_CANCEL_TIMEOUT_MS: "60",
    }, async () => {
      const failed = await captureMain(["flow", "cancel", subject.runId]);
      expect(failed.code).toBe(1);
      const printed = JSON.parse(failed.stdout) as Record<string, unknown>;
      expect(printed).toMatchObject({
        _schema_version: "1", ok: false, error: "CANCELLATION_TEARDOWN_TIMEOUT", flow_id: subject.runId,
        // The caller must be able to see the FLOW is settled even though an agent was not
        // confirmed dead.
        status: "cancelled", flowSettled: true,
      });
      expect(printed.agents).toMatchObject({ unresolved: 1, unsettled: 1 });
      expect((await subject.store.load(subject.runId)).status).toBe("cancelled");
    });
  });

  it("T-S03-6: usage is exit 2", async () => {
    expect((await captureMain(["flow"])).code).toBe(2);
    expect((await captureMain(["flow", "cancel"])).code).toBe(2);
    expect((await captureMain(["flow", "abort", "x"])).code).toBe(2);
  });

  it("T-S03-8: a cancelled run projects as `cancelled`, not `running` or `killed`", async () => {
    const subject = await planned();
    const registryRoot = await mkdtemp(join(tmpdir(), "stratum-cli-flow-reg-"));
    roots.push(registryRoot);
    await withEnv({ STRATUM_STATE_ROOT: subject.root, STRATUM_AGENT_FG_ROOT: registryRoot }, async () => {
      expect((await captureMain(["flow", "cancel", subject.runId])).code).toBe(0);
      const run = await subject.store.load(subject.runId);
      expect(projectStatus(run as PersistedRun)).toBe("cancelled");
      const detail = await captureMain(["query", "flow", subject.runId]);
      expect(detail.code).toBe(0);
      expect(JSON.parse(detail.stdout)).toMatchObject({ status: "cancelled", terminal_status: "cancelled" });
    });
  });
});
