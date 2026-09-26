import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { StratumEngine, type EngineConnector } from "../../src/engine/engine.js";
import { createEvaluator } from "../../src/eval/expr.js";

describe("devin engine fan-out (fake connector only)", () => {
  it.each(["worktree", "none"] as const)("dispatches devin with the sandbox for isolation %s", async (isolation) => {
    const repo = mkdtempSync(join(tmpdir(), "stratum-devin-flow-repo-"));
    const stateRoot = mkdtempSync(join(tmpdir(), "stratum-devin-flow-state-"));
    const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" });
    const calls: Parameters<EngineConnector>[0][] = [];
    const connector: EngineConnector = async (request) => {
      calls.push(request);
      // Only the write-enabled row simulates an edit. No agent process is spawned.
      if (request.sandbox === "workspace-write") writeFileSync(join(request.cwd!, "target.txt"), "edited\n");
      return { output: "done" };
    };
    const engine = new StratumEngine({ stateRoot, evaluator: createEvaluator(), connector });
    let runId: string | undefined;
    try {
      git("init", "-q");
      git("config", "user.name", "Test");
      git("config", "user.email", "test@example.com");
      writeFileSync(join(repo, "target.txt"), "base\n");
      git("add", "target.txt"); git("commit", "-qm", "base");
      const planned = await engine.plan({
        version: 1, contracts: { Result: { value: "string" } },
        flows: { entry: "main", main: {
          input: { items: "string[]" }, output: { from: "${finish.output}", contract: "Result" },
          steps: [
            { id: "fan", fanout: { over: "${input.items}", concurrency: 1, isolation,
              require: "all", merge: "sequential", dispatch: "engine", steps: [{ do: "edit ${item}", agent: "devin" }] } },
            { id: "finish", after: ["fan"], set: { value: '"done"' }, out: "Result" },
          ],
        } },
      }, { items: ["target.txt"] }, { workspaceRoot: repo });
      runId = planned.runId;
      const deadline = Date.now() + 10_000;
      let poll = await engine.flowPoll(runId, 0);
      while (poll.status === "running" && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 20));
        poll = await engine.flowPoll(runId, 0);
      }
      expect(poll).toMatchObject({ status: "completed" });
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ agent: "devin", sandbox: isolation === "worktree" ? "workspace-write" : "read-only" });
      if (isolation === "worktree") expect(calls[0]!.cwd).not.toBe(repo);
      else expect(calls[0]!.cwd).toBe(repo);
      expect(readFileSync(join(repo, "target.txt"), "utf8")).toBe(isolation === "worktree" ? "edited\n" : "base\n");
      expect(git("worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
    } finally {
      if (runId) await engine.flowCancel(runId);
      rmSync(repo, { recursive: true, force: true });
      rmSync(stateRoot, { recursive: true, force: true });
    }
  }, 20_000);
});
