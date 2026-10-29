import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Palette from './components/Palette';
import Toolbar from './components/Toolbar';
import PropertiesPanel from './components/PropertiesPanel';
import ValidationPanel from './components/ValidationPanel';
import ExportDialog from './components/ExportDialog';
import ImportDialog from './components/ImportDialog';
import DagCanvas from './dag/DagCanvas';
import {
  NODE_W,
  autoLayout,
  defaultStep,
  makeStarterFlow,
  nextStepId,
  validateFlow,
} from './lib/flowSchema';

// STRAT-UI-APP-1: ported from Base44 "Stratum Studio" as-is. The Base44 entity load/save
// is replaced by `initialFlow` (sample data) and an `onChange(flow)` callback.
// STRAT-UI-BUILDER-1 wires it to stratum_validate / a DataClient and restyles it.
export default function FlowBuilder({ initialFlow, onChange } = {}) {
  const [flow, setFlow] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [errors, setErrors] = useState(null);
  const [saveState, setSaveState] = useState('saved');
  const [showExport, setShowExport] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [revision, setRevision] = useState(0);
  const flowRef = useRef(null);
  flowRef.current = flow;

  useEffect(() => {
    setFlow(initialFlow || { id: 'sample', ...makeStarterFlow() });
  }, [initialFlow]);

  const patchFlow = useCallback((updater) => {
    setFlow((prev) => (prev ? updater(prev) : prev));
    setRevision((r) => r + 1);
  }, []);

  useEffect(() => {
    if (!revision) return undefined;
    const current = flowRef.current;
    if (!current || !current.id) return undefined;
    setSaveState('saving');
    const timer = setTimeout(async () => {
      onChange?.(current);
      setSaveState('saved');
    }, 700);
    return () => clearTimeout(timer);
  }, [revision]);

  const addStep = (kind) => {
    if (!flow) return;
    const id = nextStepId(kind, flow.steps || []);
    patchFlow((f) => {
      const last = f.steps?.[f.steps.length - 1];
      const lastPos = last ? (f.layout || {})[last.id] : null;
      const pos = lastPos ? { x: lastPos.x + NODE_W + 92, y: lastPos.y } : { x: 56, y: 56 };
      return {
        ...f,
        steps: [...(f.steps || []), defaultStep(kind, id)],
        layout: { ...(f.layout || {}), [id]: pos },
      };
    });
    setSelectedId(id);
  };

  const updateStep = (patch) => {
    if (!selectedId) return;
    patchFlow((f) => ({
      ...f,
      steps: f.steps.map((s) => (s.id === selectedId ? { ...s, ...patch } : s)),
    }));
  };

  const moveStep = useCallback(
    (id, x, y) => {
      patchFlow((f) => ({
        ...f,
        layout: { ...(f.layout || {}), [id]: { x: Math.round(x), y: Math.round(y) } },
      }));
    },
    [patchFlow],
  );

  const connect = useCallback(
    (fromId, toId) => {
      patchFlow((f) => ({
        ...f,
        steps: f.steps.map((s) =>
          s.id === toId && !(s.after || []).includes(fromId)
            ? { ...s, after: [...(s.after || []), fromId] }
            : s,
        ),
      }));
    },
    [patchFlow],
  );

  const deleteStep = useCallback(
    (id) => {
      if (!id) return;
      patchFlow((f) => {
        const steps = f.steps
          .filter((s) => s.id !== id)
          .map((s) => {
            const next = { ...s, after: (s.after || []).filter((a) => a !== id) };
            ['on_approve', 'on_kill', 'on_revise'].forEach((key) => {
              if (next[key] === id) next[key] = '';
            });
            return next;
          });
        const layout = { ...(f.layout || {}) };
        delete layout[id];
        const output = f.output && f.output.from === id ? { ...f.output, from: '' } : f.output;
        return { ...f, steps, layout, output };
      });
      setSelectedId(null);
    },
    [patchFlow],
  );

  const renameStep = (rawId) => {
    const nextId = String(rawId).trim().replace(/\s+/g, '_');
    if (!nextId || !selectedId) return;
    patchFlow((f) => {
      if (f.steps.some((s) => s.id === nextId && s.id !== selectedId)) return f;
      const steps = f.steps.map((s) => {
        const copy = { ...s };
        if (s.id === selectedId) copy.id = nextId;
        copy.after = (s.after || []).map((a) => (a === selectedId ? nextId : a));
        ['on_approve', 'on_kill', 'on_revise'].forEach((key) => {
          if (copy[key] === selectedId) copy[key] = nextId;
        });
        return copy;
      });
      const layout = { ...(f.layout || {}) };
      if (layout[selectedId]) {
        layout[nextId] = layout[selectedId];
        delete layout[selectedId];
      }
      const output = f.output && f.output.from === selectedId ? { ...f.output, from: nextId } : f.output;
      return { ...f, steps, layout, output };
    });
    setSelectedId(nextId);
  };

  useEffect(() => {
    if (!selectedId) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const el = document.activeElement;
      const tag = el && el.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || (el && el.isContentEditable)) return;
      e.preventDefault();
      deleteStep(selectedId);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedId, deleteStep]);

  const layout = useMemo(() => {
    if (!flow) return {};
    const base = autoLayout(flow.steps || []);
    const stored = flow.layout || {};
    const merged = {};
    (flow.steps || []).forEach((s) => {
      merged[s.id] = stored[s.id] || base[s.id];
    });
    return merged;
  }, [flow]);

  if (!flow) {
    return (
      <div className="grid h-[70vh] place-items-center">
        <div className="h-6 w-6 animate-spin rounded-full border-2 border-border border-t-foreground" />
      </div>
    );
  }

  const selected = (flow.steps || []).find((s) => s.id === selectedId) || null;

  return (
    <div className="flex h-[calc(100dvh-49px)] flex-col overflow-y-auto md:h-dvh md:overflow-hidden">
      <Toolbar
        flow={flow}
        saveState={saveState}
        errorCount={errors ? errors.length : 0}
        onValidate={() => setErrors(validateFlow(flow))}
        onExport={() => setShowExport(true)}
        onImport={() => setShowImport(true)}
      />

      {errors && <ValidationPanel errors={errors} onClose={() => setErrors(null)} />}

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <Palette onAdd={addStep} />
        <div className="min-h-[220px] min-w-0 flex-1">
          <DagCanvas
            steps={flow.steps || []}
            layout={layout}
            mode="edit"
            selectedId={selectedId}
            onSelect={setSelectedId}
            onMove={moveStep}
            onConnect={connect}
          />
        </div>
        <PropertiesPanel
          flow={flow}
          step={selected}
          onUpdate={updateStep}
          onUpdateFlow={(patch) => patchFlow((f) => ({ ...f, ...patch }))}
          onDelete={() => deleteStep(selectedId)}
          onRename={renameStep}
        />
      </div>

      <ExportDialog open={showExport} onOpenChange={setShowExport} flow={flow} />
      <ImportDialog
        open={showImport}
        onOpenChange={setShowImport}
        onImport={(parsed) => {
          patchFlow((f) => ({ ...f, ...parsed }));
          setSelectedId(null);
          setErrors(null);
        }}
      />
    </div>
  );
}