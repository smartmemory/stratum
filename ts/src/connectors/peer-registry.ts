import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { lstat, open, readFile, readdir, readlink, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

// Native type stripping does not remap .js imports to source .ts files.
const baseUrl = new URL("./base.ts", import.meta.url);
const { modelIdentity }: typeof import("./base.js") = await import(
  (existsSync(baseUrl) ? baseUrl : new URL("./base.js", import.meta.url)).href
);
const execFileAsync = promisify(execFile);
export function normalizePeerLabel(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || /[\x00-\x1f\x7f]/.test(value)
    || value.trim().length < 1 || value.trim().length > 64) {
    throw new Error("peerLabel must be 1–64 trimmed characters without ASCII controls");
  }
  const label = value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!label) throw new Error("peerLabel must contain an ASCII letter or digit");
  return label;
}

export function peerName(model: string, runId: string, options: {agent?: "codex" | "claude"; label?: string | undefined} = {}): string {
  const agent = options.agent ?? "codex";
  const identity = modelIdentity(model).model.toLowerCase();
  const short = agent === "claude"
    ? identity.replace(/^claude-/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "") || "model"
    : identity.replace(/^gpt-[\d.]+-/, "").replace(/codex-|-codex/g, "").replace(/[^a-z0-9]/g, "") || "codex";
  if (agent === "codex" && options.label === undefined) return `codex-${short}-${runId.slice(0, 6)}`;
  return `${agent}-${short.slice(0, 40)}-${runId}${options.label ? `-${options.label}` : ""}`;
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
      const path = join(sessionsDir, name);
      const info = await lstat(path);
      if (!info.isFile() || info.size > 4096) continue;
      const file = await open(path, "r");
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
      const path = join(sessionsDir, name);
      const info = await lstat(path);
      if (!info.isFile() || info.size > 262144) continue;
      const record: unknown = JSON.parse(await readFile(path, "utf8"));
      const protocol = (record as { peerProtocol?: unknown } | null)?.peerProtocol;
      if (typeof protocol === "number" && protocol > 1 && !pidIsDead(Number(name.slice(0, -5)))) {
        return { ok: false, reason: "unsupported live peer protocol" };
      }
    } catch { /* Malformed records are not evidence of a newer protocol. */ }
  }
  return { ok: true };
}

export async function sweepDeadStratumPeers(sessionsDir: string, _sockDir: string): Promise<number> {
  const names = await readdir(sessionsDir);
  let removed = 0;
  for (const name of names) {
    if (!/^[1-9]\d*\.json$/.test(name)) continue;
    const pid = Number(name.slice(0, -5));
    try {
      const path = join(sessionsDir, name);
      const info = await lstat(path);
      if (!info.isFile() || info.size > 262144) continue;
      const record: unknown = JSON.parse(await readFile(path, "utf8"));
      if ((record as { entrypoint?: unknown } | null)?.entrypoint !== "stratum-peer" || !pidIsDead(pid)) continue;
      try { await unlink(path); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          console.error("peer sweep left record and dependents alone:", path, error);
          continue;
        }
      }
      const endpoint = (record as {messagingSocketPath?: unknown}).messagingSocketPath;
      if (typeof endpoint === "string" && isAbsolute(endpoint) && !endpoint.includes("\0")) {
        await unlink(join(sessionsDir, keyFileName(pid, endpoint))).catch(() => undefined);
        if ((await lstat(endpoint).catch(() => undefined))?.isSocket()) {
          await unlink(endpoint).catch(() => undefined);
        }
      }
      removed++;
    } catch { /* A concurrent sweep or malformed record must not affect other peers. */ }
  }
  return removed;
}

export type PeerRecordFile = { pid: number; name: string; sock: string; registeredAt: string };
interface PeerSidecarCommon {
  runDir: string;
  streamPath: string;
  name: string;
  cwd: string;
  sessionsDir: string;
  sockDir: string;
  lingerMs?: number;
  firstLineDeadlineMs?: number;
}
export type PeerSidecarConfig = PeerSidecarCommon & (
  | {ownerKind?: "process"; childPid: number; childProcStartTime?: string}
  | {ownerKind: "claude-worker"; runId: string}
  | {ownerKind: "codex-appserver"; runId: string}
);
export function sidecarEnv(config: PeerSidecarConfig): NodeJS.ProcessEnv {
  return {
    ...process.env,
    STRATUM_PEER_RUN_DIR: config.runDir, STRATUM_PEER_STREAM: config.streamPath,
    STRATUM_PEER_OWNER_KIND: config.ownerKind ?? "process",
    STRATUM_PEER_RUN_ID: (config.ownerKind === "claude-worker" || config.ownerKind === "codex-appserver") ? config.runId : undefined,
    STRATUM_PEER_CHILD_PID: (config.ownerKind === "claude-worker" || config.ownerKind === "codex-appserver") ? undefined : String(config.childPid),
    STRATUM_PEER_CHILD_START: (config.ownerKind === "claude-worker" || config.ownerKind === "codex-appserver") ? undefined : config.childProcStartTime,
    STRATUM_PEER_NAME: config.name, STRATUM_PEER_CWD: config.cwd,
    STRATUM_PEER_SESSIONS_DIR: config.sessionsDir, STRATUM_PEER_SOCK_DIR: config.sockDir,
    STRATUM_PEER_LINGER_MS: String(config.lingerMs ?? 15000),
    STRATUM_PEER_FIRST_LINE_MS: String(config.firstLineDeadlineMs ?? 30000),
  };
}
export function configFromEnv(env: NodeJS.ProcessEnv): PeerSidecarConfig {
  const required = (key: string): string => {
    const value = env[key];
    if (!value) throw new Error(`Missing ${key}`);
    return value;
  };
  const kind = env.STRATUM_PEER_OWNER_KIND ?? "process";
  if (kind !== "process" && kind !== "claude-worker" && kind !== "codex-appserver") throw new Error("Invalid peer owner kind");
  const runId = kind !== "process" ? required("STRATUM_PEER_RUN_ID") : undefined;
  if (runId !== undefined && !/^[0-9a-f]{12}$/.test(runId)) throw new Error("Invalid peer run ID");
  const childPid = kind === "process" ? Number(required("STRATUM_PEER_CHILD_PID")) : 1;
  const lingerMs = Number(env.STRATUM_PEER_LINGER_MS ?? 15000);
  const firstLineDeadlineMs = Number(env.STRATUM_PEER_FIRST_LINE_MS ?? 30000);
  if (!Number.isSafeInteger(childPid) || childPid <= 0 || !Number.isSafeInteger(lingerMs) || lingerMs < 0) throw new Error("Invalid peer pid or linger");
  if (!Number.isSafeInteger(firstLineDeadlineMs) || firstLineDeadlineMs < 0) throw new Error("Invalid peer first-line deadline");
  return {
    runDir: required("STRATUM_PEER_RUN_DIR"), streamPath: required("STRATUM_PEER_STREAM"),
    ...(kind !== "process" ? {ownerKind: kind, runId: runId!}
      : {childPid, ...(env.STRATUM_PEER_CHILD_START ? {childProcStartTime: env.STRATUM_PEER_CHILD_START} : {})}),
    name: required("STRATUM_PEER_NAME"), cwd: required("STRATUM_PEER_CWD"),
    sessionsDir: required("STRATUM_PEER_SESSIONS_DIR"), sockDir: required("STRATUM_PEER_SOCK_DIR"), lingerMs, firstLineDeadlineMs,
  };
}
