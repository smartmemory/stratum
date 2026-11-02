import { useCallback, useEffect, useRef, useState } from "react";
import { useLoad } from "../context";
import type { DataClient, RunDetail as RunDetailData } from "../data-client";
import { eventColor } from "../model/status";
import { clockTime, money, relativeTime } from "../model/timing";
import { DagView } from "./DagView";
import { CopyText, EntityLink } from "../nav";
import { Empty, ErrorLine, Expandable, LiveToggle, Spinner, StatusPill, StepLink } from "./bits";
import { StepDrawer } from "./StepDrawer";

export interface RunDetailProps {
  runId: string;
  /** Host navigation back to the list; the button is hidden when absent. */
  onBack?: () => void;
  /** Host navigation to the gate inbox (narrowed to this run, and to a step when one is named); shown on runs waiting on a gate. */
  onOpenGates?: (runId?: string, stepId?: string) => void;
  /** Host navigation to this run's flow in the builder (a step id when one is named). */
  onOpenFlow?: (runId: string, stepId?: string) => void;
  /** Host navigation to the feature a run belongs to (shown as a chip when the run carries a feature code). */
  onOpenFeature?: (featureCode: string) => void;
  /** Host navigation to the runs list; the not-found state's way back when `onBack` is absent. */
  onOpenRuns?: () => void;
  /** The selected step, when the host keeps it (the shell puts it in the URL). Absent: the screen keeps its own. */
  stepId?: string | null;
  /** Called when the user selects a step (graph, drawer links, events, banner). null = the drawer closed. */
  onSelectStep?: (stepId: string | null) => void;
  /** Poll interval when the host's DataClient has no `subscribe`. */
  pollMs?: number;
}

const FOCUS = ["waiting_gate", "running", "failed", "ready"];

export function RunDetail({ runId, onBack, onOpenGates, onOpenFlow, onOpenFeature, onOpenRuns, stepId, onSelectStep, pollMs = 5000 }: RunDetailProps) {
  const [live, setLive] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [eventType, setEventType] = useState("");
  const select = (id: string | null) => {
    setSelected(id);
    onSelectStep?.(id);
  };
  const lastStepId = useRef<string | null | undefined>(stepId);
  // Live by default: pushed through `subscribe` when the client has one, else polled every pollMs.
  const subscribe = useCallback(
    (client: DataClient, push: (run: RunDetailData | null) => void) => (client.subscribe ? client.subscribe(runId, push) : undefined),
    [runId],
  );
  const { data: run, error, loading } = useLoad((client) => client.getRun(runId), [runId], live ? pollMs : 0, live ? subscribe : undefined);

  // Keep the selection while it exists; else focus the most active step.
  useEffect(() => {
    if (!run) return;
    // A step the host names wins (deep link, Back); when the host's step changes, a stale local pick is dropped.
    const hostChanged = lastStepId.current !== stepId;
    lastStepId.current = stepId;
    setSelected((prev) => {
      if (stepId && run.steps.some((step) => step.id === stepId)) return stepId;
      if (!hostChanged && prev && run.steps.some((step) => step.id === prev)) return prev;
      for (const status of FOCUS) {
        const hit = run.steps.find((step) => run.stepStates[step.id]?.status === status);
        if (hit) return hit.id;
      }
      return run.steps[0]?.id ?? null;
    });
  }, [run, stepId]);

  if (run === null && !loading) {
    return (
      <div className="sui-root sui-screen" data-screen="run">
        <Empty title="not found">No run with id {runId}.</Empty>
        <div className="sui-center">
          {onBack ? <button type="button" className="sui-btn" onClick={onBack}>Back to runs</button> : <EntityLink target={{ kind: "runs" }} onOpen={onOpenRuns}>Back to runs</EntityLink>}
        </div>
      </div>
    );
  }
  if (!run) {
    return <div className="sui-root sui-screen" data-screen="run"><ErrorLine error={error} />{!error && <Spinner />}</div>;
  }

  const step = run.steps.find((candidate) => candidate.id === selected);
  const waiting = run.steps.filter((candidate) => run.stepStates[candidate.id]?.status === "waiting_gate");
  const failedStep = run.steps.find((candidate) => run.stepStates[candidate.id]?.status === "failed");
  const eventTypes = [...new Set(run.events.map((event) => event.type))].sort();

  return (
    <div className="sui-root sui-screen" data-screen="run">
      <div className="sui-bar">
        {onBack && <button type="button" className="sui-btn sui-btn-ghost" onClick={onBack}>← runs</button>}
        <CopyText className="sui-link sui-mono sui-strong sui-id" value={run.id}>{run.id}</CopyText>
        <EntityLink target={{ kind: "flow", runId: run.id }} onOpen={onOpenFlow ? () => onOpenFlow(run.id) : undefined} title="open this flow in the builder">{run.flowName}</EntityLink>
        {run.featureCode && (
          <EntityLink className="sui-link sui-chip" target={{ kind: "feature", code: run.featureCode }} onOpen={onOpenFeature ? () => onOpenFeature(run.featureCode!) : undefined} title={`feature ${run.featureCode}`}>{run.featureCode}</EntityLink>
        )}
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
          Waiting on gate{" "}
          {waiting.map((gate, index) => (
            <span key={gate.id}>{index > 0 && ", "}<StepLink runId={run.id} stepId={gate.id} onSelect={select} /></span>
          ))}
          <span className="sui-push">
            <EntityLink className="sui-btn sui-btn-ghost" target={{ kind: "gates", runId: run.id, stepId: waiting[0]?.id }} onOpen={onOpenGates ? () => onOpenGates(run.id, waiting.length === 1 ? waiting[0]!.id : undefined) : undefined}>open gates</EntityLink>
          </span>
        </div>
      )}
      {run.failure && <div className="sui-callout sui-callout-bad"><b>run failed</b>: {run.failure.reason}{failedStep && <> · failing step <StepLink runId={run.id} stepId={failedStep.id} onSelect={select} /></>}</div>}
      {run.specError && <div className="sui-callout sui-callout-bad"><b>spec unreadable</b>: {run.specError}</div>}

      <div className="sui-run-body">
        <div className="sui-run-graph">
          {run.steps.length ? (
            <DagView steps={run.steps} states={run.stepStates} selectedId={selected} onSelect={select} />
          ) : <Empty title="no steps" />}
        </div>
        {step ? (
          <StepDrawer
            key={step.id}
            step={step}
            state={run.stepStates[step.id]}
            events={run.events}
            runId={run.id}
            onClose={() => select(null)}
            onSelectStep={select}
            onOpenGates={onOpenGates}
            onOpenFlow={onOpenFlow ? (id) => onOpenFlow(run.id, id) : undefined}
          />
        ) : (
          <aside className="sui-drawer"><Empty title="no step selected">Click a step in the graph.</Empty></aside>
        )}
      </div>

      <details className="sui-section sui-run-events">
        <summary className="sui-micro">all events · {run.events.length}</summary>
        {eventTypes.length > 1 && (
          <label className="sui-micro sui-event-filter">type{" "}
            <select className="sui-input" aria-label="filter events by type" value={eventType} onChange={(event) => setEventType(event.target.value)}>
              <option value="">all</option>
              {eventTypes.map((type) => <option key={type} value={type}>{type}</option>)}
            </select>
          </label>
        )}
        <ol className="sui-events">
          {[...run.events].reverse().filter((event) => !eventType || event.type === eventType).map((event, index) => (
            <li key={`${event.at}-${index}`}>
              <span className="sui-mono sui-muted">{clockTime(event.at)}</span>
              <span className="sui-mono" style={{ color: eventColor(event.type) }}>{event.type}</span>
              {event.stepId
                ? <button type="button" className="sui-link sui-mono" onClick={() => select(event.stepId!)}>{event.stepId}</button>
                : <span />}
              <Expandable value={event.detail} />
            </li>
          ))}
        </ol>
      </details>
    </div>
  );
}
