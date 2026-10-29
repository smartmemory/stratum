import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Palette from './components/Palette';
import Toolbar from './components/Toolbar';
import PropertiesPanel from './components/PropertiesPanel';
import ValidationPanel from './components/ValidationPanel';
import ExportDialog from './components/ExportDialog';
import ImportDialog from './components/ImportDialog';
import PlanDialog from './components/PlanDialog';
import DagCanvas from './dag/DagCanvas';
import { NODE_W } from './lib/layout';
import { autoLayout } from './lib/graph';
import {
  addStep as addStepTo,
  buildExport,
  connectAfter,
  deleteStep as deleteStepFrom,
  emptySpec,
  errorTarget,
  getFlow,
  parseImport,
  pinErrors,
  renameStep as renameStepIn,
  setAfter,
  setAt,
  updateFlow,
  updateSpec,
  updateStep,
} from './lib/spec';
import { useOptionalDataClient } from '../context';

const VALIDATE_DEBOUNCE_MS = 400;

function initialDoc(initialSpec) {
  if (!initialSpec) return { spec: emptySpec(), flowName: 'main' };
  return parseImport(initialSpec);
}

/**
 * Visual editor for a Stratum specification (STRAT-UI-BUILDER-1). Ported from the Base44
 * "Stratum Studio" canvas; the state is the real engine document (`lib/spec.ts`).
 *
 * Props: `initialSpec` (a v1 document or a run file), `onChange(spec)` (the exported
 * document after each edit). Validation and the dry plan go through the host's DataClient
 * (`validateSpec`, `planFlow`); without them those buttons are disabled, never faked.
 */
export default function FlowBuilder({ initialSpec, onChange } = {}) {
  const client = useOptionalDataClient();
  const canValidate = Boolean(client && client.validateSpec);
  const canPlan = Boolean(client && client.planFlow);

  const [doc, setDoc] = useState(() => initialDoc(initialSpec));
  const [layouts, setLayouts] = useState({});
  const [selectedId, setSelectedId] = useState(null);
  const [validation, setValidation] = useState(null); // { result, spec } of the last validateSpec call
  const [autoValidate, setAutoValidate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showPlan, setShowPlan] = useState(false);
  const [revision, setRevision] = useState(0);
  const seq = useRef(0);

  useEffect(() => {
    if (initialSpec) {
      setDoc(parseImport(initialSpec));
      setLayouts({});
      setSelectedId(null);
      setValidation(null);
    }
  }, [initialSpec]);

  const flow = getFlow(doc);
  const steps = flow.steps || [];

  const change = useCallback((updater) => {
    setDoc((prev) => updater(prev));
    setRevision((r) => r + 1);
  }, []);

  const validate = useCallback(async (current) => {
    if (!client || !client.validateSpec) return;
    const mine = ++seq.current;
    const spec = buildExport(current);
    setBusy(true);
    try {
      const result = await client.validateSpec(spec);
      if (mine === seq.current) setValidation({ result, spec });
    } catch (error) {
      if (mine === seq.current) {
        setValidation({ result: { status: 'unavailable', message: error instanceof Error ? error.message : String(error) }, spec });
      }
    } finally {
      if (mine === seq.current) setBusy(false);
    }
  }, [client]);

  useEffect(() => {
    if (!revision) return undefined;
    const timer = setTimeout(() => {
      onChange?.(buildExport(doc));
      if (autoValidate) validate(doc);
    }, VALIDATE_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [revision]);

  // ---------------------------------------------------------------- layout
  const layout = useMemo(() => {
    const stored = layouts[doc.flowName] || {};
    const missing = steps.some((s) => !stored[s.id]);
    const base = missing ? autoLayout(steps) : {};
    const merged = {};
    steps.forEach((s) => {
      merged[s.id] = stored[s.id] || base[s.id];
    });
    return merged;
  }, [doc, layouts]);

  const place = (id, pos) => setLayouts((all) => ({ ...all, [doc.flowName]: { ...layout, ...(all[doc.flowName] || {}), [id]: pos } }));

  // ---------------------------------------------------------------- edits
  const addStep = (kind) => {
    const anchor = selectedId && steps.some((s) => s.id === selectedId) ? selectedId : null;
    const { doc: next, id } = addStepTo(doc, kind, anchor ? [anchor] : []);
    const from = anchor ? layout[anchor] : steps.length ? layout[steps[steps.length - 1].id] : null;
    place(id, from ? { x: from.x + NODE_W + 92, y: from.y } : { x: 56, y: 56 });
    change(() => next);
    setSelectedId(id);
  };

  const moveStep = useCallback((id, x, y) => {
    setLayouts((all) => ({ ...all, [doc.flowName]: { ...layout, ...(all[doc.flowName] || {}), [id]: { x: Math.round(x), y: Math.round(y) } } }));
  }, [doc.flowName, layout]);

  const connect = useCallback((fromId, toId) => change((d) => connectAfter(d, fromId, toId)), [change]);

  const deleteStep = useCallback((id) => {
    if (!id) return;
    change((d) => deleteStepFrom(d, id));
    setSelectedId(null);
  }, [change]);

  const renameStep = (rawId) => {
    const nextId = String(rawId).trim();
    if (!nextId || !selectedId || steps.some((s) => s.id === nextId)) return;
    change((d) => renameStepIn(d, selectedId, nextId));
    setLayouts((all) => {
      const current = { ...layout, ...(all[doc.flowName] || {}) };
      if (current[selectedId]) {
        current[nextId] = current[selectedId];
        delete current[selectedId];
      }
      return { ...all, [doc.flowName]: current };
    });
    setSelectedId(nextId);
  };

  useEffect(() => {
    if (!selectedId) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const el = document.activeElement;
      const tag = el && el.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el && el.isContentEditable)) return;
      e.preventDefault();
      deleteStep(selectedId);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedId, deleteStep]);

  // ---------------------------------------------------------------- validation pins
  const result = validation ? validation.result : null;
  const pinned = useMemo(
    () => (result && result.status === 'invalid' ? pinErrors(validation.spec, result.errors) : { steps: {}, other: [] }),
    [validation],
  );
  const targets = useMemo(
    () => (result && result.status === 'invalid' ? result.errors.map((e) => errorTarget(validation.spec, e.path)) : []),
    [validation],
  );
  const stepErrors = pinned.steps[doc.flowName] || {};

  const pick = (target) => {
    if (target.flowName !== doc.flowName) setDoc((d) => ({ ...d, flowName: target.flowName }));
    setSelectedId(target.stepId);
  };

  const selected = steps.find((s) => s.id === selectedId) || null;

  return (
    <div className="flex h-[calc(100dvh-49px)] flex-col overflow-y-auto md:h-full md:overflow-hidden" data-testid="flow-builder">
      <Toolbar
        doc={doc}
        stepCount={steps.length}
        validation={result}
        busy={busy}
        canValidate={canValidate}
        canPlan={canPlan}
        onValidate={() => {
          setAutoValidate(true);
          validate(doc);
        }}
        onPlan={() => setShowPlan(true)}
        onExport={() => setShowExport(true)}
        onImport={() => setShowImport(true)}
        onNew={() => {
          change(() => ({ spec: emptySpec(), flowName: 'main' }));
          setLayouts({});
          setSelectedId(null);
          setValidation(null);
        }}
      />

      {result && <ValidationPanel result={result} targets={targets} onPick={pick} onClose={() => { setValidation(null); setAutoValidate(false); }} />}

      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <Palette onAdd={addStep} />
        <div className="min-h-[220px] min-w-0 flex-1">
          <DagCanvas
            steps={steps}
            layout={layout}
            mode="edit"
            selectedId={selectedId}
            stepErrors={stepErrors}
            onSelect={setSelectedId}
            onMove={moveStep}
            onConnect={connect}
          />
        </div>
        <PropertiesPanel
          doc={doc}
          flow={flow}
          step={selected}
          errors={selected ? stepErrors[selected.id] : undefined}
          onSetField={(path, value) => change((d) => updateStep(d, selectedId, (s) => setAt(s, path, value)))}
          onSetAfter={(after) => change((d) => setAfter(d, selectedId, after))}
          onReplaceStep={(next) => change((d) => updateStep(d, selectedId, () => next))}
          onUpdateFlow={(patch) => change((d) => updateFlow(d, patch))}
          onUpdateSpec={(patch) => change((d) => updateSpec(d, patch))}
          onSwitchFlow={(name) => {
            setDoc((d) => ({ ...d, flowName: name }));
            setSelectedId(null);
          }}
          onDelete={() => deleteStep(selectedId)}
          onRename={renameStep}
        />
      </div>

      <ExportDialog open={showExport} onOpenChange={setShowExport} doc={doc} />
      <ImportDialog
        open={showImport}
        onOpenChange={setShowImport}
        onImport={(parsed) => {
          change(() => parsed);
          setLayouts({});
          setSelectedId(null);
          setValidation(null);
        }}
      />
      {canPlan && <PlanDialog open={showPlan} onOpenChange={setShowPlan} doc={doc} planFlow={(spec, input) => client.planFlow(spec, input)} />}
    </div>
  );
}
