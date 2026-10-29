import type { ReactNode } from "react";
import { runTone, stepTone } from "../model/status";

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
