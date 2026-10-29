import React from 'react';
import { cn } from '../shims/utils';
import { KIND_META, NODE_H, stepSummary } from '../lib/flowSchema';
import { stepStatus } from '../lib/status';

export default function StepNode({
  step,
  pos,
  selected,
  mode = 'edit',
  status,
  onDragStart,
  onSelect,
  onPortStart,
}) {
  const meta = KIND_META[step.kind] || KIND_META.do;
  const tone = status ? stepStatus(status) : null;
  const style = { left: pos.x, top: pos.y, height: NODE_H };
  if (mode === 'view' && tone) {
    style.borderColor = `${tone.color}59`;
    style.boxShadow = `inset 2px 0 0 ${tone.color}`;
  }

  return (
    <div
      data-step-id={step.id}
      onMouseDown={onDragStart}
      onClick={(e) => {
        e.stopPropagation();
        onSelect?.(step.id);
      }}
      style={style}
      className={cn(
        'group absolute w-[236px] select-none rounded-[10px] border bg-card px-3 py-2.5 transition-[border-color,box-shadow] duration-150',
        mode === 'edit' ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer',
        selected
          ? 'border-foreground/45 ring-1 ring-foreground/20'
          : mode === 'edit'
            ? 'border-border hover:border-foreground/30'
            : 'border-border',
      )}
    >
      {mode === 'edit' && (
        <span
          className="absolute inset-y-0 left-0 w-[2px] rounded-l-[10px]"
          style={{ background: meta.tone, opacity: 0.8 }}
        />
      )}
      <div className="flex items-center justify-between gap-2">
        <span
          className="font-mono text-[9.5px] uppercase tracking-[0.18em]"
          style={{ color: meta.tone }}
        >
          {step.kind}
        </span>
        {mode === 'view' && tone && (
          <span
            className="flex items-center gap-1 font-mono text-[9px] lowercase"
            style={{ color: tone.color }}
          >
            <span
              className={cn('h-1.5 w-1.5 rounded-full', tone.pulse && 'animate-pulse')}
              style={{ background: tone.color }}
            />
            {status}
          </span>
        )}
        {mode === 'edit' && step.when && (
          <span className="font-mono text-[9px] uppercase tracking-[0.12em] text-muted-foreground">
            when
          </span>
        )}
      </div>

      <div className="mt-1 truncate font-mono text-[12.5px] font-medium">{step.id}</div>
      <div className="mt-0.5 truncate text-[11px] leading-snug text-muted-foreground">
        {stepSummary(step)}
      </div>

      <div className="mt-1.5 flex items-center justify-between gap-2 font-mono text-[9.5px] text-muted-foreground/80">
        <span className="truncate">
          {step.after?.length ? `after ${step.after.join(', ')}` : 'root'}
        </span>
        {mode === 'edit' && (
          <span className="shrink-0 opacity-0 transition-opacity group-hover:opacity-100">drag ⇢</span>
        )}
      </div>

      {mode === 'edit' && (
        <>
          <span className="pointer-events-none absolute -left-[5px] top-1/2 h-2.5 w-2.5 -translate-y-1/2 rounded-full border border-border bg-background" />
          <span
            onMouseDown={onPortStart}
            title="Drag to connect"
            className="absolute -right-[6px] top-1/2 h-3 w-3 -translate-y-1/2 cursor-crosshair rounded-full border border-border bg-background transition-colors group-hover:border-signal group-hover:bg-signal"
          />
        </>
      )}
    </div>
  );
}