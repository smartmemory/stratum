import { authorCandidate } from "./candidate.js";
import type { AssetCandidate, AssetKind, AuthoringContext } from "./candidate.js";
import type { WorkflowCandidate } from "./detector.js";
export type FormSelector = (workflow: WorkflowCandidate) => unknown;
const READ_ONLY = new Set(["Read", "Grep", "Glob", "LS", "WebFetch", "WebSearch", "NotebookRead"]);
export function synthesize(workflow: WorkflowCandidate, context: AuthoringContext, formSelector?: FormSelector): AssetCandidate | null {
  if (!workflow || !["single", "sequence"].includes(workflow.workflow?.kind) || workflow.recurrence.records < (context.minCount ?? 2) || workflow.recurrence.distinctSessions < (context.minSessions ?? 2)) return null;
  let kind: AssetKind = workflow.workflow.kind === "single" ? "command" : workflow.workflow.tools.every(t => READ_ONLY.has(t)) ? "subagent" : "skill";
  let selectedBy: "heuristic" | "override" = "heuristic";
  if (formSelector) {
    try { const selected = formSelector(structuredClone(workflow)); if (selected === "skill" || selected === "subagent" || selected === "command") { kind = selected; selectedBy = "override"; } } catch { /* deterministic fallback */ }
  }
  return authorCandidate(workflow, kind, { ...context, selectedBy });
}
