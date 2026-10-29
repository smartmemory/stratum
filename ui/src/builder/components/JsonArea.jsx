import React, { useState } from 'react';
import { Textarea } from '../shims/ui';

export default function JsonArea({ value, onCommit, minHeight = 'min-h-[86px]' }) {
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
        className={`${minHeight} resize-y font-mono text-[11.5px] leading-relaxed`}
      />
      {err && <div className="font-mono text-[10px] text-destructive">{err}</div>}
    </div>
  );
}