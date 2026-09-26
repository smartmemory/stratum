import { z } from "zod";
import { resolveLearnConfig } from "../config/learn.js";
import type { ContractSummary } from "./classify.js";
import { activeLessons, type ActiveLesson } from "./select.js";
import { canonicalWorkspace } from "./workspace.js";

/**
 * STRAT-LEARN-DELIVER-1 D3/D4: which active lessons a dispatch receives, pinned at
 * issuance and rendered only from the pin.
 */

export interface LessonPin {
  revisionId: string;
  clusterId: string;
  guidance: string;
}

export interface LessonSuppression {
  revisionId: string;
  reason: "contract-changed" | "budget";
}

export interface DeliveryPin {
  lessons: LessonPin[];
  lessonsSuppressed?: LessonSuppression[];
}

/** The pinned fields as they sit on step/item state; both omitted when empty. */
export interface PinnedState {
  lessons?: LessonPin[];
  lessonsSuppressed?: LessonSuppression[];
}

export interface DispatchTarget {
  /** Root `run.flowName` — what the harvester stamps on every failure record. */
  flowName: string;
  /** From `harvestStepId()`. */
  stepId: string;
  /** The dispatch's current compiled output contract, if it declares one. */
  contract: z.ZodTypeAny | undefined;
}

export const LESSON_BUDGET = Object.freeze({ lessons: 3, characters: 1200 });
export const LESSONS_HEADING = "## Lessons from prior runs";

/**
 * The step id the harvester would stamp on a failure of this dispatch (D3). Ordinary and
 * subflow steps: the engine's scoped id (`<prefix>/<step>`, the `result` event's stepId).
 * Engine and consumer fan-out items: the parent step id (the `fanout_attempt_result`
 * event's stepId) — callers pass no prefix, fan-out is root-only.
 */
export function harvestStepId(stepId: string, prefix?: string): string {
  return prefix ? `${prefix}/${stepId}` : stepId;
}

/**
 * D3 compatibility predicate: the lesson's contract still holds for this output contract.
 * The path is resolved through object fields and array elements (zod drops array indices
 * from the harvested path, so any element depth at a segment is a candidate).
 */
export function contractHolds(contract: z.ZodTypeAny | undefined, summary: ContractSummary): boolean {
  if (contract === undefined || summary.path.length === 0) return false;
  let nodes: z.ZodTypeAny[] = [contract];
  for (const segment of summary.path.split(".")) {
    const next: z.ZodTypeAny[] = [];
    for (const node of nodes.flatMap(withElements)) {
      if (node instanceof z.ZodObject) {
        const field = (node.shape as Record<string, z.ZodTypeAny>)[segment];
        if (field !== undefined && Object.hasOwn(node.shape, segment)) next.push(unwrap(field));
      }
    }
    if (next.length === 0) return false;
    nodes = next;
  }
  const expected = [...summary.expected].sort();
  return nodes.flatMap(withElements).some((node) => {
    if (summary.code === "invalid_enum_value") {
      return node instanceof z.ZodEnum && sameSet([...(node.options as string[])].sort(), expected);
    }
    if (summary.code === "invalid_type") {
      return expected.length === 1 && compiledTypes(node).includes(expected[0]!);
    }
    return false;
  });
}

function unwrap(node: z.ZodTypeAny): z.ZodTypeAny {
  let current = node;
  while (current instanceof z.ZodOptional || current instanceof z.ZodNullable) current = current.unwrap();
  return current;
}

/** The node itself and every array-element depth below it. */
function withElements(node: z.ZodTypeAny): z.ZodTypeAny[] {
  const out = [unwrap(node)];
  while (out[out.length - 1] instanceof z.ZodArray) out.push(unwrap((out[out.length - 1] as z.ZodArray<z.ZodTypeAny>).element));
  return out;
}

/** The `expected` strings zod reports for an `invalid_type` issue on this compiled node. */
function compiledTypes(node: z.ZodTypeAny): string[] {
  if (node instanceof z.ZodString) return ["string"];
  if (node instanceof z.ZodNumber) return node.isInt ? ["number", "integer"] : ["number"];
  if (node instanceof z.ZodBoolean) return ["boolean"];
  if (node instanceof z.ZodObject || node instanceof z.ZodRecord) return ["object"];
  if (node instanceof z.ZodArray) return ["array"];
  if (node instanceof z.ZodEnum) return [(node.options as string[]).map((value) => `'${value}'`).join(" | ")];
  return [];
}

function sameSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * D3 matching + budget over lessons already selected for this workspace. Pure.
 * A lesson is in scope when its step ids include this dispatch, or — step-agnostic only —
 * when this dispatch's contract satisfies the predicate. An in-scope lesson whose contract
 * no longer holds is suppressed as `contract-changed`; a step-agnostic lesson on an
 * unrelated step whose contract lacks the field is simply out of scope, not drift.
 */
export function matchLessons(lessons: readonly ActiveLesson[], target: DispatchTarget): DeliveryPin | undefined {
  const matched: ActiveLesson[] = [];
  const suppressed: LessonSuppression[] = [];
  for (const lesson of lessons) {
    const { candidate } = lesson;
    if (candidate.scope.flowName !== target.flowName) continue;
    const named = candidate.scope.stepIds.includes(target.stepId);
    if (!named && candidate.groupingKey !== "step-agnostic") continue;
    if (contractHolds(target.contract, candidate.contract)) matched.push(lesson);
    else if (named) suppressed.push({ revisionId: candidate.revisionId, reason: "contract-changed" });
  }
  matched.sort((a, b) => b.candidate.recurrence.records - a.candidate.recurrence.records
    || (a.candidate.clusterId < b.candidate.clusterId ? -1 : a.candidate.clusterId > b.candidate.clusterId ? 1 : 0));
  const pinned: LessonPin[] = [];
  let characters = 0;
  for (const { candidate } of matched) {
    const guidance = candidate.rendered.guidance!;
    if (pinned.length >= LESSON_BUDGET.lessons || characters + guidance.length > LESSON_BUDGET.characters) {
      suppressed.push({ revisionId: candidate.revisionId, reason: "budget" });
      continue;
    }
    pinned.push({ revisionId: candidate.revisionId, clusterId: candidate.clusterId, guidance });
    characters += guidance.length;
  }
  if (pinned.length === 0 && suppressed.length === 0) return undefined;
  return { lessons: pinned, ...(suppressed.length > 0 ? { lessonsSuppressed: suppressed } : {}) };
}

export interface PinOptions extends DispatchTarget {
  workspaceRoot: string | undefined;
  env?: NodeJS.ProcessEnv;
  /** Test seam: replaces the committed-snapshot selector. Production never sets it. */
  select?: typeof activeLessons;
}

const warned = new Set<string>();
function warnOnce(text: string): void {
  if (warned.has(text)) return;
  warned.add(text);
  console.warn(`learn deliver: ${text}`);
}

/**
 * Select and match at issuance. OFF (the default) reads nothing beyond the config. Never
 * throws: any failure delivers nothing (fail closed on injecting, never on the flow).
 */
export async function pinFor(options: PinOptions): Promise<DeliveryPin | undefined> {
  if (options.workspaceRoot === undefined) return undefined;
  try {
    const root = await canonicalWorkspace(options.workspaceRoot);
    const config = resolveLearnConfig({ projectRoot: root, ...(options.env !== undefined ? { env: options.env } : {}) });
    for (const diagnostic of config.diagnostics) warnOnce(diagnostic);
    if (!config.deliver) return undefined;
    const { lessons } = await (options.select ?? activeLessons)(root);
    const inWorkspace: ActiveLesson[] = [];
    for (const lesson of lessons) {
      if (await canonicalWorkspace(lesson.candidate.scope.workspaceRoot) === root) inWorkspace.push(lesson);
    }
    return matchLessons(inWorkspace, options);
  } catch (error) {
    warnOnce(`selection failed, delivering nothing: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

/** Write (or clear) the pin on step/item state. */
export function setPin(state: PinnedState, pin: DeliveryPin | undefined): void {
  delete state.lessons;
  delete state.lessonsSuppressed;
  if (pin === undefined) return;
  if (pin.lessons.length > 0) state.lessons = pin.lessons;
  if (pin.lessonsSuppressed !== undefined) state.lessonsSuppressed = pin.lessonsSuppressed;
}

/** The issuing event's detail fields; `{}` when nothing was offered or suppressed. */
export function pinEventDetail(pin: DeliveryPin | undefined): { lessons?: string[]; lessonsSuppressed?: LessonSuppression[] } {
  if (pin === undefined) return {};
  return {
    ...(pin.lessons.length > 0 ? { lessons: pin.lessons.map((lesson) => lesson.revisionId) } : {}),
    ...(pin.lessonsSuppressed !== undefined ? { lessonsSuppressed: pin.lessonsSuppressed } : {}),
  };
}

/** D4 block, appended to the rendered `do` after a blank line; "" without pinned lessons. */
export function lessonBlock(state: PinnedState | undefined): string {
  const lessons = state?.lessons ?? [];
  if (lessons.length === 0) return "";
  return `\n\n${LESSONS_HEADING}\n${lessons.map((lesson) => `- ${lesson.guidance}`).join("\n")}`;
}
