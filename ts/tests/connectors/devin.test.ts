import { testModels } from "../helpers/models.js";
import { spawn as nodeSpawn } from "node:child_process";
import { getEventListeners } from "node:events";
import { EventEmitter } from "node:events";
import { appendFileSync, existsSync, readFileSync, realpathSync, statSync, symlinkSync, unlinkSync, utimesSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectorEvent } from "../../src/connectors/base.js";
import type { SpawnProcess } from "../../src/connectors/codex.js";
import { DevinConnector, prepareDevinRun, type DevinConnectorOptions } from "../../src/connectors/devin.js";
import { devinRunLayout } from "../../src/connectors/devin-wrapper.js";
import { DEVIN_STALL_MS, DEVIN_MAX_RUN_MS, devinStallWatchdog, devinWireProgress, resolveDevinStallMs, resolveDevinMaxRunMs } from "../../src/connectors/devin-watchdog.js";
import { runAgent } from "../../src/connectors/runner.js";

/**
 * STRAT-AGENT-DEVIN-1 slice S1b (D2/D3/D4) — the error harness: every check
 * runs through the injectable spawn seam with recorded ATIF fixtures, a temp
 * HOME, and no network. The fake spawn emulates the supervisor wrapper's
 * contract: it copies the credentials into the per-run home, writes the ATIF
 * export, writes `exit.rc` and the sentinel, and removes the credentials copy.
 */

vi.mock("../../src/connectors/proc_identity.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../src/connectors/proc_identity.js")>(),
  procStartTime: vi.fn(async () => "fixture-start"),
}));

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "..", "fixtures", "devin");
const fixture = (name: string): string => join(FIXTURES, name);

const roots: string[] = [];
const realKill = process.kill.bind(process);

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "stratum-devin-s1b-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.useRealTimers();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

/** Env with HOME pointed at a temp root — never the real devin state (D2). */
async function homeEnv(root: string, extra: NodeJS.ProcessEnv = {}): Promise<NodeJS.ProcessEnv> {
  const home = join(root, "home");
  await mkdir(join(home, ".local", "share", "devin"), { recursive: true });
  await writeFile(join(home, ".local", "share", "devin", "credentials.toml"), "token = \"fixture\"\n");
  return {
    HOME: home,
    PATH: "/usr/bin:/bin",
    STRATUM_CONFIG_FILE: join(root, "missing-user.toml"),
    ...extra,
  };
}

interface FakeOutcome {
  /** Value written to exit.rc and the sentinel (default 0). */
  rc?: number;
  stdout?: string;
  stderr?: string;
  /** Text written to <A>/trajectory.json; omit for a missing export. */
  exportText?: string;
  writeExitRc?: boolean;
  writeSentinel?: boolean;
  /** Emulate the wrapper's copy+trap (default on). */
  emulateCreds?: boolean;
  /** Assertion/inspection hook run inside the run while the run dir exists. */
  inspect?: (ctx: { env: NodeJS.ProcessEnv; argv: string[]; command: string }) => void | Promise<void>;
}

/** The wrapper contract, emulated: creds in, exit.rc + sentinel out, creds gone. */
function fakeDevinSpawn(outcome: FakeOutcome): SpawnProcess {
  return vi.fn<SpawnProcess>((command: string, args: readonly string[], options: SpawnOptionsWithoutStdio) => {
    const child = new EventEmitter() as ChildProcessWithoutNullStreams;
    Object.defineProperty(child, "pid", { value: 424_242, writable: true });
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = vi.fn((signal?: NodeJS.Signals) => {
      queueMicrotask(() => child.emit("close", null, signal ?? "SIGTERM"));
      return true;
    });
    vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid !== -424_242) return realKill(pid, signal);
      if (signal === 0) throw Object.assign(new Error("fixture group exited"), { code: "ESRCH" });
      child.kill(signal as NodeJS.Signals);
      return true;
    });
    const env = (options.env ?? {}) as NodeJS.ProcessEnv;
    const runDir = env.STRATUM_DEVIN_RUN_DIR ?? "";
    const rc = outcome.rc ?? 0;
    queueMicrotask(async () => {
      try {
        if (outcome.emulateCreds !== false && env.STRATUM_DEVIN_CREDS_COPY && env.STRATUM_DEVIN_CREDS_SOURCE) {
          await cp(env.STRATUM_DEVIN_CREDS_SOURCE, env.STRATUM_DEVIN_CREDS_COPY, { force: true });
        }
        await outcome.inspect?.({ env, argv: [...args], command });
        if (outcome.exportText !== undefined) {
          await writeFile(join(runDir, "agent", "trajectory.json"), outcome.exportText, "utf8");
        }
        if (outcome.stdout) (child.stdout as PassThrough).write(outcome.stdout);
        if (outcome.stderr) (child.stderr as PassThrough).write(outcome.stderr);
        (child.stdout as PassThrough).end();
        (child.stderr as PassThrough).end();
        if (outcome.writeExitRc !== false) await writeFile(join(runDir, "exit.rc"), `${rc}\n`, "utf8");
        if (outcome.writeSentinel !== false) {
          await writeFile(join(runDir, "stream.jsonl"), `{"__t2f5_done__":${rc}}\n`, { encoding: "utf8", flag: "a" });
        }
        if (outcome.emulateCreds !== false && env.STRATUM_DEVIN_CREDS_COPY) {
          await rm(env.STRATUM_DEVIN_CREDS_COPY, { force: true });
        }
        child.emit("close", rc, null);
      } catch (error) {
        child.emit("error", error instanceof Error ? error : new Error(String(error)));
        child.emit("close", 1, null);
      }
    });
    return child;
  });
}

function connector(options: Partial<DevinConnectorOptions> = {}): DevinConnector {
  return new DevinConnector(options);
}

describe("DevinConnector — inactivity watchdog", () => {
  async function silentRun(extra: Partial<DevinConnectorOptions> = {}, { envStall = false } = {}) {
    const root = await temporaryRoot();
    const env = await homeEnv(root);
    let child!: ChildProcessWithoutNullStreams;
    let runDir = "";
    let wireLogPath = "";
    let alive = true;
    let ready!: () => void;
    const started = new Promise<void>(resolve => { ready = resolve; });
    const spawn: SpawnProcess = (_command, _argv, options) => {
      runDir = options.env!.STRATUM_DEVIN_RUN_DIR!;
      wireLogPath = options.env!.CHISEL_ACP_WIRE_LOG!;
      child = new EventEmitter() as ChildProcessWithoutNullStreams;
      Object.defineProperty(child, "pid", { value: 424_242 });
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      return child;
    };
    const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid !== -424_242) return realKill(pid, signal);
      if (!alive) throw Object.assign(new Error("fixture group gone"), { code: "ESRCH" });
      if (signal !== 0) { alive = false; queueMicrotask(() => child.emit("close", null, signal)); }
      return true;
    });
    const controller = new AbortController();
    vi.useFakeTimers();
    const result = connector({ env, spawn, signal: controller.signal, ...(envStall ? {} : { stallMs: 100 }),
      cancellationGraceMs: 0, onEvent: event => { if (event.kind === "agent_started") ready(); }, ...extra }).run("p");
    // Attach a rejection handler before driving the clock.
    void result.catch(() => {});
    await started;
    async function complete() {
      await writeFile(join(runDir, "agent", "trajectory.json"), readFileSync(fixture("answer.atif.json"), "utf8"));
      await writeFile(join(runDir, "exit.rc"), "0\n");
      alive = false; child.emit("close", 0, null);
      return result;
    }
    return { result, child, kill, complete, controller, runDir, wireLogPath };
  }

  it("fails a silent process and kills the process group even without ownProcessGroup", async () => {
    const run = await silentRun();
    await vi.advanceTimersByTimeAsync(100);
    await expect(run.result).rejects.toThrow("devin stalled: no activity for 0.1s (last event: spawn)");
    await expect(run.result).rejects.toThrow("silent signals: stdout, stderr, ACP wire updates");
    expect(run.kill).toHaveBeenCalledWith(-424_242, "SIGTERM");
    expect(existsSync(run.runDir)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["stdout", "stderr"] as const)("re-arms on every %s chunk, including partial lines", async stream => {
    const run = await silentRun();
    for (let index = 0; index < 5; index++) {
      await vi.advanceTimersByTimeAsync(75);
      run.child[stream].emit("data", "progress");
    }
    await expect(run.complete()).resolves.toMatchObject({ text: expect.any(String) });
    expect(run.kill).not.toHaveBeenCalledWith(-424_242, "SIGTERM");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("reports the last progress type on expiry", async () => {
    const run = await silentRun();
    run.child.stderr.emit("data", "saved");
    await vi.advanceTimersByTimeAsync(100);
    await expect(run.result).rejects.toThrow("last event: stderr (5 bytes)");
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["agent_thought_chunk", "agent_message_chunk", "tool_call", "tool_call_update"])(
    "silent streams with ACP %s progress stay alive and clean up", async kind => {
    const run = await silentRun({ stallMs: 6000 });
    for (let index = 0; index < 5; index++) {
      await vi.advanceTimersByTimeAsync(4000);
      appendFileSync(run.wireLogPath, JSON.stringify({ sessionId: "test", update: { sessionUpdate: kind, content: { text: "private" } } }) + "\n");
    }
    await expect(run.complete()).resolves.toMatchObject({ text: expect.any(String) });
    expect(run.kill).not.toHaveBeenCalledWith(-424_242, "SIGTERM");
    expect(existsSync(run.wireLogPath)).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("wire progress at expiry re-arms, then stopped thinking stalls with named signals", async () => {
    const run = await silentRun();
    await vi.advanceTimersByTimeAsync(99);
    appendFileSync(run.wireLogPath, JSON.stringify({ sessionId: "test", update: { sessionUpdate: "agent_thought_chunk", content: { text: "private" } } }) + "\n");
    await vi.advanceTimersByTimeAsync(1);
    expect(run.kill).not.toHaveBeenCalledWith(-424_242, "SIGTERM");
    await vi.advanceTimersByTimeAsync(100);
    await expect(run.result).rejects.toThrow("last event: ACP agent_thought_chunk");
    await expect(run.result).rejects.toThrow("silent signals: stdout, stderr, ACP wire updates");
    await expect(run.result).rejects.not.toThrow("private");
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["MCP", "mtime", "malformed", "usage"])("%s wire activity is silence and cannot replay an old thought", async kind => {
    const run = await silentRun();
    appendFileSync(run.wireLogPath, '{"sessionId":"test","update":{"sessionUpdate":"agent_thought_chunk"}}\n');
    await vi.advanceTimersByTimeAsync(25);
    for (let index = 0; index < 4; index++) {
      if (kind === "mtime") utimesSync(run.wireLogPath, new Date(), new Date(Date.now() + 1000));
      else appendFileSync(run.wireLogPath, kind === "MCP" ? '{"channel":"mcp","method":"ping"}\n'
        : kind === "usage" ? '{"sessionId":"test","update":{"sessionUpdate":"usage_update"}}\n' : 'thought but not JSON\n');
      await vi.advanceTimersByTimeAsync(25);
    }
    await expect(run.result).rejects.toThrow("devin stalled:");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a wire symlink loop warns once, keeps the foreground server alive and still stalls", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const run = await silentRun();
    unlinkSync(run.wireLogPath);
    symlinkSync("wire.log", run.wireLogPath);
    await vi.advanceTimersByTimeAsync(100);
    await expect(run.result).rejects.toThrow("devin stalled:");
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("ELOOP"));
    expect(run.kill).toHaveBeenCalledWith(-424_242, "SIGTERM");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a hard ceiling expires despite continuous stdout and thought progress", async () => {
    const run = await silentRun({ stallMs: 100, maxRunMs: 250 });
    for (let index = 0; index < 5; index++) {
      run.child.stdout.emit("data", "active");
      appendFileSync(run.wireLogPath, '{"sessionId":"test","update":{"sessionUpdate":"agent_thought_chunk"}}\n');
      await vi.advanceTimersByTimeAsync(50);
    }
    await vi.advanceTimersByTimeAsync(1);
    await expect(run.result).rejects.toThrow("devin exceeded maximum run time of 0.25s");
    expect(run.kill).toHaveBeenCalledWith(-424_242, "SIGTERM");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("the hard ceiling remains active when the inactivity timer is off", async () => {
    const run = await silentRun({ stallMs: 0, maxRunMs: 100 });
    await vi.advanceTimersByTimeAsync(101);
    await expect(run.result).rejects.toThrow("STRATUM_DEVIN_MAX_RUN_MS");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("both timers can be disabled independently", async () => {
    const run = await silentRun({ stallMs: 0, maxRunMs: 0 });
    await vi.advanceTimersByTimeAsync(DEVIN_MAX_RUN_MS * 2);
    await expect(run.complete()).resolves.toMatchObject({ text: expect.any(String) });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a watchdog without a wire reader names only stdout and stderr", async () => {
    vi.useFakeTimers();
    const expire = vi.fn();
    const watchdog = devinStallWatchdog(100, expire, undefined, 0);
    try {
      watchdog.activity("spawn");
      await vi.advanceTimersByTimeAsync(100);
      expect(expire.mock.calls[0]![0].message).toContain("silent signals: stdout, stderr");
      expect(expire.mock.calls[0]![0].message).not.toContain("ACP");
    } finally { watchdog.clear(); }
  });

  it("tailing handles split lines and UTF-8, and never rereads consumed bytes", async () => {
    const root = await temporaryRoot();
    const path = join(root, "wire.log");
    await writeFile(path, "");
    const progress = devinWireProgress(path);
    const line = Buffer.from('{"sessionId":"test","update":{"sessionUpdate":"agent_thought_chunk","content":{"text":"秘密"}}}\n');
    const split = line.indexOf(Buffer.from("秘")) + 1;
    appendFileSync(path, line.subarray(0, split));
    expect(progress()).toBeUndefined();
    appendFileSync(path, line.subarray(split));
    expect(progress()).toBe("ACP agent_thought_chunk");
    expect(progress()).toBeUndefined();
    appendFileSync(path, '{}\n{"method":"session/update","params":{"sessionId":"test","update":{"sessionUpdate":"tool_call"}}}\n');
    expect(progress()).toBe("ACP tool_call");
    expect(progress()).toBeUndefined();
    await writeFile(path, '{"sessionId":"test","update":{"sessionUpdate":"tool_call_update"}}\n');
    expect(progress()).toBe("ACP tool_call_update");
  });

  it("validates the max-run env using a four-hour default", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveDevinMaxRunMs({})).toBe(14_400_000);
    expect(resolveDevinMaxRunMs({ STRATUM_DEVIN_MAX_RUN_MS: "0" })).toBe(0);
    expect(resolveDevinMaxRunMs({ STRATUM_DEVIN_MAX_RUN_MS: "250" })).toBe(250);
    expect(resolveDevinMaxRunMs({ STRATUM_DEVIN_MAX_RUN_MS: "bad" })).toBe(DEVIN_MAX_RUN_MS);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Invalid STRATUM_DEVIN_MAX_RUN_MS"));
  });

  it("STRATUM_DEVIN_STALL_MS=0 disables the watchdog", async () => {
    vi.stubEnv("STRATUM_DEVIN_STALL_MS", "0");
    const root = await temporaryRoot();
    const run = await silentRun({ env: await homeEnv(root, { STRATUM_DEVIN_STALL_MS: "0" }) }, { envStall: true });
    await vi.advanceTimersByTimeAsync(DEVIN_STALL_MS * 2);
    await expect(run.complete()).resolves.toMatchObject({ text: expect.any(String) });
    expect(run.kill).not.toHaveBeenCalledWith(-424_242, "SIGTERM");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the timer on cancellation", async () => {
    const run = await silentRun();
    run.controller.abort(new Error("fixture cancelled"));
    await expect(run.result).rejects.toThrow("fixture cancelled");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("clears the watchdog and close deadline on process error", async () => {
    const run = await silentRun();
    run.child.emit("error", new Error("fixture process error"));
    await vi.advanceTimersByTimeAsync(250);
    await expect(run.result).rejects.toThrow("fixture process error");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("a partial exported answer cannot turn a stall into success", async () => {
    const run = await silentRun();
    await writeFile(join(run.runDir, "agent", "trajectory.json"), readFileSync(fixture("answer.atif.json"), "utf8"));
    await writeFile(join(run.runDir, "exit.rc"), "0\n");
    await vi.advanceTimersByTimeAsync(100);
    await expect(run.result).rejects.toThrow("devin stalled:");
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["bad", "-1", "1.5", "10ms", "", "9007199254740992"])("invalid env %j warns and uses the default", value => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(resolveDevinStallMs({ STRATUM_DEVIN_STALL_MS: value })).toBe(900_000);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("Invalid STRATUM_DEVIN_STALL_MS"));
  });

  it("uses the authoritative env and lets the injectable option override it", () => {
    vi.stubEnv("STRATUM_DEVIN_STALL_MS", "1");
    expect(resolveDevinStallMs({})).toBe(900_000);
    expect(resolveDevinStallMs({ STRATUM_DEVIN_STALL_MS: "1234" })).toBe(1234);
    expect(resolveDevinStallMs({ STRATUM_DEVIN_STALL_MS: "2147483648" })).toBe(2147483648);
    expect(resolveDevinStallMs({ STRATUM_DEVIN_STALL_MS: "1234" }, 0)).toBe(0);
  });
});

describe("DevinConnector — run layout and argv (D2)", () => {
  it("dispatches the wrapper with the seatbelt argv, per-run env, and the run dir deleted after", async () => {
    const root = await temporaryRoot();
    const env = await homeEnv(root);
    let seen: { argv: string[]; env: NodeJS.ProcessEnv; runDir: string } | undefined;
    const spawn = fakeDevinSpawn({
      exportText: readFileSync(fixture("answer.atif.json"), "utf8"),
      inspect: async ({ env: childEnv, argv, command }) => {
        const runDir = childEnv.STRATUM_DEVIN_RUN_DIR!;
        const layout = devinRunLayout(runDir);
        // runDir holds only supervisor files; A is the agent's area.
        expect(runDir).toContain(join(".stratum", "ts", "devin_fg"));
        expect((await stat(runDir)).mode & 0o777).toBe(0o700);
        for (const file of ["meta.json", "prompt.md", "devin.sb", "wrapper.sh", "stream.jsonl"]) {
          expect(existsSync(join(runDir, file)), file).toBe(true);
        }
        for (const dir of ["home/data/devin", "home/cache", "home/config/devin", "home/state", "tmp"]) {
          expect(existsSync(join(layout.agentDir, dir)), dir).toBe(true);
        }
        // argv = sandbox-exec -f devin.sb devin --model … -p
        expect(command).toBe(layout.wrapperPath);
        expect(argv.slice(0, 3)).toEqual(["sandbox-exec", "-f", layout.profilePath]);
        expect(argv.slice(3)).toEqual([
          "devin", "--model", testModels.devinDefault,
          "--permission-mode", "dangerous",
          "--config", layout.devinConfigPath,
          "--respect-workspace-trust", "false",
          "--export", layout.exportPath,
          "--prompt-file", layout.promptPath,
          "-p",
        ]);
        // Env: XDG + TMPDIR inside A, creds source/copy wired, prompt is 0600.
        for (const key of ["XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME"]) {
          expect(childEnv[key], key).toContain(join(runDir, "agent", "home"));
        }
        expect(childEnv.TMPDIR).toBe(`${layout.tmpDir}/`);
        expect(childEnv.CHISEL_ACP_WIRE_LOG).toBe(layout.wireLogPath);
        expect((await stat(layout.wireLogPath)).mode & 0o777).toBe(0o600);
        expect(await readFile(layout.profilePath, "utf8")).toContain(`(subpath "${realpathSync(layout.agentDir)}")`);
        expect(childEnv.STRATUM_DEVIN_CREDS_SOURCE).toBe(join(env.HOME!, ".local", "share", "devin", "credentials.toml"));
        expect(childEnv.STRATUM_DEVIN_CREDS_COPY).toBe(layout.credentialsCopyPath);
        expect((await stat(layout.promptPath)).mode & 0o777).toBe(0o600);
        expect((await stat(layout.profilePath)).mode & 0o777).toBe(0o600);
        expect((await stat(layout.wrapperPath)).mode & 0o777).toBe(0o700);
        seen = { argv, env: childEnv, runDir };
      },
    });
    const result = await connector({ cwd: root, env, spawn }).run("say hi");
    expect(result.text).toBe("hello");
    expect(seen).toBeDefined();
    // The foreground run dir is removed once the result is read (D2).
    expect(existsSync(seen!.runDir)).toBe(false);
  });

  it.each(["caller-wire.log", "", "protected"])("overrides inherited wire-log setting %j without extra read-only grants", async value => {
    const root = await temporaryRoot();
    const env = await homeEnv(root);
    env.CHISEL_ACP_WIRE_LOG = value === "protected" ? join(env.HOME!, ".stratum", "forged-status") : value;
    const spawn = fakeDevinSpawn({
      exportText: readFileSync(fixture("answer.atif.json"), "utf8"),
      inspect: async ({ env: childEnv }) => {
        const layout = devinRunLayout(childEnv.STRATUM_DEVIN_RUN_DIR!);
        expect(childEnv.CHISEL_ACP_WIRE_LOG).toBe(layout.wireLogPath);
        expect(statSync(layout.wireLogPath).mode & 0o777).toBe(0o600);
        const profile = await readFile(layout.profilePath, "utf8");
        expect(profile).toContain(`(subpath "${realpathSync(layout.agentDir)}")`);
        expect(profile).not.toContain("caller-wire.log");
        expect(profile).not.toContain("forged-status");
        expect(profile).not.toContain(`(subpath "${realpathSync(root)}")`);
      },
    });
    await expect(connector({ cwd: root, env, spawn }).run("p")).resolves.toMatchObject({ text: "hello" });
  });

  it("two concurrent preparations override the ambient wire path with private files", async () => {
    const root = await temporaryRoot();
    const env = await homeEnv(root);
    vi.stubEnv("HOME", env.HOME!);
    vi.stubEnv("STRATUM_CONFIG_FILE", env.STRATUM_CONFIG_FILE!);
    const ambient = join(root, "ambient-wire.log");
    vi.stubEnv("CHISEL_ACP_WIRE_LOG", ambient);
    const options = { root: join(root, "runs"), prompt: "p", cwd: root,
      model: testModels.devinDefault, sandboxMode: "read-only" as const, writableRoots: [] };
    const runs = await Promise.all([prepareDevinRun(options), prepareDevinRun(options)]);
    expect(runs[0]!.env.CHISEL_ACP_WIRE_LOG).not.toBe(runs[1]!.env.CHISEL_ACP_WIRE_LOG);
    for (const run of runs) {
      expect(run.env.CHISEL_ACP_WIRE_LOG).toBe(run.layout.wireLogPath);
      expect(statSync(run.layout.wireLogPath).mode & 0o777).toBe(0o600);
      expect(statSync(run.layout.runDir).mode & 0o777).toBe(0o700);
      expect(await readFile(run.layout.profilePath, "utf8")).not.toContain(ambient);
    }
    expect(existsSync(ambient)).toBe(false);
  });

  it("writes the sandbox preamble into prompt.md for read-only, not for full access", async () => {
    const root = await temporaryRoot();
    const env = await homeEnv(root);
    const texts: string[] = [];
    const capture = fakeDevinSpawn({
      exportText: readFileSync(fixture("answer.atif.json"), "utf8"),
      inspect: async ({ argv }) => {
        const promptPath = argv[argv.indexOf("--prompt-file") + 1]!;
        texts.push(await readFile(promptPath, "utf8"));
      },
    });
    await connector({ cwd: root, env, spawn: capture }).run("say hi");
    expect(texts[0]).toContain("[sandbox constraints]");
    expect(texts[0]).toContain("say hi");

    const fullEnv = await homeEnv(root, { STRATUM_DEVIN_ALLOW_FULL_ACCESS: "1" });
    await connector({
      cwd: root, env: fullEnv, sandboxMode: "danger-full-access",
      spawn: fakeDevinSpawn({
        exportText: readFileSync(fixture("answer.atif.json"), "utf8"),
        inspect: async ({ argv }) => {
          expect(argv[0]).toBe("devin"); // no sandbox-exec under full access
          const promptPath = argv[argv.indexOf("--prompt-file") + 1]!;
          texts.push(await readFile(promptPath, "utf8"));
        },
      }),
    }).run("say hi");
    expect(texts[1]).toBe("say hi");
  });

  it("copies the owner's mcp_config.json into the per-run home", async () => {
    const root = await temporaryRoot();
    const env = await homeEnv(root);
    await mkdir(join(env.HOME!, ".config", "devin"), { recursive: true });
    await writeFile(join(env.HOME!, ".config", "devin", "mcp_config.json"), "{\"mcpServers\":{\"memory\":{}}}\n");
    const spawn = fakeDevinSpawn({
      exportText: readFileSync(fixture("answer.atif.json"), "utf8"),
      inspect: async ({ env: childEnv }) => {
        const layout = devinRunLayout(childEnv.STRATUM_DEVIN_RUN_DIR!);
        expect(await readFile(layout.mcpConfigPath, "utf8")).toContain("memory");
        const config = JSON.parse(await readFile(layout.devinConfigPath, "utf8"));
        expect(config.permissions.allow).toEqual([]);
      },
    });
    await connector({ cwd: root, env, spawn }).run("p");
    expect(spawn).toHaveBeenCalledOnce();
  });

  it("scrubs provider keys and devin overrides from the child env (D7)", async () => {
    const root = await temporaryRoot();
    const env = await homeEnv(root, {
      ANTHROPIC_API_KEY: "sk", OPENAI_API_KEY: "sk", CLAUDECODE: "1",
      DEVIN_MODEL: "evil", DEVIN_PERMISSION_MODE: "auto", DEVIN_SANDBOX: "1",
      SMARTMEMORY_API_KEY: "sk", SMARTMEMORY_WORKSPACE_ID: "w",
    });
    const spawn = fakeDevinSpawn({
      exportText: readFileSync(fixture("answer.atif.json"), "utf8"),
      inspect: ({ env: childEnv }) => {
        for (const key of [
          "ANTHROPIC_API_KEY", "CLAUDE_API_KEY", "CLAUDECODE", "OPENAI_API_KEY",
          "DEVIN_MODEL", "DEVIN_PERMISSION_MODE", "DEVIN_SANDBOX",
          "SMARTMEMORY_API_KEY", "SMARTMEMORY_WORKSPACE_ID",
        ]) expect(childEnv[key], key).toBeUndefined();
      },
    });
    await connector({ cwd: root, env, spawn }).run("p");
  });

  it("fails before spawn with the named not-logged-in error when credentials are absent", async () => {
    const root = await temporaryRoot();
    const env = await homeEnv(root);
    await rm(join(env.HOME!, ".local", "share", "devin", "credentials.toml"));
    const spawn = fakeDevinSpawn({});
    await expect(connector({ cwd: root, env, spawn }).run("p"))
      .rejects.toThrow("devin is not logged in (run `devin auth`)");
    expect(spawn).not.toHaveBeenCalled();
    expect(existsSync(join(env.HOME!, ".stratum"))).toBe(false);
  });
});

describe("DevinConnector — ATIF result channel (D2/D6)", () => {
  const setup = async (fixtureName: string, extra: FakeOutcome = {}, env: NodeJS.ProcessEnv | undefined = undefined) => {
    const root = await temporaryRoot();
    const spawn = fakeDevinSpawn({
      exportText: readFileSync(fixture(fixtureName), "utf8"),
      ...extra,
    });
    const result = await connector({ cwd: root, env: env ?? await homeEnv(root), spawn }).run("p");
    return { root, result };
  };

  it("returns the last agent step's message and final_metrics usage, priced at usd:0 estimated", async () => {
    const { result } = await setup("toolcall.atif.json");
    expect(result.text).toBe("done");
    expect(result.usage).toMatchObject({ tokens: 41592 + 69, usd: 0 });
    expect(result.usdSource).toBe("estimated");
    expect(result.split).toEqual({ input: 41592, output: 69, cacheRead: 20736 });
    expect(result.telemetry).toMatchObject({ model: testModels.devinDefault });
  });

  it("emits agent_started, agent_relay and step_usage events", async () => {
    const events: ConnectorEvent[] = [];
    const root = await temporaryRoot();
    const spawn = fakeDevinSpawn({ exportText: readFileSync(fixture("answer.atif.json"), "utf8") });
    await connector({ cwd: root, env: await homeEnv(root), spawn, onEvent: (e) => { events.push(e); } }).run("p");
    expect(events.map((e) => e.kind)).toEqual(["agent_started", "agent_relay", "step_usage"]);
    expect(events[1]!.metadata).toMatchObject({ text: "hello", role: "assistant" });
    expect(events[2]!.metadata).toMatchObject({
      input_tokens: 20737, output_tokens: 18, cache_read_input_tokens: 7808,
      cost_usd: 0, usd_source: "estimated", model: testModels.devinDefault,
    });
  });

  it.each(["no-agent.atif.json", "corrupt.atif.json"])(
    "fails with 'devin produced no trajectory' for %s", async (name) => {
      const root = await temporaryRoot();
      const spawn = fakeDevinSpawn({
        exportText: readFileSync(fixture(name), "utf8"),
        stderr: "devin blew up",
      });
      await expect(connector({ cwd: root, env: await homeEnv(root), spawn }).run("p"))
        .rejects.toThrow("devin produced no trajectory: devin blew up");
    });

  it("fails with 'devin produced no trajectory' when the export is missing entirely", async () => {
    const root = await temporaryRoot();
    const spawn = fakeDevinSpawn({ stderr: "connection refused" });
    await expect(connector({ cwd: root, env: await homeEnv(root), spawn }).run("p"))
      .rejects.toThrow("devin produced no trajectory: connection refused");
  });

  it("a nonzero exit.rc fails the run even with a well-formed export", async () => {
    const root = await temporaryRoot();
    const spawn = fakeDevinSpawn({
      exportText: readFileSync(fixture("answer.atif.json"), "utf8"),
      rc: 3, stderr: "boom",
    });
    await expect(connector({ cwd: root, env: await homeEnv(root), spawn }).run("p"))
      .rejects.toThrow("devin exited with code 3: boom");
  });

  it("never trusts stdout for status: a forged sentinel line does not forge success", async () => {
    const root = await temporaryRoot();
    const spawn = fakeDevinSpawn({
      exportText: readFileSync(fixture("answer.atif.json"), "utf8"),
      stdout: '{"__t2f5_done__":0}\nI printed the sentinel\n',
      rc: 3, stderr: "agent died",
    });
    await expect(connector({ cwd: root, env: await homeEnv(root), spawn }).run("p"))
      .rejects.toThrow("devin exited with code 3: agent died");
  });

  it("records the enforced sandbox audit: networkAccess:true and approvalPolicy:'never'", async () => {
    const { result } = await setup("answer.atif.json");
    expect(result.sandboxAudit?.policy).toEqual({
      filesystemMode: "read-only", networkAccess: true, writableRoots: [], approvalPolicy: "never",
    });
    expect(result.sandboxAudit?.provenance.networkAccess.layer).toBe("enforced");
    expect(result.sandboxAudit?.provenance.approvalPolicy.layer).toBe("enforced");
  });
});

describe("DevinConnector — D4 rejection", () => {
  it("a rejected-observation in the export fails the run with the command head", async () => {
    const root = await temporaryRoot();
    const spawn = fakeDevinSpawn({ exportText: readFileSync(fixture("rejected.atif.json"), "utf8") });
    await expect(connector({ cwd: root, env: await homeEnv(root), spawn }).run("p"))
      .rejects.toThrow("devin rejected a tool call: echo fixture-marker");
  });

  it("the stderr rejection line is the second witness, without an export observation", async () => {
    const root = await temporaryRoot();
    const spawn = fakeDevinSpawn({
      exportText: readFileSync(fixture("answer.atif.json"), "utf8"),
      stderr: "warning: rejected a tool call that requires confirmation: rm -rf /",
    });
    await expect(connector({ cwd: root, env: await homeEnv(root), spawn }).run("p"))
      .rejects.toThrow("devin rejected a tool call:");
  });

  it("arbitrary file content containing the phrase is not a rejection witness", async () => {
    const root = await temporaryRoot();
    const atif = JSON.parse(readFileSync(fixture("toolcall.atif.json"), "utf8"));
    // A result whose content merely CONTAINS the phrase — a file the agent
    // catted — is not the rejection observation (D4: exact-match on the call's
    // own observation only).
    atif.steps[2].observation.results[0].content = "log line: Tool execution was rejected by the user\nmore";
    const spawn = fakeDevinSpawn({ exportText: JSON.stringify(atif) });
    const result = await connector({ cwd: root, env: await homeEnv(root), spawn }).run("p");
    expect(result.text).toBe("done");
  });
});

describe("DevinConnector — sandbox policy gates (D3)", () => {
  it("refuses read-only/workspace-write off macOS with a named error", async () => {
    const env = { HOME: await temporaryRoot(), PATH: "/usr/bin:/bin" };
    for (const sandboxMode of ["read-only", "workspace-write"] as const) {
      expect(() => connector({ sandboxMode, platform: "linux", env }))
        .toThrow(/requires macOS seatbelt \(sandbox-exec\)/);
    }
    expect(() => connector({ sandboxMode: "read-only", platform: "win32", env }))
      .toThrow(/not supported on win32/);
  });

  it("permits danger-full-access off macOS only with the devin opt-in", async () => {
    const env = { HOME: await temporaryRoot(), PATH: "/usr/bin:/bin" };
    expect(() => connector({
      sandboxMode: "danger-full-access", platform: "linux",
      env: { ...env, STRATUM_DEVIN_ALLOW_FULL_ACCESS: "1" },
    })).not.toThrow();
    expect(() => connector({ sandboxMode: "danger-full-access", env }))
      .toThrow("STRATUM_DEVIN_ALLOW_FULL_ACCESS");
  });

  it("rejects a workspace-write cwd that overlaps the stratum root before spawn", async () => {
    const root = await temporaryRoot();
    const env = await homeEnv(root);
    const cwd = join(env.HOME!, ".stratum", "nested");
    await mkdir(cwd, { recursive: true });
    const spawn = fakeDevinSpawn({});
    await expect(connector({ cwd, env, sandboxMode: "workspace-write", spawn }).run("p"))
      .rejects.toThrow(/devin cannot grant .*overlaps stratum's state directory/);
    expect(spawn).not.toHaveBeenCalled();
  });

  it("rejects a writableRoots entry overlapping the stratum root", async () => {
    const root = await temporaryRoot();
    const env = await homeEnv(root);
    const spawn = fakeDevinSpawn({});
    await expect(connector({
      cwd: root, env, sandboxMode: "workspace-write",
      writableRoots: [join(env.HOME!, ".stratum")], spawn,
    }).run("p")).rejects.toThrow(/devin cannot grant/);
    expect(spawn).not.toHaveBeenCalled();
  });
});

describe("DevinConnector — stdout overrun and cancellation (D2)", () => {
  it("kills the run on an unterminated stdout buffer past the limit", async () => {
    vi.stubEnv("STRATUM_CODEX_STREAM_LIMIT_BYTES", "65536");
    try {
      const root = await temporaryRoot();
      const spawn = fakeDevinSpawn({
        exportText: readFileSync(fixture("answer.atif.json"), "utf8"),
        stdout: "x".repeat(70_000), // one over-limit line, never terminated
      });
      await expect(connector({ cwd: root, env: await homeEnv(root), spawn }).run("p"))
        .rejects.toThrow(/devin stdout exceeded STRATUM_CODEX_STREAM_LIMIT_BYTES/);
      const child = vi.mocked(spawn).mock.results[0]?.value as ChildProcessWithoutNullStreams;
      expect(child.kill).toHaveBeenCalledWith("SIGKILL");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("aborts the wrapper group on signal and surfaces the abort", async () => {
    const root = await temporaryRoot();
    const controller = new AbortController();
    const spawn = fakeDevinSpawn({
      exportText: readFileSync(fixture("answer.atif.json"), "utf8"),
      inspect: () => { controller.abort(); },
    });
    await expect(connector({ cwd: root, env: await homeEnv(root), spawn, signal: controller.signal }).run("p"))
      .rejects.toThrow();
    const child = vi.mocked(spawn).mock.results[0]?.value as ChildProcessWithoutNullStreams;
    expect(child.kill).toHaveBeenCalled();
  });

  it("reports the wrapper pid through onSpawn when ownProcessGroup is set", async () => {
    const root = await temporaryRoot();
    const pids: number[] = [];
    const spawn = vi.fn<SpawnProcess>((...callArgs) => {
      const child = fakeDevinSpawn({ exportText: readFileSync(fixture("answer.atif.json"), "utf8") })(...callArgs);
      (child as ChildProcessWithoutNullStreams & { pid: number }).pid = 424_242;
      return child;
    });
    await connector({
      cwd: root, env: await homeEnv(root), spawn,
      ownProcessGroup: true, onSpawn: (pid) => pids.push(pid),
    }).run("p");
    expect(pids).toEqual([424_242]);
  });
});

describe("DevinConnector — stderr witnesses (D3 fact)", () => {
  it("an empty 'Available:' model list is a named transient failure, not a validation error", async () => {
    const root = await temporaryRoot();
    const spawn = fakeDevinSpawn({
      exportText: readFileSync(fixture("answer.atif.json"), "utf8"),
      stderr: `Unknown model: '${testModels.devinDefault}'
Available:
`,
    });
    await expect(connector({ cwd: root, env: await homeEnv(root), spawn }).run("p"))
      .rejects.toThrow(/empty model list \(transient devin-service degradation\)/);
  });

  it("a nonempty Available: list falls through to the normal error", async () => {
    const root = await temporaryRoot();
    const spawn = fakeDevinSpawn({
      stderr: `Unknown model: 'typo'
Available: ${testModels.devinMedium}, ${testModels.devinDefault}`,
      rc: 1,
    });
    await expect(connector({ cwd: root, env: await homeEnv(root), spawn }).run("p"))
      .rejects.toThrow("devin produced no trajectory");
  });
});

describe("runAgent devin dispatch (S1b wiring)", () => {
  it("passes the devinSpawn boundary through to the connector", async () => {
    const root = await temporaryRoot();
    const env = await homeEnv(root);
    const spawn = fakeDevinSpawn({ exportText: readFileSync(fixture("answer.atif.json"), "utf8") });
    const result = await runAgent(
      { agent: "devin", prompt: "p", cwd: root, env, registryRoot: root },
      { devinSpawn: spawn },
    );
    expect(result).toMatchObject({ text: "hello" });
    expect(spawn).toHaveBeenCalledOnce();
  });

  it("refuses background devin dispatch at the credentials gate", async () => {
    const root = await temporaryRoot();
    await expect(runAgent({
      agent: "devin", prompt: "p", cwd: root, background: true, registryRoot: root,
      env: { STRATUM_CONFIG_FILE: join(root, "missing-user.toml"), HOME: root, PATH: "/usr/bin:/bin" },
    })).rejects.toThrow("devin is not logged in (run `devin auth`)");
  });
});


describe("DevinConnector — real process groups on normal completion", () => {
  it.each([false, true])("reaps a leftover child before removing its run dir (ignores SIGTERM: %s)", async (ignoreTerm) => {
    const root = await temporaryRoot();
    let pid: number | undefined;
    let runDir = "";
    let descendantPid = 0;
    let aliveAtClose = false;
    const spawn: SpawnProcess = (_command, _args, options) => {
      runDir = options.env!.STRATUM_DEVIN_RUN_DIR!;
      const layout = devinRunLayout(runDir);
      // The child acknowledges readiness over IPC, then outlives its wrapper.
      // Ignoring stdout/stderr lets the wrapper's close fire independently.
      const descendant = `
        const fs = require('node:fs');
        ${ignoreTerm ? "process.on('SIGTERM', () => {});" : ""}
        setTimeout(() => {
          fs.mkdirSync(${JSON.stringify(layout.agentDir)}, { recursive: true });
          fs.writeFileSync(${JSON.stringify(join(layout.agentDir, "late-cache"))}, 'late');
        }, 2000);
        process.send('ready');
        process.disconnect();
      `;
      const wrapper = `
        const fs = require('node:fs');
        const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(descendant)}],
          { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
        child.once('message', () => {
          fs.writeFileSync(${JSON.stringify(join(root, "child.pid"))}, String(child.pid));
          fs.writeFileSync(${JSON.stringify(layout.exportPath)}, ${JSON.stringify(readFileSync(fixture("answer.atif.json"), "utf8"))});
          fs.writeFileSync(${JSON.stringify(layout.exitRcPath)}, '0');
          process.exit(0);
        });
      `;
      const child = nodeSpawn(process.execPath, ["-e", wrapper], options);
      pid = child.pid;
      child.once("close", () => {
        descendantPid = Number(readFileSync(join(root, "child.pid"), "utf8"));
        aliveAtClose = process.kill(descendantPid, 0);
      });
      return child;
    };
    try {
      const result = await connector({ cwd: root, env: await homeEnv(root), spawn, cancellationGraceMs: 100 }).run("p");
      expect(result.text).toBe("hello");
      expect(aliveAtClose).toBe(true);
      expect(() => process.kill(descendantPid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
      expect(() => process.kill(-pid!, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
      expect(existsSync(runDir)).toBe(false);
    } finally {
      if (pid) { try { process.kill(-pid, "SIGKILL"); } catch { /* already reaped */ } }
    }
  });

  it("does not signal or wait the grace period when the wrapper leaves an empty group", async () => {
    const root = await temporaryRoot();
    let pid: number | undefined;
    let runDir = "";
    let closedAt = 0;
    const kill = vi.spyOn(process, "kill");
    const spawn: SpawnProcess = (_command, _args, options) => {
      runDir = options.env!.STRATUM_DEVIN_RUN_DIR!;
      const layout = devinRunLayout(runDir);
      const script = `const fs = require('node:fs');
        fs.writeFileSync(${JSON.stringify(layout.exportPath)}, ${JSON.stringify(readFileSync(fixture("answer.atif.json"), "utf8"))});
        fs.writeFileSync(${JSON.stringify(layout.exitRcPath)}, '0');`;
      const child = nodeSpawn(process.execPath, ["-e", script], options);
      pid = child.pid;
      child.once("close", () => { closedAt = performance.now(); });
      return child;
    };
    const result = await connector({ cwd: root, env: await homeEnv(root), spawn, cancellationGraceMs: 2000 }).run("p");
    expect(result.text).toBe("hello");
    expect(closedAt).toBeGreaterThan(0);
    expect(performance.now() - closedAt).toBeLessThan(500);
    expect(kill.mock.calls.filter(([target, signal]) => target === -pid! && signal !== 0)).toEqual([]);
    expect(existsSync(runDir)).toBe(false);
  });
});

describe("DevinConnector — real child startup failures", () => {
  it("retains immediate stderr while identity capture is pending", async () => {
    const root = await temporaryRoot();
    let closed!: Promise<void>;
    const spawn: SpawnProcess = (_command, _args, options) => {
      const child = nodeSpawn(process.execPath, ["-e", "process.stderr.write('sandbox startup denied\\n'); process.exit(1)"], options);
      closed = new Promise(resolve => child.once("close", () => resolve()));
      return child;
    };
    await expect(connector({ cwd: root, env: await homeEnv(root), spawn,
      procStartTime: async () => { await closed; return "captured-start"; },
    }).run("p")).rejects.toThrow("sandbox startup denied");
  });

  it.each(["agent_started", "onSpawn", "identity"] as const)("tears down a real wrapper on %s failure", async (failure) => {
    const root = await temporaryRoot();
    const env = await homeEnv(root);
    const bin = join(root, "bin");
    await mkdir(bin);
    await writeFile(join(bin, "devin"), "#!/bin/sh\nexec sleep 30\n", { mode: 0o700 });
    env.PATH = `${bin}:/usr/bin:/bin`;
    env.STRATUM_DEVIN_ALLOW_FULL_ACCESS = "1";
    const controller = new AbortController();
    let pid: number | undefined;
    let runDir = "";
    let sawMeta = false;
    let copyRemovedAtClose = false;
    const spawn: SpawnProcess = (command, args, options) => {
      runDir = options.env!.STRATUM_DEVIN_RUN_DIR!;
      const child = nodeSpawn(command, args, options);
      pid = child.pid;
      child.once("close", () => {
        sawMeta = existsSync(join(runDir, "meta.json"));
        copyRemovedAtClose = !existsSync(devinRunLayout(runDir).credentialsCopyPath);
      });
      return child;
    };
    const realIdentity = (await vi.importActual<typeof import("../../src/connectors/proc_identity.js")>("../../src/connectors/proc_identity.js")).procStartTime;
    try {
      await expect(connector({ cwd: root, env, spawn, signal: controller.signal,
        sandboxMode: "danger-full-access", ownProcessGroup: true, cancellationGraceMs: 100,
        procStartTime: async (wrapperPid) => {
          // Make the identity refusal exercise a LIVE wrapper with a copy,
          // rather than winning a race against the shell's startup.
          await vi.waitFor(() => expect(existsSync(devinRunLayout(runDir).credentialsCopyPath)).toBe(true));
          return failure === "identity" ? undefined : realIdentity(wrapperPid);
        },
        onSpawn: () => { if (failure === "onSpawn") throw new Error("onSpawn failed"); },
        onEvent: (event) => { if (failure === "agent_started" && event.kind === "agent_started") throw new Error("agent_started failed"); },
      }).run("p")).rejects.toThrow(failure === "identity" ? "devin wrapper identity could not be captured" : `${failure} failed`);
      expect(pid).toBeTypeOf("number");
      expect(() => process.kill(-pid!, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
      expect(getEventListeners(controller.signal, "abort")).toEqual([]);
      expect(existsSync(join(runDir, "agent", "home", "data", "devin", "credentials.toml"))).toBe(false);
      if (failure === "identity") {
        expect(sawMeta).toBe(false);
        expect(copyRemovedAtClose).toBe(true);
      }
    } finally {
      if (pid) { try { process.kill(-pid, "SIGKILL"); } catch { /* already reaped */ } }
    }
  });
});
