import { useMemo } from "react";
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

export function DagView({ steps, states, selectedId, onSelect }: DagViewProps) {
  const edges = useMemo(() => deriveEdges(steps), [steps]);
  const layout = useMemo(() => layoutGraph(steps, edges), [steps, edges]);

  return (
    <div className="sui-dag" data-testid="dag">
      <div className="sui-dag-canvas" style={{ width: layout.width, height: layout.height }}>
        <svg className="sui-dag-svg" width={layout.width} height={layout.height} aria-hidden="true">
          <defs>
            {(Object.keys(EDGE_STYLE) as EdgeKind[]).map((kind) => (
              <marker key={kind} id={`sui-arrow-${kind}`} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
                <path d="M 0 0 L 10 5 L 0 10 z" fill={EDGE_STYLE[kind].color} />
              </marker>
            ))}
          </defs>
          {layout.edges.map((edge) => {
            const style = EDGE_STYLE[edge.kind];
            const mid = edge.points[Math.floor(edge.points.length / 2)]!;
            return (
              <g key={edge.id} data-edge={edge.id}>
                <path d={edgePath(edge.points)} fill="none" stroke={style.color} strokeWidth={1.4} strokeDasharray={style.dash} markerEnd={`url(#sui-arrow-${edge.kind})`} />
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
      <div className="sui-legend" aria-label="edge legend">
        <span><i style={{ borderColor: EDGE_STYLE.after.color }} />after</span>
        <span><i className="sui-dashed" style={{ borderColor: EDGE_STYLE.data.color }} />data ref</span>
        <span><i className="sui-dashed" style={{ borderColor: EDGE_STYLE.approve.color }} />approve</span>
        <span><i className="sui-dashed" style={{ borderColor: EDGE_STYLE.kill.color }} />kill / on_fail</span>
        <span><i className="sui-dashed" style={{ borderColor: EDGE_STYLE.revise.color }} />revise (back-edge)</span>
      </div>
    </div>
  );
}
