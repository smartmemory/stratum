import { closeSync, constants, existsSync, fstatSync, openSync, readFileSync, readSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { StringDecoder } from "node:string_decoder";

export const DEVIN_STALL_MS = 15 * 60 * 1000;
export const DEVIN_MAX_RUN_MS = 4 * 60 * 60 * 1000;

/** Filesystem failures are silence, never exceptions escaping timer callbacks.
 * Warn once per monitored file, without including its contents. */
function fileWarning(signal: string) {
  let warned = false;
  return (error: unknown) => {
    if (warned) return;
    warned = true;
    console.warn(`Devin watchdog cannot read ${signal} (${(error as NodeJS.ErrnoException).code ?? "IO_ERROR"}); treating it as no progress`);
  };
}

export function devinFileProgress(path: string, signal: string): () => string | undefined {
  const warn = fileWarning(signal);
  let previous = 0;
  return () => {
    try {
      const size = statSync(path).size;
      const changed = size > previous;
      previous = size;
      return changed ? `${signal} (${size} bytes)` : undefined;
    } catch (error) { warn(error); return undefined; }
  };
}

const ACP_PROGRESS = new Set(["agent_thought_chunk", "agent_message_chunk", "tool_call", "tool_call_update"]);

/** Tail only new bytes. The real CHISEL log serializes session/update params
 * directly as {sessionId, update: {sessionUpdate, ...}}, one JSON line each.
 * Also accept an explicit JSON-RPC envelope for that same notification. */
export function devinWireProgress(path: string): () => string | undefined {
  const warn = fileWarning("ACP wire updates");
  let offset = 0;
  let inode: number | undefined;
  let pending = "";
  let oversized = false;
  let decoder = new StringDecoder("utf8");
  return () => {
    let fd: number | undefined;
    try {
      fd = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
      const info = fstatSync(fd);
      if (!info.isFile()) throw Object.assign(new Error("not a regular wire log"), { code: "EINVAL" });
      if (info.ino !== inode || info.size < offset) {
        offset = 0; pending = ""; oversized = false; decoder = new StringDecoder("utf8");
      }
      inode = info.ino;
      const buffer = Buffer.allocUnsafe(65536);
      let event: string | undefined;
      // Bound work per scan even if a runaway agent grows the file continuously.
      const end = Math.min(info.size, offset + 4 * 1024 * 1024);
      while (offset < end) {
        const count = readSync(fd, buffer, 0, Math.min(buffer.length, end - offset), offset);
        if (count === 0) break;
        offset += count;
        const pieces = decoder.write(buffer.subarray(0, count)).split("\n");
        for (let index = 0; index < pieces.length; index++) {
          if (!oversized) pending += pieces[index];
          if (pending.length > 1024 * 1024) { pending = ""; oversized = true; }
          if (index === pieces.length - 1) continue;
          if (!oversized) {
            try {
              const json = JSON.parse(pending);
              const params = json.method === "session/update" ? json.params : json.method === undefined ? json : undefined;
              const kind = params?.update?.sessionUpdate;
              if (typeof params?.sessionId === "string" && ACP_PROGRESS.has(kind)) event = `ACP ${kind}`;
            } catch { /* Partial, malformed and non-ACP lines are silence. */ }
          }
          pending = ""; oversized = false;
        }
      }
      return event;
    } catch (error) { warn(error); return undefined; }
    finally {
      if (fd !== undefined) {
        try { closeSync(fd); } catch (error) { warn(error); }
      }
    }
  };
}

function resolveDuration(env: NodeJS.ProcessEnv, key: string, fallback: number, override?: number): number {
  const raw = override ?? env[key];
  if (raw === undefined) return fallback;
  const value = typeof raw === "number" ? raw : /^\d+$/.test(raw.trim()) ? Number(raw) : NaN;
  if (Number.isSafeInteger(value) && value >= 0) return value;
  console.warn(`Invalid ${key}: expected nonnegative integer ms; using default ${fallback}ms`);
  return fallback;
}

export function resolveDevinStallMs(env: NodeJS.ProcessEnv, override?: number): number {
  return resolveDuration(env, "STRATUM_DEVIN_STALL_MS", DEVIN_STALL_MS, override);
}

export function resolveDevinMaxRunMs(env: NodeJS.ProcessEnv, override?: number): number {
  return resolveDuration(env, "STRATUM_DEVIN_MAX_RUN_MS", DEVIN_MAX_RUN_MS, override);
}

/** Mirrors the app-server driver's arm/clear shape, with an independent ceiling. */
export function devinStallWatchdog(ms: number, expire: (error: Error) => void, wireLogPath?: string,
  maxRunMs = DEVIN_MAX_RUN_MS, startedAt = Date.now(),
  signals = wireLogPath === undefined ? "stdout, stderr" : "stdout, stderr, ACP wire updates") {
  let stall: NodeJS.Timeout | undefined;
  let scan: NodeJS.Timeout | undefined;
  let ceiling: NodeJS.Timeout | undefined;
  let stopped = false;
  const wireProgress = ms > 0 && wireLogPath !== undefined ? devinWireProgress(wireLogPath) : undefined;
  function progress() {
    const event = wireProgress?.();
    if (event !== undefined) { armStallWatchdog(event); return true; }
    return false;
  }
  function armStallWatchdog(event: string) {
    if (stopped || ms === 0) return;
    clearTimeout(stall);
    const deadline = Date.now() + ms;
    function wait() {
      if (stopped) return;
      const remaining = deadline - Date.now();
      if (remaining > 0) { stall = setTimeout(wait, Math.min(remaining, 2_147_483_647)); return; }
      stall = undefined;
      if (progress()) return;
      expire(new Error(`devin stalled: no activity for ${ms / 1000}s (last event: ${event}); silent signals: ${signals}`));
    }
    wait();
  }
  if (wireProgress !== undefined) scan = setInterval(progress, Math.max(1, Math.min(5000, Math.ceil(ms / 4))));
  if (maxRunMs > 0) {
    const deadline = startedAt + maxRunMs;
    function wait() {
      if (stopped) return;
      const remaining = deadline - Date.now();
      if (remaining > 0) { ceiling = setTimeout(wait, Math.min(remaining, 2_147_483_647)); return; }
      // Defer even an already-expired deadline until construction has completed.
      ceiling = setTimeout(() => { if (!stopped) expire(new Error(`devin exceeded maximum run time of ${maxRunMs / 1000}s (STRATUM_DEVIN_MAX_RUN_MS)`)); }, 0);
    }
    wait();
  }
  return { activity: armStallWatchdog, clear() {
    stopped = true; clearTimeout(stall); clearInterval(scan); clearTimeout(ceiling);
  } };
}

/** Detached supervisor owns background monitoring, escalation and wire retention. */
async function watchBackground(runDir: string, runId: string, root: string, ms: number, maxRunMs: number): Promise<void> {
  const sourceRoot = new URL("../", import.meta.url).href;
  const { registerHooks } = await import("node:module");
  const hooks = import.meta.url.endsWith(".ts") ? registerHooks({ resolve(specifier, context, next) {
    if (context.parentURL?.startsWith(sourceRoot) && specifier.startsWith(".") && specifier.endsWith(".js")) {
      const candidate = new URL(specifier.slice(0, -3) + ".ts", context.parentURL);
      if (existsSync(candidate)) return next(candidate.href, context);
    }
    return next(specifier, context);
  } }) : undefined;
  const extension = import.meta.url.endsWith(".ts") ? "ts" : "js";
  const { cancelBackgroundRun }: typeof import("./background.js") = await import(new URL(`./background.${extension}`, import.meta.url).href);
  const { processIdentity }: typeof import("./proc_identity.js") = await import(new URL(`./proc_identity.${extension}`, import.meta.url).href);
  const { cancellationGraceMs }: typeof import("./cancellation.js") = await import(new URL(`./cancellation.${extension}`, import.meta.url).href);
  const meta = JSON.parse(readFileSync(join(runDir, "meta.json"), "utf8"));
  const graceMs = cancellationGraceMs();
  const limits = [ms, maxRunMs, graceMs].filter(value => value > 0);
  const interval = Math.max(1, Math.min(1000, Math.ceil(Math.min(...limits) / 4)));
  let scan: NodeJS.Timeout | undefined;
  let retry: NodeJS.Timeout | undefined;
  let stopped = false;
  let expiring = false;
  let cancelling = false;
  let escalationAt = Infinity;
  let teardownDeadline = Infinity;
  let escalated = false;
  let generation = 0;
  const wireLog = join(runDir, "agent", "wire.log");
  const outputs = [devinFileProgress(join(runDir, "stdout.log"), "stdout"), devinFileProgress(join(runDir, ".err"), "stderr"), devinWireProgress(wireLog)];
  const retainWarning = fileWarning("wire retention cleanup");
  function terminal() { return existsSync(join(runDir, "exit.rc")) || !existsSync(runDir); }
  function stop() {
    stopped = true; clearTimeout(scan); clearTimeout(retry); watchdog.clear(); hooks?.deregister();
    // Keep status, stderr and ATIF for polling, but discard sensitive ACP content.
    if (existsSync(runDir)) {
      try { unlinkSync(wireLog); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") retainWarning(error); }
    }
  }
  function groupGone() {
    try { process.kill(-meta.childPid, 0); return false; }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
  }
  function progress(): boolean {
    let changed = false;
    for (const output of outputs) {
      const event = output();
      if (event !== undefined) { changed = true; generation++; watchdog.activity(event); }
    }
    return changed;
  }
  const watchdog = devinStallWatchdog(ms, function expire(error) {
    if (stopped || expiring || cancelling) return;
    expiring = true;
    void (async () => {
      if (terminal()) return stop();
      const ceiling = error.message.startsWith("devin exceeded maximum run time");
      if (!ceiling && progress()) return;
      const expiredGeneration = generation;
      const identity = await processIdentity(meta.childPid, meta.procStartTime);
      if (terminal() || (identity === "dead" && groupGone())) return stop();
      if (identity !== "alive") {
        retry = setTimeout(() => expire(error), interval);
        return;
      }
      if (stopped || (!ceiling && (progress() || generation !== expiredGeneration))) return;
      // Last terminal recheck must be immediately before the durable write.
      if (terminal()) return stop();
      writeFileSync(join(runDir, "stall.txt"), error.message, { mode: 0o600 });
      cancelling = true; watchdog.clear();
      await cancelBackgroundRun(runId, { registryRoot: root });
      escalationAt = Date.now() + graceMs;
      // Bound even a zero-grace teardown, with time for the SIGKILL to be reaped.
      teardownDeadline = escalationAt + 3 * Math.max(graceMs, interval);
    })().catch(error => { stop(); console.error(error); process.exitCode = 1; }).finally(() => { expiring = false; });
  }, undefined, maxRunMs, Date.parse(meta.createdAt), "stdout, stderr, ACP wire updates");
  const poll = async () => {
    if (stopped) return;
    if (cancelling) {
      if (groupGone()) return stop();
      if (Date.now() >= teardownDeadline) {
        console.error(`Devin watchdog giving up cancellation: process group ${meta.childPid} still exists after teardown deadline`);
        process.exitCode = 1;
        return stop();
      }
      if (!escalated && Date.now() >= escalationAt) {
        // The authenticated group's pgid cannot be reused while members remain,
        // even after TERM reaps its leader. Escalation must include those orphans.
        try { process.kill(-meta.childPid, "SIGKILL"); escalated = true; }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return stop(); throw error; }
      }
    } else {
      if (terminal() || groupGone()) return stop();
      progress();
    }
    if (!stopped) scan = setTimeout(() => { void poll().catch(error => { stop(); console.error(error); process.exitCode = 1; }); }, interval);
  };
  try { watchdog.activity("spawn"); await poll(); }
  catch (error) { stop(); throw error; }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [runDir, runId, root, ms, maxRunMs] = process.argv.slice(2);
  void watchBackground(runDir!, runId!, root!, Number(ms), Number(maxRunMs)).catch(error => { console.error(error); process.exitCode = 1; });
}
