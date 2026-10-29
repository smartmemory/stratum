import React from 'react';
import { KIND_META } from '../lib/flowSchema';

export default function Palette({ onAdd }) {
  return (
    <div className="flex shrink-0 gap-1 overflow-x-auto border-b border-border bg-card/30 p-2 lg:w-[190px] lg:flex-col lg:overflow-y-auto lg:border-b-0 lg:border-r">
      <div className="micro hidden px-1.5 pb-1.5 lg:block">steps</div>
      {Object.entries(KIND_META).map(([kind, meta]) => (
        <button
          key={kind}
          type="button"
          onClick={() => onAdd(kind)}
          className="group flex shrink-0 items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-secondary/70 lg:w-full"
        >
          <span
            className="h-1.5 w-1.5 shrink-0 rounded-full"
            style={{ background: meta.tone }}
          />
          <span className="font-mono text-[12px]">{kind}</span>
          <span className="hidden text-[10px] text-muted-foreground lg:ml-auto lg:block lg:opacity-0 lg:transition-opacity lg:group-hover:opacity-100">
            add
          </span>
        </button>
      ))}
      <div className="mt-auto hidden border-t border-border px-1.5 pt-3 text-[10.5px] leading-relaxed text-muted-foreground lg:block">
        drag the right port onto another step to connect. press delete to remove the selected step.
      </div>
    </div>
  );
}