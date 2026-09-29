import { testModels } from "../helpers/models.js";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENT_TYPES, type AgentType } from "../../src/connectors/base.js";
import { DevinConnector } from "../../src/connectors/devin.js";
import { mcpSurface } from "../../src/mcp/contracts.js";
import { startBackgroundRun } from "../../src/connectors/background.js";
import type { QueryFunction } from "../../src/connectors/claude.js";
import type { SpawnProcess } from "../../src/connectors/codex.js";
import { runAgent, validateAgentSettings, type AgentRunOptions } from "../../src/connectors/runner.js";

/**
 * STRAT-AGENT-DEVIN-1 D1 equality check: every parameter stratum_agent_run
 * accepts for codex is accepted for devin or rejected with a named devin
 * error — never silently dropped through an `else` that meant claude, and
 * never blocked by a codex-only check that forgot the third agent. The table
 * is driven from AGENT_TYPES so a fourth agent arrives as a test failure, not
 * an unhandled row.
 */

// Valid dispatches reach the credentials gate after validation in both modes.
const NOT_LOGGED_IN = /devin is not logged in \(run `devin auth`\)/;

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "stratum-agent-equality-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const stubClaudeQuery: QueryFunction = async function* () {
  yield { type: "result", subtype: "success", result: "stub ok", duration_ms: 0, total_cost_usd: 0 };
};

function fakeCodexSpawn(): SpawnProcess {
  return vi.fn<SpawnProcess>(() => {
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn(() => true);
    queueMicrotask(() => {
      (child.stdout as PassThrough).write(
        JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "stub ok" } }) + "\n",
      );
      (child.stdout as PassThrough).end();
      (child.stderr as PassThrough).end();
      child.emit("close", 0, null);
    });
    return child;
  });
}

describe("AGENT_TYPES is the one dispatchable list (D1)", () => {
  it("contains exactly claude, codex, devin", () => {
    expect([...AGENT_TYPES]).toEqual(["claude", "codex", "devin"]);
  });

  it.each(AGENT_TYPES)("runAgent reaches a real branch for agent=%s — no silent fallthrough", async (agent) => {
    const root = await temporaryRoot();
    const env = { STRATUM_CONFIG_FILE: join(root, "missing-user.toml"), HOME: root, PATH: "/usr/bin:/bin" };
    const attempt = runAgent(
      { agent, prompt: "p", cwd: root, registryRoot: root, env },
      { claudeQuery: stubClaudeQuery, codexSpawn: fakeCodexSpawn() },
    );
    if (agent === "devin") {
      // S1b validates devin and stops at the real connector's credentials gate.
      await expect(attempt).rejects.toThrow(NOT_LOGGED_IN);
    } else {
      await expect(attempt).resolves.toMatchObject({ text: "stub ok" });
    }
  });

  it.each(AGENT_TYPES)("validateAgentSettings has a named branch for agent=%s", (agent) => {
    expect(() => validateAgentSettings({ agent })).not.toThrow();
  });
});

describe("unknown agent errors name the whole set at every layer (D1)", () => {
  const badAgent = "gemini" as AgentType;

  it("runAgent", async () => {
    await expect(runAgent({ agent: badAgent, prompt: "p", cwd: "/tmp" }))
      .rejects.toThrow('Unknown agent "gemini"; must be one of "claude", "codex", "devin"');
  });

  it("startBackgroundRun", async () => {
    const root = await temporaryRoot();
    await expect(startBackgroundRun({ agent: badAgent, prompt: "p", cwd: root, registryRoot: root }))
      .rejects.toThrow('Unknown agent "gemini"; must be one of "claude", "codex", "devin"');
  });
});

describe("devin parameter equality — every codex knob is honoured or named-rejected (D1)", () => {
  // Accepted rows must reach the connector with their values intact.
  // A RegExp = the named devin rejection the parameter must produce.
  const table: Array<{ name: string; options: Partial<AgentRunOptions>; expected: "accepted" | RegExp }> = [
    { name: "model (full id)", options: { model: testModels.devinMedium }, expected: "accepted" },
    { name: "model (family + effort)", options: { model: testModels.devinFamily, effort: "max" }, expected: "accepted" },
    { name: "model (slash form)", options: { model: `${testModels.devinFamily}/max` }, expected: "accepted" },
    { name: "effort", options: { effort: "medium" }, expected: "accepted" },
    { name: "sandboxMode read-only", options: { sandboxMode: "read-only" }, expected: "accepted" },
    { name: "sandboxMode workspace-write", options: { sandboxMode: "workspace-write" }, expected: "accepted" },
    { name: "sandboxMode danger-full-access + opt-in", options: { sandboxMode: "danger-full-access", env: { STRATUM_DEVIN_ALLOW_FULL_ACCESS: "1" } }, expected: "accepted" },
    { name: "networkAccess true", options: { networkAccess: true }, expected: "accepted" },
    { name: "writableRoots", options: { writableRoots: ["/tmp"] }, expected: "accepted" },
    { name: "ownProcessGroup", options: { ownProcessGroup: true }, expected: "accepted" },
    { name: "env", options: { env: { STRATUM_CONFIG_FILE: "/nonexistent" } }, expected: "accepted" },
    { name: "onSpawn", options: { onSpawn: () => undefined }, expected: "accepted" },
    { name: "networkAccess:false is named-rejected (D3)", options: { networkAccess: false },
      expected: /devin cannot run without network; networkAccess:false is not enforceable for devin/ },
    { name: "approvalPolicy is named-rejected (D11)", options: { approvalPolicy: "on-request" },
      expected: /Codex approvalPolicy is not supported by devin/ },
    { name: "thinking is named-rejected", options: { thinking: { type: "adaptive" } },
      expected: /Devin does not support Claude thinking\/tool filters/ },
    { name: "allowedTools is named-rejected", options: { allowedTools: ["Read"] },
      expected: /Devin does not support Claude thinking\/tool filters/ },
    { name: "disallowedTools is named-rejected", options: { disallowedTools: ["Bash"] },
      expected: /Devin does not support Claude thinking\/tool filters/ },
    { name: "unknown model is named-rejected (D6)", options: { model: "typo" },
      expected: /Unknown devin model "typo"; accepted models:/ },
    { name: "unknown effort is named-rejected (D6)", options: { effort: "bogus" },
      expected: /Unknown devin effort "bogus"/ },
    { name: "danger-full-access without opt-in is named-rejected", options: { sandboxMode: "danger-full-access" },
      expected: /STRATUM_DEVIN_ALLOW_FULL_ACCESS/ },
  ];

  it("covers every parameter in the MCP validator request schema", async () => {
    const keys = Object.keys((await mcpSurface()).tools.stratum_agent_run!.request).map(key => key.replace(/\?$/, ""));
    // Lifecycle fields are exercised by tests/mcp/agent-run and cancellation;
    // all provider options must have an explicit row in this table.
    const lifecycle = ["cancellationId", "flow", "peerLabel"];
    const covered = new Set(["agent", "prompt", "cwd", "background", ...lifecycle,
      ...table.flatMap(row => Object.keys(row.options))]);
    expect(keys.filter(key => !covered.has(key))).toEqual([]);
  });

  it.each(table)("$name", async ({ options, expected }) => {
    const root = await temporaryRoot();
    const { env: optionEnv, ...rest } = options;
    const env = { STRATUM_CONFIG_FILE: join(root, "missing-user.toml"), HOME: root, PATH: "/usr/bin:/bin", ...(optionEnv ?? {}) };
    if (expected !== "accepted") {
      await expect(runAgent({ agent: "devin", prompt: "p", cwd: root, registryRoot: root, env, ...rest })).rejects.toThrow(expected);
      return;
    }
    const delivered: Record<string, unknown>[] = [];
    const run = vi.spyOn(DevinConnector.prototype, "run").mockImplementation(async function (this: DevinConnector, prompt) {
      // The real constructor has applied runAgent's forwarding and config.
      delivered.push({ ...(this as unknown as Record<string, unknown>), prompt });
      return { text: "delivered", usage: { tokens: 0, ms: 0, usd: 0 }, telemetry: { durationMs: 0, model: testModels.devinDefault } };
    });
    try {
      await expect(runAgent({ agent: "devin", prompt: "p", cwd: root, registryRoot: root, env, ...rest })).resolves.toMatchObject({ text: "delivered" });
      expect(delivered).toHaveLength(1);
      const actual = delivered[0]!;
      expect(actual).toMatchObject({ cwd: root, prompt: "p" });
      for (const [key, value] of Object.entries(rest)) {
        if (key === "model" || key === "effort") continue;
        if (key === "networkAccess") expect(actual.sandboxAudit).toMatchObject({ policy: { networkAccess: value } });
        else expect(actual[key], key).toEqual(value);
      }
      const models: Record<string, string> = { [testModels.devinMedium]: testModels.devinMedium, [testModels.devinFamily]: testModels.devinMax, [`${testModels.devinFamily}/max`]: testModels.devinMax };
      expect(actual.model).toBe(options.model ? models[options.model] : options.effort ? `${testModels.devinFamily}-${options.effort}` : testModels.devinDefault);
      expect(actual.env).toMatchObject(env);
    } finally { run.mockRestore(); }
  });

  it.each(table)("$name — validateAgentSettings layer agrees", ({ options, expected }) => {
    // Options that pass validation reach the connector; rejected ones fail
    // with the same devin-named error before any spawn.
    const check = () => validateAgentSettings({ agent: "devin", ...options });
    if (expected === "accepted") expect(check).not.toThrow();
    else if (/Unknown sandboxMode|ALLOW_FULL_ACCESS/.test(expected.source)) {
      // sandboxMode discriminant and the full-access env grant are enforced
      // outside validateAgentSettings (in runAgent / the connector guard).
    } else expect(check).toThrow(expected);
  });

  it("background dispatches reach the credentials gate without writing a run dir", async () => {
    const root = await temporaryRoot();
    await expect(runAgent({
      agent: "devin", prompt: "p", cwd: root, background: true,
      registryRoot: root, peerLabel: "review",
      env: { STRATUM_CONFIG_FILE: join(root, "missing-user.toml"), HOME: root, PATH: "/usr/bin:/bin" },
    })).rejects.toThrow(NOT_LOGGED_IN);
    expect(await readdir(root)).toEqual([]);
  });
});
