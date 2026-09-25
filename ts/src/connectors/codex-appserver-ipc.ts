import type { ChildProcess } from "node:child_process";

/** Message delivery is independent of the run's terminal claim. */
export interface SteerRequest { type: "steer"; reqId: string; senderFrom: string; msgId: string; text: string; runId?: string; expectedTurnId?: string }
export interface SteerResult { type: "steer-result"; reqId: string; outcome: "delivered" | "expired" | "dropped"; detail: "refused" | "unknown" | null }
export type DriverMessage = SteerResult
  | { type: "active-turn-state"; runId: string; threadId: string | null; turnId: string | null }
  | { type: "run-finalized"; runId: string };
export type PeerMessage = SteerRequest | { type: "owner-ready"; runId: string };
export interface DriverPeerAttachment {
  send(message: DriverMessage): void;
  subscribe(receive: (message: PeerMessage) => void): () => void;
  close(): void;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
const nonempty = (value: unknown): value is string => typeof value === "string" && value.length > 0;
export function isPeerMessage(value: unknown, runId: string): value is PeerMessage {
  if (!record(value) || value.runId !== runId) return false;
  return value.type === "owner-ready" || (value.type === "steer" && nonempty(value.reqId)
    && nonempty(value.senderFrom) && nonempty(value.msgId) && typeof value.text === "string"
    && nonempty(value.expectedTurnId));
}
export function isDriverMessage(value: unknown, runId: string): value is DriverMessage {
  if (!record(value)) return false;
  if (value.type === "steer-result") return nonempty(value.reqId) && (
    (value.outcome === "delivered" && value.detail === null)
    || (value.outcome === "expired" && value.detail === "refused")
    || (value.outcome === "dropped" && value.detail === "unknown"));
  if (value.runId !== runId) return false;
  return value.type === "run-finalized" || (value.type === "active-turn-state"
    && (value.threadId === null || nonempty(value.threadId)) && (value.turnId === null || nonempty(value.turnId)));
}

/** Persistent IPC: readiness may precede attachment; finalization is flushed before close. */
export class AppServerPeerHandle implements DriverPeerAttachment {
  private listeners = new Set<(message: PeerMessage) => void>();
  private ready = false;
  private closed = false;
  private closing = false;
  private sends = 0;
  private timer: NodeJS.Timeout | undefined;
  private readonly child: ChildProcess;
  private readonly runId: string;
  constructor(child: ChildProcess, runId: string) {
    this.child = child; this.runId = runId;
    child.on("message", this.receive);
    child.on("error", this.abandon);
    child.on("disconnect", this.abandon);
    child.on("exit", this.abandon);
    child.channel?.unref();
  }
  get pid(): number | undefined { return this.child.pid; }
  /** A registration that missed its budget must not leave a late endpoint. */
  async abortRegistration(): Promise<void> {
    this.abandon();
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    await new Promise<void>(resolve => {
      const timer = setTimeout(() => this.child.kill("SIGKILL"), 1000);
      this.child.once("exit", () => { clearTimeout(timer); resolve(); });
      this.child.kill("SIGTERM");
    });
  }
  private receive = (value: unknown) => {
    if (this.closed || !isPeerMessage(value, this.runId)) return;
    if (value.type === "owner-ready") this.ready = true;
    for (const listener of this.listeners) listener(value);
  };
  subscribe(receive: (message: PeerMessage) => void): () => void {
    if (this.closed) return () => {};
    this.listeners.add(receive);
    if (this.ready) receive({type:"owner-ready", runId:this.runId});
    return () => this.listeners.delete(receive);
  }
  send(message: DriverMessage): void {
    if (this.closed || this.closing || !this.child.connected) return;
    this.sends++;
    try { this.child.send(message, error => {
      this.sends--;
      if (error || (this.closing && !this.sends)) this.abandon();
    }); } catch { this.sends--; this.abandon(); }
  }
  finalize(): void { this.send({type:"run-finalized", runId:this.runId}); this.close(); }
  close(): void {
    if (this.closed || this.closing) return;
    this.closing = true;
    if (!this.sends) this.abandon();
    else { this.timer = setTimeout(this.abandon, 1000); this.timer.unref(); }
  }
  abandon = (): void => {
    if (this.closed) return;
    this.closed = true; clearTimeout(this.timer); this.listeners.clear();
    this.child.off("message", this.receive);
    this.child.off("disconnect", this.abandon); this.child.off("exit", this.abandon);
    // Keep the error sink for asynchronous channel errors.
    try { if (this.child.connected) this.child.disconnect(); } catch { /* channel closed */ }
  };
}
