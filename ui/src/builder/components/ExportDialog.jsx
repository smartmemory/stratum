import React, { useMemo, useState } from 'react';
import { Check, Copy, Download } from '../shims/icons';
import { Button } from '../shims/ui';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '../shims/ui';
import { buildExport } from '../lib/spec';

export default function ExportDialog({ open, onOpenChange, doc }) {
  const [copied, setCopied] = useState(false);
  const json = useMemo(() => JSON.stringify(buildExport(doc), null, 2), [doc, open]);

  const copy = async () => {
    await navigator.clipboard.writeText(json);
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  };

  const download = () => {
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${doc.spec.flows.entry || 'flow'}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="font-mono text-[14px]">Export flow</DialogTitle>
          <DialogDescription className="text-[12px]">
            The whole version 1 document (contracts and every flow), exactly as the engine reads it.
          </DialogDescription>
        </DialogHeader>
        <pre data-testid="export-json" className="max-h-[52vh] overflow-auto rounded-md border border-border bg-background p-3 font-mono text-[11.5px] leading-relaxed">
          {json}
        </pre>
        <div className="flex justify-end gap-2">
          <Button variant="outline" size="sm" className="gap-1.5" onClick={download}>
            <Download className="h-3.5 w-3.5" /> Download
          </Button>
          <Button size="sm" className="gap-1.5" onClick={copy}>
            {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
            {copied ? 'Copied' : 'Copy JSON'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}