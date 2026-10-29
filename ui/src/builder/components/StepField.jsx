import React, { useState } from 'react';
import { Input } from '../shims/ui';
import { Textarea } from '../shims/ui';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '../shims/ui';

function ListInput({ value, placeholder, onCommit }) {
  const [draft, setDraft] = useState((value || []).join(', '));
  return (
    <Input
      value={draft}
      placeholder={placeholder}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => onCommit(draft.split(',').map((s) => s.trim()).filter(Boolean))}
      className="h-8 font-mono text-[12px]"
    />
  );
}

function JsonInput({ value, onCommit }) {
  const [draft, setDraft] = useState(() => JSON.stringify(value ?? {}, null, 2));
  const [err, setErr] = useState('');
  return (
    <div className="space-y-1">
      <Textarea
        value={draft}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          try {
            onCommit(draft.trim() ? JSON.parse(draft) : {});
            setErr('');
          } catch (e) {
            setErr('invalid JSON');
          }
        }}
        className="min-h-[86px] resize-y font-mono text-[11.5px] leading-relaxed"
      />
      {err && <div className="font-mono text-[10px] text-destructive">{err}</div>}
    </div>
  );
}

export default function StepField({ def, step, stepIds, onChange }) {
  const value = step[def.key];
  const mountKey = `${step.id}:${def.key}`;

  if (def.type === 'number') {
    return (
      <Input
        type="number"
        min={def.min}
        max={def.max}
        step={def.step || 1}
        value={value ?? ''}
        onChange={(e) => onChange(def.key, e.target.value === '' ? '' : Number(e.target.value))}
        className="h-8 font-mono text-[12px]"
      />
    );
  }

  if (def.type === 'list') {
    return (
      <ListInput
        key={mountKey}
        value={value}
        placeholder={def.placeholder}
        onCommit={(v) => onChange(def.key, v)}
      />
    );
  }

  if (def.type === 'json') {
    return <JsonInput key={mountKey} value={value} onCommit={(v) => onChange(def.key, v)} />;
  }

  if (def.type === 'enum') {
    return (
      <Select value={value || def.options[0]} onValueChange={(v) => onChange(def.key, v)}>
        <SelectTrigger className="h-8 font-mono text-[12px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {def.options.map((option) => (
            <SelectItem key={option} value={option} className="font-mono text-[12px]">
              {option}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  if (def.type === 'target') {
    return (
      <Select
        value={value || 'none'}
        onValueChange={(v) => onChange(def.key, v === 'none' ? '' : v)}
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
    );
  }

  return (
    <Input
      value={value ?? ''}
      placeholder={def.placeholder}
      onChange={(e) => onChange(def.key, e.target.value)}
      className="h-8 font-mono text-[12px]"
    />
  );
}