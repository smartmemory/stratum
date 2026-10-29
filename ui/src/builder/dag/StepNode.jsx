import React from 'react';
import { cn } from '../shims/utils';
import { NODE_H } from '../lib/layout';
import { KIND_META, stepKind, stepSummary } from '../lib/spec';
import { stepStatus } from '../lib/status';

export default function StepNode({
  step,
  pos,
  selected,
  mode = 'edit',
  status,
  errors,
  onDragStart,
  onSelect,
  onPortStart,
}) {
  const kind = stepKind(step);
  const meta = (kind && KIND_META[kind]) || { tone: '#ef4444' };
  const tone = status ? stepStatus(status) : null;
  const style = { left: pos.x, top: pos.y, height: NODE_H };
  if (mode === 'view' && tone) {
    style.borderColor = `${tone.color}59`;
    style.boxShadow = `inset 2px 0 0 ${tone.color}`;
  }
  const errorCount = errors ? errors.length : 0;

  return (
    <div
      data-step-id={step.id}
      data-kind={kind || 'invalid'}
      data-error={errorCount ? errors.map((e) => e.code).join(' ') : undefined}
      onMouseDown={onDragStart}
      onClick={(e) => {
        e.stopPropagation();
        onSelect?.(step.id);
      }}
      style={style}
      className={cn(
        'group absolute w-[236px] select-none rounded-[10px] border bg-card px-3 py-2.5 transition-[border-color,box-shadow] duration-150',
        mode === 'edit' ? 'cursor-grab active:cursor-grabbing' : 'cursor-pointer',
        errorCount
          ? 'border-destructive ring-2 ring-destructive/50'
          : selected
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
          {kind || 'no kind'}
        </span>
        {errorCount > 0 && (
          <span
            className="truncate rounded bg-destructive/15 px-1 font-mono text-[9px] text-destructive"
            title={errors.map((e) => `${e.code} ${e.path}: ${e.message}`).join('\n')}
          >
            {errors[0].code}
            {errorCount > 1 ? ` +${errorCount - 1}` : ''}
          </span>
        )}
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
        {mode === 'edit' && !errorCount && step.when && (
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
            title="Drag to connect (adds an after edge)"
            className="absolute -right-[6px] top-1/2 h-3 w-3 -translate-y-1/2 cursor-crosshair rounded-full border border-border bg-background transition-colors group-hover:border-signal group-hover:bg-signal"
          />
        </>
      )}
    </div>
  );
}
