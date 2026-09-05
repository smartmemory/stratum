/** Link without racing the operation: callers still await connector teardown. */
export function linkAbort(signal: AbortSignal | undefined, controller: AbortController): () => void {
  const abort = (): void => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  return () => signal?.removeEventListener("abort", abort);
}

import type { ChildProcess } from "node:child_process";

export function cancellationGraceMs(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.STRATUM_CANCEL_GRACE_MS ?? 5000);
  if (!Number.isFinite(value) || value < 0) throw new Error("STRATUM_CANCEL_GRACE_MS must be a nonnegative number");
  return value;
}

/** Windows cannot promise process-tree teardown with child.kill(). Fail before spawn. */
export function requireProcessGroups(platform: string = process.platform): void {
  if (platform === "win32") throw Object.assign(new Error("Cancellable agent runs require POSIX process groups; Windows tree cancellation is unsupported"), { code: "CANCELLATION_UNSUPPORTED_PLATFORM" });
}

/** A killed leader's `close` says nothing about the rest of its process group:
 * members can still be draining when the leader is reaped. Poll the group for
 * ESRCH so cancellation is only acknowledged once nothing in it is left, and
 * bound the wait so one wedged member cannot stall the acknowledgement. */
const REAP_POLL_MS = 10;
export const REAP_TIMEOUT_MS = 2_000;

async function reap(alive: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (alive()) {
    if (Date.now() >= deadline) throw Object.assign(new Error(`Process group still exists after ${timeoutMs}ms reap deadline`), { code: "CANCELLATION_TEARDOWN_TIMEOUT" });
    await new Promise<void>((resolve) => { setTimeout(resolve, REAP_POLL_MS); });
  }
}

/** Own teardown separately from child.kill: SDK cleanup cannot bypass the grace period. */
export function processTermination(child: ChildProcess, group: boolean, graceMs = cancellationGraceMs(), reapTimeoutMs = REAP_TIMEOUT_MS) {
  let closed = false;
  const close = new Promise<void>((resolve) => child.once("close", () => { closed = true; resolve(); }));
  let teardown: Promise<void> | undefined;
  let forceKill: (() => void) | undefined;
  const send = (signal: NodeJS.Signals): void => {
    if (group && child.pid) {
      try { process.kill(-child.pid, signal); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    } else if (!closed) child.kill(signal);
  };
  const alive = (): boolean => {
    if (!group || !child.pid) return !closed;
    try { process.kill(-child.pid, 0); return true; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
  };
  // `initial` is the signal sent FIRST. The grace window and the SIGKILL
  // escalation below are unchanged, so a caller asking for SIGKILL skips the
  // grace period rather than bypassing teardown. A later emergency SIGKILL
  // interrupts an existing grace window, while joining the same teardown.
  const terminate = (initial: NodeJS.Signals = "SIGTERM"): Promise<void> => {
    if (teardown && initial === "SIGKILL") forceKill?.();
    teardown ??= (async () => {
      send(initial);
      let timer: NodeJS.Timeout | undefined;
      try {
        if (initial !== "SIGKILL") {
          await Promise.race([new Promise<void>(resolve => { forceKill = resolve; }),
            new Promise<void>(resolve => { timer = setTimeout(resolve, graceMs); }),
            close.then(() => alive() ? new Promise<void>(() => {}) : undefined)]);
        }
        if (alive()) send("SIGKILL");
        await close;
        // The leader is gone; wait for the rest of its group before acknowledging.
        if (group) await reap(alive, reapTimeoutMs);
      } catch (error) {
        const failure = error instanceof Error ? error : new Error(String(error));
        if (!("code" in failure) || failure.code !== "CANCELLATION_TEARDOWN_TIMEOUT") {
          Object.assign(failure, { code: "CANCELLATION_UNCONFIRMED" });
        }
        throw failure;
      } finally { if (timer) clearTimeout(timer); }
    })();
    void teardown.catch(() => {});
    return teardown;
  };
  return { close, terminate, finish: () => teardown ?? Promise.resolve() };
}

export async function teardownDeadline<T>(operation: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Object.assign(new Error(`${message} after ${ms}ms`), { code: "CANCELLATION_TEARDOWN_TIMEOUT" })), ms);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
