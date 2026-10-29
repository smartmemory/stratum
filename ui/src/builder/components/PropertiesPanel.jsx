import React, { useEffect, useState } from 'react';
import { Trash2 } from '../shims/icons';
import { Input } from '../shims/ui';
import { KIND_FIELDS, KIND_META } from '../lib/flowSchema';
import StepField from './StepField';
import FlowSettings from './FlowSettings';
import { cn } from '../shims/utils';

function Label({ children, hint }) {
  return (
    <div className="flex items-baseline justify-between gap-2">
      <span className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-muted-foreground">
        {children}
      </span>
      {hint && <span className="text-[10px] text-muted-foreground/70">{hint}</span>}
    </div>
  );
}

function IdField({ value, onCommit }) {
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  return (
    <Input
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => {
        if (draft && draft !== value) onCommit(draft.trim());
        else setDraft(value);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.currentTarget.blur();
      }}
      className="h-8 font-mono text-[12px]"
    />
  );
}

export default function PropertiesPanel({ flow, step, onUpdate, onUpdateFlow, onDelete, onRename }) {
  const meta = step ? KIND_META[step.kind] || KIND_META.do : null;
  const fields = step ? KIND_FIELDS[step.kind] || [] : [];
  const otherIds = step ? (flow.steps || []).filter((s) => s.id !== step.id).map((s) => s.id) : [];
  const after = (step && step.after) || [];

  const toggleAfter = (id) => {
    onUpdate({
      after: after.includes(id) ? after.filter((a) => a !== id) : [...after, id],
    });
  };

  return (
    <div className="flex max-h-[40vh] w-full shrink-0 flex-col overflow-y-auto border-t border-border bg-card/30 lg:max-h-none lg:w-[322px] lg:border-l lg:border-t-0">
      {!step ? (
        <FlowSettings flow={flow} onUpdateFlow={onUpdateFlow} />
      ) : (
        <>
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <div className="flex items-center gap-2">
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: meta.tone }} />
              <span className="font-mono text-[10px] uppercase tracking-[0.16em]">{step.kind}</span>
            </div>
            <button
              type="button"
              onClick={onDelete}
              className="rounded p-1 text-muted-foreground transition-colors hover:text-destructive"
              aria-label="Delete step"
            >
              <Trash2 className="h-3.5 w-3.5" strokeWidth={1.8} />
            </button>
          </div>

          <div className="space-y-3 p-3">
            <div className="space-y-1">
              <Label>id</Label>
              <IdField value={step.id} onCommit={onRename} />
            </div>

            <div className="space-y-1">
              <Label hint={`${after.length} incoming`}>after</Label>
              <div className="flex flex-wrap gap-1">
                {!otherIds.length && (
                  <span className="text-[11px] text-muted-foreground">no other steps yet</span>
                )}
                {otherIds.map((id) => {
                  const on = after.includes(id);
                  return (
                    <button
                      key={id}
                      type="button"
                      onClick={() => toggleAfter(id)}
                      className={cn(
                        'rounded border px-1.5 py-0.5 font-mono text-[10.5px] transition-colors',
                        on
                          ? 'border-foreground/40 bg-secondary text-foreground'
                          : 'border-border text-muted-foreground hover:text-foreground',
                      )}
                    >
                      {id}
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="space-y-1">
              <Label hint="optional">when</Label>
              <Input
                value={step.when || ''}
                placeholder="plan.risk > 0.5"
                onChange={(e) => onUpdate({ when: e.target.value })}
                className="h-8 font-mono text-[12px]"
              />
            </div>

            <div className="h-px bg-border" />

            {fields.map((def) => (
              <div key={def.key} className="space-y-1">
                <Label hint={def.hint}>{def.label}</Label>
                <StepField
                  def={def}
                  step={step}
                  stepIds={otherIds}
                  onChange={(key, value) => onUpdate({ [key]: value })}
                />
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}