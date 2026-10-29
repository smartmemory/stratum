import React from 'react';
import { Check, X, AlertTriangle } from '../shims/icons';

export default function ValidationPanel({ errors, onClose }) {
  const valid = errors.length === 0;
  return (
    <div className="max-h-[38%] shrink-0 overflow-y-auto border-b border-border bg-card/60">
      <div className="flex items-center gap-2 px-3 py-1.5">
        {valid ? (
          <Check className="h-3.5 w-3.5 text-emerald-500" strokeWidth={2} />
        ) : (
          <AlertTriangle className="h-3.5 w-3.5 text-destructive" strokeWidth={2} />
        )}
        <span className="font-mono text-[11px] uppercase tracking-[0.12em]">
          {valid ? 'flow is valid' : `${errors.length} error${errors.length > 1 ? 's' : ''}`}
        </span>
        <button
          type="button"
          onClick={onClose}
          className="ml-auto rounded p-1 text-muted-foreground transition-colors hover:text-foreground"
          aria-label="Close validation"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {!valid && (
        <table className="w-full border-t border-border text-left">
          <thead>
            <tr className="text-muted-foreground">
              <th className="micro px-3 py-1 font-normal">code</th>
              <th className="micro px-3 py-1 font-normal">path</th>
              <th className="micro px-3 py-1 font-normal">message</th>
            </tr>
          </thead>
          <tbody>
            {errors.map((err, i) => (
              <tr key={`${err.code}-${i}`} className="border-t border-border/60">
                <td className="whitespace-nowrap px-3 py-1.5 font-mono text-[11px] text-destructive">
                  {err.code}
                </td>
                <td className="whitespace-nowrap px-3 py-1.5 font-mono text-[11px] text-muted-foreground">
                  {err.path}
                </td>
                <td className="px-3 py-1.5 text-[12px]">{err.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}