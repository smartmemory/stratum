import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getEncoding } from "js-tiktoken";
import { parseDocument } from "yaml";
import { afterEach, describe, expect, it } from "vitest";
import { StratumEngine, type EngineConnector } from "../../src/engine/engine.js";
import { createEvaluator } from "../../src/eval/expr.js";
import { validateSpec } from "../../src/ir/validate.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function v1(name: string): Promise<unknown> {
  const bytes = await readFile(new URL(`../../parity/${name}.v1.yaml`, import.meta.url));
  const document = parseDocument(bytes.toString("utf8"), { prettyErrors: false });
  expect(document.errors).toEqual([]);
  return document.toJS();
}

async function engine() {
  const root = await mkdtemp(join(tmpdir(), "stratum-p6-parity-")); roots.push(root);
  const connector: EngineConnector = async ({ prompt }) => ({ output: { value: prompt } });
  return new StratumEngine({ stateRoot: root, evaluator: createEvaluator(), connector });
}

async function waitForTerminal(subject: StratumEngine, runId: string) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const poll = await subject.flowPoll(runId, 0);
    if (poll.status !== "running") return poll;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error("P6 fanout did not finish");
}

describe("P6 v1 reference parity flows", () => {
  it("parses authored YAML through the same thin boundary used by stratum validate", async () => {
    for (const name of ["linear-gate", "fanout", "subflow"]) expect(validateSpec(await v1(name)).ok).toBe(true);
  });

  it("keeps the five-task authoring specimen within 400 cl100k_base tokens from file bytes", async () => {
    const bytes = await readFile(new URL("../../parity/linear-gate.v1.yaml", import.meta.url));
    const encoding = getEncoding("cl100k_base");
    expect(encoding.encode(bytes.toString("utf8")).length).toBeLessThanOrEqual(400);
    const spec = parseDocument(bytes.toString("utf8"), { prettyErrors: false }).toJS() as { flows: { main: { steps: Array<Record<string, unknown>> } } };
    expect(spec.flows.main.steps.filter((step) => step.do !== undefined)).toHaveLength(5);
  });

  it("completes linear+gate with all ensures passing and an approve outcome", async () => {
    const subject = await engine();
    const planned = await subject.plan(await v1("linear-gate"), { name: "Ada" });
    if (planned.status !== "ready") throw new Error("expected first task");
    for (const step of ["prepare", "draft", "check"]) await subject.stepDone(planned.runId, step, { output: { value: step } });
    const gate = await subject.gateResolve(planned.runId, "review", "approve");
    expect(gate.status).toBe("ready");
    await subject.stepDone(planned.runId, "refine", { output: { value: "refine" } });
    const terminal = await subject.stepDone(planned.runId, "publish", { output: { value: "publish" } });
    // Every task step in the spec carries an ensure, so a completed terminal
    // status is the observed "all ensures passed" outcome.
    expect(terminal.status).toBe("completed");
  });

  it("completes fanout with all stage ensures passing", async () => {
    const subject = await engine();
    const planned = await subject.plan(await v1("fanout"), { items: ["a", "b"] });
    const terminal = await waitForTerminal(subject, planned.runId);
    expect(terminal.status).toBe("completed");
  });

  it("completes the subflow with all task ensures passing", async () => {
    const subject = await engine();
    const planned = await subject.plan(await v1("subflow"), { name: "Ada" });
    if (planned.status !== "ready") throw new Error("expected parent task");
    await subject.stepDone(planned.runId, "before", { output: { value: "before" } });
    await subject.stepDone(planned.runId, "wrap/child_one", { output: { value: "one" } });
    await subject.stepDone(planned.runId, "wrap/child_two", { output: { value: "two" } });
    const terminal = await subject.stepDone(planned.runId, "after", { output: { value: "after" } });
    expect(terminal.status).toBe("completed");
  });
});
