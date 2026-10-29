import { deriveEdges, layoutGraph } from '../../model/graph';
import { NODE_H, NODE_W } from './layout';

// STRAT-UI-BUILDER-1: edges come from the run view's `deriveEdges` (one rule set for both
// screens, mirroring the engine): `after`, inferred `${step.output}` data refs (drawn, NOT
// written into `after`), `on_fail`, gate `on_approve` / `on_kill`, and `on_revise` as a
// back-edge that is not part of the DAG (`ir/validate.ts:482-488`).
export const EDGE_STYLE = {
  after: { color: '#5b6067', marker: 'arrow-after' },
  data: { color: '#38bdf8', marker: 'arrow-data', dashed: '2 4', label: 'data' },
  approve: { color: '#10b981', marker: 'arrow-approve', label: 'approve', bow: -34 },
  kill: { color: '#ef4444', marker: 'arrow-kill', label: 'kill', bow: 44 },
  fail: { color: '#ef4444', marker: 'arrow-kill', dashed: '6 4', label: 'on_fail', bow: 60 },
  revise: { color: '#a78bfa', marker: 'arrow-revise', dashed: '5 5', label: 'revise', bow: 110 },
};

export function flowEdges(steps = []) {
  return deriveEdges(steps);
}

/** Auto positions (dagre, revise excluded from ranking) for steps without a stored position. */
export function autoLayout(steps = []) {
  return layoutGraph(steps, deriveEdges(steps), { w: NODE_W, h: NODE_H, ranksep: 92 }).nodes;
}

export function buildEdges(steps = [], layout = {}) {
  return flowEdges(steps).flatMap((edge) => {
    const from = layout[edge.from];
    const to = layout[edge.to];
    if (!from || !to) return [];
    const style = EDGE_STYLE[edge.kind];
    return [{
      id: edge.id,
      kind: edge.kind,
      fromId: edge.from,
      toId: edge.to,
      from,
      to,
      color: edge.kind === 'after' ? null : style.color,
      marker: style.marker,
      label: style.label,
      dashed: style.dashed,
      direction: edge.kind === 'revise' ? 'back' : 'forward',
      bow: style.bow || 0,
    }];
  });
}

export function edgePath(edge) {
  const { from, to, direction, bow = 0 } = edge;
  const y1 = from.y + NODE_H / 2;
  const y2 = to.y + NODE_H / 2;
  if (direction === 'back') {
    const x1 = from.x + 10;
    const x2 = to.x + NODE_W - 10;
    return `M ${x1} ${y1} C ${x1 - 64} ${y1 + bow}, ${x2 + 64} ${y2 + bow}, ${x2} ${y2}`;
  }
  const x1 = from.x + NODE_W;
  const x2 = to.x;
  const dx = Math.max(64, Math.abs(x2 - x1) * 0.5);
  return `M ${x1} ${y1} C ${x1 + dx} ${y1 + bow}, ${x2 - dx} ${y2 + bow}, ${x2} ${y2}`;
}

export function edgeLabelPoint(edge) {
  const { from, to, direction, bow = 0 } = edge;
  const y1 = from.y + NODE_H / 2;
  const y2 = to.y + NODE_H / 2;
  if (direction === 'back') {
    return { x: (from.x + to.x + NODE_W) / 2, y: (y1 + y2) / 2 + bow * 0.62 };
  }
  return { x: (from.x + NODE_W + to.x) / 2, y: (y1 + y2) / 2 + bow * 0.62 };
}

export function canvasSize(layout = {}) {
  const positions = Object.values(layout);
  const maxX = Math.max(0, ...positions.map((p) => p.x));
  const maxY = Math.max(0, ...positions.map((p) => p.y));
  return {
    width: Math.max(960, maxX + NODE_W + 160),
    height: Math.max(560, maxY + NODE_H + 180),
  };
}
