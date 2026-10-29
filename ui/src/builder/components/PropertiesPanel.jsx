import React, { useEffect, useState } from 'react';
import { Trash2 } from '../shims/icons';
import { Input } from '../shims/ui';
import { KIND_FIELDS, KIND_META, stepKind } from '../lib/spec';
import StepField from './StepField';
import FlowSettings from './FlowSettings';
import JsonArea from './JsonArea';
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
      aria-label="field id"
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

/**
 * Step editor over the RAW engine step. Each kind shows only the fields the engine allows
 * for it (`KIND_FIELDS`); "step JSON" edits the whole object for anything else, so no
 * field of an imported spec is unreachable or dropped.
 */
export default function PropertiesPanel({
  doc,
  flow,
  step,
  errors,
  onSetField,
  onSetAfter,
  onReplaceStep,
  onUpdateFlow,
  onUpdateSpec,
  onSwitchFlow,
  onDelete,
  onRename,
}) {
  const kind = step ? stepKind(step) : null;
  const meta = kind ? KIND_META[kind] : { tone: '#ef4444' };
  const fields = kind ? KIND_FIELDS[kind] : [];
  const stepIds = (flow.steps || []).map((s) => s.id);
  const otherIds = step ? stepIds.filter((id) => id !== step.id) : [];
  const after = (step && step.after) || [];
  const contracts = Object.keys(doc.spec.contracts || {});
  const flows = Object.keys(doc.spec.flows).filter((name) => name !== 'entry' && name !== doc.flowName);

  const toggleAfter = (id) => onSetAfter(after.includes(id) ? after.filter((a) => a !== id) : [...after, id]);

  return (
    <div className="flex max-h-[40vh] w-full shrink-0 flex-col overflow-y-auto border-t border-border bg-card/30 lg:max-h-none lg:w-[340px] lg:border-l lg:border-t-0">
      {!step ? (
        <FlowSettings doc={doc} flow={flow} onUpdateFlow={onUpdateFlow} onUpdateSpec={onUpdateSpec} onSwitchFlow={onSwitchFlow} />
      ) : (
        <>
          <div className="flex items-center justify-between border-b border-border px-3 py-2">
            <div className="flex items-center gap-2">
              <span className="h-1.5 w-1.5 rounded-full" style={{ background: meta.tone }} />
              <span className="font-mono text-[10px] uppercase tracking-[0.16em]">{kind || 'no single kind'}</span>
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
            {errors && errors.length > 0 && (
              <div className="space-y-1 rounded-md border border-destructive/40 bg-destructive/10 p-2" data-testid="step-errors">
                {errors.map((error, index) => (
                  <div key={index} className="font-mono text-[10.5px] leading-snug text-destructive">
                    <span className="font-semibold">{error.code}</span> {error.path}: {error.message}
                  </div>
                ))}
              </div>
            )}

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
                      aria-label={`after ${id}`}
                      aria-pressed={on}
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
                aria-label="field when"
                value={step.when || ''}
                placeholder="${plan.output.risk} > 0.5"
                onChange={(e) => onSetField(['when'], e.target.value || undefined)}
                className="h-8 font-mono text-[12px]"
              />
            </div>

            <div className="h-px bg-border" />

            {fields.map((def) => (
              <div key={def.path.join('.')} className="space-y-1">
                <Label hint={def.hint}>{def.label}</Label>
                <StepField
                  def={def}
                  step={step}
                  stepIds={stepIds}
                  contracts={contracts}
                  flows={flows}
                  onChange={onSetField}
                />
              </div>
            ))}

            <details className="rounded-md border border-border">
              <summary className="cursor-pointer px-2 py-1 font-mono text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                step JSON
              </summary>
              <div className="p-2">
                <JsonArea
                  key={JSON.stringify(step)}
                  label="step json"
                  value={step}
                  minHeight="min-h-[160px]"
                  onCommit={(next) => {
                    if (next && typeof next === 'object' && !Array.isArray(next)) onReplaceStep({ ...next, id: step.id });
                  }}
                />
              </div>
            </details>
          </div>
        </>
      )}
    </div>
  );
}
