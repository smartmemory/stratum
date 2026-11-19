import React, { useState } from 'react';
import { Textarea } from '../shims/ui';

/** JSON editor committed on blur. An empty box commits `undefined` (the caller decides what that means). */
export default function JsonArea({ value, onCommit, label, placeholder, minHeight = 'min-h-[86px]' }) {
  const [draft, setDraft] = useState(() => (value === undefined ? '' : JSON.stringify(value, null, 2)));
  const [err, setErr] = useState('');

  return (
    <div className="space-y-1">
      <Textarea
        aria-label={label}
        aria-invalid={Boolean(err)}
        value={draft}
        placeholder={placeholder}
        spellCheck={false}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => {
          try {
            onCommit(draft.trim() ? JSON.parse(draft) : undefined);
            setErr('');
          } catch (e) {
            setErr(e instanceof SyntaxError ? 'invalid JSON' : e instanceof Error ? e.message : 'Could not apply JSON');
          }
        }}
        className={`${minHeight} resize-y font-mono text-[11.5px] leading-relaxed`}
      />
      {err && <div role="alert" className="font-mono text-[10px] text-destructive">{err}</div>}
    </div>
  );
}
