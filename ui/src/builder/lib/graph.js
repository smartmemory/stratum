import { NODE_H, NODE_W } from './flowSchema';

const ROUTES = [
  { key: 'on_approve', label: 'approve', color: '#10b981', bow: -34 },
  { key: 'on_kill', label: 'kill', color: '#ef4444', bow: 44 },
  { key: 'on_revise', label: 'revise', color: '#a78bfa', bow: 110, dashed: true },
];

export function buildEdges(steps = [], layout = {}) {
  const edges = [];
  steps.forEach((step) => {
    const to = layout[step.id];
    if (!to) return;
    (step.after || []).forEach((afterId) => {
      const from = layout[afterId];
      if (!from) return;
      edges.push({
        id: `after:${afterId}->${step.id}`,
        fromId: afterId,
        toId: step.id,
        from,
        to,
        color: null,
        direction: 'forward',
        bow: 0,
      });
    });
    if (step.kind === 'gate') {
      ROUTES.forEach((route) => {
        const targetId = step[route.key];
        const targetPos = targetId && layout[targetId];
        if (!targetPos) return;
        edges.push({
          id: `route:${step.id}:${route.label}`,
          fromId: step.id,
          toId: targetId,
          from: to,
          to: targetPos,
          color: route.color,
          label: route.label,
          dashed: route.dashed,
          direction: route.key === 'on_revise' ? 'back' : 'forward',
          bow: route.bow,
        });
      });
    }
  });
  return edges;
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