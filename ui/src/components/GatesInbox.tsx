import { useState } from "react";
import type { GateAction, GateResolution, PendingGate } from "../data-client";
import { useDataClient, useLoad } from "../context";
import { clockTime, relativeTime } from "../model/timing";
import { Empty, ErrorLine, LiveToggle, Spinner } from "./bits";

export interface GatesInboxProps {
  /** Host navigation to a run. The "inspect run" link is hidden when absent. */
  onOpenRun?: (runId: string) => void;
  pollMs?: number;
}

const gateKey = (gate: PendingGate) => `${gate.runId}/${gate.stepId}`;

function outcomeText(result: GateResolution): string {
  if (result.ok) return `${result.outcome} → ${result.result}`;
  return `${result.kind === "conflict" ? "conflict" : "refused"} (${result.code}): ${result.message}`;
}

export function GateCard({ gate, busy, onResolve, onOpenRun }: {
  gate: PendingGate;
  busy: boolean;
  onResolve: (action: GateAction, note?: string) => void;
  onOpenRun?: (runId: string) => void;
}) {
  const [mode, setMode] = useState<"idle" | "revise" | "reject">("idle");
  const [note, setNote] = useState("");
  const canRevise = gate.onRevise !== null;
  const noToken = gate.gateToken === null;

  return (
    <article className="sui-card" data-gate={gateKey(gate)}>
      <header className="sui-card-head">
        <span className="sui-mono sui-strong">{gate.stepId}</span>
        <span className="sui-muted">{gate.flowName}</span>
        <span className="sui-mono sui-muted sui-push" title={gate.runId}>{gate.runId.slice(0, 8)}</span>
      </header>
      <div className="sui-card-body">
        <div className="sui-kv sui-mono">
          <span>revisions <b>{gate.round}{gate.maxRounds !== null ? ` / ${gate.maxRounds}` : " / none allowed"}</b></span>
          <span title={clockTime(gate.waitingSince)}>waiting <b>{relativeTime(gate.waitingSince)}</b></span>
          <span>approve → <b>{gate.onApprove ?? "continue"}</b></span>
          <span>revise → <b>{gate.onRevise ?? "—"}</b></span>
          <span>kill → <b>{gate.onKill ?? "end run"}</b></span>
        </div>
        {noToken && <div className="sui-callout sui-callout-bad">This gate has no round token, so it cannot be resolved from here.</div>}

        {mode === "revise" && (
          <div className="sui-form">
            <label className="sui-micro" htmlFor={`note-${gateKey(gate)}`}>revision note</label>
            <textarea
              id={`note-${gateKey(gate)}`}
              className="sui-input sui-textarea"
              value={note}
              onChange={(event) => setNote(event.target.value)}
              placeholder="What should change before the next review?"
            />
            {gate.reviseEndsRun && <div className="sui-callout sui-callout-bad">No revision rounds left{gate.maxRounds === null ? " (the flow sets no max_rounds)" : ""}: a revise now ends the run.</div>}
            <div className="sui-actions">
              <button type="button" className="sui-btn" disabled={busy || !note.trim()} onClick={() => onResolve("revise", note.trim())}>Request revision</button>
              <button type="button" className="sui-btn sui-btn-ghost" onClick={() => setMode("idle")}>Cancel</button>
            </div>
          </div>
        )}
        {mode === "reject" && (
          <div className="sui-form">
            <div className="sui-callout sui-callout-bad">Reject kills the gate{gate.onKill ? ` and routes to ${gate.onKill}` : " and ends the run"}.</div>
            <div className="sui-actions">
              <button type="button" className="sui-btn sui-btn-bad" disabled={busy} onClick={() => onResolve("reject")}>Confirm reject</button>
              <button type="button" className="sui-btn sui-btn-ghost" onClick={() => setMode("idle")}>Cancel</button>
            </div>
          </div>
        )}
        {mode === "idle" && (
          <div className="sui-actions">
            <button type="button" className="sui-btn sui-btn-good" disabled={busy || noToken} onClick={() => onResolve("approve")}>Approve</button>
            <button type="button" className="sui-btn sui-btn-bad-outline" disabled={busy || noToken} onClick={() => setMode("reject")}>Reject</button>
            <button type="button" className="sui-btn" disabled={busy || noToken || !canRevise} onClick={() => setMode("revise")} title={canRevise ? undefined : "this gate has no on_revise route"}>Revise</button>
            {onOpenRun && <button type="button" className="sui-link sui-push" onClick={() => onOpenRun(gate.runId)}>inspect run</button>}
          </div>
        )}
      </div>
    </article>
  );
}

export function GatesInbox({ onOpenRun, pollMs = 4000 }: GatesInboxProps) {
  const client = useDataClient();
  const [live, setLive] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [results, setResults] = useState<Array<{ key: string; text: string; ok: boolean }>>([]);
  const { data: gates, error, reload } = useLoad((c) => c.listGates(), [], live ? pollMs : 0);

  const resolve = async (gate: PendingGate, action: GateAction, note?: string) => {
    if (gate.gateToken === null) return;
    setBusy(gateKey(gate));
    let result: GateResolution;
    try {
      result = await client.resolveGate({ runId: gate.runId, stepId: gate.stepId, action, note, gateToken: gate.gateToken });
    } catch (err) {
      result = { ok: false, kind: "error", code: "CLIENT", message: err instanceof Error ? err.message : String(err) };
    }
    setResults((prev) => [{ key: gateKey(gate), text: `${gate.stepId} (${gate.runId.slice(0, 8)}): ${outcomeText(result)}`, ok: result.ok }, ...prev].slice(0, 5));
    setBusy(null);
    reload();
  };

  return (
    <div className="sui-root sui-screen" data-screen="gates">
      <div className="sui-bar">
        <h1 className="sui-title">Gates</h1>
        <span className="sui-mono sui-muted">{gates ? `${gates.length} waiting` : "loading"}</span>
        <div className="sui-push"><LiveToggle live={live} onChange={setLive} /></div>
      </div>
      <ErrorLine error={error} />
      {results.length > 0 && (
        <ul className="sui-results" aria-label="gate results">
          {results.map((entry, index) => <li key={`${entry.key}-${index}`} className={entry.ok ? "sui-good" : "sui-bad"}>{entry.text}</li>)}
        </ul>
      )}
      <div className="sui-scroll sui-pad">
        {!gates && !error && <Spinner />}
        {gates && gates.length === 0 && <Empty title="inbox empty">No gate is waiting on a decision.</Empty>}
        <div className="sui-cards">
          {(gates ?? []).map((gate) => (
            <GateCard
              // A new gate round has a new token: remount so a half-filled revise form never carries over.
              key={`${gateKey(gate)}/${gate.gateToken ?? ""}`}
              gate={gate}
              busy={busy === gateKey(gate)}
              onResolve={(action, note) => void resolve(gate, action, note)}
              onOpenRun={onOpenRun}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
