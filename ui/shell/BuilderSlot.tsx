// @ts-nocheck: the builder components are JSX ported from Base44 (its model, lib/spec.ts, is typed).
import { FlowBuilder } from "../src/builder";
import "./theme.css";

/**
 * Builder screen (STRAT-UI-BUILDER-1). Validate and Dry plan go through the shell's
 * DataClient to the engine (`/api/validate`, `/api/plan`); nothing is saved or run.
 */
export default function BuilderSlot() {
  return (
    <div className="dark flex h-full min-h-0 flex-col bg-background text-foreground">
      <div className="border-b border-border px-4 py-2 font-mono text-[11px] text-muted-foreground">
        flow builder: edits a Stratum spec in the browser. Validate runs the engine validator, Dry plan runs
        stratum_plan in a throwaway dir. Export to save; nothing here starts a run.
      </div>
      <div className="flex min-h-0 flex-1">
        <FlowBuilder />
      </div>
    </div>
  );
}
