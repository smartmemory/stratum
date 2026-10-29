import { useCallback, useEffect, useState } from "react";
import { useLoad } from "../context";
import type { DataClient, RunDetail as RunDetailData } from "../data-client";
import { eventColor } from "../model/status";
import { clockTime, money, preview, relativeTime } from "../model/timing";
import { DagView } from "./DagView";
import { Empty, ErrorLine, LiveToggle, Spinner, StatusPill } from "./bits";
import { StepDrawer } from "./StepDrawer";

export interface RunDetailProps {
  runId: string;
  /** Host navigation back to the list; the button is hidden when absent. */
  onBack?: () => void;
  /** Host navigation to the gate inbox; shown on runs waiting on a gate. */
  onOpenGates?: () => void;
  /** Poll interval when the host's DataClient has no `subscribe`. */
  pollMs?: number;
}

const FOCUS = ["waiting_gate", "running", "failed", "ready"];

export function RunDetail({ runId, onBack, onOpenGates, pollMs = 5000 }: RunDetailProps) {
  const [live, setLive] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  // Live by default: pushed through `subscribe` when the client has one, else polled every pollMs.
  const subscribe = useCallback(
    (client: DataClient, push: (run: RunDetailData | null) => void) => (client.subscribe ? client.subscribe(runId, push) : undefined),
    [runId],
  );
  const { data: run, error, loading } = useLoad((client) => client.getRun(runId), [runId], live ? pollMs : 0, live ? subscribe : undefined);

  // Keep the selection while it exists; else focus the most active step.
  useEffect(() => {
    if (!run) return;
    setSelected((prev) => {
      if (prev && run.steps.some((step) => step.id === prev)) return prev;
      for (const status of FOCUS) {
        const hit = run.steps.find((step) => run.stepStates[step.id]?.status === status);
        if (hit) return hit.id;
      }
      return run.steps[0]?.id ?? null;
    });
  }, [run]);

  if (run === null && !loading) {
    return (
      <div className="sui-root sui-screen" data-screen="run">
        <Empty title="not found">No run with id {runId}.</Empty>
        {onBack && <div className="sui-center"><button type="button" className="sui-btn" onClick={onBack}>Back to runs</button></div>}
      </div>
    );
  }
  if (!run) {
    return <div className="sui-root sui-screen" data-screen="run"><ErrorLine error={error} />{!error && <Spinner />}</div>;
  }

  const step = run.steps.find((candidate) => candidate.id === selected);
  const waiting = run.steps.filter((candidate) => run.stepStates[candidate.id]?.status === "waiting_gate");

  return (
    <div className="sui-root sui-screen" data-screen="run">
      <div className="sui-bar">
        {onBack && <button type="button" className="sui-btn sui-btn-ghost" onClick={onBack}>← runs</button>}
        <span className="sui-mono sui-strong" title={run.id}>{run.id}</span>
        <span className="sui-muted">{run.flowName}</span>
        <StatusPill status={run.displayStatus} />
        <span className="sui-push sui-mono sui-muted">
          started {relativeTime(run.startedAt)} · spent {money(run.spent.usd)} · {run.completedSteps}/{run.stepCount} steps
          {run.maxRounds !== null ? ` · round ${run.round}/${run.maxRounds}` : ""}
        </span>
        <LiveToggle live={live} onChange={setLive} />
      </div>
      <ErrorLine error={error} />

      {waiting.length > 0 && (
        <div className="sui-banner" role="status">
          Waiting on gate {waiting.map((gate) => gate.id).join(", ")}
          {onOpenGates && <button type="button" className="sui-btn sui-btn-ghost sui-push" onClick={onOpenGates}>open gates</button>}
        </div>
      )}
      {run.failure && <div className="sui-callout sui-callout-bad"><b>run failed</b>: {run.failure.reason}</div>}
      {run.specError && <div className="sui-callout sui-callout-bad"><b>spec unreadable</b>: {run.specError}</div>}

      <div className="sui-run-body">
        <div className="sui-run-graph">
          {run.steps.length ? (
            <DagView steps={run.steps} states={run.stepStates} selectedId={selected} onSelect={setSelected} />
          ) : <Empty title="no steps" />}
        </div>
        {step ? (
          <StepDrawer step={step} state={run.stepStates[step.id]} events={run.events} onClose={() => setSelected(null)} />
        ) : (
          <aside className="sui-drawer"><Empty title="no step selected">Click a step in the graph.</Empty></aside>
        )}
      </div>

      <details className="sui-section sui-run-events">
        <summary className="sui-micro">all events · {run.events.length}</summary>
        <ol className="sui-events">
          {[...run.events].reverse().map((event, index) => (
            <li key={`${event.at}-${index}`}>
              <span className="sui-mono sui-muted">{clockTime(event.at)}</span>
              <span className="sui-mono" style={{ color: eventColor(event.type) }}>{event.type}</span>
              {event.stepId
                ? <button type="button" className="sui-link sui-mono" onClick={() => setSelected(event.stepId!)}>{event.stepId}</button>
                : <span />}
              <span className="sui-ellipsis">{preview(event.detail, 140)}</span>
            </li>
          ))}
        </ol>
      </details>
    </div>
  );
}
