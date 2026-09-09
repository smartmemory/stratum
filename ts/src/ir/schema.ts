import { z } from "zod";
import { PATH_FIELD_PATTERN, STEP_ID_PATTERN } from "./refs.js";

export const StepIdSchema = z.string().regex(STEP_ID_PATTERN, "invalid step id");
export const ContractFieldNameSchema = z.string().regex(PATH_FIELD_PATTERN, "invalid contract field name");

export const BudgetSchema = z.object({
  usd: z.number().positive().optional(),
  tokens: z.number().int().positive().optional(),
  dispatches: z.number().int().positive().optional(),
  ms: z.number().int().positive().optional(),
}).strict().refine((budget) => Object.keys(budget).length > 0, "budget requires at least one key");

export const EnsurePredicateSchema = z.union([
  z.object({ expr: z.string() }).strict(),
  z.object({ file_exists: z.string() }).strict(),
  z.object({ file_contains: z.object({ path: z.string(), text: z.string() }).strict() }).strict(),
  z.object({ judged: z.object({ statement: z.string(), stakes: z.enum(["cheap", "default", "paranoid"]) }).strict() }).strict(),
]);

export const IterateSchema = z.object({
  max: z.number().int().positive(),
  until: z.string(),
}).strict();

export const GateSchema = z.object({
  on_approve: StepIdSchema.nullable(),
  on_revise: StepIdSchema.nullable(),
  on_kill: StepIdSchema.nullable(),
  max_rounds: z.number().int().positive().optional(),
}).strict();

export const EvaluateSchema = z.object({
  command: z.string().min(1),
  in: z.string().optional(),
  timeout_ms: z.number().int().positive(),
}).strict();

export const FanoutStageSchema = z.object({
  do: z.string(),
  agent: z.enum(["claude", "codex"]).optional(),
  out: z.string().optional(),
  ensure: z.array(EnsurePredicateSchema).optional(),
  attempts: z.number().int().positive().optional(),
  when: z.string().optional(),
}).strict();

export const FanoutSchema = z.object({
  over: z.string(),
  steps: z.array(FanoutStageSchema).min(1),
  concurrency: z.number().int().positive(),
  isolation: z.enum(["worktree", "none"]),
  require: z.union([z.literal("all"), z.literal("any"), z.number().int().positive()]),
  merge: z.literal("sequential"),
  pre_merge: z.array(z.string()).optional(),
  dispatch: z.enum(["engine", "consumer"]).default("engine"),
}).strict();

const StepShape = z.object({
  id: StepIdSchema,
  after: z.array(StepIdSchema).optional(),
  when: z.string().optional(),
  do: z.string().optional(),
  set: z.record(z.string()).optional(),
  agent: z.enum(["claude", "codex"]).optional(),
  out: z.string().optional(),
  ensure: z.array(EnsurePredicateSchema).optional(),
  attempts: z.number().int().positive().optional(),
  iterate: IterateSchema.optional(),
  budget: BudgetSchema.optional(),
  on_fail: StepIdSchema.optional(),
  gate: GateSchema.optional(),
  fanout: FanoutSchema.optional(),
  run: z.string().optional(),
  with: z.record(z.unknown()).optional(),
  evaluate: EvaluateSchema.optional(),
}).strict();

const COMMON_STEP_FIELDS = new Set(["id", "after", "when"]);
const STEP_FIELDS: Record<string, readonly string[]> = {
  do: ["id", "after", "when", "do", "agent", "out", "ensure", "attempts", "iterate", "budget", "on_fail"],
  set: ["id", "after", "when", "set", "out", "ensure"],
  gate: ["id", "after", "when", "gate"],
  fanout: ["id", "after", "when", "fanout", "attempts", "budget", "on_fail"],
  run: ["id", "after", "when", "run", "with", "budget", "on_fail"],
  evaluate: ["id", "after", "when", "evaluate", "out"],
};

export const StepSchema = StepShape.superRefine((step, ctx) => {
  const kinds = ["do", "set", "gate", "fanout", "run", "evaluate"].filter((key) => step[key as keyof typeof step] !== undefined);
  if (kinds.length !== 1) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "E2_CONSTRUCT_MIX" });
    return;
  }
  const kind = kinds[0]!;
  const allowed = new Set(STEP_FIELDS[kind]!);
  for (const key of Object.keys(step)) {
    if (!allowed.has(key) && !COMMON_STEP_FIELDS.has(key)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: "E2_FIELD_FOR_KIND" });
    }
  }
  if (kind === "set" && step.out === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["out"], message: "required for set" });
  }
  if (kind === "run" && step.with === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["with"], message: "required for run" });
  }
});

// z.record() drops an own __proto__ key during structural parsing, which
// would SILENTLY lose a declared field (anti-E2). Reserved names are
// therefore rejected loudly before the record parse ever runs.
export const RESERVED_FIELD_NAMES = new Set(["__proto__", "constructor", "prototype"]);
const rejectReservedFields = (value: unknown, ctx: z.RefinementCtx): void => {
  if (typeof value !== "object" || value === null) return;
  for (const key of Object.getOwnPropertyNames(value)) {
    if (RESERVED_FIELD_NAMES.has(key)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: "E2_RESERVED_FIELD" });
    }
  }
};
export const ContractSchema = z.custom<Record<string, string>>(
  (value) => typeof value === "object" && value !== null && !Array.isArray(value),
  "contract must be an object",
).superRefine(rejectReservedFields).pipe(z.record(ContractFieldNameSchema, z.string()));
export const ContractsSchema = z.record(z.string().regex(PATH_FIELD_PATTERN), ContractSchema);

// Carry names use StepIdSchema (STEP_ID_PATTERN), not PATH_FIELD_PATTERN (R3-2): the
// step-reference regex only claims lowercase step-id-shaped names, so a carry name must
// share that charset for the `${name.output}` reservation (CARRY_PATH_RESERVED) to be total.
export const CarryVariableSchema = z.object({
  initial: z.string().min(1),
  on_revise: z.record(StepIdSchema, z.string().min(1)).optional(),
}).strict();

export const CarrySchema = z.custom<Record<string, unknown>>(
  (value) => typeof value === "object" && value !== null && !Array.isArray(value),
  "carry must be an object",
).superRefine(rejectReservedFields).pipe(z.record(StepIdSchema, CarryVariableSchema));

export const FlowOutputSchema = z.object({
  from: z.string(),
  contract: z.string(),
}).strict();

export const FlowSchema = z.object({
  input: ContractSchema,
  output: FlowOutputSchema,
  budget: BudgetSchema.optional(),
  max_rounds: z.number().int().positive().optional(),
  carry: CarrySchema.optional(),
  steps: z.array(StepSchema),
}).strict();

export const FlowMapSchema = z.object({ entry: z.string() }).catchall(FlowSchema);

export const SpecificationSchema = z.object({
  version: z.literal(1),
  contracts: ContractsSchema,
  flows: FlowMapSchema,
}).strict();

export type Specification = z.infer<typeof SpecificationSchema>;
export type Flow = z.infer<typeof FlowSchema>;
export type Step = z.infer<typeof StepSchema>;
