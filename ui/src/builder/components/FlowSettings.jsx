import React from 'react';
import { Input } from '../shims/ui';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../shims/ui';
import JsonArea from './JsonArea';

function Field({ label, hint, children }) {
  return (
    <div className="space-y-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-muted-foreground">
          {label}
        </span>
        {hint && <span className="text-[10px] text-muted-foreground/70">{hint}</span>}
      </div>
      {children}
    </div>
  );
}

export default function FlowSettings({ flow, onUpdateFlow }) {
  const stepIds = (flow.steps || []).map((s) => s.id);
  const output = flow.output || {};

  return (
    <div className="space-y-3 p-3">
      <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
        flow settings
      </div>

      <Field label="name">
        <Input
          value={flow.name || ''}
          onChange={(e) => onUpdateFlow({ name: e.target.value })}
          className="h-8 font-mono text-[12px]"
        />
      </Field>

      <Field label="output.from">
        <Select
          value={output.from || 'none'}
          onValueChange={(v) =>
            onUpdateFlow({ output: { ...output, from: v === 'none' ? '' : v } })
          }
        >
          <SelectTrigger className="h-8 font-mono text-[12px]">
            <SelectValue placeholder="—" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="none" className="font-mono text-[12px]">
              —
            </SelectItem>
            {stepIds.map((id) => (
              <SelectItem key={id} value={id} className="font-mono text-[12px]">
                {id}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </Field>

      <Field label="output.contract">
        <Input
          value={output.contract || ''}
          placeholder="plan"
          onChange={(e) => onUpdateFlow({ output: { ...output, contract: e.target.value } })}
          className="h-8 font-mono text-[12px]"
        />
      </Field>

      <Field label="input" hint="json">
        <JsonArea key="input" value={flow.input} onCommit={(v) => onUpdateFlow({ input: v })} />
      </Field>

      <Field label="contracts" hint="json">
        <JsonArea
          key="contracts"
          value={flow.contracts}
          onCommit={(v) => onUpdateFlow({ contracts: v })}
        />
      </Field>

      <div className="rounded-md border border-dashed border-border p-2.5 text-[11px] leading-relaxed text-muted-foreground">
        Select a step to edit it. Edges come from each step&apos;s{' '}
        <span className="font-mono text-foreground/80">after</span> list — drag a step&apos;s right
        port onto another step to add one.
      </div>
    </div>
  );
}