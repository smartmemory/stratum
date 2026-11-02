import { useState, type ReactNode } from "react";
import { runTone, stepTone } from "../model/status";
import { preview } from "../model/timing";
import { CopyText, EntityLink } from "../nav";

export function StatusPill({ status, kind = "run" }: { status: string; kind?: "run" | "step" }) {
  const tone = kind === "step" ? stepTone(status) : runTone(status);
  return (
    <span className="sui-pill" style={{ color: tone.color }} data-status={status}>
      <span className={tone.live ? "sui-dot sui-pulse" : "sui-dot"} />
      {tone.label}
    </span>
  );
}

export function LiveToggle({ live, onChange }: { live: boolean; onChange: (live: boolean) => void }) {
  return (
    <button
      type="button"
      className={live ? "sui-live sui-live-on" : "sui-live"}
      aria-pressed={live}
      onClick={() => onChange(!live)}
      title={live ? "Stop auto-refresh" : "Auto-refresh"}
    >
      <span className={live ? "sui-dot sui-pulse" : "sui-dot"} />
      live
    </button>
  );
}

export function Spinner() {
  return (
    <div className="sui-center" role="status" aria-label="loading">
      <div className="sui-spinner" />
    </div>
  );
}

export function Empty({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="sui-center sui-empty">
      <div className="sui-micro">{title}</div>
      {children && <p className="sui-muted">{children}</p>}
    </div>
  );
}

export function ErrorLine({ error }: { error: string | null }) {
  if (!error) return null;
  return <div className="sui-error" role="alert">{error}</div>;
}

/** A step id that selects that step: the host's callback, else a real link when the NavProvider has a URL for the step, else text. */
export function StepLink({ runId, stepId, onSelect }: { runId?: string; stepId: string; onSelect?: (stepId: string) => void }) {
  return (
    <EntityLink target={{ kind: "step", runId, stepId }} onOpen={onSelect ? () => onSelect(stepId) : undefined}>
      {stepId}
    </EntityLink>
  );
}

/** Pretty text for a value that may be long: strings as they are, everything else as indented JSON. */
export const fullText = (value: unknown): string => (typeof value === "string" ? value : JSON.stringify(value, null, 2) ?? "");

/**
 * A clipped preview that opens to the full text (with a copy button) on click or Enter. Renders as a grid
 * child of an events `<li>`: the opened text spans the row. Plain text when there is nothing to open.
 */
export function Expandable({ value, max = 140 }: { value: unknown; max?: number }) {
  const [open, setOpen] = useState(false);
  const text = fullText(value);
  if (!text) return <span className="sui-ellipsis" />;
  const clipped = preview(value, max);
  if (clipped === text && !text.includes("\n")) return <span className="sui-ellipsis">{clipped}</span>;
  return (
    <>
      <button type="button" className="sui-expand sui-ellipsis" aria-expanded={open} onClick={() => setOpen(!open)} title={open ? "collapse" : "show all"}>
        <span aria-hidden="true">{open ? "▾ " : "▸ "}</span><span>{clipped}</span>
      </button>
      {open && (
        <div className="sui-expanded">
          <pre className="sui-pre">{text}</pre>
          <CopyText value={text}>copy</CopyText>
        </div>
      )}
    </>
  );
}
