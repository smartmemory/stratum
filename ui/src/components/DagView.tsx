import { useMemo, useState, type KeyboardEvent } from "react";
import type { StepSpec, StepStateView } from "../data-client";
import { deriveEdges, edgePath, layoutGraph, NODE_H, NODE_W, type EdgeKind } from "../model/graph";
import { kindTone, stepTone } from "../model/status";

const EDGE_STYLE: Record<EdgeKind, { color: string; dash?: string; label?: string }> = {
  after: { color: "var(--stratum-edge, hsl(var(--muted-foreground, 215 20% 65%) / 0.55))" },
  data: { color: "var(--stratum-edge-data, #38bdf8)", dash: "2 4" },
  approve: { color: "var(--stratum-succeeded, #10b981)", dash: "6 4", label: "approve" },
  kill: { color: "var(--stratum-failed, #ef4444)", dash: "6 4", label: "kill" },
  fail: { color: "var(--stratum-failed, #ef4444)", dash: "6 4", label: "on_fail" },
  revise: { color: "var(--stratum-waiting, #a78bfa)", dash: "4 4", label: "revise" },
};

export interface DagViewProps {
  steps: StepSpec[];
  states: Record<string, StepStateView>;
  selectedId: string | null;
  onSelect: (stepId: string) => void;
}

/** Legend entries toggle edge kinds: `kill / on_fail` is one entry for both kinds. */
const LEGEND: Array<{ label: string; kinds: EdgeKind[]; dashed: boolean; color: string }> = [
  { label: "after", kinds: ["after"], dashed: false, color: EDGE_STYLE.after.color },
  { label: "data ref", kinds: ["data"], dashed: true, color: EDGE_STYLE.data.color },
  { label: "approve", kinds: ["approve"], dashed: true, color: EDGE_STYLE.approve.color },
  { label: "kill / on_fail", kinds: ["kill", "fail"], dashed: true, color: EDGE_STYLE.kill.color },
  { label: "revise (back-edge)", kinds: ["revise"], dashed: true, color: EDGE_STYLE.revise.color },
];

export function DagView({ steps, states, selectedId, onSelect }: DagViewProps) {
  const [hidden, setHidden] = useState<Set<EdgeKind>>(new Set());
  const edges = useMemo(() => deriveEdges(steps), [steps]);
  const layout = useMemo(() => layoutGraph(steps, edges), [steps, edges]);

  return (
    <div className="sui-dag" data-testid="dag">
      <div className="sui-dag-canvas" style={{ width: layout.width, height: layout.height }}>
        <svg className="sui-dag-svg" width={layout.width} height={layout.height} role="group" aria-label="edges: select one to jump to the step it points at">
          <defs>
            {(Object.keys(EDGE_STYLE) as EdgeKind[]).map((kind) => (
              <marker key={kind} id={`sui-arrow-${kind}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill={EDGE_STYLE[kind].color} />
              </marker>
            ))}
          </defs>
          {layout.edges.filter((edge) => !hidden.has(edge.kind)).map((edge) => {
            const style = EDGE_STYLE[edge.kind];
            const mid = edge.points[Math.floor(edge.points.length / 2)]!;
            const label = `${edge.kind === "fail" ? "on_fail" : edge.kind} edge ${edge.from} to ${edge.to}`;
            const activate = () => onSelect(edge.to);
            return (
              <g
                key={edge.id}
                data-edge={edge.id}
                className="sui-edge"
                role="button"
                tabIndex={0}
                aria-label={label}
                onClick={activate}
                onKeyDown={(event: KeyboardEvent) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    activate();
                  }
                }}
              >
                <title>{`${label}: click to select ${edge.to}`}</title>
                <path d={edgePath(edge.points)} fill="none" stroke="transparent" strokeWidth={12} className="sui-edge-hit" />
                <path className="sui-edge-line" d={edgePath(edge.points)} fill="none" stroke={style.color} strokeWidth={1.4} strokeDasharray={style.dash} markerEnd={`url(#sui-arrow-${edge.kind})`} />
                {style.label && (
                  <text x={mid.x} y={mid.y - 4} className="sui-edge-label" fill={style.color} textAnchor="middle">{style.label}</text>
                )}
              </g>
            );
          })}
        </svg>
        {steps.map((step) => {
          const pos = layout.nodes[step.id]!;
          const status = states[step.id]?.status ?? "pending";
          const tone = stepTone(status);
          const kind = kindTone(step.kind);
          const state = states[step.id];
          const attempts = state?.attempts.length ?? 0;
          const items = state?.fanout?.items;
          const itemsDone = items?.filter((item) => item.status === "succeeded" || item.status === "skipped").length ?? 0;
          return (
            <button
              key={step.id}
              type="button"
              className={step.id === selectedId ? "sui-node sui-node-on" : "sui-node"}
              style={{ left: pos.x, top: pos.y, width: NODE_W, height: NODE_H, boxShadow: `inset 3px 0 0 ${tone.color}` }}
              onClick={() => onSelect(step.id)}
              data-step-id={step.id}
              data-status={status}
              title={`${step.id}: ${tone.label}${attempts ? `, ${attempts} attempt${attempts === 1 ? "" : "s"}` : ""}`}
            >
              <span className="sui-node-top">
                <span className="sui-node-kind" style={{ color: kind.color }}>{step.kind}</span>
                <span className="sui-node-status" style={{ color: tone.color }}>
                  <span className={tone.live ? "sui-dot sui-pulse" : "sui-dot"} />
                  {tone.label}
                </span>
              </span>
              <span className="sui-node-id">{step.id}</span>
              <span className="sui-node-meta">
                {items ? `${itemsDone}/${items.length} items` : attempts ? `${attempts} attempt${attempts === 1 ? "" : "s"}` : step.when ? "conditional" : " "}
              </span>
            </button>
          );
        })}
      </div>
      <div className="sui-legend" role="group" aria-label="edge legend">
        {LEGEND.map((entry) => {
          const off = entry.kinds.every((kind) => hidden.has(kind));
          return (
            <button
              key={entry.label}
              type="button"
              className="sui-legend-item"
              aria-pressed={!off}
              title={off ? `show ${entry.label} edges` : `hide ${entry.label} edges`}
              onClick={() => setHidden((prev) => {
                const next = new Set(prev);
                for (const kind of entry.kinds) (off ? next.delete(kind) : next.add(kind));
                return next;
              })}
            >
              <i className={entry.dashed ? "sui-dashed" : undefined} style={{ borderColor: entry.color }} />{entry.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
