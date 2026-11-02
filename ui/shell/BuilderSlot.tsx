// @ts-nocheck: the builder components are JSX ported from Base44 (its model, lib/spec.ts, is typed).
import { useEffect, useState } from "react";
import { FlowBuilder } from "../src/builder";
import { useOptionalDataClient } from "../src";
import "./theme.css";

/**
 * Builder screen (STRAT-UI-BUILDER-1). Validate and Dry plan go through the shell's
 * DataClient to the engine (`/api/validate`, `/api/plan`); nothing is saved or run.
 * Deep links (STRAT-UI-LINKS-1): `runId` opens that run's own spec (`getRunSpec`, a read),
 * `specName` a host-saved spec (`readSpec`), `stepId` selects a step of the entry flow.
 */
export default function BuilderSlot({ runId, specName, stepId }) {
  const client = useOptionalDataClient();
  const wanted = runId || specName || null;
  const [loaded, setLoaded] = useState({ key: null, spec: null, error: null });

  useEffect(() => {
    if (!wanted) return undefined;
    let live = true;
    const read = runId ? client?.getRunSpec?.(runId) : client?.readSpec?.(specName);
    const settle = (patch) => { if (live) setLoaded({ key: wanted, spec: null, error: null, ...patch }); };
    if (!read) settle({ error: runId ? "this host cannot serve a run's spec" : "this host cannot reopen saved specs" });
    else read.then((spec) => settle(spec ? { spec } : { error: `${runId ? "run" : "spec"} ${wanted} not found` }), (error) => settle({ error: String(error?.message ?? error) }));
    return () => { live = false; };
  }, [client, runId, specName, wanted]);

  const pending = wanted && loaded.key !== wanted;
  return (
    <div className="dark flex h-full min-h-0 flex-col bg-background text-foreground">
      <div className="border-b border-border px-4 py-2 font-mono text-[11px] text-muted-foreground">
        flow builder: edits a Stratum spec in the browser. Validate runs the engine validator, Dry plan runs
        stratum_plan in a throwaway dir. Export to save; nothing here starts a run.
        {wanted && !pending && !loaded.error && ` Opened from ${runId ? `run ${runId}` : `spec ${specName}`}.`}
        {loaded.error && wanted && !pending && <span className="text-destructive" role="alert"> Could not open it: {loaded.error}.</span>}
      </div>
      <div className="flex min-h-0 flex-1">
        {pending ? null : <FlowBuilder key={wanted ?? "blank"} initialSpec={loaded.key === wanted ? loaded.spec ?? undefined : undefined} initialStepId={stepId} />}
      </div>
    </div>
  );
}
