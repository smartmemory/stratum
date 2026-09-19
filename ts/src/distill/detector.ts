import { compare, digest, integer, isRecord } from "./harvest.js";
import type { TranscriptHandle, TranscriptSession } from "./harvest.js";

export const DETECTOR_VERSION = "1";
export const CANONICALIZER_VERSION = "1";
/** Canonical JSON uses ECMAScript numbers/Unicode, recursively sorted object keys. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort(compare).map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
export const hash = (value: unknown): string => digest(canonicalJson(value));
function ordinaryJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(ordinaryJson).join(", ")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort(compare).map(k => `${JSON.stringify(k)}: ${ordinaryJson(value[k])}`).join(", ")}}`;
  return JSON.stringify(value) ?? "null";
}
/** Best-effort patterns, not a guarantee that arbitrary secrets are recognized. */
export function redact(value: string): string {
  return value.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-]*PRIVATE KEY-----|$)/g, "[REDACTED]")
    .replace(/\b(?:sk-[A-Za-z0-9_-]+|gh[pousr]_[A-Za-z0-9_]+|github_pat_[A-Za-z0-9_]+|AKIA[A-Z0-9]{16})\b/g, "[REDACTED]")
    .replace(/\bBearer\s+[^\s"']+/gi, "Bearer [REDACTED]")
    .replace(/((?:password|passwd|secret|token|api[_-]?key)\s*["']?\s*[:=]\s*["']?)[^\s"',;}]+/gi, "$1[REDACTED]");
}
export function canonicalizeInput(input: unknown): string {
  const data = isRecord(input) ? input : {};
  const key = ["command", "file_path", "path", "pattern", "url", "notebook_path"].find(k => typeof data[k] === "string" && data[k] !== "");
  return Array.from(redact(key ? data[key] as string : ordinaryJson(data))).slice(0, 120).join("");
}
export interface WorkflowStep { toolName: string; canonicalInput: string; lineNo: number; blockIndex: number; toolUseId: string | null; cwd: string | null; lineDigest: string }
export type WorkflowDescription = { kind: "single"; signature: string; step: { toolName: string; canonicalInput: string } } | { kind: "sequence"; signature: string; tools: string[] };
export interface WorkflowOccurrence { id: string; sourceKind: "claude-transcript"; projectDir: string; sessionId: string; transcriptFile: string; cwd: string | null; steps: WorkflowStep[] }
export interface WorkflowCandidate { workflow: WorkflowDescription; scope: { transcriptProjectDir: string; observedCwds: string[] }; evidence: WorkflowOccurrence[]; recurrence: { records: number; distinctSessions: number }; sourceHandle: TranscriptHandle }
export function toolSteps(session: TranscriptSession): WorkflowStep[] {
  return session.observations.map(({ input, ...step }) => ({ ...step, canonicalInput: canonicalizeInput(input) }));
}
export function occurrenceId(o: Omit<WorkflowOccurrence, "id">): string {
  return hash({ sourceKind: o.sourceKind, projectDir: o.projectDir, sessionId: o.sessionId, transcriptFile: o.transcriptFile,
    steps: o.steps.map(s => ({ lineNo: s.lineNo, blockIndex: s.blockIndex, lineDigest: s.lineDigest })) });
}
export function description(steps: WorkflowStep[]): WorkflowDescription {
  if (steps.length === 1) {
    const step = { toolName: steps[0]!.toolName, canonicalInput: steps[0]!.canonicalInput };
    return { kind: "single", signature: canonicalJson([step.toolName, step.canonicalInput]), step };
  }
  const tools = steps.map(s => s.toolName);
  return { kind: "sequence", signature: canonicalJson(tools), tools };
}
export function workflowFromEvidence(evidence: WorkflowOccurrence[]): WorkflowCandidate {
  evidence = [...evidence].sort((a, b) =>
    compare(a.projectDir, b.projectDir) || compare(a.transcriptFile, b.transcriptFile)
    || a.steps[0]!.lineNo - b.steps[0]!.lineNo || a.steps[0]!.blockIndex - b.steps[0]!.blockIndex
    || compare(a.id, b.id));
  const first = evidence[0]!;
  const step = first.steps[0]!;
  return { workflow: description(first.steps), scope: { transcriptProjectDir: first.projectDir,
    observedCwds: [...new Set(evidence.flatMap(o => o.steps.flatMap(s => s.cwd === null ? [] : [s.cwd])))].sort(compare) }, evidence,
    recurrence: { records: evidence.length, distinctSessions: new Set(evidence.map(o => canonicalJson([o.projectDir, o.sessionId]))).size },
    sourceHandle: { projectDir: first.projectDir, sessionId: first.sessionId, transcriptFile: first.transcriptFile, lineNo: step.lineNo, blockIndex: step.blockIndex } };
}
export function detect(sessions: TranscriptSession[], options: { minCount?: number; minSessions?: number; ngramRange?: [number, number] } = {}): WorkflowCandidate[] {
  const { minCount = 2, minSessions = 2, ngramRange = [2, 4] } = options;
  if (!integer(minCount, 1) || !integer(minSessions, 1) || !integer(ngramRange[0], 2) || !integer(ngramRange[1], ngramRange[0])) throw new Error("invalid detection thresholds");
  const groups = new Map<string, Map<string, WorkflowOccurrence>>();
  const ordered = [...sessions].sort((a, b) => compare(canonicalJson([a.projectDir, a.transcriptFile]), canonicalJson([b.projectDir, b.transcriptFile])));
  for (const session of ordered) {
    const steps = toolSteps(session);
    for (const n of [1, ...Array.from({ length: ngramRange[1] - ngramRange[0] + 1 }, (_, i) => ngramRange[0] + i)]) {
      for (let i = 0; i + n <= steps.length; i++) {
        const window = steps.slice(i, i + n);
        const cwd = window[0]!.cwd !== null && window.every(s => s.cwd === window[0]!.cwd) ? window[0]!.cwd : null;
        const source: Omit<WorkflowOccurrence, "id"> = { sourceKind: "claude-transcript", projectDir: session.projectDir, sessionId: session.sessionId, transcriptFile: session.transcriptFile, cwd, steps: window };
        const occurrence = { ...source, id: occurrenceId(source) };
        const d = description(window);
        const key = canonicalJson([session.projectDir, d.kind, d.signature]);
        if (!groups.has(key)) groups.set(key, new Map());
        groups.get(key)!.set(occurrence.id, occurrence);
      }
    }
  }
  return [...groups.values()].map(group => workflowFromEvidence([...group.values()]))
    .filter(w => w.recurrence.records >= minCount && w.recurrence.distinctSessions >= minSessions)
    .sort((a, b) => b.recurrence.records - a.recurrence.records || b.recurrence.distinctSessions - a.recurrence.distinctSessions || compare(a.workflow.kind, b.workflow.kind) || compare(a.workflow.signature, b.workflow.signature) || compare(a.scope.transcriptProjectDir, b.scope.transcriptProjectDir));
}
