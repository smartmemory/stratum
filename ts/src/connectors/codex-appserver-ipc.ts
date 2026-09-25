/** Message delivery is independent of the run's terminal claim. */
export interface SteerRequest { type: "steer"; reqId: string; senderFrom: string; msgId: string; text: string }
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
