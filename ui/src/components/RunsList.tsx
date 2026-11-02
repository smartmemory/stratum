import { useMemo, useState, type KeyboardEvent } from "react";
import type { RunSummary } from "../data-client";
import { useHost, useLoad } from "../context";
import { runTone } from "../model/status";
import { money, relativeTime, staleAge } from "../model/timing";
import { CopyText, EntityLink } from "../nav";
import { Empty, ErrorLine, LiveToggle, Spinner, StatusPill } from "./bits";

export interface RunsListProps {
  /** Navigation is the host's: called with the run id when a row is opened, and with the current step too when that step is clicked. */
  onOpenRun: (runId: string, stepId?: string) => void;
  /** Optional links (STRAT-UI-LINKS-1): without a callback (or a NavProvider URL) the item stays plain text. */
  onOpenFeature?: (featureCode: string) => void;
  /** The flow of a run, in the builder. */
  onOpenFlow?: (runId: string) => void;
  /** The Gates inbox, narrowed to a run when given. */
  onOpenGates?: (runId?: string) => void;
  /** The builder, empty (the empty state's "create a flow"). */
  onOpenBuilder?: () => void;
  /** The active filter tab, when the host keeps it (the shell puts it in the URL). Absent: the list keeps its own. */
  filter?: string;
  onFilterChange?: (filter: string) => void;
  /** Auto-refresh interval while "live" is on. */
  pollMs?: number;
  /** Clock for the stale and "last 7 d" rules; tests pin it. */
  now?: number;
}

const RECENT_MS = 7 * 24 * 3600 * 1000;
const STALE_HOVER = "No run event for more than 7 d. Stratum stores no heartbeat; this is the time of the last run event.";

const isLive = (run: RunSummary) => run.displayStatus === "running" || run.displayStatus === "awaiting_gate";

const FILTERS: Array<{ key: string; label: string; match: (run: RunSummary, now: number) => boolean }> = [
  {
    key: "recent",
    label: "active, last 7 d",
    match: (run, now) => !run.stale && (isLive(run) || (run.lastEventAt !== null && now - Date.parse(run.lastEventAt) <= RECENT_MS)),
  },
  { key: "stale", label: "stale", match: (run) => run.stale },
  { key: "all", label: "all", match: () => true },
  { key: "active", label: "active", match: isLive },
  { key: "gates", label: "awaiting gate", match: (run) => run.waitingGates > 0 },
  { key: "failed", label: "failed", match: (run) => ["failed", "killed", "budget_exhausted", "cancelled"].includes(run.displayStatus) },
  { key: "complete", label: "complete", match: (run) => run.displayStatus === "complete" },
];

export function RunsList({ onOpenRun, onOpenFeature, onOpenFlow, onOpenGates, onOpenBuilder, filter: filterProp, onFilterChange, pollMs = 4000, now: nowProp }: RunsListProps) {
  const [live, setLive] = useState(false);
  const [localFilter, setLocalFilter] = useState("recent");
  const filter = filterProp ?? localFilter;
  const setFilter = (key: string) => {
    setLocalFilter(key);
    onFilterChange?.(key);
  };
  const [query, setQuery] = useState("");
  const { data: loaded, error } = useLoad((client) => client.listRuns(), [], live ? pollMs : 0);
  // COMP-SUBAPP-HOST-1: a host's selected feature narrows the list before any other filter; no host, every run.
  const feature = useHost()?.selection?.featureCode || null;
  const runs = useMemo(() => (feature && loaded ? loaded.filter((run) => run.featureCode === feature) : loaded), [loaded, feature]);

  const now = nowProp ?? Date.now();

  const shown = useMemo(() => {
    const match = FILTERS.find((entry) => entry.key === filter)?.match ?? (() => true);
    const q = query.trim().toLowerCase();
    return (runs ?? []).filter(
      (run) => match(run, now) && (!q || run.id.includes(q) || run.flowName.toLowerCase().includes(q) || run.label.toLowerCase().includes(q)),
    );
  }, [runs, filter, query, now]);

  const waitingTotal = useMemo(() => (runs ?? []).reduce((sum, run) => sum + run.waitingGates, 0), [runs]);

  // Arrow keys move between rows' open links (a roving focus without a tabindex per row).
  const onRowKeys = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    const links = [...event.currentTarget.querySelectorAll<HTMLElement>(".sui-runs-open")];
    const at = links.indexOf(document.activeElement as HTMLElement);
    const next = links[at + (event.key === "ArrowDown" ? 1 : -1)];
    if (at >= 0 && next) {
      event.preventDefault();
      next.focus();
    }
  };

  const counts = useMemo(
    () => Object.fromEntries(FILTERS.map((entry) => [entry.key, (runs ?? []).filter((run) => entry.match(run, now)).length])),
    [runs, now],
  );

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
              aria-label={entry.label}
              className={filter === entry.key ? "sui-seg-on" : undefined}
              onClick={() => setFilter(entry.key)}
            >
              {entry.label}{runs && <span className="sui-muted sui-mono"> {counts[entry.key]}</span>}
            </button>
          ))}
        </div>
        <input
          className="sui-input sui-search"
          placeholder="label, flow or run id"
          aria-label="search runs"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {waitingTotal > 0 && (
          <EntityLink target={{ kind: "gates" }} onOpen={onOpenGates ? () => onOpenGates() : undefined}>{waitingTotal} waiting in Gates</EntityLink>
        )}
        <div className="sui-push"><LiveToggle live={live} onChange={setLive} /></div>
      </div>
      <ErrorLine error={error} />

      <div className="sui-runs-head sui-runs-grid">
        <span className="sui-micro">run</span>
        <span className="sui-micro">status</span>
        <span className="sui-micro">progress</span>
        <span className="sui-micro sui-right">spent</span>
        <span className="sui-micro sui-right">started</span>
      </div>

      {!runs && !error && <Spinner />}
      {runs && shown.length === 0 && (
        <Empty title="no runs">{runs.length ? "Nothing matches this filter." : feature ? `No run carries ${feature}.` : "Runs appear here once the engine plans a flow."}
          {!runs.length && !feature && <> <EntityLink target={{ kind: "builder" }} onOpen={onOpenBuilder}>Open the builder</EntityLink> to write one.</>}
        </Empty>
      )}

      <div className="sui-scroll" onKeyDown={onRowKeys}>
        {shown.map((run) => {
          const pct = run.stepCount ? Math.round((run.completedSteps / run.stepCount) * 100) : 0;
          return (
            <div key={run.id} className="sui-runs-row sui-runs-grid" onClick={() => onOpenRun(run.id)} data-run-id={run.id}>
              <span className="sui-runs-name" title={run.label}>
                <span className="sui-runs-first">
                  <EntityLink className="sui-link sui-runs-open sui-ellipsis sui-runs-label" target={{ kind: "run", id: run.id }} onOpen={() => onOpenRun(run.id)}>
                    <span data-label>{run.label}</span>
                  </EntityLink>
                  {run.featureCode && (
                    <EntityLink className="sui-link sui-chip" target={{ kind: "feature", code: run.featureCode }} onOpen={onOpenFeature ? () => onOpenFeature(run.featureCode!) : undefined} title={`feature ${run.featureCode}`}>
                      {run.featureCode}
                    </EntityLink>
                  )}
                </span>
                <span className="sui-ellipsis sui-muted sui-mono sui-runs-sub" title={run.id}>
                  <EntityLink target={{ kind: "flow", runId: run.id }} onOpen={onOpenFlow ? () => onOpenFlow(run.id) : undefined} title="open this flow in the builder">{run.flowName}</EntityLink>
                  {run.currentStepId && (
                    <>
                      {" · "}
                      <EntityLink target={{ kind: "run", id: run.id, stepId: run.currentStepId }} onOpen={() => onOpenRun(run.id, run.currentStepId!)} title={`open the run at ${run.currentStepId}`}>{run.currentStepId}</EntityLink>
                    </>
                  )}
                  {" · "}
                  <CopyText value={run.id}>{run.id.slice(0, 8)}</CopyText>
                </span>
              </span>
              <span>
                {run.stale ? (
                  <span className="sui-stale sui-mono" style={{ color: runTone("running").color }} title={STALE_HOVER} data-stale="true">
                    {run.waitingGates > 0 ? "stale · awaiting gate · " : "stale · "}
                    {run.lastEventAt ? `no event since ${new Date(run.lastEventAt).toLocaleDateString([], { month: "short", day: "numeric" })} (${staleAge(run.lastEventAt, now)})` : "no events recorded"}
                  </span>
                ) : (
                  <StatusPill status={run.displayStatus} />
                )}
                {run.waitingGates > 0 && (
                  <>
                    {" "}
                    <EntityLink target={{ kind: "gates", runId: run.id }} onOpen={onOpenGates ? () => onOpenGates(run.id) : undefined} title="open this run's gates">
                      {run.waitingGates} gate{run.waitingGates === 1 ? "" : "s"}
                    </EntityLink>
                  </>
                )}
              </span>
              <span className="sui-progress" title={`${run.completedSteps}/${run.stepCount} steps`}>
                <span className="sui-progress-track"><span className="sui-progress-fill" style={{ width: `${pct}%` }} /></span>
                <span className="sui-mono sui-muted">{run.completedSteps}/{run.stepCount}</span>
              </span>
              <span className="sui-mono sui-right">{money(run.spent.usd)}</span>
              <span className="sui-mono sui-muted sui-right" title={run.startedAt ?? ""}>{relativeTime(run.startedAt)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
