import React, { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react';
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
 * Props: `initialSpec` (a v1 document or a run file), `initialStepId` (selected on open, and again whenever it
 * changes, so a host's `step=` link or Back moves the selection without dropping edits), `onChange(spec)` (the
 * exported document, 400 ms after the last edit; the timer restarts on every edit). Validation and the dry plan go
 * through the host's DataClient (`validateSpec`, `planFlow`); without them those buttons are disabled, never faked.
 *
 * Ref handle (STRAT-FLOWBUILDER-FLUSH-1), for a host Save that must not guess at the `onChange` timer:
 * `getDocument()` returns the exported document as of now, synchronously, with every committed edit in it (the
 * builder keeps the latest document in a ref written in the same tick as the edit, not after a render). It calls
 * `flush()` first. `flush()` commits a field being typed in (step id, list, JSON) by blurring it, the same path as
 * the user leaving the field, so a Save from a keyboard shortcut with the caret still in a field keeps that text.
 * A field whose draft is invalid JSON stays uncommitted and keeps its "invalid JSON" note. `onChange` is unchanged.
 *
 * @typedef {{ getDocument: () => Record<string, unknown>, flush: () => void }} FlowBuilderHandle
 * @type {React.ForwardRefExoticComponent<{ initialSpec?: unknown, initialStepId?: string | null, onChange?: (spec: Record<string, unknown>) => void } & React.RefAttributes<FlowBuilderHandle>>}
 */
const FlowBuilder = forwardRef(function FlowBuilder({ initialSpec, initialStepId, onChange }, ref) {
  const client = useOptionalDataClient();
  const canValidate = Boolean(client && client.validateSpec);
  const canPlan = Boolean(client && client.planFlow);

  const [doc, setDocState] = useState(() => initialDoc(initialSpec));
  // The committed document as of now. Every write goes through `setDoc`, which updates this ref before React
  // re-renders, so `getDocument()` right after an edit (even inside the same event) already sees it.
  const docRef = useRef(doc);
  const setDoc = useCallback((next) => {
    const value = typeof next === 'function' ? next(docRef.current) : next;
    docRef.current = value;
    setDocState(value);
  }, []);
  const rootRef = useRef(null);
  const [layouts, setLayouts] = useState({});
  const [selectedId, setSelectedId] = useState(initialStepId ?? null);
  const [selectedEdge, setSelectedEdge] = useState(null); // { id, fromId, toId } of a chosen `after` edge
  const [validation, setValidation] = useState(null); // { result, spec } of the last validateSpec call
  const [autoValidate, setAutoValidate] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [showImport, setShowImport] = useState(false);
  const [showPlan, setShowPlan] = useState(false);
  const [revision, setRevision] = useState(0);
  const seq = useRef(0);

  // The one way to select a step: it clears a chosen edge, so Delete removes what is visibly selected.
  const selectStep = useCallback((id) => {
    setSelectedEdge(null);
    setSelectedId(id ?? null);
  }, []);

  useEffect(() => {
    if (initialSpec) {
      setDoc(parseImport(initialSpec));
      setLayouts({});
      selectStep(initialStepId);
      setValidation(null);
    }
  }, [initialSpec]);

  // A new `initialStepId` on the same spec (the host's `step=` changed, or Back) moves the selection; edits stay.
  useEffect(() => {
    selectStep(initialStepId);
  }, [initialStepId]);

  const flow = getFlow(doc);
  const steps = flow.steps || [];

  const change = useCallback((updater) => {
    setDoc(updater);
    setRevision((r) => r + 1);
  }, [setDoc]);

  const flush = useCallback(() => {
    const el = typeof document === 'undefined' ? null : document.activeElement;
    if (!el || !rootRef.current || !rootRef.current.contains(el)) return;
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') el.blur();
  }, []);

  useImperativeHandle(ref, () => ({
    flush,
    getDocument: () => {
      flush();
      return buildExport(docRef.current);
    },
  }), [flush]);

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
    const { doc: next, id } = addStepTo(docRef.current, kind, anchor ? [anchor] : []);
    const from = anchor ? layout[anchor] : steps.length ? layout[steps[steps.length - 1].id] : null;
    place(id, from ? { x: from.x + NODE_W + 92, y: from.y } : { x: 56, y: 56 });
    change(() => next);
    selectStep(id);
  };

  const moveStep = useCallback((id, x, y) => {
    setLayouts((all) => ({ ...all, [doc.flowName]: { ...layout, ...(all[doc.flowName] || {}), [id]: { x: Math.round(x), y: Math.round(y) } } }));
  }, [doc.flowName, layout]);

  const connect = useCallback((fromId, toId) => change((d) => connectAfter(d, fromId, toId)), [change]);

  const deleteStep = useCallback((id) => {
    if (!id) return;
    change((d) => deleteStepFrom(d, id));
    selectStep(null);
  }, [change, selectStep]);

  const renameStep = (rawId) => {
    const nextId = String(rawId).trim();
    if (!nextId || !selectedId || (getFlow(docRef.current).steps || []).some((s) => s.id === nextId)) return;
    change((d) => renameStepIn(d, selectedId, nextId));
    setLayouts((all) => {
      const current = { ...layout, ...(all[doc.flowName] || {}) };
      if (current[selectedId]) {
        current[nextId] = current[selectedId];
        delete current[selectedId];
      }
      return { ...all, [doc.flowName]: current };
    });
    selectStep(nextId);
  };

  // An `after` edge disconnects by removing the dependency from its target step.
  const deleteEdge = useCallback((edge) => {
    if (!edge) return;
    change((d) => {
      const target = getFlow(d).steps.find((s) => s.id === edge.toId);
      return target ? setAfter(d, edge.toId, (target.after || []).filter((id) => id !== edge.fromId)) : d;
    });
    setSelectedEdge(null);
  }, [change]);

  // Choosing an edge: an `after` edge is selected (Delete removes it); a route or data edge lives in a step
  // field, so choosing it selects the step that owns the field and the panel shows it. A route (approve, kill,
  // on_fail, revise) is a field of its source step; a data edge is the consumer's `${producer.output}` reference,
  // so it selects the consumer (`toId`), not the producer.
  const chooseEdge = (edge) => {
    if (edge.kind === 'after') {
      setSelectedEdge({ id: edge.id, fromId: edge.fromId, toId: edge.toId });
      setSelectedId(null);
    } else {
      selectStep(edge.kind === 'data' ? edge.toId : edge.fromId);
    }
  };

  useEffect(() => {
    if (!selectedId && !selectedEdge) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return;
      const el = document.activeElement;
      const tag = el && el.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (el && el.isContentEditable)) return;
      e.preventDefault();
      if (selectedEdge) deleteEdge(selectedEdge);
      else deleteStep(selectedId);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedId, selectedEdge, deleteStep, deleteEdge]);

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

  // A validation row with no step to point at (a flow-level error) selects the flow settings.
  const pick = (target) => {
    if (!target) {
      selectStep(null);
      return;
    }
    if (target.flowName !== doc.flowName) setDoc((d) => ({ ...d, flowName: target.flowName }));
    selectStep(target.stepId);
  };

  const switchFlow = (name) => {
    setDoc((d) => ({ ...d, flowName: name }));
    selectStep(null);
  };

  const selected = steps.find((s) => s.id === selectedId) || null;

  return (
    <div ref={rootRef} className="flex h-[calc(100dvh-49px)] flex-col overflow-y-auto md:h-full md:overflow-hidden" data-testid="flow-builder">
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
        onSwitchFlow={switchFlow}
        onNew={() => {
          change(() => ({ spec: emptySpec(), flowName: 'main' }));
          setLayouts({});
          selectStep(null);
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
            onSelect={selectStep}
            selectedEdgeId={selectedEdge ? selectedEdge.id : null}
            onSelectEdge={chooseEdge}
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
          onSwitchFlow={switchFlow}
          onSelectStep={selectStep}
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
          selectStep(null);
          setValidation(null);
        }}
      />
      {canPlan && <PlanDialog open={showPlan} onOpenChange={setShowPlan} doc={doc} planFlow={(spec, input) => client.planFlow(spec, input)} stepIds={steps.map((s) => s.id)} onPickStep={selectStep} />}
    </div>
  );
});

export default FlowBuilder;
