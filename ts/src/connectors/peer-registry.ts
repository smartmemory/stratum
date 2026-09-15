import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { open, readFile, readdir, readlink, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

// Native type stripping does not remap .js imports to source .ts files.
const baseUrl = new URL("./base.ts", import.meta.url);
const { modelIdentity }: typeof import("./base.js") = await import(
  (existsSync(baseUrl) ? baseUrl : new URL("./base.js", import.meta.url)).href
);
const execFileAsync = promisify(execFile);
export function peerName(model: string, runId: string): string {
  const short = modelIdentity(model).model.toLowerCase().replace(/^gpt-[\d.]+-/, "")
    .replace(/codex-|-codex/g, "").replace(/[^a-z0-9]/g, "") || "codex";
  return `codex-${short}-${runId.slice(0, 6)}`;
}
export function resolveSessionsDir(env: NodeJS.ProcessEnv): string {
  return env.STRATUM_PEER_SESSIONS_DIR ?? join(env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude"), "sessions");
}

export function resolveSockDir(env: NodeJS.ProcessEnv): string {
  return env.STRATUM_PEER_SOCK_DIR ?? "/tmp/cc-socks";
}

export async function claudeProcStart(pid: number): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)], {
      env: { ...process.env, LC_ALL: "C", TZ: "UTC" }, timeout: 1000,
    });
    return stdout.trim() || undefined;
  } catch { return undefined; }
}

export async function pidDomain(): Promise<string | undefined> {
  if (process.platform === "darwin") return "darwin";
  if (process.platform !== "linux") return undefined;
  try {
    const [machine, namespace] = await Promise.all([readFile("/etc/machine-id", "utf8"), readlink("/proc/self/ns/pid")]);
    return `darwin:${machine.trim()}:${namespace}`;
  } catch { return undefined; }
}

function socketHash(sockPath: string): string {
  return createHash("sha256").update(resolve(sockPath)).digest("hex");
}
export function keyFileName(pid: number, sockPath: string): string {
  return `${pid}.${socketHash(sockPath)}.key`;
}

export function isAllowedCallback(from: string, ownSockDir: string): string | undefined {
  if (!from.startsWith("uds:")) return undefined;
  const path = from.slice(4);
  // Reject traversal before normalizing: it must not disguise an untrusted directory.
  if (!isAbsolute(path) || path.includes("\0") || path.split("/").some(part => part === ".." || part === ".")) return undefined;
  if (!/^\d+\.sock$/.test(basename(path))) return undefined;
  const dir = dirname(path);
  return dir === resolve(ownSockDir) || /^\/(?:private\/)?tmp\/cc-socks(?:-\d+)?$/.test(dir)
    || /^\/run\/user\/\d+\/cc-socks$/.test(dir) ? path : undefined;
}

export async function readPeerToken(sessionsDir: string, sockPath: string): Promise<string | undefined> {
  let names: string[];
  try { names = await readdir(sessionsDir); } catch { return undefined; }
  const suffix = `.${socketHash(sockPath)}.key`;
  for (const name of names.filter(name => /^\d+\./.test(name) && name.endsWith(suffix))) {
    try {
      const file = await open(join(sessionsDir, name), "r");
      try {
        if (!(await file.stat()).isFile() || (await file.stat()).size > 4096) continue;
        const buffer = Buffer.alloc(4096);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        if ((await file.stat()).size > 4096) continue;
        const value: unknown = JSON.parse(buffer.subarray(0, bytesRead).toString("utf8"));
        const token = (value as { peerToken?: unknown } | null)?.peerToken;
        if (typeof token === "string" && /^[0-9a-f]{32}$/.test(token)) return token;
      } finally { await file.close(); }
    } catch { /* Another session may rotate or remove its key during lookup. */ }
  }
  return undefined;
}

function pidIsDead(pid: number): boolean {
  try { process.kill(pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}
export async function shouldRegister(sessionsDir: string, env: NodeJS.ProcessEnv): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (env.STRATUM_PEER_REGISTER === "0") return { ok: false, reason: "disabled" };
  let names: string[];
  try {
    if (!(await stat(sessionsDir)).isDirectory()) return { ok: false, reason: "missing sessions directory" };
    names = await readdir(sessionsDir);
  } catch { return { ok: false, reason: "unreadable sessions directory" }; }
  for (const name of names) {
    if (!/^[1-9]\d*\.json$/.test(name)) continue;
    try {
      const record: unknown = JSON.parse(await readFile(join(sessionsDir, name), "utf8"));
      const protocol = (record as { peerProtocol?: unknown } | null)?.peerProtocol;
      if (typeof protocol === "number" && protocol > 1 && !pidIsDead(Number(name.slice(0, -5)))) {
        return { ok: false, reason: "unsupported live peer protocol" };
      }
    } catch { /* Malformed records are not evidence of a newer protocol. */ }
  }
  return { ok: true };
}

export async function sweepDeadStratumPeers(sessionsDir: string, sockDir: string): Promise<number> {
  const names = await readdir(sessionsDir);
  let removed = 0;
  for (const name of names) {
    if (!/^[1-9]\d*\.json$/.test(name)) continue;
    const pid = Number(name.slice(0, -5));
    try {
      const record: unknown = JSON.parse(await readFile(join(sessionsDir, name), "utf8"));
      if ((record as { entrypoint?: unknown } | null)?.entrypoint !== "stratum-peer" || !pidIsDead(pid)) continue;
      const files = [name, ...names.filter(key => key.startsWith(`${pid}.`) && key.endsWith(".key"))];
      for (const file of files) await unlink(join(sessionsDir, file)).catch(() => undefined);
      await unlink(join(sockDir, `${pid}.sock`)).catch(() => undefined);
      removed++;
    } catch { /* A concurrent sweep or malformed record must not affect other peers. */ }
  }
  return removed;
}

export type PeerRecordFile = { pid: number; name: string; sock: string; registeredAt: string };
export interface PeerSidecarConfig {
  runDir: string;
  streamPath: string;
  childPid: number;
  childProcStartTime?: string;
  name: string;
  cwd: string;
  sessionsDir: string;
  sockDir: string;
  lingerMs?: number;
}
export function sidecarEnv(config: PeerSidecarConfig): NodeJS.ProcessEnv {
  return {
    ...process.env,
    STRATUM_PEER_RUN_DIR: config.runDir, STRATUM_PEER_STREAM: config.streamPath,
    STRATUM_PEER_CHILD_PID: String(config.childPid), STRATUM_PEER_CHILD_START: config.childProcStartTime,
    STRATUM_PEER_NAME: config.name, STRATUM_PEER_CWD: config.cwd,
    STRATUM_PEER_SESSIONS_DIR: config.sessionsDir, STRATUM_PEER_SOCK_DIR: config.sockDir,
    STRATUM_PEER_LINGER_MS: String(config.lingerMs ?? 15000),
  };
}
export function configFromEnv(env: NodeJS.ProcessEnv): PeerSidecarConfig {
  const required = (key: string): string => {
    const value = env[key];
    if (!value) throw new Error(`Missing ${key}`);
    return value;
  };
  const childPid = Number(required("STRATUM_PEER_CHILD_PID"));
  const lingerMs = Number(env.STRATUM_PEER_LINGER_MS ?? 15000);
  if (!Number.isSafeInteger(childPid) || childPid <= 0 || !Number.isSafeInteger(lingerMs) || lingerMs < 0) throw new Error("Invalid peer pid or linger");
  return {
    runDir: required("STRATUM_PEER_RUN_DIR"), streamPath: required("STRATUM_PEER_STREAM"),
    childPid, ...(env.STRATUM_PEER_CHILD_START ? {childProcStartTime: env.STRATUM_PEER_CHILD_START} : {}),
    name: required("STRATUM_PEER_NAME"), cwd: required("STRATUM_PEER_CWD"),
    sessionsDir: required("STRATUM_PEER_SESSIONS_DIR"), sockDir: required("STRATUM_PEER_SOCK_DIR"), lingerMs,
  };
}
