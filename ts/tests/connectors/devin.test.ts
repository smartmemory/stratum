import { spawn as nodeSpawn } from "node:child_process";
import { getEventListeners } from "node:events";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams, SpawnOptionsWithoutStdio } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConnectorEvent } from "../../src/connectors/base.js";
import type { SpawnProcess } from "../../src/connectors/codex.js";
import { DevinConnector, type DevinConnectorOptions } from "../../src/connectors/devin.js";
import { devinRunLayout } from "../../src/connectors/devin-wrapper.js";
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
          "devin", "--model", "swe-2-high",
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
    expect(result.telemetry).toMatchObject({ model: "swe-2-high" });
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
      cost_usd: 0, usd_source: "estimated", model: "swe-2-high",
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
      stderr: "Unknown model: 'swe-2-high'\nAvailable:\n",
    });
    await expect(connector({ cwd: root, env: await homeEnv(root), spawn }).run("p"))
      .rejects.toThrow(/empty model list \(transient devin-service degradation\)/);
  });

  it("a nonempty Available: list falls through to the normal error", async () => {
    const root = await temporaryRoot();
    const spawn = fakeDevinSpawn({
      stderr: "Unknown model: 'typo'\nAvailable: swe-2-medium, swe-2-high",
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
