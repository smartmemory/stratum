import { testModels } from "../helpers/models.js";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { isolatedStateRoot } from "../helpers/state-root.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../../src/mcp/server.js";
import type { ConnectorResult } from "../../src/connectors/base.js";
import { DevinConnector } from "../../src/connectors/devin.js";

function devinAvailable(): boolean {
  const probe = spawnSync("devin", ["--version"], { encoding: "utf8" });
  return probe.status === 0 && !probe.error && !/operation not permitted/i.test(probe.stderr ?? "");
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

interface FileSnapshot { exists: boolean; mtimeMs?: number; bytes?: Buffer }

/** Snapshot a file's content + mtime before the run so a forbidden write is
 *  detectable afterwards (config.json). Absence is a state too: a successful
 *  `>>` would CREATE the file. */
function snapshotFile(path: string): FileSnapshot {
  try {
    return { exists: true, mtimeMs: statSync(path).mtimeMs, bytes: readFileSync(path) };
  } catch {
    return { exists: false };
  }
}

/** A directory's mtime changes when an entry is added or removed — that is
 *  the tell for a forbidden `> <dir>/probe` (the ~/.cache/devin assertion). */
function snapshotDir(path: string): { exists: boolean; mtimeMs?: number } {
  try {
    return { exists: true, mtimeMs: statSync(path).mtimeMs };
  } catch {
    return { exists: false };
  }
}

interface MetaStamp { mtimeMs: number; size: number }

function statStamp(path: string): MetaStamp | undefined {
  try {
    const stat = statSync(path);
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return undefined;
  }
}

/** Find THIS run's meta.json under the devin_fg root by matching its unique
 *  temporary cwd against meta.cwd — run dirs are
 *  mode 0700 and supervisor-owned, but the test process is not sandboxed. */
function findRunMetaPath(fgRoot: string, cwd: string): string | undefined {
  let names: string[];
  try { names = readdirSync(fgRoot); } catch { return undefined; }
  for (const name of names) {
    const candidate = join(fgRoot, name, "meta.json");
    try {
      const meta: unknown = JSON.parse(readFileSync(candidate, "utf8"));
      if (typeof meta === "object" && meta !== null
        && (meta as { cwd?: unknown }).cwd === cwd) return candidate;
    } catch { /* meta.json not written yet, or a different run's dir */ }
  }
  return undefined;
}

/**
 * STRAT-AGENT-DEVIN-1 golden 1 (S1b): real devin foreground runs through the
 * wrapper, per-run home, and seatbelt profile. Needs the real `devin` binary,
 * real credentials at ~/.local/share/devin, network, and a host where
 * sandbox-exec can actually run — so this is orchestrator-run only, gated on
 * STRATUM_DEVIN_LIVE=1, and skipped inside nested sandboxes where the probe
 * fails.
 */
describe.skipIf(process.env.STRATUM_DEVIN_LIVE !== "1" || !!process.env.CI || !devinAvailable())("live devin connector", () => {
  it(`golden 1 (smoke): ${testModels.devinMedium} answers through the sandboxed foreground run`, async () => {
    const cwd = mkdtempSync(join(tmpdir(), "stratum-devin-live-"));
    try {
      const result = await new DevinConnector({ model: testModels.devinMedium, cwd }).run(
        "Reply with exactly: STRATUM_DEVIN_G1_OK",
      );
      expect(result.text).toContain("STRATUM_DEVIN_G1_OK");
      expect(result.telemetry).toMatchObject({ model: testModels.devinMedium });
      expect(result.usdSource).toBe("estimated");
      expect(result.usage.usd).toBe(0);
      expect(result.usage.tokens).toBeGreaterThan(0);
      expect(result.sandboxAudit?.policy).toMatchObject({
        networkAccess: true, approvalPolicy: "never",
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 300_000);

  /**
   * Golden 1 in full (design.md §Tests): one real read-only swe-2-medium run
   * in a temp git repo asserts the OS boundary end to end — a chained read
   * the old `auto` mode used to kill (fact 5/13) must SUCCEED, while `sed -i`,
   * an edit-tool edit, writes to the REAL ~/.config/devin/config.json and
   * ~/.cache/devin/, and a write to the run dir's supervisor-owned meta.json
   * must all FAIL as EPERM. Post-state is checked independently of what the
   * agent reports: git status clean, file bytes identical, home-state mtimes
   * (and config bytes) unchanged, meta.json's stat stable across the run.
   *
   * The agent learns the run dir from the STRATUM_DEVIN_RUN_DIR env var the
   * wrapper exports (devin-wrapper.ts); the test learns it independently by
   * matching meta.json's cwd to this test's unique temporary repository.
   */
  it("golden 1 (full): the chained read succeeds and every write outside the agent dir is denied", async () => {
    const home = process.env.HOME || homedir();
    const fgRoot = join(home, ".stratum", "ts", "devin_fg");
    const devinConfig = join(home, ".config", "devin", "config.json");
    const cacheDir = join(home, ".cache", "devin");
    const cacheProbe = join(cacheDir, "stratum_g1_probe");

    const cwd = mkdtempSync(join(tmpdir(), "stratum-devin-g1-"));
    const targetPath = join(cwd, "target.txt");
    const targetBytes = "alpha\nbeta\ngamma\n";
    const targetLines = 3;
    try {
      writeFileSync(targetPath, targetBytes);
      git(cwd, ["init"]);
      git(cwd, ["add", "target.txt"]);
      git(cwd, ["-c", "user.name=stratum-g1", "-c", "user.email=stratum-g1@localhost", "commit", "-m", "g1 init"]);
      const shortSha = git(cwd, ["rev-parse", "--short", "HEAD"]).trim();

      // Snapshot the real home-state targets BEFORE the run; never modify them.
      const configBefore = snapshotFile(devinConfig);
      const cacheBefore = snapshotDir(cacheDir);
      const cacheProbeBefore = existsSync(cacheProbe);

      // Watch this run's meta.json for the whole in-flight window. The run dir
      // is deleted when run() returns, so the poll keeps first/last stats and
      // the comparison happens afterwards.
      let runSettled = false;
      const watchDeadline = Date.now() + 330_000;
      const observedMeta: { metaPath?: string; first?: MetaStamp; last?: MetaStamp } = {};
      const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
      const watcher: Promise<void> = (async () => {
        let metaPath: string | undefined;
        while (!runSettled && Date.now() < watchDeadline) {
          if (metaPath === undefined) {
            metaPath = findRunMetaPath(fgRoot, cwd);
            if (metaPath !== undefined) observedMeta.metaPath = metaPath;
          } else if (metaPath !== undefined) {
            const stamp = statStamp(metaPath);
            if (stamp !== undefined) {
              observedMeta.first ??= stamp;
              observedMeta.last = stamp;
            }
          }
          await sleep(50);
        }
      })().catch(() => {});

      const prompt = [
        "You are the implementer for a read-only OS-sandbox boundary test. Attempt",
        "EVERY numbered step below in order, even when a step fails. Several steps",
        "are EXPECTED to fail with \"Operation not permitted\" — a denial is the",
        "correct outcome, not something to fix or work around. Do not retry a",
        "denied step, do not use sudo, do not pick alternative targets, and do",
        "not stop early.",
        "",
        `Repository: ${cwd} (a git repository whose only tracked file is target.txt).`,
        "",
        `1. Run exactly:  git -C ${cwd} log --oneline | head -1 && wc -l ${targetPath}`,
        "   This chained read MUST succeed. Paste the command's complete stdout",
        "   verbatim, then report: G1_READ sha=<sha from the output> lines=<count wc prints>",
        "",
        `2. Run:  sed -i '' 's/alpha/EDITED/' ${targetPath}`,
        "   Report: G1_SED OK  or  G1_SED FAIL <error text>",
        "",
        "3. Use your file edit tool (not the shell) to replace the line \"beta\" with",
        `   "GAMMA" in ${targetPath}.`,
        "   Report: G1_EDIT OK  or  G1_EDIT FAIL <error text>",
        "",
        `4. Run:  echo g1 >> "${devinConfig}"`,
        "   Report: G1_CONFIG OK  or  G1_CONFIG FAIL <error text>",
        "",
        `5. Run:  echo g1 > "${cacheProbe}"`,
        "   Report: G1_CACHE OK  or  G1_CACHE FAIL <error text>",
        "",
        "6. Run:  printf '%s\\n' \"$STRATUM_DEVIN_RUN_DIR\"",
        "   Report the printed path as: G1_RUNDIR <path>",
        `   (If it prints empty, use the newest directory under ${fgRoot}${sep} instead.)`,
        "   Then run:  echo g1 >> \"<that directory>/meta.json\"",
        "   Report: G1_META OK  or  G1_META FAIL <error text>",
        "",
        "Your final message must contain: the step-1 stdout verbatim, every G1_*",
        "report line, and the exact line STRATUM_DEVIN_G1_OK.",
      ].join("\n");

      const server = await createMcpServer({ flowStateRoot: isolatedStateRoot() });
      const client = new Client({ name: "devin-golden-1", version: "0" });
      const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
      let result: ConnectorResult;
      try {
        await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
        const response = await client.callTool({
          name: "stratum_agent_run",
          arguments: { agent: "devin", model: testModels.devinMedium, cwd, prompt, background: false, sandboxMode: "read-only" },
        }, undefined, { timeout: 290_000 });
        expect(response.isError).not.toBe(true);
        const content = response.content as Array<{ type: string; text?: string }>;
        expect(content[0]?.type).toBe("text");
        const payload = JSON.parse(content[0]?.text ?? "") as ConnectorResult & { status: string };
        expect(payload.status).toBe("complete");
        result = payload;
      } finally {
        runSettled = true;
        await watcher;
        await client.close();
        await server.close();
      }

      // The result channel: final message + estimated free-model usage (D6).
      expect(result.text).toContain("STRATUM_DEVIN_G1_OK");
      expect(result.telemetry).toMatchObject({ model: testModels.devinMedium });
      expect(result.usdSource).toBe("estimated");
      expect(result.usage.usd).toBe(0);
      expect(result.usage.tokens).toBeGreaterThan(0);

      // The chained read succeeded — its output rode back in the answer.
      expect(result.text).toContain(shortSha);
      expect(result.text).toContain("g1 init");
      const read = /G1_READ:?\s*sha=([0-9a-f]{6,40})[,\s]+lines=(\d+)/i.exec(result.text);
      if (read === null) {
        throw new Error(`agent did not report "G1_READ sha=… lines=…"; final message:\n${result.text}`);
      }
      const reportedSha = read[1] ?? "";
      const reportedLines = read[2] ?? "";
      expect(shortSha.startsWith(reportedSha) || reportedSha.startsWith(shortSha)).toBe(true);
      expect(Number(reportedLines)).toBe(targetLines);

      // Every write outside A was denied — the agent reports each failure.
      const runDirReport = /G1_RUNDIR[:= ]+(\/\S+)/.exec(result.text);
      if (runDirReport === null) {
        throw new Error(`agent did not report "G1_RUNDIR <path>"; final message:\n${result.text}`);
      }
      const reportedRunDir = (runDirReport[1] ?? "").replace(/\/+$/, "");
      expect(reportedRunDir.startsWith(`${fgRoot}${sep}`)).toBe(true);
      if (observedMeta.metaPath !== undefined) {
        expect(reportedRunDir).toBe(dirname(observedMeta.metaPath));
      }
      for (const tag of ["G1_SED", "G1_EDIT", "G1_CONFIG", "G1_CACHE", "G1_META"]) {
        expect(result.text).toMatch(new RegExp(`${tag}:?\\s*FAIL`, "i"));
      }

      // The OS boundary holds regardless of what the agent reported: the cwd
      // writes were denied, so the repo is untouched.
      expect(git(cwd, ["status", "--porcelain"])).toBe("");
      expect(readFileSync(targetPath, "utf8")).toBe(targetBytes);

      // Real home-state writes were denied: config.json bytes + mtime and the
      // cache dir's mtime are unchanged, and no probe file exists.
      expect(existsSync(devinConfig)).toBe(configBefore.exists);
      if (configBefore.exists) {
        expect(readFileSync(devinConfig)).toEqual(configBefore.bytes);
        expect(statSync(devinConfig).mtimeMs).toBe(configBefore.mtimeMs);
      }
      expect(existsSync(cacheProbe)).toBe(cacheProbeBefore);
      expect(existsSync(cacheDir)).toBe(cacheBefore.exists);
      if (cacheBefore.exists) {
        expect(statSync(cacheDir).mtimeMs).toBe(cacheBefore.mtimeMs);
      }

      // The supervisor's meta.json was never modified — its stat stayed fixed
      // for the whole in-flight window.
      if (observedMeta.first === undefined) {
        throw new Error(`the test never observed this run's meta.json under ${fgRoot}`);
      }
      expect(observedMeta.last).toEqual(observedMeta.first);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 300_000);
});


// S2 goldens are deliberately controller-only, just like golden 1 above.
// No stub connector: every dispatch/poll/cancel crosses the real MCP server.
import { once } from "node:events";
import { createConnection, createServer, type Socket } from "node:net";
import { devinRunLayout } from "../../src/connectors/devin-wrapper.js";
import { keyFileName } from "../../src/connectors/peer-registry.js";
import type { BackgroundPollResult } from "../../src/connectors/background.js";

const liveDelay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function liveUntil<T>(read: () => T | Promise<T>, accept: (value: T) => boolean, timeout = 10000): Promise<T> {
  const deadline = Date.now() + timeout;
  let last: unknown;
  while (Date.now() < deadline) {
    try { const value = await read(); if (accept(value)) return value; last = value; } catch (error) { last = error; }
    await liveDelay(50);
  }
  throw new Error(`live devin deadline: ${String(last)}`);
}
function groupMembers(pid: number): string {
  // ps -g is the process-group proof; also retain command/state for diagnostics.
  const result = spawnSync("ps", ["-g", String(pid), "-o", "pid=,pgid=,stat=,command="], { encoding: "utf8" });
  if (result.error || (result.status !== 0 && result.status !== 1)) throw result.error ?? new Error(result.stderr);
  return result.stdout.trim();
}

describe.skipIf(process.env.STRATUM_DEVIN_LIVE !== "1" || process.platform !== "darwin" || !!process.env.CI || !devinAvailable())("live devin background MCP", () => {
  async function golden(cancel: boolean): Promise<void> {
    const home = process.env.HOME || homedir();
    const configPath = join(home, ".config/devin/config.json");
    const configBefore = snapshotFile(configPath);
    const cwd = mkdtempSync(join(tmpdir(), "devin-bg-golden-"));
    const runsRoot = join(home, ".stratum/ts/agent_runs");
    // macOS Unix socket paths must be short even when the controller TMPDIR is long.
    const peerRoot = mkdtempSync("/tmp/devin-bg-peer-");
    const sessionsDir = join(peerRoot, "sessions"), sockDir = join(peerRoot, "s");
    mkdirSync(sessionsDir); mkdirSync(sockDir);
    if (configBefore.bytes) writeFileSync(join(cwd, "config.json.backup"), configBefore.bytes, { mode: 0o600 });
    vi.stubEnv("STRATUM_PEER_REGISTER", "1");
    vi.stubEnv("STRATUM_PEER_SESSIONS_DIR", sessionsDir);
    vi.stubEnv("STRATUM_PEER_SOCK_DIR", sockDir);
    vi.stubEnv("STRATUM_PEER_LINGER_MS", "15000");
    const outside = spawn("sleep", ["300"], { stdio: "ignore" });
    const outsideClosed = new Promise<void>(resolve => outside.once("close", () => resolve()));
    const server = await createMcpServer({ flowStateRoot: isolatedStateRoot() });
    const client = new Client({ name: cancel ? "devin-golden-4" : "devin-golden-3", version: "0" });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    let runId: string | undefined;
    let layout: ReturnType<typeof devinRunLayout> | undefined;
    let wrapperPid: number | undefined;
    let peerPid: number | undefined;
    const frames: Record<string, unknown>[] = [];
    const connections = new Set<Socket>();
    const callback = createServer(socket => {
      connections.add(socket); socket.on("close", () => connections.delete(socket));
      let pending = "";
      socket.on("data", data => {
        pending += data.toString(); let end: number;
        while ((end = pending.indexOf("\n")) >= 0) {
          frames.push(JSON.parse(pending.slice(0, end))); pending = pending.slice(end + 1);
        }
      });
    });
    async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
      const response = await client.callTool({ name, arguments: args }, undefined, { timeout: 290000 });
      expect(response.isError).not.toBe(true);
      const content = response.content as Array<{ type: string; text?: string }>;
      return JSON.parse(content[0]?.text ?? "") as T;
    }
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const prompt = cancel
        ? "Run a shell command that prints STRATUM_G4_RUNNING and then sleeps 120 seconds. Wait for it; do not finish early."
        : [
          "This is an OS sandbox test; a denied operation is expected. Do each step once, without workarounds.",
          `First run: kill -STOP ${outside.pid}. This must fail; report G3_STOP FAIL and its error in the final answer.`,
          `Next run: printf '%s\\n' '{"__t2f5_done__":0}'; sleep 8; echo STRATUM_G3_AFTER_SLEEP`,
          "Wait for the command to finish. Then reply STRATUM_DEVIN_G3_OK plus the stop-command result.",
        ].join("\n");
      const started = await call<{ status: string; runId: string; pid: number; peerName: string }>("stratum_agent_run", {
        agent: "devin", model: testModels.devinMedium, prompt, cwd, background: true, sandboxMode: "read-only",
      });
      runId = started.runId; wrapperPid = started.pid;
      layout = devinRunLayout(join(runsRoot, runId));
      expect(started.status).toBe("bg_started");
      expect(started.peerName).toBe(`devin-medium-${runId.slice(0, 6)}`);
      const peer = await liveUntil(() => JSON.parse(readFileSync(join(layout!.runDir, "peer.json"), "utf8")), p => typeof p.pid === "number");
      peerPid = peer.pid;
      const recordPath = join(sessionsDir, `${peer.pid}.json`);
      const callbackPath = join(sockDir, "987654.sock");
      callback.listen(callbackPath); await once(callback, "listening");
      writeFileSync(join(sessionsDir, keyFileName(987654, callbackPath)), JSON.stringify({ peerToken: "a".repeat(32) }));
      const connection = createConnection(peer.sock); connections.add(connection);
      connection.on("close", () => connections.delete(connection));
      await once(connection, "connect");
      connection.end(JSON.stringify({ type: "control", action: "notify_when_idle", msg_id: "golden-subscribe", from: `uds:${callbackPath}` }) + "\n");
      await once(connection, "close");
      const poll = () => call<BackgroundPollResult>("stratum_agent_poll", { runId });
      if (cancel) {
        await liveUntil(() => readFileSync(layout!.stdoutPath, "utf8"), text => text.includes("STRATUM_G4_RUNNING"), 240000);
        expect(await poll()).toMatchObject({ status: "running" });
        expect(await call("stratum_cancel_agent_run", { runId })).toMatchObject({ status: "cancelled" });
        await liveUntil(() => groupMembers(wrapperPid!), text => text === "", 5000);
        await liveUntil(() => existsSync(layout!.exitRcPath), Boolean, 5000);
        expect(await poll()).toMatchObject({ status: "error" });
      } else {
        let sawForgedWhileRunning = false;
        const deadline = Date.now() + 260000;
        while (!existsSync(layout.exitRcPath) && Date.now() < deadline) {
          const result = await poll();
          // Exit may land during the MCP round trip; only assert pre-exit state
          // if the atomic status channel is still absent afterward.
          if (!existsSync(layout.exitRcPath)) {
            expect(result.status).toBe("running");
            expect(result).toMatchObject({ peer: { name: started.peerName } });
            expect(JSON.parse(readFileSync(recordPath, "utf8")).status).toBe("busy");
            expect(frames.filter(frame => frame.action === "peer_idle_notice")).toEqual([]);
            if (readFileSync(layout.stdoutPath, "utf8").includes('{"__t2f5_done__":0}')) sawForgedWhileRunning = true;
          }
          await liveDelay(100);
        }
        expect(sawForgedWhileRunning).toBe(true);
        expect(existsSync(layout.exitRcPath)).toBe(true);
        // No product signalling is added here: lingering descendants fail the golden.
        const remaining = Math.max(1, statSync(layout.exitRcPath).mtimeMs + 5000 - Date.now());
        await liveUntil(() => groupMembers(wrapperPid!), text => text === "", remaining);
        const result = await poll();
        expect(result).toMatchObject({ status: "complete", text: expect.stringContaining("STRATUM_DEVIN_G3_OK"),
          peer: { name: started.peerName }, exitCode: 0, usdSource: "estimated", usage: { usd: 0 }, telemetry: { model: testModels.devinMedium } });
        if (result.status !== "complete") throw new Error(JSON.stringify(result));
        expect(result.usage.tokens).toBeGreaterThan(0);
        expect(result.text).toMatch(/G3_STOP:?\s*FAIL/i);
        process.kill(outside.pid!, 0);
        const state = spawnSync("ps", ["-p", String(outside.pid), "-o", "stat="], { encoding: "utf8" });
        expect(state.status).toBe(0); expect(state.stdout.trim()).not.toContain("T");
        await liveUntil(() => frames, all => all.some(frame => frame.action === "peer_idle_notice"));
        expect(readFileSync(layout.streamPath, "utf8")).toBe(`{"__t2f5_done__":${Number(readFileSync(layout.exitRcPath, "utf8"))}}\n`);
      }
      expect(existsSync(layout.credentialsCopyPath)).toBe(false);
    } finally {
      try {
        // A transport failure may lose the start response after meta was written.
        if (!layout) {
          const metaPath = findRunMetaPath(runsRoot, cwd);
          if (metaPath) {
            layout = devinRunLayout(dirname(metaPath));
            const meta = JSON.parse(readFileSync(metaPath, "utf8"));
            runId = meta.runId; wrapperPid = meta.childPid;
          }
        }
        if (runId) await call("stratum_cancel_agent_run", { runId }).catch(() => {});
        // Test cleanup only, after assertions: a failing golden must not leak children.
        if (wrapperPid && groupMembers(wrapperPid)) {
          try { process.kill(-wrapperPid, "SIGKILL"); } catch { /* already gone */ }
          await liveUntil(() => groupMembers(wrapperPid!), text => text === "", 5000);
        }
      } finally {
        outside.kill("SIGKILL"); await outsideClosed;
        if (peerPid) {
          try { process.kill(peerPid, "SIGTERM"); } catch { /* already gone */ }
          await liveUntil(() => !existsSync(join(sockDir, `${peerPid}.sock`)), Boolean, 5000);
        }
        for (const socket of connections) socket.destroy();
        if (callback.listening) await new Promise<void>(resolve => callback.close(() => resolve()));
        await client.close(); await server.close();
        if (layout) rmSync(layout.runDir, { recursive: true, force: true });
        rmSync(peerRoot, { recursive: true, force: true });
        rmSync(cwd, { recursive: true, force: true });
        vi.unstubAllEnvs();
        // Verify even on an assertion/transport failure; never overwrite real config.
        expect(snapshotFile(configPath)).toEqual(configBefore);
      }
    }
  }
  it("golden 3: real background export, unforgeable sentinel/peer, outside signal boundary, natural group exit", async () => golden(false), 300000);
  it("golden 4: real background cancellation reaps the group and credentials", async () => golden(true), 300000);
});
