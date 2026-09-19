#!/usr/bin/env -S node --experimental-strip-types
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, watch, type FSWatcher } from "node:fs";
import { lstat, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { createConnection, createServer, type Socket } from "node:net";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { PeerRecordFile, PeerSidecarConfig } from "./peer-registry.js";

function moduleUrl(name: string): URL {
  const source = new URL(`./${name}.ts`, import.meta.url);
  return existsSync(source) ? source : new URL(`./${name}.js`, import.meta.url);
}
const { claudeProcStart, configFromEnv, isAllowedCallback, keyFileName, pidDomain, readPeerToken, sidecarEnv }: typeof import("./peer-registry.js") = await import(moduleUrl("peer-registry").href);
const { processIdentity, procStartTime }: typeof import("./proc_identity.js") = await import(moduleUrl("proc_identity").href);

export interface PeerSidecarHandle { finalize(): void; abandon(): void }

function workerHandle(child: ChildProcess, runId: string): PeerSidecarHandle {
  let ready = false;
  let requested = false;
  let sending = false;
  let closed = false;
  let sendTimer: NodeJS.Timeout | undefined;
  const stop = () => {
    if (closed) return;
    closed = true;
    clearTimeout(readyTimer);
    clearTimeout(sendTimer);
    child.removeListener("message", message);
    child.removeListener("disconnect", stop);
    child.removeListener("exit", stop);
    // Retain an inert error sink: Node may emit an asynchronous channel error
    // after disconnect, and EventEmitter errors must always have a listener.
    child.removeListener("error", stop);
    child.on("error", absorbError);
    try { if (child.connected) child.disconnect(); } catch { /* closed channel */ }
  };
  const absorbError = () => {};
  const flush = () => {
    if (closed || !ready || !requested || sending) return;
    sending = true;
    sendTimer = setTimeout(stop, 1000);
    sendTimer.unref();
    try { child.send({type:"run-finalized", runId}, () => stop()); } catch { stop(); }
  };
  const message = (value: unknown) => {
    if (value && typeof value === "object" && (value as {type?: unknown}).type === "owner-ready"
      && (value as {runId?: unknown}).runId === runId) {
      ready = true;
      clearTimeout(readyTimer);
      flush();
    }
  };
  const readyTimer = setTimeout(stop, 2000);
  readyTimer.unref();
  child.on("message", message);
  child.on("error", stop);
  child.once("disconnect", stop);
  child.once("exit", stop);
  child.channel?.unref();
  return {finalize() { requested = true; flush(); }, abandon: stop};
}

export async function spawnPeerSidecar(config: PeerSidecarConfig): Promise<PeerSidecarHandle | undefined> {
  let stderr: Awaited<ReturnType<typeof open>> | undefined;
  let handle: PeerSidecarHandle | undefined;
  try {
    const entry = fileURLToPath(moduleUrl("peer-sidecar"));
    stderr = await open(`${config.streamPath}.peer.err`, "a", 0o600);
    const child = spawn(process.execPath, [...(entry.endsWith(".ts") ? ["--experimental-strip-types"] : []), entry], {
      detached: true, stdio: config.ownerKind === "claude-worker"
        ? ["ignore", "ignore", stderr.fd, "ipc"] : ["ignore", "ignore", stderr.fd], env: sidecarEnv(config),
    });
    if (config.ownerKind === "claude-worker") handle = workerHandle(child, config.runId);
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.unref();
    return handle;
  } catch (error) {
    handle?.abandon();
    console.error("stratum peer spawn failed:", error);
    return undefined;
  } finally { await stderr?.close().catch(() => undefined); }
}

/** Serializes sidecar scans and identity checks. */
export class PeerWorkQueue {
  private work = Promise.resolve();
  private readonly pending = new Set<"scan" | "identity" | "owner">();
  private readonly onError: (error: unknown) => void;
  constructor(onError: (error: unknown) => void) { this.onError = onError; }
  schedule(kind: "scan" | "identity" | "owner", task: () => Promise<void>): void {
    if (this.pending.has(kind)) return;
    this.pending.add(kind);
    this.work = this.work.then(task).catch(this.onError).finally(() => { this.pending.delete(kind); });
  }
  drain(): Promise<void> { return this.work; }
}

async function main(): Promise<void> {
  const config = configFromEnv(process.env);
  const workerOwner = config.ownerKind === "claude-worker";
  if (workerOwner && (!process.connected || !process.send)) throw new Error("Worker peer requires connected IPC");
  let ownerFinalized = false;
  let ownerLost = false;
  let ownerReady = false;
  let ownerStarted = false;
  const ownerMessage = (value: unknown) => {
    if (config.ownerKind === "claude-worker" && value && typeof value === "object"
      && (value as {type?: unknown}).type === "run-finalized"
      && (value as {runId?: unknown}).runId === config.runId) {
      ownerFinalized = true;
      if (ownerStarted) schedule("owner", checkOwner);
    }
  };
  const ownerDisconnect = () => {
    ownerLost = true;
    if (ownerStarted) schedule("owner", checkOwner);
  };
  if (workerOwner) {
    process.on("message", ownerMessage);
    process.on("disconnect", ownerDisconnect);
    process.on("error", ownerDisconnect);
    try {
      process.send!({type:"owner-ready", runId: config.runId}, error => {
        if (error) ownerDisconnect(); else ownerReady = true;
      });
    } catch { ownerDisconnect(); }
  }
  const sockPath = join(config.sockDir, `${process.pid}.sock`);
  const recordPath = join(config.sessionsDir, `${process.pid}.json`);
  const keyPath = join(config.sessionsDir, keyFileName(process.pid, sockPath));
  const owned = new Set<string>();
  const sessionId = randomUUID();
  let boundSocket: Awaited<ReturnType<typeof lstat>> | undefined;
  let serverFailed = false;
  const connections = new Set<Socket>();
  const inFlight = new Set<Promise<void>>();
  type Callback = {to: string; frame: Record<string, unknown>; notice: boolean};
  const callbacks: Callback[] = [];
  const activeNotices = new Set<string>();
  const abortCallbacks = new Set<() => void>();
  let callbackBudget = 5000;
  const subscriptions = new Map<string, {id: string; to: string; from_mode?: unknown; notified: boolean}>();
  let terminalReady = false;
  function notifyPending(state = terminalState): void {
    if (!state) return;
    for (const subscription of subscriptions.values()) {
      if (subscription.notified) continue;
      subscription.notified = true;
      sendControl(subscription.to, {type:"control", action:"peer_idle_notice", orig_msg_id:subscription.id,
        state:state.state, finished_at:state.finishedAt, ...(state.detail ? {detail:state.detail} : {}), from:`uds:${sockPath}`,
        ...(subscription.from_mode !== undefined ? {from_mode:subscription.from_mode} : {})}, true);
    }
  }
  const peerToken = randomBytes(16).toString("hex");
  function sendControl(to: string, frame: Record<string, unknown>, notice = false): void {
    const replacement = notice ? callbacks.findIndex(item => item.notice && item.to === to) : -1;
    if (replacement >= 0) callbacks.splice(replacement, 1);
    if (callbacks.length >= 32) {
      // The subscription table reserves at most 32 notices. Refusals yield their slots.
      const refusal = notice ? callbacks.findIndex(item => !item.notice) : -1;
      if (refusal < 0) { console.error("peer callback dropped: full"); return; }
      callbacks.splice(refusal, 1);
      console.error("peer callback dropped: full (reserved for idle notice)");
    }
    callbacks.push({to, frame, notice});
    pumpCallbacks();
  }
  function pumpCallbacks(): void {
    while (inFlight.size < 8) {
      const index = callbacks.findIndex(item => !item.notice || !activeNotices.has(item.to));
      if (index < 0) return;
      const callback = callbacks.splice(index, 1)[0]!;
      if (callback.notice) activeNotices.add(callback.to);
      const attempt = dialBack(callback).catch(error => { console.error("peer callback failed:", error); });
      inFlight.add(attempt);
      void attempt.finally(() => {
        inFlight.delete(attempt);
        if (callback.notice) activeNotices.delete(callback.to);
        pumpCallbacks();
      });
    }
  }
  function dialBack({to, frame}: Callback): Promise<void> {
    return new Promise<void>(resolve => {
      let socket: Socket | undefined;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        abortCallbacks.delete(finish);
        socket?.destroy();
        resolve();
      };
      // Token lookup, connect and write share one slot deadline, including shutdown aborts.
      const timeout = setTimeout(finish, callbackBudget);
      abortCallbacks.add(finish);
      void readPeerToken(config.sessionsDir, to).then(token => {
        if (settled) return; // A late lookup must not open an untracked connection.
        socket = createConnection(to);
        socket.once("connect", () => socket!.end(
          (token ? JSON.stringify({type:"auth", token}) + "\n" : "") + JSON.stringify(frame) + "\n",
        ));
        socket.once("error", finish);
        socket.once("close", finish);
      }).catch(error => { console.error("peer callback failed:", error); finish(); });
    });
  }
  async function drainCallbacks(): Promise<void> {
    // Only accepted notices must survive shutdown; queued user refusals are best effort.
    for (let i = callbacks.length - 1; i >= 0; i--) {
      if (!callbacks[i]!.notice) { callbacks.splice(i, 1); console.error("peer callback dropped: shutdown"); }
    }
    // Share the five-second shutdown window across the bounded remaining waves.
    callbackBudget = Math.floor(4800 / (1 + Math.ceil(callbacks.length / 8)));
    const active = [...abortCallbacks];
    const release = setTimeout(() => { for (const abort of active) abort(); }, callbackBudget);
    let deadline: NodeJS.Timeout | undefined;
    const drain = async () => {
      while (inFlight.size || callbacks.length) {
        pumpCallbacks();
        await Promise.all([...inFlight]);
      }
    };
    try {
      await Promise.race([drain(), new Promise<void>(resolve => { deadline = setTimeout(resolve, 5000); })]);
    } finally { clearTimeout(release); clearTimeout(deadline); }
  }
  function receive(value: unknown): void {
    if (stopping || !value || typeof value !== "object" || Array.isArray(value)) return;
    const frame = value as Record<string, unknown>;
    const to = typeof frame.from === "string" ? isAllowedCallback(frame.from, config.sockDir) : undefined;
    if (!to || typeof frame.msg_id !== "string") { console.error("peer frame rejected: invalid callback or msg_id"); return; }
    if (frame.type === "user") {
      console.error("peer user message refused");
      sendControl(to, {type:"control", action:"peer_message_status", orig_msg_id:frame.msg_id,
        status:"expired", status_detail:"refused", from:`uds:${sockPath}`,
        ...(frame.from_mode !== undefined ? {from_mode:frame.from_mode} : {})});
    } else if (frame.type === "control" && frame.action === "notify_when_idle") {
      // At capacity even replacements are rejected, matching the specified acceptance rule.
      if (subscriptions.size >= 32) { console.error("peer subscription rejected: full"); return; }
      // Claude admits the notice to the subscriber model only with its original permission mode.
      subscriptions.set(frame.from as string, {id:frame.msg_id, to, from_mode:frame.from_mode, notified:false});
      if (terminalReady) notifyPending();
    } else { console.error("peer frame ignored"); }
  }
  let record: Record<string, unknown> | undefined;
  let terminalState: {state: "idle" | "exited" | "unavailable"; finishedAt: number; detail?: string} | undefined;
  let stopping = false;
  let watcher: FSWatcher | undefined;
  const timers = new Set<NodeJS.Timeout>();
  const work = new PeerWorkQueue(error => {
    console.error(error);
    terminalState ??= {state:"unavailable", finishedAt:Date.now(), detail:String(error)};
    void cleanup().then(() => process.exit(2));
  });
  let startupDone = Promise.resolve();
  let offset = 0;
  let pending = Buffer.alloc(0);
  let discarding = false;
  function schedule(kind: "scan" | "identity" | "owner", task: () => Promise<void>): void {
    work.schedule(kind, async () => { if (!stopping) await task(); });
  }
  async function terminal(state: "idle" | "exited" | "unavailable", detail?: string): Promise<void> {
    if (terminalState) return;
    const now = Date.now();
    terminalState = {state, finishedAt: now, ...(detail ? {detail} : {})};
    if (record) {
      Object.assign(record, {status:"idle", updatedAt:now, statusUpdatedAt:now});
      await atomicJson(recordPath, record, 0o644);
      terminalReady = true;
      notifyPending();
      linger();
    }
  }
  function linger(): void {
    timers.add(setTimeout(() => { void cleanup().then(() => process.exit(0)); }, config.lingerMs ?? 15000));
  }
  async function scan(): Promise<void> {
    if (terminalState) return;
    let file: Awaited<ReturnType<typeof open>>;
    try { file = await open(config.streamPath, "r"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    try {
      const chunk = Buffer.alloc(64 * 1024);
      while (!stopping && !terminalState) {
        const {bytesRead} = await file.read(chunk, 0, chunk.length, offset);
        if (!bytesRead) break;
        offset += bytesRead;
        pending = Buffer.concat([pending, chunk.subarray(0,bytesRead)]);
        let newline: number;
        while ((newline = pending.indexOf(10)) >= 0) {
          const line = discarding ? "" : pending.subarray(0,newline).toString("utf8").trim();
          discarding = false;
          pending = pending.subarray(newline+1);
          let value: unknown;
          try { value = JSON.parse(line); } catch { continue; }
          if (!value || typeof value !== "object" || Array.isArray(value)) continue;
          const rc = (value as Record<string,unknown>).__t2f5_done__;
          if (typeof rc === "number") { await terminal("idle", rc !== 0 ? `rc=${rc}` : undefined); break; }
          if (record) {
            record.updatedAt = Date.now();
            await atomicJson(recordPath, record, 0o644);
          }
        }
        if (pending.length > 5_000_000) { pending = Buffer.alloc(0); discarding = true; }
      }
    } finally { await file.close(); }
  }
  async function checkOwner(): Promise<void> {
    if (terminalState || (!ownerFinalized && !ownerLost)) return;
    await scan();
    if (!terminalState) await terminal(ownerFinalized ? "exited" : "unavailable",
      ownerFinalized ? "worker_ended_without_sentinel" : "worker_owner_channel_lost");
  }
  const server = createServer(socket => {
    connections.add(socket);
    socket.on("error", () => socket.destroy());
    socket.on("close", () => connections.delete(socket));
    let input = Buffer.alloc(0);
    let first = true;
    const deadline = setTimeout(() => socket.destroy(), config.firstLineDeadlineMs ?? 30000);
    socket.on("close", () => clearTimeout(deadline));
    socket.on("data", (data: Buffer) => {
      input = Buffer.concat([input, data]);
      let newline: number;
      while ((newline = input.indexOf(10)) >= 0) {
        if (newline > 1024 * 1024) { socket.destroy(); return; }
        const line = input.subarray(0,newline).toString("utf8"); input = input.subarray(newline+1);
        const wasFirst = first; first = false; clearTimeout(deadline);
        try {
          const value: unknown = JSON.parse(line);
          if (wasFirst && (value as {type?: unknown} | null)?.type === "auth") {
            if ((value as {token?: unknown}).token !== peerToken) console.error("peer auth token mismatch (advisory)");
          } else receive(value);
        } catch { console.error("peer malformed frame ignored"); }
      }
      if (input.length > 1024 * 1024) socket.destroy();
    });
    socket.on("end", () => socket.end());
  });
  server.on("error", error => { serverFailed = true; console.error("peer socket error:", error); });
  async function removeOwnedJson(path: string): Promise<void> {
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.size > 262144) throw new Error("unsafe file");
      const value = JSON.parse(await readFile(path, "utf8"));
      const matches = path === keyPath ? value?.peerToken === peerToken
        : value?.pid === process.pid && value?.sessionId === sessionId;
      if (!matches) throw new Error("identity mismatch");
      await unlink(path);
    } catch (error) { console.error("peer cleanup left path alone:", path, error); }
  }
  async function closeOwnedSocket(): Promise<void> {
    if (!owned.has(sockPath)) return;
    try {
      const info = await lstat(sockPath);
      if (!info.isSocket() || !boundSocket || info.dev !== boundSocket.dev || info.ino !== boundSocket.ino
        || !server.listening || serverFailed) throw new Error("socket listener identity mismatch");
      // Node unlinks the Unix socket itself when closing. Never close a replaced path.
      await new Promise<void>(resolve => {
        server.close(error => {
          if (error) console.error("peer socket close failed:", error);
          resolve();
        });
        for (const socket of connections) socket.destroy();
      });
    } catch (error) { console.error("peer cleanup left path alone:", sockPath, error); }
    owned.delete(sockPath);
  }
  async function atomicJson(path: string, value: unknown, mode: number, retain = true): Promise<void> {
    const temp = `${path}.${process.pid}.tmp`;
    try {
      const file = await open(temp, "wx", mode);
      owned.add(temp);
      try {
        await file.writeFile(JSON.stringify(value));
        // The registry contract specifies exact modes, independent of the caller's umask.
        await file.chmod(mode);
      } finally { await file.close(); }
      await rename(temp, path);
      owned.delete(temp);
      if (retain) owned.add(path);
    } finally {
      if (owned.has(temp)) { await unlink(temp).catch(() => undefined); owned.delete(temp); }
    }
  }
  let cleanupPromise: Promise<void> | undefined;
  function cleanup(signal = false): Promise<void> {
    cleanupPromise ??= (async () => {
      stopping = true;
      // Startup can be between bind and publishing its files when a signal arrives.
      await startupDone;
      process.removeListener("message", ownerMessage);
      process.removeListener("disconnect", ownerDisconnect);
      process.removeListener("error", ownerDisconnect);
      if (workerOwner) {
        process.on("error", () => {});
        try { if (process.connected) process.disconnect(); } catch { /* already closed */ }
      }
      watcher?.close();
      for (const timer of timers) clearTimeout(timer);
      for (const socket of connections) socket.destroy();
      await work.drain();
      notifyPending(signal ? {state:"exited", finishedAt:Date.now()} : terminalState ?? {state:"unavailable", finishedAt:Date.now(), detail:"peer stopped before completion"});
      await drainCallbacks();
      await closeOwnedSocket();
      for (const path of owned) await removeOwnedJson(path);
      owned.clear();
    })();
    return cleanupPromise;
  }
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => {
    void cleanup(true).then(() => process.exit(0));
  });
  let childProcStartTime = config.ownerKind === "claude-worker" ? undefined : config.childProcStartTime;
  const start = async (): Promise<void> => {
    if (config.ownerKind !== "claude-worker" && !childProcStartTime) {
      let dead = false;
      try { process.kill(config.childPid, 0); }
      catch (error) { dead = (error as NodeJS.ErrnoException).code === "ESRCH"; }
      if (dead) await terminal("exited", "cancelled_or_died");
      else {
        childProcStartTime = await procStartTime(config.childPid);
        if (childProcStartTime) console.error(`peer child identity captured: ${config.childPid} ${childProcStartTime}`);
        else {
          // The child may have exited while its start time was being read.
          try { process.kill(config.childPid, 0); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ESRCH") await terminal("exited", "cancelled_or_died");
          }
        }
      }
    }
    try {
      const info = await lstat(recordPath);
      if (!info.isFile() || info.size > 262144) throw new Error("foreign peer record: unsafe file");
      const existing: unknown = JSON.parse(await readFile(recordPath, "utf8"));
      if ((existing as {entrypoint?: unknown} | null)?.entrypoint !== "stratum-peer") throw new Error("foreign peer record");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (stopping || (workerOwner && ownerLost && !ownerReady)) return;
    await mkdir(config.sockDir, {recursive: true, mode: 0o700});
    if (stopping || (workerOwner && ownerLost && !ownerReady)) return;
    const listen = (): Promise<void> => new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(sockPath, () => { server.removeListener("error", reject); resolve(); });
    });
    try { await listen(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || !(await lstat(sockPath)).isSocket()) throw error;
      const stale = await new Promise<boolean>(resolve => {
        const probe = createConnection(sockPath);
        const timer = setTimeout(() => { probe.destroy(); resolve(false); }, 250);
        probe.once("connect", () => { clearTimeout(timer); probe.destroy(); resolve(false); });
        probe.once("error", (error: NodeJS.ErrnoException) => {
          clearTimeout(timer); probe.destroy(); resolve(error.code === "ECONNREFUSED" || error.code === "ENOENT");
        });
      });
      if (!stale) throw error;
      // sockPath is constructed from our own pid; never reclaim another endpoint.
      await unlink(sockPath);
      await listen();
    }
    boundSocket = await lstat(sockPath);
    serverFailed = false;
    owned.add(sockPath);
    if (stopping || (workerOwner && ownerLost && !ownerReady)) return;
    const procStart = await claudeProcStart(process.pid);
    const domain = await pidDomain();
    if (stopping || (workerOwner && ownerLost && !ownerReady)) return;
    const identity = {...(procStart ? {procStart} : {}), ...(domain ? {pidDomain: domain} : {})};
    await atomicJson(keyPath, {peerToken, ...identity}, 0o600);
    const now = Date.now();
    const {version} = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as {version: string};
    await scan();
    if (workerOwner) await checkOwner();
    if (stopping || (workerOwner && ownerLost && !ownerReady)) return;
    record = {
      pid:process.pid, sessionId, cwd:config.cwd, startedAt:now, ...identity,
      version, peerProtocol:1, peerFeatures:["notify_idle"], kind:"bg", entrypoint:"stratum-peer",
      messagingSocketPath:sockPath, name:config.name, nameSource:"derived", status:terminalState ? "idle" : "busy", updatedAt:now, statusUpdatedAt:now,
    };
    await atomicJson(recordPath, record, 0o644);
    // This durable discovery file survives cleanup so later polls can describe registration.
    await atomicJson(join(config.runDir,"peer.json"), {
      pid:process.pid, name:config.name, sock:sockPath, registeredAt:new Date().toISOString(),
    } satisfies PeerRecordFile, 0o600, false);
    if (terminalState) { terminalReady = true; notifyPending(); linger(); }
    else {
      try { watcher = watch(config.streamPath, () => schedule("scan", scan)); watcher.on("error", error => console.error(error)); }
      catch { /* The fallback also handles a stream created after registration. */ }
      timers.add(setInterval(() => schedule("scan", scan), 500));
      if (config.ownerKind !== "claude-worker") timers.add(setInterval(() => schedule("identity", async () => {
        if (terminalState) return;
        // Cancellation kills the child's group, never this detached shadow's group.
        let identity: "alive" | "dead" | "unknown" = "unknown";
        if (childProcStartTime) identity = await processIdentity(config.childPid, childProcStartTime);
        else {
          try { process.kill(config.childPid, 0); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") identity = "dead"; }
        }
        if (identity === "dead") {
          await scan();
          if (!terminalState) await terminal("exited", "cancelled_or_died");
        }
      }), 2000));
    }
  };
  const started = start();
  startupDone = started.catch(() => undefined);
  try {
    await started;
    ownerStarted = true;
    if (workerOwner && ownerLost && !ownerReady) await cleanup();
    else if (workerOwner) schedule("owner", checkOwner);
  }
  catch (error) { await cleanup(); throw error; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error); process.exitCode = 2; });
}
