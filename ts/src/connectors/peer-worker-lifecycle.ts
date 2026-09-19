import type { PeerSidecarHandle } from "./peer-sidecar.js";

/** Observes worker lifetime without participating in finalization authority. */
export function createWorkerPeerLifecycle() {
  let handle: PeerSidecarHandle | undefined;
  let exited = false;
  let finalized = false;
  let abandoned = false;
  let sent = false;
  const safely = (operation: () => void) => { try { operation(); } catch { /* peer-only failure */ } };
  const flush = () => {
    if (handle && exited && finalized && !abandoned && !sent) {
      sent = true;
      safely(() => handle!.finalize());
    }
  };
  return {
    attach(value: PeerSidecarHandle) {
      if (abandoned || handle) { safely(() => value.abandon()); return; }
      handle = value;
      flush();
    },
    markExited() { exited = true; flush(); },
    markFinalized() { finalized = true; flush(); },
    abandon() { abandoned = true; if (handle) safely(() => handle!.abandon()); },
  };
}
