import { describe, expect, it, vi } from "vitest";

const runAgent = vi.fn();
vi.mock("../../src/connectors/runner.js", () => ({ runAgent: (...args: unknown[]) => runAgent(...args) }));

const { defaultConnector } = await import("../../src/engine/engine.js");

describe("engine default connector", () => {
  it("instructs the contract, feeds back the prior failure, requests workspace-write, and parses fenced JSON", async () => {
    runAgent.mockResolvedValueOnce({
      text: '```json\n{"value":"fixed"}\n```',
      usage: { tokens: 5 },
      telemetry: { durationMs: 3, model: "fake" },
    });
    const result = await defaultConnector({
      agent: "codex",
      prompt: "Fix item",
      cwd: "/work",
      attempt: 2,
      previousFailure: { attempt: 1, reason: "ensure failed: value was empty" },
      outSchema: { value: "string" },
      sandbox: "workspace-write",
    });
    expect(result).toEqual({ output: { value: "fixed" }, usage: { tokens: 5 }, telemetry: { durationMs: 3, model: "fake" } });
    const request = runAgent.mock.calls[0]![0] as { prompt: string; sandboxMode?: string };
    expect(request.sandboxMode).toBe("workspace-write");
    expect(request.prompt).toContain('{"value":"string"}');
    expect(request.prompt).toContain("ensure failed: value was empty");
  });

  it("passes raw text through when the stage declares no out contract", async () => {
    runAgent.mockResolvedValueOnce({ text: "plain words", usage: {}, telemetry: { durationMs: 1, model: "fake" } });
    const result = await defaultConnector({ agent: "claude", prompt: "p", attempt: 1 });
    expect(result).toMatchObject({ output: "plain words" });
    // Claude runs never receive a codex sandbox flag.
    expect((runAgent.mock.calls[1]![0] as { sandboxMode?: string }).sandboxMode).toBeUndefined();
  });

  it("fails the attempt with feedback when contract JSON cannot be parsed", async () => {
    runAgent.mockResolvedValueOnce({ text: "not json at all", usage: {}, telemetry: { durationMs: 1, model: "fake" } });
    const result = await defaultConnector({ agent: "claude", prompt: "p", attempt: 1, outSchema: { value: "string" } });
    expect(result).toMatchObject({ failure: expect.stringContaining("must be JSON") });
  });
});
