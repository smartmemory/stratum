import React from 'react';
import { Download, Upload, ShieldCheck } from '../shims/icons';
import { Button } from '../shims/ui';
import { cn } from '../shims/utils';

/** No run control here by design (COMPOSE-UI-INTEGRATION-1): "Dry plan" only. */
export default function Toolbar({ doc, stepCount, validation, busy, canValidate, canPlan, onValidate, onPlan, onExport, onImport, onNew }) {
  const errorCount = validation && validation.status === 'invalid' ? validation.errors.length : 0;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border bg-card/40 px-3 py-2">
      <div className="flex items-baseline gap-2">
        <span className="micro">flow</span>
        <span className="font-mono text-[13px]" data-testid="flow-name">{doc.flowName}</span>
        {doc.spec.flows.entry === doc.flowName && (
          <span className="font-mono text-[9.5px] uppercase tracking-[0.12em] text-muted-foreground">entry</span>
        )}
      </div>
      <span className="hidden font-mono text-[10px] text-muted-foreground sm:inline">{stepCount} steps</span>
      {validation && (
        <span
          className={cn(
            'flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.12em]',
            validation.status === 'valid' ? 'text-emerald-500' : 'text-destructive',
          )}
        >
          <span className={cn('h-1.5 w-1.5 rounded-full', validation.status === 'valid' ? 'bg-emerald-500' : 'bg-destructive')} />
          {validation.status === 'valid' ? 'valid' : validation.status === 'invalid' ? `${errorCount} error${errorCount > 1 ? 's' : ''}` : 'unvalidated'}
        </span>
      )}
      <div className="ml-auto flex items-center gap-1.5">
        <Button size="sm" variant="ghost" className="h-7 px-2 text-[12px]" onClick={onNew}>
          New
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 gap-1.5 px-2 text-[12px]"
          onClick={onValidate}
          disabled={!canValidate || busy}
          title={canValidate ? 'Run the engine validateSpec' : 'This host supplies no validateSpec'}
        >
          <ShieldCheck className="h-3.5 w-3.5" strokeWidth={1.8} />
          Validate
          {errorCount > 0 && (
            <span className="rounded bg-destructive/15 px-1 font-mono text-[10px] text-destructive">{errorCount}</span>
          )}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2 text-[12px]"
          onClick={onPlan}
          disabled={!canPlan || busy}
          title={canPlan ? 'stratum_plan in a throwaway state dir: nothing runs, nothing is saved' : 'This host supplies no planFlow'}
        >
          Dry plan
        </Button>
        <Button size="sm" variant="outline" className="h-7 gap-1.5 px-2 text-[12px]" onClick={onImport}>
          <Upload className="h-3.5 w-3.5" strokeWidth={1.8} />
          Import
        </Button>
        <Button size="sm" variant="outline" className="h-7 gap-1.5 px-2 text-[12px]" onClick={onExport}>
          <Download className="h-3.5 w-3.5" strokeWidth={1.8} />
          Export
        </Button>
      </div>
    </div>
  );
}
