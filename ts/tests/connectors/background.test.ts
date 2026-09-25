import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  T2F5_DONE_SENTINEL,
  cancelBackgroundRun,
  pollBackgroundRun,
  startBackgroundRun,
  type BackgroundRunMeta,
} from "../../src/connectors/background.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function root(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "stratum-p3-bg-"));
  roots.push(path);
  return path;
}

const THREAD_STARTED = { type: "thread.started", thread_id: "t-1" };
const AGENT_MSG = { type: "item.completed", item: { type: "agent_message", text: "done text" } };
const TURN_DONE = { type: "turn.completed", usage: { input_tokens: 3, output_tokens: 4, cached_input_tokens: 0 } };

function fakeCodex(records: unknown[], options: { rc?: number; stderr?: string; sleep?: number } = {}): string[] {
  const script = [
    ...records.map((record) => `printf '%s\\n' '${JSON.stringify(record).replaceAll("'", "'\\''")}'`),
    ...(options.stderr ? [`printf '%s' '${options.stderr.replaceAll("'", "'\\''")}' 1>&2`] : []),
    ...(options.sleep ? [`sleep ${options.sleep}`] : []),
    `exit ${options.rc ?? 0}`,
  ].join("; ");
  return ["sh", "-c", script];
}

async function waitFor(runId: string, registryRoot: string, status: string, timeout = 5_000) {
  const deadline = Date.now() + timeout;
  let last: Awaited<ReturnType<typeof pollBackgroundRun>> | undefined;
  while (Date.now() < deadline) {
    last = await pollBackgroundRun(runId, { registryRoot });
    if (last.status === status) return last;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${status}: ${JSON.stringify(last)}`);
}

async function readMeta(registryRoot: string, runId: string): Promise<BackgroundRunMeta> {
  return JSON.parse(await readFile(join(registryRoot, runId, "meta.json"), "utf8")) as BackgroundRunMeta;
}

async function writeRegistryRun(registryRoot: string, runId: string, records: unknown[], stderr = "") {
  const runDir = join(registryRoot, runId);
  await mkdir(runDir, { recursive: true });
  const streamPath = join(runDir, "stream.jsonl");
  const stderrPath = `${streamPath}.err`;
  await writeFile(streamPath, records.map((record) => `${JSON.stringify(record)}\n`).join(""), "utf8");
  await writeFile(stderrPath, stderr, "utf8");
  const meta: BackgroundRunMeta = {
    runId, agent: "codex", model: "gpt-5", cwd: registryRoot, sandboxMode: "read-only",
    promptChars: 1, createdAt: "2026-07-10T00:00:00Z", childPid: 0,
    streamPath, stderrPath,
  };
  await writeFile(join(runDir, "meta.json"), JSON.stringify(meta), "utf8");
}

describe("P3 background run gate", () => {
  it("requires explicit opt-in for full access and omits the sandbox preamble when enabled", async () => {
    const registryRoot = await root();
    await expect(startBackgroundRun({
      agent: "codex", prompt: "solve", cwd: registryRoot, registryRoot,
      sandboxMode: "danger-full-access" as never,
      command: fakeCodex([AGENT_MSG]),
    })).rejects.toThrow("STRATUM_CODEX_ALLOW_FULL_ACCESS");

    const started = await startBackgroundRun({
      agent: "codex", prompt: "solve", cwd: registryRoot, registryRoot,
      sandboxMode: "danger-full-access" as never,
      env: { PATH: process.env.PATH, STRATUM_CODEX_ALLOW_FULL_ACCESS: "yes" },
      command: fakeCodex([AGENT_MSG]),
    });
    expect(await readFile(`${started.streamPath}.in`, "utf8")).toBe("solve");
    expect(await readMeta(registryRoot, started.runId)).toMatchObject({
      sandboxMode: "danger-full-access",
      sandboxAudit: {
        policy: { filesystemMode: "danger-full-access" },
        provenance: { filesystemMode: { layer: "dispatch", source: "startBackgroundRun options" } },
        fullAccessAuthorization: { layer: "env", source: "STRATUM_CODEX_ALLOW_FULL_ACCESS" },
      },
    });
    expect(await waitFor(started.runId, registryRoot, "complete")).toMatchObject({
      text: "done text",
      sandboxAudit: { fullAccessAuthorization: { layer: "env", source: "STRATUM_CODEX_ALLOW_FULL_ACCESS" } },
    });
  });

  it("runs the golden flow through running, complete, usage, and persisted process identity", async () => {
    const registryRoot = await root();
    const started = await startBackgroundRun({
      agent: "codex", prompt: "solve", cwd: registryRoot, registryRoot,
      command: fakeCodex([THREAD_STARTED, AGENT_MSG, TURN_DONE], { sleep: 0.5 }),
    });

    expect(started.status).toBe("bg_started");
    expect(started.runId).toMatch(/^[0-9a-f]{12}$/);
    expect(await readFile(started.streamPath, "utf8")).not.toContain(T2F5_DONE_SENTINEL);
    expect(await waitFor(started.runId, registryRoot, "running")).toMatchObject({
      status: "running", runId: started.runId, streamPath: started.streamPath,
    });
    expect(await waitFor(started.runId, registryRoot, "complete")).toMatchObject({
      status: "complete", text: "done text", exitCode: 0, usage: { tokens: 7 },
    });
    const meta = await readMeta(registryRoot, started.runId);
    if (meta.agent !== "codex") throw new Error("golden Codex run persisted Claude metadata");
    expect(typeof started.pid).toBe("number");
    expect(meta.childPid).toBe(started.pid);
    expect(meta.procStartTime).toBeTruthy();
  });

  it.each([
    { model: "gpt-6-astra/medium", reported: undefined, expectedUsd: 1.469586, source: "estimated" },
    { model: "gpt-6-astra/medium", reported: 0.25, expectedUsd: 0.25, source: "reported" },
    { model: "unpriced-model/medium", reported: undefined, expectedUsd: undefined, source: undefined },
  ])("polls Codex cached tokens and cost for $model with reported=$reported", async ({ model, reported, expectedUsd, source }) => {
    const registryRoot = await root();
    const runId = "aabbcc112233";
    await writeRegistryRun(registryRoot, runId, [
      AGENT_MSG,
      { type: "turn.completed", usage: {
        input_tokens: 585903, cached_input_tokens: 524416,
        cache_write_input_tokens: 0, output_tokens: 6606, reasoning_output_tokens: 648,
        ...(reported !== undefined ? { total_cost_usd: reported } : {}),
      } },
      { [T2F5_DONE_SENTINEL]: 0 },
    ]);
    const meta = await readMeta(registryRoot, runId);
    await writeFile(join(registryRoot, runId, "meta.json"), JSON.stringify({ ...meta, model }));

    const result = await pollBackgroundRun(runId, { registryRoot });
    expect(result.status).toBe("complete");
    if (result.status !== "complete") throw new Error("expected completed Codex run");
    expect(result.split).toEqual({ input: 585903, output: 6606, cacheRead: 524416 });
    expect(result.usage.tokens).toBe(592509);
    expect(result.usdSource).toBe(source);
    if (expectedUsd === undefined) expect(result.usage.usd).toBeUndefined();
    else {
      expect(result.usage.usd).toBeGreaterThan(0);
      expect(result.usage.usd).toBeCloseTo(expectedUsd, 8);
    }
  });

  it("polls a nonzero wrapper result as error with stderr", async () => {
    const registryRoot = await root();
    const started = await startBackgroundRun({
      agent: "codex", prompt: "solve", cwd: registryRoot, registryRoot,
      command: fakeCodex([THREAD_STARTED], { rc: 4, stderr: "auth failed" }),
    });
    expect(await waitFor(started.runId, registryRoot, "error")).toMatchObject({
      status: "error", exitCode: 4, stderrTail: expect.stringContaining("auth failed"),
    });
  });

  it("polls an exit-0 API 400 or empty Codex run as error", async () => {
    const registryRoot = await root();
    const apiFailure = await startBackgroundRun({
      agent: "codex", prompt: "solve", cwd: registryRoot, registryRoot,
      command: fakeCodex([], {
        stderr: 'ERROR: {"type":"error","status":400,"error":{"message":"model unavailable"}}',
      }),
    });
    expect(await waitFor(apiFailure.runId, registryRoot, "error")).toMatchObject({
      status: "error", exitCode: 0,
      reason: "Codex API error (status 400): model unavailable",
    });

    const emptyRunId = "c0de00000000";
    await writeRegistryRun(registryRoot, emptyRunId, [{ [T2F5_DONE_SENTINEL]: 0 }]);
    expect(await pollBackgroundRun(emptyRunId, { registryRoot })).toMatchObject({
      status: "error", exitCode: 0, reason: "codex completed without agent output",
    });

    const opaque = await startBackgroundRun({
      agent: "codex", prompt: "solve", cwd: registryRoot, registryRoot,
      command: fakeCodex([]),
    });
    expect(await waitFor(opaque.runId, registryRoot, "complete")).toMatchObject({
      status: "complete", exitCode: 0, text: "",
    });
  });

  it("guards unsupported background lanes and returns not_found for unknown runs", async () => {
    const registryRoot = await root();
    // Unknown agent rejected (D11 discriminant validation)
    await expect(startBackgroundRun({ agent: "gemini" as "claude", prompt: "p", cwd: registryRoot, registryRoot }))
      .rejects.toThrow("Unknown agent");
    // Claude bg with sandboxMode:read-only rejected (D8)
    await expect(startBackgroundRun({ agent: "claude", prompt: "p", cwd: registryRoot, registryRoot, sandboxMode: "read-only" }))
      .rejects.toThrow("sandboxMode='read-only' are not supported");
    await expect(pollBackgroundRun("missing", { registryRoot })).resolves.toEqual({ status: "not_found", runId: "missing" });
  });

  it("cancels only the verified process group and then polls terminal", async () => {
    const registryRoot = await root();
    const started = await startBackgroundRun({
      agent: "codex", prompt: "solve", cwd: registryRoot, registryRoot,
      command: fakeCodex([THREAD_STARTED], { sleep: 30 }),
    });
    await waitFor(started.runId, registryRoot, "running");

    await expect(cancelBackgroundRun(started.runId, { registryRoot })).resolves.toEqual({ status: "cancelled", runId: started.runId });
    expect(await waitFor(started.runId, registryRoot, "error")).toMatchObject({ status: "error", reason: "child_died_without_sentinel" });
  });

  it("caps oversized poll text at 20k while preserving the tail", async () => {
    const registryRoot = await root();
    const runId = "cafe12345678";
    await writeRegistryRun(registryRoot, runId, [
      { type: "item.completed", item: { type: "agent_message", text: "a".repeat(25_000) } },
      { [T2F5_DONE_SENTINEL]: 0 },
    ]);
    const result = await pollBackgroundRun(runId, { registryRoot });
    expect(result.status).toBe("complete");
    if (result.status !== "complete") return;
    expect(result.text.length).toBeLessThanOrEqual(20_000);
    expect(result.text).toMatch(/^\[truncated, full stream at /);
    expect(result.text.endsWith("a".repeat(100))).toBe(true);
  });

  it("rejects non-hex ids before registry traversal or cancellation", async () => {
    const registryRoot = await root();
    const evil = "../evilrun12";
    await expect(pollBackgroundRun(evil, { registryRoot })).resolves.toEqual({ status: "not_found", runId: evil });
    await expect(cancelBackgroundRun(evil, { registryRoot })).resolves.toEqual({ status: "not_found", runId: evil });
  });

  it("rejects a registry record whose embedded run id does not match", async () => {
    const registryRoot = await root();
    const runId = "ab12cd34ef99";
    await writeRegistryRun(registryRoot, runId, [THREAD_STARTED]);
    const meta = await readMeta(registryRoot, runId);
    await writeFile(join(registryRoot, runId, "meta.json"), JSON.stringify({ ...meta, runId: "000000000000" }), "utf8");
    await expect(pollBackgroundRun(runId, { registryRoot })).resolves.toEqual({ status: "not_found", runId });
  });

  it("creates the run registry private to the invoking user (0700 dirs, 0600 files)", async () => {
    const registryRoot = await root();
    const started = await startBackgroundRun({
      agent: "codex", prompt: "secret prompt", cwd: registryRoot, registryRoot,
      command: fakeCodex([THREAD_STARTED, AGENT_MSG, TURN_DONE]),
    });
    await waitFor(started.runId, registryRoot, "complete");
    const runDir = join(registryRoot, started.runId);
    expect((await stat(runDir)).mode & 0o777).toBe(0o700);
    for (const file of ["stream.jsonl", "stream.jsonl.err", "stream.jsonl.in", "meta.json"]) {
      expect((await stat(join(runDir, file))).mode & 0o777).toBe(0o600);
    }
  });

  it("ignores substituted meta paths — poll reads only files inside the run directory", async () => {
    const registryRoot = await root();
    const runId = "beef00000001";
    await writeRegistryRun(registryRoot, runId, [{ [T2F5_DONE_SENTINEL]: 3 }], "real stderr");
    const secretPath = join(registryRoot, "secret.txt");
    await writeFile(secretPath, "TOPSECRET", "utf8");
    const meta = await readMeta(registryRoot, runId);
    await writeFile(
      join(registryRoot, runId, "meta.json"),
      JSON.stringify({ ...meta, streamPath: secretPath, stderrPath: secretPath }),
      "utf8",
    );
    const result = await pollBackgroundRun(runId, { registryRoot });
    expect(result.status).toBe("error");
    if (result.status !== "error") return;
    expect(result.exitCode).toBe(3);
    expect(result.stderrTail).toBe("real stderr");
    expect(JSON.stringify(result)).not.toContain("TOPSECRET");
  });

  it("drops an oversized unterminated line instead of buffering it, then keeps scanning", async () => {
    const registryRoot = await root();
    const runId = "beef00000002";
    await writeRegistryRun(registryRoot, runId, []);
    const streamPath = join(registryRoot, runId, "stream.jsonl");
    const oversized = `x`.repeat(6_000_000);
    await writeFile(streamPath, `${oversized}\n${JSON.stringify(AGENT_MSG)}\n${JSON.stringify({ [T2F5_DONE_SENTINEL]: 0 })}\n`, "utf8");
    const result = await pollBackgroundRun(runId, { registryRoot });
    expect(result).toMatchObject({ status: "complete", text: "done text", exitCode: 0 });
  });

  it("reports durationMs and resolved model/effort telemetry on terminal polls", async () => {
    const registryRoot = await root();
    const started = await startBackgroundRun({
      agent: "codex", prompt: "solve", cwd: registryRoot, registryRoot, model: "gpt-5.6-terra/high",
      command: fakeCodex([THREAD_STARTED, AGENT_MSG, TURN_DONE], { sleep: 0.5 }),
    });
    const complete = await waitFor(started.runId, registryRoot, "complete");
    expect(complete).toMatchObject({ telemetry: { model: "gpt-5.6-terra", effort: "high" } });
    if (complete.status !== "complete") return;
    // createdAt is stamped pre-spawn, so the 0.5s child sleep must show up.
    expect(complete.telemetry.durationMs).toBeGreaterThanOrEqual(300);
    expect(Number.isFinite(complete.telemetry.durationMs)).toBe(true);

    const failedId = "beef00000003";
    await writeRegistryRun(registryRoot, failedId, [{ [T2F5_DONE_SENTINEL]: 2 }]);
    const failed = await pollBackgroundRun(failedId, { registryRoot });
    expect(failed).toMatchObject({ status: "error", exitCode: 2, telemetry: { model: "gpt-5", durationMs: expect.any(Number) } });
  });

  it("refuses to signal after a process start-time mismatch", async () => {
    const registryRoot = await root();
    const started = await startBackgroundRun({
      agent: "codex", prompt: "solve", cwd: registryRoot, registryRoot,
      command: fakeCodex([THREAD_STARTED], { sleep: 30 }),
    });
    const meta = await readMeta(registryRoot, started.runId);
    await writeFile(join(registryRoot, started.runId, "meta.json"), JSON.stringify({ ...meta, procStartTime: "wrong" }), "utf8");
    await expect(cancelBackgroundRun(started.runId, { registryRoot })).resolves.toEqual({ status: "already_error", runId: started.runId });
    expect(await pollBackgroundRun(started.runId, { registryRoot })).toMatchObject({ status: "error", reason: "child_died_without_sentinel" });

    await writeFile(join(registryRoot, started.runId, "meta.json"), JSON.stringify(meta), "utf8");
    await cancelBackgroundRun(started.runId, { registryRoot });
  });
});
