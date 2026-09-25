import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StratumEngine } from "../../src/engine/engine.js";
import { createEvaluator } from "../../src/eval/expr.js";
import { harvest } from "../../src/learn/harvest.js";
import { classify } from "../../src/learn/classify.js";

describe("harvest engine-produced fanout failures", () => {
  it.each(["all", "any"])("preserves item/stage recovery and deduplicates require %s", async (require) => {
    const root = await mkdtemp(join(tmpdir(), "stratum-harvest-fanout-"));
    try {
      const calls = new Map<string, number>();
      const engine = new StratumEngine({ stateRoot: root, evaluator: createEvaluator(),
        connector: async ({ prompt }) => {
          const call = (calls.get(prompt) ?? 0) + 1;
          calls.set(prompt, call);
          const valid = prompt === "first b" || (prompt !== "second b" && call > 1);
          return { output: { value: valid ? "ok" : 42 } };
        },
      });
      const planned = await engine.plan({ version: 1, contracts: { Result: { value: "string" } },
        flows: { entry: "main", main: { input: { items: "string[]" },
          output: { from: "${fan.output[1]}", contract: "Result" },
          steps: [{ id: "fan", attempts: 2, fanout: {
            over: "${input.items}", concurrency: 1, isolation: "none", require, merge: "sequential",
            steps: [{ do: "first ${item}", out: "Result" }, { do: "second ${item}", out: "Result" }],
          } }],
        } },
      }, { items: ["b", "a"] });
      await expect.poll(async () => (await engine.audit(planned.runId)).status)
        .toBe(require === "all" ? "failed" : "completed");
      // Only the engine writes the harvested JSON; no synthetic event producer.
      const persisted = JSON.parse(await readFile(join(root, `${planned.runId}.json`), "utf8"));
      const failures = (type: string) => persisted.events.filter(
        (event: { type: string; detail: { failure?: unknown } }) => event.type === type && event.detail.failure);
      expect(failures("fanout_attempt_result")).toHaveLength(4);
      expect(failures("result")).toHaveLength(require === "all" ? 1 : 0);
      const result = await harvest(root);
      expect(result.skipped).toBe(0);
      expect(result.droppedEvents).toBe(0);
      expect(result.records).toHaveLength(4);
      expect(result.records.map(({ stepId, itemIndex, stage, attempt, recovered }) =>
        ({ stepId, itemIndex, stage, attempt, recovered }))).toEqual([
        { stepId: "fan", itemIndex: 0, stage: 1, attempt: 2, recovered: false },
        { stepId: "fan", itemIndex: 0, stage: 1, attempt: 3, recovered: false },
        { stepId: "fan", itemIndex: 1, stage: 0, attempt: 1, recovered: true },
        { stepId: "fan", itemIndex: 1, stage: 1, attempt: 3, recovered: true },
      ]);
      for (const record of result.records) {
        expect(record.runId).toBe(planned.runId);
        expect(record.shape).toBe("schema");
        expect(record.reason).toContain("invalid_type");
      }
      const cluster = classify(result.records).find((entry) => entry.groupingKey === "step-agnostic")!;
      expect(cluster.recurrence).toEqual({ records: 4, distinctRuns: 1, distinctPairs: 1 });
      expect(cluster.evidence).toHaveLength(4);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
