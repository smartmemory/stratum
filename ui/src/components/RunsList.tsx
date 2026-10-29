import { useMemo, useState } from "react";
import type { RunSummary } from "../data-client";
import { useLoad } from "../context";
import { money, relativeTime } from "../model/timing";
import { Empty, ErrorLine, LiveToggle, Spinner, StatusPill } from "./bits";

export interface RunsListProps {
  /** Navigation is the host's: called with the run id when a row is opened. */
  onOpenRun: (runId: string) => void;
  /** Auto-refresh interval while "live" is on. */
  pollMs?: number;
}

const FILTERS: Array<{ key: string; label: string; match: (run: RunSummary) => boolean }> = [
  { key: "all", label: "all", match: () => true },
  { key: "active", label: "active", match: (run) => run.displayStatus === "running" || run.displayStatus === "awaiting_gate" },
  { key: "gates", label: "awaiting gate", match: (run) => run.waitingGates > 0 },
  { key: "failed", label: "failed", match: (run) => ["failed", "killed", "budget_exhausted", "cancelled"].includes(run.displayStatus) },
  { key: "complete", label: "complete", match: (run) => run.displayStatus === "complete" },
];

export function RunsList({ onOpenRun, pollMs = 4000 }: RunsListProps) {
  const [live, setLive] = useState(false);
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const { data: runs, error } = useLoad((client) => client.listRuns(), [], live ? pollMs : 0);

  const shown = useMemo(() => {
    const match = FILTERS.find((entry) => entry.key === filter)?.match ?? (() => true);
    const q = query.trim().toLowerCase();
    return (runs ?? []).filter((run) => match(run) && (!q || run.id.includes(q) || run.flowName.toLowerCase().includes(q)));
  }, [runs, filter, query]);

  return (
    <div className="sui-root sui-screen" data-screen="runs">
      <div className="sui-bar">
        <h1 className="sui-title">Runs</h1>
        <span className="sui-mono sui-muted">{runs ? `${shown.length} of ${runs.length}` : "loading"}</span>
        <div className="sui-seg" role="tablist" aria-label="filter runs">
          {FILTERS.map((entry) => (
            <button
              key={entry.key}
              type="button"
              role="tab"
              aria-selected={filter === entry.key}
              className={filter === entry.key ? "sui-seg-on" : undefined}
              onClick={() => setFilter(entry.key)}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <input
          className="sui-input sui-search"
          placeholder="flow or run id"
          aria-label="search runs"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <div className="sui-push"><LiveToggle live={live} onChange={setLive} /></div>
      </div>
      <ErrorLine error={error} />

      <div className="sui-runs-head sui-runs-grid">
        <span className="sui-micro">run</span>
        <span className="sui-micro">flow</span>
        <span className="sui-micro">status</span>
        <span className="sui-micro">progress</span>
        <span className="sui-micro sui-right">spent</span>
        <span className="sui-micro sui-right">started</span>
      </div>

      {!runs && !error && <Spinner />}
      {runs && shown.length === 0 && (
        <Empty title="no runs">{runs.length ? "Nothing matches this filter." : "Runs appear here once the engine plans a flow."}</Empty>
      )}

      <div className="sui-scroll">
        {shown.map((run) => {
          const pct = run.stepCount ? Math.round((run.completedSteps / run.stepCount) * 100) : 0;
          return (
            <button key={run.id} type="button" className="sui-runs-row sui-runs-grid" onClick={() => onOpenRun(run.id)} data-run-id={run.id}>
              <span className="sui-mono" title={run.id}>{run.id.slice(0, 8)}</span>
              <span className="sui-ellipsis">
                {run.flowName}
                {run.currentStepId && <span className="sui-muted sui-mono"> · {run.currentStepId}</span>}
              </span>
              <span><StatusPill status={run.displayStatus} /></span>
              <span className="sui-progress" title={`${run.completedSteps}/${run.stepCount} steps`}>
                <span className="sui-progress-track"><span className="sui-progress-fill" style={{ width: `${pct}%` }} /></span>
                <span className="sui-mono sui-muted">{run.completedSteps}/{run.stepCount}</span>
              </span>
              <span className="sui-mono sui-right">{money(run.spent.usd)}</span>
              <span className="sui-mono sui-muted sui-right" title={run.startedAt ?? ""}>{relativeTime(run.startedAt)}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
