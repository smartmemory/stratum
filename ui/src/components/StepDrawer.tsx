import { useMemo } from "react";
import type { RunEvent, StepSpec, StepStateView } from "../data-client";
import { dataRefs } from "../model/graph";
import { eventColor, kindTone } from "../model/status";
import { clockTime, formatDuration, money, preview, stepTiming } from "../model/timing";
import { StatusPill } from "./bits";

export interface StepDrawerProps {
  step: StepSpec;
  state: StepStateView | undefined;
  events: RunEvent[];
  onClose?: () => void;
}

function Json({ value }: { value: unknown }) {
  const text = useMemo(() => {
    const raw = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    return raw.length > 20_000 ? `${raw.slice(0, 20_000)}\n… (${raw.length - 20_000} more characters)` : raw;
  }, [value]);
  return <pre className="sui-pre">{text}</pre>;
}

export function StepDrawer({ step, state, events, onClose }: StepDrawerProps) {
  const timing = stepTiming(step.id, state, events);
  const mine = events.filter((event) => event.stepId === step.id);
  const refs = dataRefs(step).filter((ref) => !(step.after ?? []).includes(ref));
  const attempts = state?.attempts ?? [];
  const items = state?.fanout?.items;

  return (
    <aside className="sui-drawer" aria-label={`step ${step.id}`} data-testid="step-drawer">
      <header className="sui-drawer-head">
        <span className="sui-node-kind" style={{ color: kindTone(step.kind).color }}>{step.kind}</span>
        <span className="sui-mono sui-strong">{step.id}</span>
        <StatusPill status={state?.status ?? "pending"} kind="step" />
        {onClose && <button type="button" className="sui-btn sui-btn-ghost sui-push" onClick={onClose} aria-label="close step">×</button>}
      </header>

      <dl className="sui-facts">
        <dt>started</dt><dd>{clockTime(timing.startedAt)}</dd>
        <dt>ended</dt><dd>{clockTime(timing.endedAt)}</dd>
        <dt>duration</dt><dd>{formatDuration(timing.durationMs)}</dd>
        <dt>spent</dt><dd>{money(state?.spent?.usd)}{state?.spent?.dispatches ? ` · ${state.spent.dispatches} dispatches` : ""}</dd>
        <dt>after</dt><dd>{step.after?.length ? step.after.join(", ") : "root"}</dd>
        {refs.length > 0 && (<><dt>data refs</dt><dd>{refs.join(", ")}</dd></>)}
        {step.gate && (<><dt>routes</dt><dd>approve → {step.gate.on_approve ?? "continue"} · revise → {step.gate.on_revise ?? "—"} · kill → {step.gate.on_kill ?? "end"}</dd></>)}
        {step.on_fail && (<><dt>on_fail</dt><dd>{step.on_fail}</dd></>)}
        {state?.epoch ? (<><dt>epoch</dt><dd>{state.epoch} (revised)</dd></>) : null}
        {state?.iterations ? (<><dt>iterations</dt><dd>{state.iterations}</dd></>) : null}
      </dl>

      {state?.failure && (
        <div className="sui-callout sui-callout-bad"><b>failure</b> (attempt {state.failure.attempt}): {state.failure.reason}</div>
      )}
      {state?.routed && (
        <div className="sui-callout"><b>routed</b> (attempt {state.routed.attempt}): {state.routed.reason}</div>
      )}

      <section className="sui-section">
        <div className="sui-section-head"><span className="sui-micro">attempts</span><span className="sui-mono sui-muted">{attempts.length}</span></div>
        {attempts.length === 0 ? <div className="sui-muted sui-pad">no attempts</div> : (
          <table className="sui-table">
            <thead><tr><th>#</th><th>at</th><th>model</th><th>time</th><th>outcome</th></tr></thead>
            <tbody>
              {attempts.map((attempt, index) => (
                <tr key={`${attempt.attempt}-${index}`}>
                  <td className="sui-mono">{attempt.attempt}</td>
                  <td className="sui-mono">{clockTime(attempt.at)}</td>
                  <td className="sui-mono">{attempt.model ?? "—"}</td>
                  <td className="sui-mono">{formatDuration(attempt.durationMs)}</td>
                  <td className={attempt.failure ? "sui-bad" : undefined}>
                    {attempt.failure ? attempt.failure.reason : preview(attempt.result, 120) || "ok"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {items && (
        <section className="sui-section">
          <div className="sui-section-head"><span className="sui-micro">fanout items</span><span className="sui-mono sui-muted">{items.length}</span></div>
          <div className="sui-items">
            {items.map((item) => (
              <div key={item.index} className="sui-item" title={item.failure?.reason ?? preview(item.output, 200)}>
                <span className="sui-mono">#{item.index}</span>
                <StatusPill status={item.status} kind="step" />
                <span className="sui-mono sui-muted">{item.attempts.length} att{item.stage !== undefined ? ` · stage ${item.stage}` : ""}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {state?.output !== undefined && (
        <details className="sui-section" open>
          <summary className="sui-micro">output</summary>
          <Json value={state.output} />
        </details>
      )}

      <section className="sui-section">
        <div className="sui-section-head"><span className="sui-micro">events</span><span className="sui-mono sui-muted">{mine.length}</span></div>
        <ol className="sui-events">
          {mine.map((event, index) => (
            <li key={`${event.at}-${index}`}>
              <span className="sui-mono sui-muted">{clockTime(event.at)}</span>
              <span className="sui-mono" style={{ color: eventColor(event.type) }}>{event.type}</span>
              <span className="sui-ellipsis">{preview(event.detail, 140)}</span>
            </li>
          ))}
        </ol>
      </section>

      <details className="sui-section">
        <summary className="sui-micro">spec</summary>
        <Json value={step} />
      </details>
    </aside>
  );
}
