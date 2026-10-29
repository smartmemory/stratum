import React, { useEffect, useState } from 'react';
import { Button } from '../shims/ui';
import { Textarea } from '../shims/ui';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '../shims/ui';
import { parseImport } from '../lib/spec';

export default function ImportDialog({ open, onOpenChange, onImport }) {
  const [text, setText] = useState('');
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) {
      setText('');
      setError('');
    }
  }, [open]);

  const submit = () => {
    try {
      const parsed = parseImport(JSON.parse(text));
      onImport(parsed);
      onOpenChange(false);
    } catch (e) {
      setError(e.message || 'Could not parse that document');
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="font-mono text-[14px]">Import flow</DialogTitle>
          <DialogDescription className="text-[12px]">
            Paste a version 1 document, or a run file from ~/.stratum/ts/flows (its spec is used). The current document is replaced.
          </DialogDescription>
        </DialogHeader>
        <Textarea
          aria-label="import json"
          value={text}
          spellCheck={false}
          placeholder={'{\n  "version": 1,\n  "contracts": {},\n  "flows": { "entry": "…", "…": { "steps": [] } }\n}'}
          onChange={(e) => {
            setText(e.target.value);
            setError('');
          }}
          className="min-h-[240px] font-mono text-[11.5px] leading-relaxed"
        />
        {error && <div className="font-mono text-[11px] text-destructive">{error}</div>}
        <DialogFooter>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button size="sm" onClick={submit} disabled={!text.trim()}>
            Import
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}