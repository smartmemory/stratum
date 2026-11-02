import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { NODE_H, NODE_W } from '../lib/layout';
import { buildEdges, canvasSize, edgeLabelPoint, edgePath } from '../lib/graph';
import StepNode from './StepNode';

const MARKERS = [
  ['arrow-after', '#5b6067'],
  ['arrow-approve', '#10b981'],
  ['arrow-kill', '#ef4444'],
  ['arrow-revise', '#a78bfa'],
  ['arrow-data', '#38bdf8'],
];

const markerFor = (edge) => edge.marker || 'arrow-after';

export default function DagCanvas({
  steps,
  layout,
  mode = 'edit',
  selectedId,
  onSelect,
  onMove,
  onConnect,
  statusMap,
  stepErrors,
  selectedEdgeId,
  onSelectEdge,
}) {
  const canvasRef = useRef(null);
  const [drag, setDrag] = useState(null);
  const [link, setLink] = useState(null);

  const point = useCallback((e) => {
    const rect = canvasRef.current.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }, []);

  useEffect(() => {
    if (!drag && !link) return undefined;
    const onPointerMove = (e) => {
      if (!canvasRef.current) return;
      const p = point(e);
      if (drag) onMove(drag.id, Math.max(0, p.x - drag.dx), Math.max(0, p.y - drag.dy));
      if (link) setLink((l) => (l ? { ...l, x: p.x, y: p.y } : l));
    };
    const onPointerUp = (e) => {
      if (link) {
        const el = document.elementFromPoint(e.clientX, e.clientY);
        const target = el && el.closest('[data-step-id]');
        const targetId = target && target.getAttribute('data-step-id');
        if (targetId && targetId !== link.fromId) onConnect(link.fromId, targetId);
      }
      setDrag(null);
      setLink(null);
    };
    window.addEventListener('mousemove', onPointerMove);
    window.addEventListener('mouseup', onPointerUp);
    return () => {
      window.removeEventListener('mousemove', onPointerMove);
      window.removeEventListener('mouseup', onPointerUp);
    };
  }, [drag, link, onMove, onConnect, point]);

  const edges = useMemo(() => buildEdges(steps, layout), [steps, layout]);
  const size = useMemo(() => canvasSize(layout), [layout]);

  const startDrag = (step) => (e) => {
    onSelect?.(step.id);
    if (mode !== 'edit' || e.button !== 0) return;
    const p = point(e);
    const pos = layout[step.id];
    if (!pos) return;
    setDrag({ id: step.id, dx: p.x - pos.x, dy: p.y - pos.y });
  };

  const startPort = (step) => (e) => {
    if (mode !== 'edit') return;
    e.preventDefault();
    e.stopPropagation();
    const p = point(e);
    setLink({ fromId: step.id, x: p.x, y: p.y });
  };

  return (
    <div className="h-full w-full overflow-auto">
      <div
        ref={canvasRef}
        onClick={() => onSelect?.(null)}
        className="canvas-grid relative"
        style={{ width: size.width, height: size.height }}
      >
        <svg className="pointer-events-none absolute inset-0" width={size.width} height={size.height}>
          <defs>
            {MARKERS.map(([id, color]) => (
              <marker
                key={id}
                id={id}
                viewBox="0 0 10 10"
                refX="9"
                refY="5"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 10 5 L 0 10 z" fill={color} />
              </marker>
            ))}
          </defs>

          {edges.map((edge) => {
            const color = edge.color || '#5b6067';
            const active =
              !selectedId || selectedId === edge.fromId || selectedId === edge.toId;
            const mid = edgeLabelPoint(edge);
            const chosen = selectedEdgeId === edge.id;
            const what = `${edge.kind === 'fail' ? 'on_fail' : edge.kind} edge ${edge.fromId} to ${edge.toId}`;
            const pickEdge = (e) => {
              e.stopPropagation();
              onSelectEdge?.(edge);
            };
            return (
              <g
                key={edge.id}
                data-edge={edge.id}
                data-selected={chosen || undefined}
                opacity={active || chosen ? 1 : 0.35}
                className="builder-edge"
                tabIndex={onSelectEdge ? 0 : undefined}
                role={onSelectEdge ? 'button' : undefined}
                aria-label={onSelectEdge ? what : undefined}
                aria-pressed={onSelectEdge ? chosen : undefined}
                style={onSelectEdge ? { pointerEvents: 'stroke', cursor: 'pointer' } : undefined}
                onClick={onSelectEdge ? pickEdge : undefined}
                onKeyDown={
                  onSelectEdge
                    ? (e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          pickEdge(e);
                        }
                      }
                    : undefined
                }
              >
                <title>{what}</title>
                {onSelectEdge && (
                  <path d={edgePath(edge)} fill="none" stroke="transparent" strokeWidth={14} style={{ pointerEvents: 'stroke' }} />
                )}
                <path
                  d={edgePath(edge)}
                  fill="none"
                  stroke={chosen ? '#f8fafc' : color}
                  strokeWidth={chosen ? 2.6 : edge.color ? 1.5 : 1.3}
                  strokeOpacity={edge.color ? 0.9 : 0.7}
                  strokeDasharray={edge.dashed || undefined}
                  markerEnd={`url(#${markerFor(edge)})`}
                />
                {edge.label && (
                  <text
                    x={mid.x}
                    y={mid.y}
                    textAnchor="middle"
                    fontSize="9"
                    fill={color}
                    style={{ fontFamily: 'JetBrains Mono, monospace', letterSpacing: '0.08em' }}
                  >
                    {edge.label}
                  </text>
                )}
              </g>
            );
          })}

          {link &&
            layout[link.fromId] &&
            (() => {
              const from = layout[link.fromId];
              const x1 = from.x + NODE_W;
              const y1 = from.y + NODE_H / 2;
              const dx = Math.max(50, Math.abs(link.x - x1) * 0.5);
              return (
                <path
                  d={`M ${x1} ${y1} C ${x1 + dx} ${y1}, ${link.x - dx} ${link.y}, ${link.x} ${link.y}`}
                  fill="none"
                  stroke="#a78bfa"
                  strokeWidth="1.5"
                  strokeDasharray="5 4"
                />
              );
            })()}
        </svg>

        {steps.map((step) =>
          layout[step.id] ? (
            <StepNode
              key={step.id}
              step={step}
              pos={layout[step.id]}
              mode={mode}
              selected={selectedId === step.id}
              status={statusMap ? statusMap[step.id] : undefined}
              errors={stepErrors ? stepErrors[step.id] : undefined}
              onSelect={onSelect}
              onNudge={(id, dx, dy) => {
                const p = layout[id];
                if (p) onMove(id, Math.max(0, p.x + dx), Math.max(0, p.y + dy));
              }}
              onDragStart={startDrag(step)}
              onPortStart={startPort(step)}
            />
          ) : null,
        )}

        {!steps.length && (
          <div className="absolute inset-0 grid place-items-center">
            <div className="rounded-lg border border-dashed border-border px-5 py-4 text-center">
              <div className="font-mono text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
                empty graph
              </div>
              <div className="mt-1 text-[12px] text-muted-foreground">
                Add a step from the palette to start.
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}