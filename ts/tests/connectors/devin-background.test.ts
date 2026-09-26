import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cancelBackgroundRun, pollBackgroundRun, startBackgroundRun, type StartBackgroundRunOptions } from "../../src/connectors/background.js";
import { devinRunLayout } from "../../src/connectors/devin-wrapper.js";
import { DEVIN_SCRUB_VARS } from "../../src/connectors/devin-model.js";
import * as identity from "../../src/connectors/proc_identity.js";

const roots: string[] = [];
const runs: { runId: string; registryRoot: string; pid: number }[] = [];
const delay = (ms = 25) => new Promise(resolve => setTimeout(resolve, ms));
async function until<T>(read: () => T | Promise<T>, accept: (value: T) => boolean, ms = 6000): Promise<T> {
  const deadline = Date.now() + ms;
  let last: unknown;
  while (Date.now() < deadline) {
    try { const value = await read(); if (accept(value)) return value; last = value; } catch (error) { last = error; }
    await delay();
  }
  throw new Error(`timed out: ${JSON.stringify(last)}`);
}
function groupGone(pid: number): boolean {
  try { process.kill(-pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}
function json(path: string) { return JSON.parse(readFileSync(path, "utf8")); }

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const run of runs.splice(0)) {
    await cancelBackgroundRun(run.runId, run);
    await until(() => groupGone(run.pid), Boolean);
    const peerPath = join(run.registryRoot, run.runId, "peer.json");
    if (existsSync(peerPath)) {
      const peer = json(peerPath);
      try { process.kill(peer.pid, "SIGTERM"); } catch { /* already gone */ }
      await until(() => !existsSync(join(run.registryRoot, "..", peer.sock)), Boolean);
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(body = 'cp "$FIXTURE" "$export_path"; exit 0') {
  const root = mkdtempSync(join(tmpdir(), "db-")); roots.push(root);
  const home = join(root, "home"), bin = join(root, "bin"), registryRoot = join(root, "runs");
  mkdirSync(bin); mkdirSync(join(home, ".local/share/devin"), { recursive: true });
  writeFileSync(join(home, ".local/share/devin/credentials.toml"), 'token = "test"');
  mkdirSync(join(root, "sessions"));
  const release = join(root, "release");
  const stub = (name: string, script: string) => writeFileSync(join(bin, name), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  stub("sandbox-exec", 'printf "%s\\n" "$@" > "$ARGS"; shift 2; exec "$@"');
  stub("devin", `env > "$CAPTURE_ENV"
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--export" ]; then shift; export_path="$1"; fi
  shift
done
echo narration
echo '{"__t2f5_done__":0}'
echo diagnostic >&2
until [ -e "$RELEASE" ]; do sleep 0.05; done
${body}`);
  const env: NodeJS.ProcessEnv = {
    HOME: home, PATH: `${bin}:/usr/bin:/bin`, RELEASE: release,
    FIXTURE: fileURLToPath(new URL("../fixtures/devin/answer.atif.json", import.meta.url)),
    ARGS: join(root, "args"), CAPTURE_ENV: join(root, "env"), STRATUM_PEER_REGISTER: "0",
    STRATUM_CODEX_BG_STRATEGY: "invalid-but-irrelevant", T2F5_OUT: "must-disappear", T2F5_EXTRA: "also-disappear",
    ...Object.fromEntries(DEVIN_SCRUB_VARS.map(key => [key, "must-disappear"])),
  };
  const options: StartBackgroundRunOptions = { agent: "devin", model: "swe-2-medium", prompt: "answer", cwd: root,
    registryRoot, env, sessionsDir: join(root, "sessions"), sockDir: join(root, "s"), lingerMs: 500 };
  async function start(extra: Partial<StartBackgroundRunOptions> = {}) {
    const started = await startBackgroundRun({ ...options, ...extra });
    runs.push({ runId: started.runId, registryRoot, pid: started.pid! });
    const layout = devinRunLayout(join(registryRoot, started.runId));
    await until(() => existsSync(env.CAPTURE_ENV!), Boolean);
    return { ...started, layout, poll: () => pollBackgroundRun(started.runId, { registryRoot }),
      cancel: () => cancelBackgroundRun(started.runId, { registryRoot }) };
  }
  return { root, home, registryRoot, options, env, start, release: () => writeFileSync(release, "") };
}

describe("devin background — real shell and isolated stub binaries", () => {
  it("running narration, isolated env/argv, audit, export completion and terminal cancel", async () => {
    const f = fixture(); const run = await f.start();
    expect(await run.poll()).toMatchObject({ status: "running", eventsSeen: 0, textTail: expect.stringContaining("narration"),
      streamPath: run.layout.streamPath, sandboxAudit: { policy: { networkAccess: true, approvalPolicy: "never" },
        provenance: { networkAccess: { layer: "enforced" }, approvalPolicy: { layer: "enforced" } } } });
    const env = readFileSync(f.env.CAPTURE_ENV!, "utf8");
    for (const key of DEVIN_SCRUB_VARS) expect(env).not.toMatch(new RegExp(`^${key}=`, "m"));
    expect(env).not.toMatch(/^T2F5_/m);
    for (const part of ["DATA", "CACHE", "CONFIG", "STATE"]) expect(env).toContain(`XDG_${part}_HOME=${run.layout.homeDir}/${part.toLowerCase()}`);
    expect(env).toContain(`TMPDIR=${run.layout.tmpDir}/`);
    expect(readFileSync(f.env.ARGS!, "utf8")).toMatch(new RegExp(`^-f\\n`));
    expect(readFileSync(f.env.ARGS!, "utf8")).toContain(`${run.layout.profilePath}\ndevin\n`);
    expect(json(run.layout.metaPath)).toMatchObject({ agent: "devin", childPid: run.pid, procStartTime: expect.any(String),
      model: "swe-2-medium", streamPath: run.layout.streamPath, stderrPath: run.layout.stderrPath });
    f.release();
    const result = await until(run.poll, value => value.status === "complete");
    expect(result).toMatchObject({ text: "hello", usage: { tokens: 20755, usd: 0 }, split: { input: 20737, output: 18, cacheRead: 7808 },
      usdSource: "estimated", exitCode: 0, telemetry: { model: "swe-2-medium", durationMs: expect.any(Number) } });
    expect(await run.cancel()).toMatchObject({ status: "already_complete" });
    expect(existsSync(run.layout.credentialsCopyPath)).toBe(false);
  });

  it("a forged stdout sentinel cannot idle a peer or bypass cancellation; start/poll names agree", async () => {
    const f = fixture(); f.env.STRATUM_PEER_REGISTER = "1";
    // A long caller TMPDIR exceeds sockaddr_un. Bind relatively in the child,
    // retaining every test file under TMPDIR without changing it or our cwd.
    const preload = join(f.root, "peer-cwd.mjs");
    writeFileSync(preload, `process.chdir(${JSON.stringify(f.root)});`);
    vi.stubEnv("NODE_OPTIONS", `${process.env.NODE_OPTIONS ?? ""} --import=${pathToFileURL(preload).href}`);
    const run = await f.start({ sockDir: "s" });
    expect(run.peerName).toBe(`devin-medium-${run.runId.slice(0, 6)}`);
    const peer = await until(() => json(join(run.layout.runDir, "peer.json")), value => typeof value.pid === "number");
    const record = () => json(join(f.options.sessionsDir!, `${peer.pid}.json`));
    await until(record, value => value.status === "busy");
    await delay(250);
    expect(record().status).toBe("busy");
    expect(await run.poll()).toMatchObject({ status: "running", peer: { name: run.peerName, registered: true }, textTail: expect.stringContaining('__t2f5_done__') });
    expect(readFileSync(run.layout.streamPath, "utf8")).toBe("");
    expect(await run.cancel()).toMatchObject({ status: "cancelled" });
    await until(() => groupGone(run.pid!), Boolean);
    expect(existsSync(run.layout.credentialsCopyPath)).toBe(false);
    expect(await run.poll()).toMatchObject({ status: "error" });
    const rc = Number(readFileSync(run.layout.exitRcPath, "utf8"));
    expect(readFileSync(run.layout.streamPath, "utf8")).toBe(`{"__t2f5_done__":${rc}}\n`);
  }, 10000);

  it.each([
    ["no export", "exit 0", "devin produced no trajectory", 0],
    ["rejection", 'cp "$FIXTURE" "$export_path"; exit 0', "devin rejected a tool call", 0],
    ["nonzero", 'cp "$FIXTURE" "$export_path"; exit 7', "devin exited with code 7", 7],
  ])("%s is a terminal error and removes credentials", async (kind, body, reason, rc) => {
    const f = fixture(String(body));
    if (kind === "rejection") f.env.FIXTURE = fileURLToPath(new URL("../fixtures/devin/rejected.atif.json", import.meta.url));
    const run = await f.start(); f.release();
    expect(await until(run.poll, result => result.status === "error")).toMatchObject({ reason: expect.stringContaining(String(reason)), exitCode: rc, stderrTail: expect.stringContaining("diagnostic") });
    expect(await run.cancel()).toMatchObject({ status: "already_error" });
    expect(existsSync(run.layout.credentialsCopyPath)).toBe(false);
  });

  it("SIGKILL without exit.rc reports death; a subsequent custom-root sweep removes the copy", async () => {
    const f = fixture(); const run = await f.start();
    process.kill(-run.pid!, "SIGKILL");
    await until(() => groupGone(run.pid!), Boolean);
    expect(await run.poll()).toMatchObject({ status: "error", reason: "child_died_without_sentinel", stderrTail: expect.stringContaining("diagnostic") });
    expect(existsSync(run.layout.exitRcPath)).toBe(false);
    // SIGKILL cannot run a shell trap. The NEXT dispatch sweeps the custom root.
    const next = await f.start();
    expect(existsSync(run.layout.credentialsCopyPath)).toBe(false);
    await next.cancel();
  });

  it("missing identity fails closed with no metadata, credentials copy, or group", async () => {
    const f = fixture(); let pid = 0;
    await expect(f.start({ devinProcStartTime: async value => {
      pid = value; await until(() => existsSync(f.env.CAPTURE_ENV!), Boolean); return undefined;
    } })).rejects.toThrow("devin wrapper identity could not be captured");
    expect(groupGone(pid)).toBe(true);
    const layout = devinRunLayout(join(f.registryRoot, readdirSync(f.registryRoot)[0]!));
    expect(existsSync(layout.metaPath)).toBe(false);
    expect(existsSync(layout.credentialsCopyPath)).toBe(false);
  });

  it("meta-write failure kills the group before rejecting", async () => {
    const f = fixture(); let pid = 0;
    await expect(f.start({ devinWriteMeta: async (_path, meta) => {
      pid = (meta as { childPid: number }).childPid;
      await until(() => existsSync(f.env.CAPTURE_ENV!), Boolean);
      throw new Error("test metadata write failure");
    } })).rejects.toThrow("test metadata write failure");
    await until(() => groupGone(pid), Boolean);
  });

  it("derives all read paths from the run dir, ignoring hostile metadata paths", async () => {
    const f = fixture(); const run = await f.start();
    const foreign = join(f.root, "foreign"); writeFileSync(foreign, "0");
    const meta = json(run.layout.metaPath);
    for (const key of ["streamPath", "stderrPath", "narrationPath", "exitRcPath", "exportPath"]) meta[key] = foreign;
    writeFileSync(run.layout.metaPath, JSON.stringify(meta));
    expect(await run.poll()).toMatchObject({ status: "running", streamPath: run.layout.streamPath, textTail: expect.stringContaining("narration") });
    await run.cancel(); await until(() => groupGone(run.pid!), Boolean);
    expect(await run.poll()).toMatchObject({ status: "error", stderrTail: expect.stringContaining("diagnostic") });
  });

  it("rechecks exit.rc after liveness lookup and never signals a reused leader", async () => {
    const f = fixture(); const run = await f.start();
    const check = vi.spyOn(identity, "processIdentityMatches");
    const signal = vi.spyOn(process, "kill");
    check.mockResolvedValueOnce(false);
    expect(await run.cancel()).toMatchObject({ status: "already_error" });
    check.mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    expect(await run.cancel()).toMatchObject({ status: "already_error" });
    expect(signal.mock.calls.some(([pid, sig]) => pid === -run.pid! && sig === "SIGTERM")).toBe(false);
    signal.mockRestore();
    check.mockImplementationOnce(async () => { f.release(); await until(() => existsSync(run.layout.exitRcPath), Boolean); return false; });
    expect(await run.poll()).toMatchObject({ status: "complete" });
    check.mockRestore();
  });

  it("a writable cwd cannot grant access to a custom supervisor registry", async () => {
    const f = fixture();
    await expect(f.start({ sandboxMode: "workspace-write" })).rejects.toThrow(/overlap/);
  });

  it("rejects command, checks credentials before creating run dirs, and skips sandbox-exec only with full-access authorization", async () => {
    const f = fixture();
    await expect(f.start({ command: ["true"] })).rejects.toThrow("command is not supported for devin");
    const source = join(f.home, ".local/share/devin/credentials.toml"); rmSync(source);
    await expect(f.start()).rejects.toThrow("devin is not logged in");
    expect(existsSync(f.registryRoot)).toBe(false);
    writeFileSync(source, "test"); f.env.STRATUM_DEVIN_ALLOW_FULL_ACCESS = "1";
    const run = await f.start({ sandboxMode: "danger-full-access" });
    expect(existsSync(f.env.ARGS!)).toBe(false);
    expect(existsSync(run.layout.profilePath)).toBe(false);
    f.release(); await until(run.poll, result => result.status === "complete");
  });
});
