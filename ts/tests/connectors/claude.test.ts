import { testModels } from "../helpers/models.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeConnector, type QueryFunction } from "../../src/connectors/claude.js";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { StratumEngine } from "../../src/engine/engine.js";
import { StateStore } from "../../src/engine/state.js";
import { spineSpent } from "../../src/engine/receipts.js";
import { createEvaluator } from "../../src/eval/expr.js";

const osState = vi.hoisted(() => ({ homedirFails: false }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => { if (osState.homedirFails) throw new Error("no home directory"); return actual.homedir(); } };
});

let indexRoot: string;
beforeEach(async () => {
  indexRoot = await mkdtemp(join(tmpdir(), "test_detach_name_2-"));
  vi.stubEnv("DETACH_CLAUDE_INDEX_DIR", indexRoot);
});
afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await rm(indexRoot, { recursive: true, force: true });
});

const callerId = "01234567-89ab-4cde-8fab-0123456789ab";
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

describe("Claude session index", () => {
  it("records the launch time in detach_claude's local format", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(2026, 0, 2, 3, 4, 5));
    await new ClaudeConnector({ sessionId: callerId, query: () => messages() }).run("test");
    const record = JSON.parse(await readFile(join(indexRoot, `${callerId}.json`), "utf8"));
    expect(record.started).toBe("2026-01-02 03:04:05");
  });

  it.each([
    { name: "generated", sessionId: undefined, indexLabel: undefined },
    { name: "caller-supplied", sessionId: callerId, indexLabel: "stratum-author" },
  ])("dispatches the $name id and indexes it before query", async ({ sessionId, indexLabel }) => {
    const events: Array<{ kind: string; metadata: Record<string, unknown> }> = [];
    let dispatchedId: string | undefined;
    const query: QueryFunction = async function* ({ options }) {
      dispatchedId = options?.sessionId as string;
      expect(dispatchedId).toMatch(uuid);
      if (sessionId !== undefined) expect(dispatchedId).toBe(sessionId);
      const index = JSON.parse(await readFile(join(indexRoot, `${dispatchedId}.json`), "utf8"));
      expect(index).toEqual({
        session_id: dispatchedId, label: indexLabel ?? `stratum-claude-${dispatchedId.slice(0, 8)}`,
        started: expect.stringMatching(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/),
        cwd: "/work", model: "claude-test", source: "stratum",
      });
      expect(options).not.toHaveProperty("resume");
      expect(options).not.toHaveProperty("continue");
      yield { type: "result", subtype: "success", result: "indexed" };
    };
    await expect(new ClaudeConnector({
      ...(sessionId !== undefined ? { sessionId } : {}),
      ...(indexLabel !== undefined ? { indexLabel } : {}),
      cwd: "/work", model: "claude-test", query, onEvent: event => { events.push(event); },
    }).run("test")).resolves.toMatchObject({ text: "indexed" });
    expect(events.find(event => event.kind === "agent_started")?.metadata.session_id).toBe(dispatchedId);
    expect(await readdir(indexRoot)).toEqual([`${dispatchedId}.json`]);
  });

  it.each([
    { name: "malformed id", options: { sessionId: "not-a-uuid" } },
    { name: "path traversal id", options: { sessionId: "../escape" } },
    { name: "empty id", options: { sessionId: "" } },
    { name: "empty label", options: { indexLabel: "" } },
    { name: "blank label", options: { indexLabel: "  " } },
  ])("refuses $name with a typed error before dispatch or indexing", async ({ options }) => {
    const query = vi.fn<QueryFunction>(() => messages());
    await expect(new ClaudeConnector({ ...options, query }).run("test")).rejects.toBeInstanceOf(TypeError);
    expect(query).not.toHaveBeenCalled();
    expect(await readdir(indexRoot)).toEqual([]);
  });

  it.each([
    { name: "connector env override", override: "custom", expected: "custom" },
    { name: "default under connector HOME", override: undefined, expected: ".claude/session-state/detach-claude" },
    { name: "empty override falls back like costlib", override: "", expected: ".claude/session-state/detach-claude" },
  ])("resolves $name without merging the ambient index override", async ({ override, expected }) => {
    const env = { HOME: indexRoot, ...(override !== undefined ? { DETACH_CLAUDE_INDEX_DIR: override ? join(indexRoot, override) : "" } : {}) };
    await new ClaudeConnector({ sessionId: callerId, env, query: () => messages() }).run("test");
    const record = JSON.parse(await readFile(join(indexRoot, expected, `${callerId}.json`), "utf8"));
    expect(record).toMatchObject({ session_id: callerId, label: "stratum-claude-01234567", source: "stratum" });
    expect(await readdir(indexRoot)).not.toContain(`${callerId}.json`);
  });

  // One row per step of the index write that can throw: path resolve, mkdir, record build, write.
  it.each([
    { stage: "resolve", expectedPath: "unresolved", error: /no home directory/ },
    { stage: "mkdir", expectedPath: join("blocked", "index", `${callerId}.json`), error: /ENOTDIR/ },
    { stage: "build", expectedPath: `${callerId}.json`, error: /BigInt/ },
    { stage: "write", expectedPath: `${callerId}.json`, error: /EISDIR/ },
  ])("warns once and completes after index $stage failure", async ({ stage, expectedPath, error }) => {
    let env: NodeJS.ProcessEnv = { DETACH_CLAUDE_INDEX_DIR: indexRoot };
    let cwd: string | undefined;
    if (stage === "resolve") { env = {}; osState.homedirFails = true; }
    if (stage === "mkdir") {
      await writeFile(join(indexRoot, "blocked"), "not a directory");
      env = { DETACH_CLAUDE_INDEX_DIR: join(indexRoot, "blocked", "index") };
    }
    if (stage === "build") cwd = 1n as unknown as string;
    if (stage === "write") await mkdir(join(indexRoot, `${callerId}.json`));
    const warning = vi.spyOn(console, "error").mockImplementation(() => {});
    const query = vi.fn<QueryFunction>(() => messages());
    const events: Array<{ kind: string; metadata: Record<string, unknown> }> = [];
    try {
      await expect(new ClaudeConnector({
        sessionId: callerId, indexLabel: "stratum-lost", env, query, ...(cwd !== undefined ? { cwd } : {}),
        onEvent: event => { events.push(event); },
      }).run("test")).resolves.toMatchObject({ text: "echo ok" });
    } finally {
      osState.homedirFails = false;
    }
    expect(query).toHaveBeenCalledOnce();
    expect(warning).toHaveBeenCalledOnce();
    const text = warning.mock.calls[0]![0] as string;
    expect(text).toContain("WARNING stratum: Claude session index write failed at ");
    expect(text).toContain(expectedPath);
    expect(text).toMatch(error);
    expect(text).toContain("stratum-lost");
    expect(events.filter(event => event.kind === "agent_relay")).toEqual([
      { kind: "agent_relay", metadata: { text: "partial", role: "assistant" } },
    ]);
  });

  it("keeps distinct files when a label is reused", async () => {
    const connector = new ClaudeConnector({ indexLabel: "stratum-reused", query: () => messages() });
    await connector.run("one");
    await connector.run("two");
    const files = await readdir(indexRoot);
    expect(files).toHaveLength(2);
    for (const file of files) expect(JSON.parse(await readFile(join(indexRoot, file), "utf8")).label).toBe("stratum-reused");
  });
});

async function* messages() {
  yield { type: "system", subtype: "init", model: `${testModels.claudeDefault}-20260701` };
  yield { type: "assistant", message: { content: [{ type: "text", text: "partial" }] } };
  yield {
    type: "result", subtype: "success", is_error: false, result: "echo ok", duration_ms: 42, total_cost_usd: 0.01,
    usage: { input_tokens: 3, output_tokens: 4, cost_usd: 0.01, cache_creation_input_tokens: 2, cache_read_input_tokens: 1, dispatches: 50 },
  };
}

describe("ClaudeConnector", () => {
  describe.each(["success", "terminal error", "SDK throw"])("%s effort telemetry", (outcome) => {
    it.each(["low", "max", undefined])("reports only the dispatched effort (%s)", async (effort) => {
      const events: Array<{ kind: string; metadata: Record<string, unknown> }> = [];
      const query = vi.fn<QueryFunction>(async function* () {
        if (outcome === "SDK throw") throw new Error("SDK failed");
        yield {
          type: "result", subtype: outcome === "success" ? "success" : "error_during_execution",
          result: "done", errors: ["query failed"], usage: { input_tokens: 3, output_tokens: 4 },
        };
      });
      const run = new ClaudeConnector({
        ...(effort !== undefined ? { effort } : {}), query, onEvent: event => { events.push(event); },
      }).run("test");
      const result = outcome === "success" ? await run : await run.catch(error => error);
      if (outcome !== "success") expect(result).toBeInstanceOf(Error);
      const sdkOptions = query.mock.calls[0]![0].options!;
      const identities = [sdkOptions, result.telemetry, ...events.filter(event => event.kind === "step_usage").map(event => event.metadata)];
      expect(events.filter(event => event.kind === "step_usage")).toHaveLength(outcome === "SDK throw" ? 0 : 1);
      for (const identity of identities) {
        if (effort === undefined) expect(identity).not.toHaveProperty("effort");
        else expect(identity).toHaveProperty("effort", effort);
      }
    });
  });

  it("omits effort when an event handler fails before SDK dispatch", async () => {
    const query = vi.fn<QueryFunction>(() => messages());
    const failure = await new ClaudeConnector({
      effort: "high", query, onEvent: () => { throw new Error("event failed"); },
    }).run("test").catch(error => error);
    expect(failure).toBeInstanceOf(Error);
    expect(query).not.toHaveBeenCalled();
    expect(failure.telemetry).not.toHaveProperty("effort");
  });

  async function capturedTools(options: ConstructorParameters<typeof ClaudeConnector>[0]): Promise<unknown> {
    let tools: unknown;
    const query: QueryFunction = async function* ({ options: sdkOptions }) {
      tools = sdkOptions?.tools;
      yield { type: "result", subtype: "success", result: "ok" };
    };
    await new ClaudeConnector({ ...options, query }).run("test");
    return tools;
  }

  it("adds ToolSearch to an explicit allowedTools restriction", async () => {
    await expect(capturedTools({ allowedTools: ["Read", "Bash"] }))
      .resolves.toEqual(["Read", "Bash", "ToolSearch"]);
  });

  it("does not duplicate ToolSearch when it is already allowed", async () => {
    await expect(capturedTools({ allowedTools: ["Read", "ToolSearch"] }))
      .resolves.toEqual(["Read", "ToolSearch"]);
  });

  it("respects an explicit ToolSearch disallow", async () => {
    await expect(capturedTools({ allowedTools: ["Read"], disallowedTools: ["ToolSearch"] }))
      .resolves.toEqual(["Read"]);
  });

  it("keeps the Claude Code preset when allowedTools is undefined", async () => {
    await expect(capturedTools({}))
      .resolves.toEqual({ type: "preset", preset: "claude_code" });
  });

  it("maps live assistant, tool, result, and usage messages to connector events", async () => {
    const query: QueryFunction = async function* () {
      yield {
        type: "assistant",
        message: { content: [
          { type: "text", text: "working" },
          { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/work/a.ts" } },
        ] },
      };
      yield {
        type: "user",
        message: { content: [{ type: "tool_result", tool_use_id: "toolu_1", content: "contents", is_error: false }] },
      };
      yield {
        type: "result", subtype: "success", result: "done", duration_ms: 5, total_cost_usd: 0.01,
        usage: { input_tokens: 3, output_tokens: 4, cost_usd: 0.01, cache_creation_input_tokens: 2, cache_read_input_tokens: 1 },
      };
    };
    const events: Array<{ kind: string; metadata: Record<string, unknown> }> = [];
    const connector = new ClaudeConnector({
      model: "claude-test",
      query,
      onEvent: async (event) => { events.push(event); },
    });

    await expect(connector.run("ping")).resolves.toMatchObject({ text: "done", usage: { tokens: 7 } });
    expect(events).toEqual([
      { kind: "agent_started", metadata: { agent: "claude", model: "claude-test", prompt_chars: 4, session_id: expect.stringMatching(uuid) } },
      { kind: "agent_relay", metadata: { text: "working", role: "assistant" } },
      {
        kind: "tool_use_summary",
        metadata: {
          tool: "Read", summary: "/work/a.ts", ok: true, duration_ms: 0,
          input: { file_path: "/work/a.ts" }, tool_use_id: "toolu_1",
        },
      },
      { kind: "tool_result", metadata: { tool_use_id: "toolu_1", ok: true, output: "contents" } },
      {
        kind: "step_usage",
        metadata: {
          input_tokens: 3, output_tokens: 4, cost_usd: 0.01, usd_source: "reported",
          cache_creation_input_tokens: 2,
          cache_read_input_tokens: 1, model: "claude-test",
        },
      },
    ]);
  });

  it("uses agent-sdk query() through a narrow boundary and reports resolved telemetry", async () => {
    const query = vi.fn<QueryFunction>(() => messages());
    const connector = new ClaudeConnector({
      model: testModels.claudeDefault,
      cwd: "/work",
      allowedTools: ["Read"],
      query,
    });

    const result = await connector.run("echo test");

    expect(query).toHaveBeenCalledWith({
      prompt: "echo test",
      options: expect.objectContaining({
        cwd: "/work", model: testModels.claudeDefault, permissionMode: "acceptEdits", tools: ["Read", "ToolSearch"],
      }),
    });
    expect(result).toEqual({
      text: "echo ok",
      usage: { usd: 0.01, tokens: 7, ms: 42 },
      split: { input: 3, output: 4, cacheRead: 1, cacheCreation: 2 },
      usdSource: "reported",
      telemetry: { durationMs: 42, model: `${testModels.claudeDefault}-20260701` },
    });
    expect(result.usage).not.toHaveProperty("dispatches");
  });

  it("preserves a reported zero-cost result", async () => {
    const query: QueryFunction = async function* () {
      yield { type: "result", subtype: "success", result: "free", duration_ms: 3, total_cost_usd: 0, usage: { input_tokens: 2, output_tokens: 1 } };
    };
    const result = await new ClaudeConnector({ query }).run("test");
    expect(result.usage).toEqual({ tokens: 3, ms: 3, usd: 0 });
    expect(result.usdSource).toBe("reported");
  });

  it("fails on an SDK terminal error result", async () => {
    const query: QueryFunction = async function* () {
      yield { type: "result", subtype: "error_during_execution", errors: ["auth failed"], duration_ms: 2 };
    };
    await expect(new ClaudeConnector({ query }).run("test")).rejects.toThrow("auth failed");
  });

  it("rejects the logged-out CLI result despite its success subtype", async () => {
    const query: QueryFunction = async function* () {
      yield {
        type: "result", subtype: "success", is_error: true,
        result: "Not logged in · Please run /login", terminal_reason: "api_error",
        duration_ms: 76, total_cost_usd: 0,
        usage: { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
      };
    };
    await expect(new ClaudeConnector({ query }).run("test")).rejects.toThrow("Not logged in");
  });
});

// Replay SDK result frames at the transport seam; the connector and both engine
// settlement paths are production code, and assertions reload receipts from disk.
describe.each(["stepDone", "usageReport"] as const)("Claude %s receipts", (settlement) => {
  it.each([
    ["absent", undefined, undefined], ["zero", 0, 0], ["positive", 0.01, 0.01],
    ["negative", -1, undefined], ["null", null, undefined], ["string", "0", undefined],
    ["NaN", NaN, undefined], ["infinite", Infinity, undefined],
  ])("preserves %s provider cost", async (_label, cost, expected) => {
    const events: Array<{ kind: string; metadata: Record<string, unknown> }> = [];
    const query: QueryFunction = async function* () {
      for await (const frame of messages()) {
        if (frame.type !== "result") { yield frame; continue; }
        const { total_cost_usd: _cost, ...rest } = frame;
        yield { ...rest, ...(cost !== undefined ? { total_cost_usd: cost } : {}) };
      }
    };
    const result = await new ClaudeConnector({ query, onEvent: event => { events.push(event); } }).run("test");
    const metadata = events.find(event => event.kind === "step_usage")!.metadata;
    const expectedUsd = expected === undefined ? {} : { usd: expected };
    expect(result.usage).toEqual({ tokens: 7, ms: 42, ...expectedUsd });
    if (expected === undefined) {
      expect(result).not.toHaveProperty("usdSource");
      expect(metadata).not.toHaveProperty("cost_usd");
      expect(metadata).not.toHaveProperty("usd_source");
    } else {
      expect(result.usdSource).toBe("reported");
      expect(metadata).toMatchObject({ cost_usd: expected, usd_source: "reported" });
    }
    const root = await mkdtemp(join(tmpdir(), "claude-cost-receipts-"));
    try {
      const engine = new StratumEngine({ stateRoot: root, evaluator: createEvaluator() });
      const planned = await engine.plan({
        version: 1, contracts: { Result: { value: "string" } },
        flows: { entry: "main", main: {
          input: {}, output: { from: "${work.output}", contract: "Result" },
          budget: { usd: 0.005, tokens: 100 },
          steps: [{ id: "work", do: "work", out: "Result" }],
        } },
      }, {});
      if (planned.status !== "ready") throw new Error("expected ready step");
      const dispatchId = planned.ready[0]!.dispatchToken;
      if (settlement === "usageReport") {
        await engine.usageReport(planned.runId, { ...result, dispatchId, stepId: "work", source: "claude" });
      } else {
        await engine.stepDone(planned.runId, "work", { ...result, output: { value: result.text } }, dispatchId);
      }
      const run = await new StateStore(root).load(planned.runId);
      expect(run.receipts).toHaveLength(1);
      const receipt = run.receipts![0]!;
      expect(receipt.amount).toEqual({ tokens: 7, ms: 42, ...expectedUsd });
      if (expected === undefined) expect(receipt).not.toHaveProperty("usdSource");
      else expect(receipt.usdSource).toBe("reported");
      expect(run.flowSpent).toEqual({ dispatches: 1, tokens: 7, ms: 42, ...(expected ? { usd: expected } : {}) });
      expect(spineSpent(run)).toEqual({ tokens: 7, ms: 42, ...(expected ? { usd: expected } : {}) });
      // Unknown cost retains the existing no-debit policy, not a known free price.
      expect(run.status === "budget_exhausted").toBe(expected === 0.01);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

it.each([undefined, 0, 0.01])("preserves Claude error-frame cost %s", async (cost) => {
  const query: QueryFunction = async function* () {
    yield { type: "result", subtype: "error_during_execution", errors: ["failed"],
      ...(cost !== undefined ? { total_cost_usd: cost } : {}) };
  };
  const failure = await new ClaudeConnector({ query }).run("test").catch(error => error);
  expect(failure.usage).toEqual({ tokens: 0, ms: 0, ...(cost !== undefined ? { usd: cost } : {}) });
  if (cost === undefined) expect(failure).not.toHaveProperty("usdSource");
  else expect(failure.usdSource).toBe("reported");
});
