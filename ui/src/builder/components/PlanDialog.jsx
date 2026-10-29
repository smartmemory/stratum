import React, { useEffect, useState } from 'react';
import { Button, Textarea } from '../shims/ui';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '../shims/ui';
import { buildExport, sampleInput } from '../lib/spec';

/**
 * Dry plan: the host's `planFlow` runs the engine's `plan` (what `stratum_plan` runs) in a
 * throwaway state directory with agent dispatch refused, and returns the first response.
 * Nothing is dispatched or saved. There is deliberately no "run" button anywhere.
 */
export default function PlanDialog({ open, onOpenChange, doc, planFlow }) {
  const [input, setInput] = useState('{}');
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setInput(JSON.stringify(sampleInput(doc.spec), null, 2));
      setResult(null);
    }
  }, [open]);

  const plan = async () => {
    let parsed;
    try {
      parsed = input.trim() ? JSON.parse(input) : {};
    } catch {
      setResult({ status: 'error', message: 'input is not valid JSON' });
      return;
    }
    setBusy(true);
    try {
      setResult(await planFlow(buildExport(doc), parsed));
    } catch (error) {
      setResult({ status: 'error', message: error instanceof Error ? error.message : String(error) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="font-mono text-[14px]">Dry plan</DialogTitle>
          <DialogDescription className="text-[12px]">
            The engine plans this document in a throwaway state directory: it validates the spec and the entry
            input and returns the first steps it would hand out. No agent is dispatched and no run is saved.
          </DialogDescription>
        </DialogHeader>
        <div className="font-mono text-[9.5px] uppercase tracking-[0.14em] text-muted-foreground">entry input</div>
        <Textarea
          aria-label="plan input"
          value={input}
          spellCheck={false}
          onChange={(e) => setInput(e.target.value)}
          className="min-h-[90px] font-mono text-[11.5px] leading-relaxed"
        />
        {result && (
          <pre
            data-testid="plan-result"
            data-status={result.status}
            className={`mt-3 max-h-[40vh] overflow-auto rounded-md border p-3 font-mono text-[11px] leading-relaxed ${result.status === 'planned' ? 'border-emerald-500/40' : 'border-destructive/50 text-destructive'}`}
          >
            {JSON.stringify(result, null, 2)}
          </pre>
        )}
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Close
          </Button>
          <Button size="sm" onClick={plan} disabled={busy}>
            {busy ? 'Planning…' : 'Plan (dry)'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
