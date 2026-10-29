import React from 'react';
import { Input } from '../shims/ui';
import JsonArea from './JsonArea';

const SELECT = 'flex h-8 w-full rounded-md border border-border bg-transparent px-2 font-mono text-[12px]';

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

/** Flow-level fields (`ir/schema.ts` FlowSchema) plus the document's contracts and flow list. */
export default function FlowSettings({ doc, flow, onUpdateFlow, onUpdateSpec, onSwitchFlow }) {
  const output = flow.output || {};
  const contracts = Object.keys(doc.spec.contracts || {});
  const flows = Object.keys(doc.spec.flows).filter((name) => name !== 'entry');
  const isEntry = doc.spec.flows.entry === doc.flowName;
  const contractList = output.contract && !contracts.includes(output.contract) ? [output.contract, ...contracts] : contracts;
  const keyOf = (part) => `${doc.flowName}:${part}:${JSON.stringify(part === 'contracts' ? doc.spec.contracts : flow[part] ?? null)}`;

  return (
    <div className="space-y-3 p-3" data-testid="flow-settings">
      <div className="font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
        flow settings
      </div>
      <Field label="flow" hint={isEntry ? 'entry flow' : 'called by run:'}>
        <select aria-label="flow picker" className={SELECT} value={doc.flowName} onChange={(e) => onSwitchFlow(e.target.value)}>
          {flows.map((name) => (
            <option key={name} value={name}>
              {name}
              {doc.spec.flows.entry === name ? ' (entry)' : ''}
            </option>
          ))}
        </select>
      </Field>

      <Field label="output.from" hint="${step.output}">
        <Input
          aria-label="field output.from"
          value={output.from || ''}
          placeholder="${last_step.output}"
          onChange={(e) => onUpdateFlow({ output: { ...output, from: e.target.value } })}
          className="h-8 font-mono text-[12px]"
        />
      </Field>

      <Field label="output.contract">
        <select
          aria-label="field output.contract"
          className={SELECT}
          value={output.contract || ''}
          onChange={(e) => onUpdateFlow({ output: { ...output, contract: e.target.value } })}
        >
          <option value="">(none)</option>
          {contractList.map((name) => (
            <option key={name} value={name}>
              {name}
            </option>
          ))}
        </select>
      </Field>

      <Field label="max_rounds" hint="revise budget">
        <Input
          aria-label="field max_rounds"
          type="number"
          value={flow.max_rounds ?? ''}
          onChange={(e) => onUpdateFlow({ max_rounds: e.target.value === '' ? undefined : Number(e.target.value) })}
          className="h-8 font-mono text-[12px]"
        />
      </Field>

      <Field label="input" hint="field → type">
        <JsonArea key={keyOf('input')} label="field input" value={flow.input} onCommit={(v) => onUpdateFlow({ input: v ?? {} })} />
      </Field>

      <Field label="contracts" hint="whole document">
        <JsonArea
          key={keyOf('contracts')}
          label="field contracts"
          value={doc.spec.contracts}
          minHeight="min-h-[120px]"
          onCommit={(v) => onUpdateSpec({ contracts: v ?? {} })}
        />
      </Field>

      <div className="rounded-md border border-dashed border-border p-2.5 text-[11px] leading-relaxed text-muted-foreground">
        Select a step to edit it. Solid arrows are <span className="font-mono text-foreground/80">after</span>;
        dotted blue arrows are inferred from <span className="font-mono text-foreground/80">{'${step.output}'}</span>{' '}
        references (drawn, not written into <span className="font-mono text-foreground/80">after</span>); coloured
        arrows are routing (approve, kill, on_fail); the purple dashed back-arrow is{' '}
        <span className="font-mono text-foreground/80">on_revise</span>.
      </div>
    </div>
  );
}
