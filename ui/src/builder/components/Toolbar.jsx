import React from 'react';
import { Download, Upload, ShieldCheck } from '../shims/icons';
import { Button } from '../shims/ui';
import { cn } from '../shims/utils';

export default function Toolbar({ flow, saveState, errorCount, onValidate, onExport, onImport }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-card/40 px-3 py-2">
      <div className="flex items-baseline gap-2">
        <span className="micro">flow</span>
        <span className="font-mono text-[13px]">{flow.name}</span>
      </div>

      <span className="flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.12em] text-muted-foreground">
        <span
          className={cn(
            'h-1.5 w-1.5 rounded-full',
            saveState === 'saving' ? 'animate-pulse bg-amber-400' : 'bg-emerald-500',
          )}
        />
        {saveState === 'saving' ? 'saving' : 'saved'}
      </span>

      <span className="hidden font-mono text-[10px] text-muted-foreground sm:inline">
        {flow.steps?.length || 0} steps
      </span>

      <div className="ml-auto flex items-center gap-1.5">
        <Button size="sm" variant="ghost" className="h-7 gap-1.5 px-2 text-[12px]" onClick={onValidate}>
          <ShieldCheck className="h-3.5 w-3.5" strokeWidth={1.8} />
          Validate
          {errorCount > 0 && (
            <span className="rounded bg-destructive/15 px-1 font-mono text-[10px] text-destructive">
              {errorCount}
            </span>
          )}
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1.5 px-2 text-[12px]"
          onClick={onImport}
        >
          <Upload className="h-3.5 w-3.5" strokeWidth={1.8} />
          Import
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1.5 px-2 text-[12px]"
          onClick={onExport}
        >
          <Download className="h-3.5 w-3.5" strokeWidth={1.8} />
          Export
        </Button>
      </div>
    </div>
  );
}