import React, { useEffect, useState } from 'react';
import { Input, Textarea } from '../shims/ui';
import JsonArea from './JsonArea';
import { fieldValue, getAt } from '../lib/spec';

const SELECT = 'flex h-8 w-full rounded-md border border-border bg-transparent px-2 font-mono text-[12px]';

function ListInput({ value, label, onCommit }) {
  const [draft, setDraft] = useState((value || []).join(', '));
  useEffect(() => setDraft((value || []).join(', ')), [value]);
  return (
    <Input
      aria-label={label}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => onCommit(draft.split(',').map((s) => s.trim()).filter(Boolean))}
      className="h-8 font-mono text-[12px]"
    />
  );
}

function Options({ value, label, options, allowBlank, blankLabel = '—', onPick }) {
  const list = value !== undefined && value !== null && value !== '' && !options.includes(String(value))
    ? [String(value), ...options]
    : options;
  return (
    <select
      aria-label={label}
      className={SELECT}
      value={value === undefined || value === null ? '' : String(value)}
      onChange={(e) => onPick(e.target.value)}
    >
      {allowBlank && <option value="">{blankLabel}</option>}
      {list.map((option) => (
        <option key={option} value={option}>
          {option}
        </option>
      ))}
    </select>
  );
}

/**
 * One schema field of a step, addressed by `def.path` inside the raw step (e.g.
 * ['gate', 'on_approve']). `onChange(path, value)` receives the value to store, where
 * `undefined` means "remove the key" (see `fieldValue`).
 */
export default function StepField({ def, step, stepIds, contracts, flows, onChange }) {
  const value = getAt(step, def.path);
  const label = `field ${def.path.join('.')}`;
  const commit = (raw) => onChange(def.path, fieldValue(def, raw));

  switch (def.type) {
    case 'number':
      return (
        <Input
          aria-label={label}
          type="number"
          value={value ?? ''}
          onChange={(e) => commit(e.target.value)}
          className="h-8 font-mono text-[12px]"
        />
      );
    case 'textarea':
      return (
        <Textarea
          aria-label={label}
          value={value ?? ''}
          spellCheck={false}
          onChange={(e) => commit(e.target.value)}
          className="min-h-[72px] resize-y font-mono text-[11.5px] leading-relaxed"
        />
      );
    case 'list':
      return <ListInput key={`${step.id}:${label}`} value={value} label={label} onCommit={commit} />;
    case 'json':
      return (
        <JsonArea
          key={`${step.id}:${label}:${JSON.stringify(value ?? null)}`}
          label={label}
          value={value}
          placeholder={def.hint}
          onCommit={(parsed) => commit(parsed)}
        />
      );
    case 'enum':
      return <Options value={value} label={label} options={def.options} allowBlank={def.empty !== 'string'} blankLabel="(unset)" onPick={commit} />;
    case 'target':
      return (
        <Options
          value={value}
          label={label}
          options={stepIds.filter((id) => id !== step.id)}
          allowBlank
          blankLabel={def.empty === 'null' ? 'null' : '(unset)'}
          onPick={commit}
        />
      );
    case 'contract':
      return <Options value={value} label={label} options={contracts} allowBlank blankLabel="(none)" onPick={commit} />;
    case 'flow':
      return <Options value={value} label={label} options={flows} allowBlank blankLabel="(pick a flow)" onPick={commit} />;
    case 'require':
    case 'text':
    default:
      return (
        <Input
          aria-label={label}
          value={value ?? ''}
          placeholder={def.hint}
          onChange={(e) => commit(e.target.value)}
          className="h-8 font-mono text-[12px]"
        />
      );
  }
}
