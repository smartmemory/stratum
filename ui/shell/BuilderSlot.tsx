// @ts-nocheck: the builder is untyped Base44 JSX until STRAT-UI-BUILDER-1.
import { FlowBuilder } from "../src/builder";
import "./theme.css";

/** Slot for the builder canvas (STRAT-UI-BUILDER-1). Sample data only; nothing is saved. */
export default function BuilderSlot() {
  return (
    <div className="dark flex h-full min-h-0 flex-col bg-background text-foreground">
      <div className="border-b border-border px-4 py-2 font-mono text-[11px] text-muted-foreground">
        builder preview: Base44 port with sample data, not wired to the engine yet (STRAT-UI-BUILDER-1)
      </div>
      <div className="flex min-h-0 flex-1">
        <FlowBuilder />
      </div>
    </div>
  );
}
