// Live run updates for the standalone server: ONE poller per server process.
//
// Why a stat poll and not fs.watch / chokidar: this machine had an fseventsd blow-up from file
// watchers (units/FSEVENTSD-WATCH-1). A poll registers nothing with the OS. It runs one 1 s timer
// that stats only the run files somebody is subscribed to (never readdir on the 500+ file flows
// dir), and does nothing while there are no subscribers. The timer is created once, unref'd, and
// cleared by close().
import { stat } from "node:fs/promises";
import { join } from "node:path";

const DEFAULT_INTERVAL_MS = 1000;
const RUN_FILE_OK = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * @param {{ flowsDir: string, loadDetail: (runId: string) => Promise<object | null>, intervalMs?: number }} options
 *   loadDetail resolves the run's projected detail, null when the run does not exist, and throws
 *   when the file is unreadable (half-written): the watcher then retries on the next tick.
 */
export function createRunWatcher({ flowsDir, loadDetail, intervalMs = DEFAULT_INTERVAL_MS }) {
  /** runId → { subs: Set<cb>, sig: string | undefined } */
  const entries = new Map();
  let timer = null;
  let started = 0;
  let ticking = false;
  let closed = false;

  const signature = (info) => `${info.ino}:${info.size}:${info.mtimeMs}`;
  const statSig = async (runId) => {
    try {
      return signature(await stat(join(flowsDir, `${runId}.json`)));
    } catch (error) {
      if (error?.code === "ENOENT") return "missing";
      throw error;
    }
  };

  function fan(entry, value) {
    for (const cb of [...entry.subs]) {
      try { cb(value); } catch { /* a dead subscriber must not stop the others */ }
    }
  }

  /** Re-read one run when its file changed, push to its subscribers. Returns after the push. */
  async function refresh(runId, entry, { force }) {
    let sig;
    try { sig = await statSig(runId); } catch { return; }
    if (!force && sig === entry.sig) return;
    let value;
    try { value = await loadDetail(runId); } catch { return; } // half-written: keep the old sig, retry
    entry.sig = sig;
    fan(entry, value);
  }

  async function tick() {
    if (ticking || closed) return;
    ticking = true;
    try {
      await Promise.all([...entries].map(([runId, entry]) => refresh(runId, entry, { force: false })));
    } finally {
      ticking = false;
    }
  }

  function ensureTimer() {
    if (timer || closed) return;
    started += 1;
    timer = setInterval(() => void tick(), intervalMs);
    timer.unref?.();
  }

  return {
    /** cb(detail | null) on every change, plus once right away. Returns unsubscribe. */
    subscribe(runId, cb) {
      if (closed || !RUN_FILE_OK.test(runId)) return () => {};
      let entry = entries.get(runId);
      if (!entry) {
        entry = { subs: new Set(), sig: undefined };
        entries.set(runId, entry);
      }
      entry.subs.add(cb);
      ensureTimer();
      const mine = entry;
      // The first snapshot goes to this subscriber only, so a re-subscribe does not repeat to the others.
      void (async () => {
        let sig;
        try { sig = await statSig(runId); } catch { return; }
        let value;
        try { value = await loadDetail(runId); } catch { return; }
        if (mine.sig === undefined) mine.sig = sig;
        if (mine.subs.has(cb)) { try { cb(value); } catch { /* ignore */ } }
      })();
      return () => {
        mine.subs.delete(cb);
        if (mine.subs.size === 0 && entries.get(runId) === mine) entries.delete(runId);
      };
    },
    /** timers: live timers now (0 or 1); started: timers ever created (stays 1); subscribers: open subscriptions. */
    stats() {
      let subscribers = 0;
      for (const entry of entries.values()) subscribers += entry.subs.size;
      return { timers: timer ? 1 : 0, started, subscribers, runs: entries.size };
    },
    close() {
      closed = true;
      if (timer) clearInterval(timer);
      timer = null;
      entries.clear();
    },
  };
}
