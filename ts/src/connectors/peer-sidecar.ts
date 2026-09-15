#!/usr/bin/env -S node --experimental-strip-types
import { spawn } from "node:child_process";
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
const { processIdentity }: typeof import("./proc_identity.js") = await import(moduleUrl("proc_identity").href);

export async function spawnPeerSidecar(config: PeerSidecarConfig): Promise<void> {
  let stderr: Awaited<ReturnType<typeof open>> | undefined;
  try {
    const entry = fileURLToPath(moduleUrl("peer-sidecar"));
    stderr = await open(`${config.streamPath}.peer.err`, "a", 0o600);
    const child = spawn(process.execPath, [...(entry.endsWith(".ts") ? ["--experimental-strip-types"] : []), entry], {
      detached: true, stdio: ["ignore", "ignore", stderr.fd], env: sidecarEnv(config),
    });
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", resolve);
      child.once("error", reject);
    });
    child.unref();
  } catch (error) {
    console.error("stratum peer spawn failed:", error);
  } finally { await stderr?.close().catch(() => undefined); }
}

async function main(): Promise<void> {
  const config = configFromEnv(process.env);
  const sockPath = join(config.sockDir, `${process.pid}.sock`);
  const recordPath = join(config.sessionsDir, `${process.pid}.json`);
  const keyPath = join(config.sessionsDir, keyFileName(process.pid, sockPath));
  const owned = new Set<string>();
  const connections = new Set<Socket>();
  const inFlight = new Set<Promise<void>>();
  const subscriptions = new Map<string, {id: string; to: string; notified: boolean}>();
  let terminalReady = false;
  function notifyPending(state = terminalState): void {
    if (!state) return;
    for (const subscription of subscriptions.values()) {
      if (subscription.notified) continue;
      subscription.notified = true;
      sendControl(subscription.to, {type:"control", action:"peer_idle_notice", orig_msg_id:subscription.id,
        state:state.state, finished_at:state.finishedAt, ...(state.detail ? {detail:state.detail} : {}), from:`uds:${sockPath}`});
    }
  }
  const peerToken = randomBytes(16).toString("hex");
  function sendControl(toSockPath: string, frame: Record<string, unknown>): void {
    const attempt = (async () => {
      const token = await readPeerToken(config.sessionsDir, toSockPath);
      await new Promise<void>(resolve => {
        const socket = createConnection(toSockPath);
        const timeout = setTimeout(() => { socket.destroy(); resolve(); }, 5000);
        socket.once("connect", () => socket.end(
          (token ? JSON.stringify({type:"auth", token}) + "\n" : "") + JSON.stringify(frame) + "\n",
        ));
        socket.once("error", () => { socket.destroy(); });
        socket.once("close", () => { clearTimeout(timeout); resolve(); });
      });
    })().catch(error => { console.error("peer callback failed:", error); });
    inFlight.add(attempt);
    void attempt.finally(() => inFlight.delete(attempt));
  }
  function receive(value: unknown): void {
    if (stopping || !value || typeof value !== "object" || Array.isArray(value)) return;
    const frame = value as Record<string, unknown>;
    const to = typeof frame.from === "string" ? isAllowedCallback(frame.from, config.sockDir) : undefined;
    if (!to || typeof frame.msg_id !== "string") { console.error("peer frame rejected: invalid callback or msg_id"); return; }
    if (frame.type === "user") {
      console.error("peer user message refused");
      sendControl(to, {type:"control", action:"peer_message_status", orig_msg_id:frame.msg_id,
        status:"expired", status_detail:"refused", from:`uds:${sockPath}`});
    } else if (frame.type === "control" && frame.action === "notify_when_idle") {
      // At capacity even replacements are rejected, matching the specified acceptance rule.
      if (subscriptions.size >= 32) { console.error("peer subscription rejected: full"); return; }
      subscriptions.set(frame.from as string, {id:frame.msg_id, to, notified:false});
      if (terminalReady) notifyPending();
    } else { console.error("peer frame ignored"); }
  }
  let record: Record<string, unknown> | undefined;
  let terminalState: {state: "idle" | "exited"; finishedAt: number; detail?: string} | undefined;
  let stopping = false;
  let watcher: FSWatcher | undefined;
  const timers = new Set<NodeJS.Timeout>();
  let work = Promise.resolve();
  let startupDone = Promise.resolve();
  let offset = 0;
  let pending = Buffer.alloc(0);
  let discarding = false;
  function schedule(task: () => Promise<void>): void {
    work = work.then(async () => { if (!stopping) await task(); }).catch(error => {
      console.error(error);
      void cleanup().then(() => process.exit(2));
    });
  }
  async function terminal(state: "idle" | "exited", detail?: string): Promise<void> {
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
  const server = createServer(socket => {
    connections.add(socket);
    socket.on("error", () => socket.destroy());
    socket.on("close", () => connections.delete(socket));
    let input = Buffer.alloc(0);
    let first = true;
    const deadline = setTimeout(() => socket.destroy(), 30000);
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
      if (server.listening) server.close();
      // Startup can be between bind and publishing its files when a signal arrives.
      await startupDone;
      watcher?.close();
      for (const timer of timers) clearTimeout(timer);
      const closed = new Promise<void>(resolve => server.close(() => resolve()));
      for (const socket of connections) socket.destroy();
      await work;
      notifyPending(signal ? {state:"exited", finishedAt:Date.now()} : terminalState ?? {state:"idle", finishedAt:Date.now()});
      // A peer that never half-closes must not hold the shadow alive indefinitely.
      let deadline: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.all([...inFlight]),
        new Promise<void>(resolve => { deadline = setTimeout(resolve, 5000); }),
      ]);
      clearTimeout(deadline);
      await closed;
      for (const path of owned) await unlink(path).catch(() => undefined);
      owned.clear();
    })();
    return cleanupPromise;
  }
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.once(signal, () => {
    void cleanup(true).then(() => process.exit(0));
  });
  const start = async (): Promise<void> => {
    try {
      const existing: unknown = JSON.parse(await readFile(recordPath, "utf8"));
      if ((existing as {entrypoint?: unknown} | null)?.entrypoint !== "stratum-peer") throw new Error("foreign peer record");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (stopping) return;
    await mkdir(config.sockDir, {recursive: true, mode: 0o700});
    if (stopping) return;
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
    owned.add(sockPath);
    if (stopping) return;
    const procStart = await claudeProcStart(process.pid);
    const domain = await pidDomain();
    if (stopping) return;
    const identity = {...(procStart ? {procStart} : {}), ...(domain ? {pidDomain: domain} : {})};
    await atomicJson(keyPath, {peerToken, ...identity}, 0o600);
    const now = Date.now();
    const {version} = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8")) as {version: string};
    await scan();
    record = {
      pid:process.pid, sessionId:randomUUID(), cwd:config.cwd, startedAt:now, ...identity,
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
      try { watcher = watch(config.streamPath, () => schedule(scan)); watcher.on("error", error => console.error(error)); }
      catch { /* The fallback also handles a stream created after registration. */ }
      timers.add(setInterval(() => schedule(scan), 500));
      timers.add(setInterval(() => schedule(async () => {
        if (terminalState) return;
        // Cancellation kills the child's group, never this detached shadow's group.
        if (await processIdentity(config.childPid, config.childProcStartTime ?? "") === "dead") {
          await scan();
          if (!terminalState) await terminal("exited", "cancelled_or_died");
        }
      }), 2000));
    }
  };
  const started = start();
  startupDone = started.catch(() => undefined);
  try { await started; }
  catch (error) { await cleanup(); throw error; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error); process.exitCode = 2; });
}
