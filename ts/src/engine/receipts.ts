import { BUDGET_KEYS, type Budget, validConnectorTelemetry, validUsage } from "./ledger.js";
import type { AttemptTelemetry, PersistedRun, ReceiptRecord } from "./state.js";

export interface ReceiptInput {
  dispatchId: string;
  stepId?: string;
  source: string;
  usage: Budget;
  telemetry?: AttemptTelemetry;
  split?: { input: number; output: number; cacheRead?: number; cacheCreation?: number };
  usdSource?: "reported" | "estimated" | "legacy";
  at?: string;
}

export class ReceiptValidationError extends Error {
  readonly errorType: "invalid_receipt" | "invalid_step";

  constructor(message: string, errorType: ReceiptValidationError["errorType"] = "invalid_receipt") {
    super(message);
    this.name = "ReceiptValidationError";
    this.errorType = errorType;
  }
}

export function buildReceipt(run: PersistedRun, input: ReceiptInput): ReceiptRecord {
  if (typeof input !== "object" || input === null || Array.isArray(input)) invalid("receipt must be an object");
  if (typeof input.dispatchId !== "string" || input.dispatchId.length === 0) invalid("dispatchId must be a non-empty string");
  if (input.stepId !== undefined && (typeof input.stepId !== "string" || input.stepId.length === 0)) {
    invalid("stepId must be a non-empty string when present");
  }
  if (typeof input.source !== "string" || input.source.length === 0) invalid("source must be a non-empty string");
  if (!validUsage(input.usage)) invalid("usage must be a valid non-negative budget object");
  if (Object.hasOwn(input.usage, "dispatches")) invalid("dispatches are engine-accounted and cannot appear in a receipt");
  if (!validConnectorTelemetry(input.telemetry)) invalid("telemetry must contain a non-empty model and non-negative durationMs");
  if (input.usage.usd !== undefined && input.usdSource === undefined) invalid("usdSource is required when usage.usd is present");
  if (input.usdSource !== undefined && !["reported", "estimated", "legacy"].includes(input.usdSource)) {
    invalid('usdSource must be "reported", "estimated", or "legacy"');
  }
  if (input.at !== undefined && typeof input.at !== "string") invalid("at must be a string when present");
  if (input.split !== undefined && !validSplit(input.split)) invalid("split must contain non-negative input/output token counts");

  const telemetry = input.telemetry ?? { model: "unknown", durationMs: 0 };
  const seq = (run.receiptCounter ?? 0) + 1;
  run.receiptCounter = seq;
  return {
    seq,
    dispatchId: input.dispatchId,
    ...(input.stepId !== undefined ? { stepId: input.stepId } : {}),
    source: input.source,
    amount: { ...input.usage },
    telemetry: { ...telemetry },
    ...(input.split !== undefined ? { split: { ...input.split } } : {}),
    ...(input.usdSource !== undefined ? { usdSource: input.usdSource } : {}),
    ...(input.at !== undefined ? { reportedAt: input.at } : {}),
    at: new Date().toISOString(),
    egress: "pending",
  };
}

export function findReceipt(run: PersistedRun, dispatchId: string): ReceiptRecord | undefined {
  return run.receipts?.find((receipt) => receipt.dispatchId === dispatchId);
}

export function spineSpent(run: PersistedRun): Budget {
  const spent: Budget = {};
  for (const receipt of run.receipts ?? []) {
    for (const key of BUDGET_KEYS) {
      const amount = receipt.amount[key];
      if (amount !== undefined && amount !== 0) spent[key] = (spent[key] ?? 0) + amount;
    }
  }
  return spent;
}

function validSplit(value: unknown): value is NonNullable<ReceiptInput["split"]> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const split = value as Record<string, unknown>;
  if (Object.keys(split).some((key) => !["input", "output", "cacheRead", "cacheCreation"].includes(key))) return false;
  return nonNegative(split.input) && nonNegative(split.output)
    && (split.cacheRead === undefined || nonNegative(split.cacheRead))
    && (split.cacheCreation === undefined || nonNegative(split.cacheCreation));
}

function nonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function invalid(message: string): never {
  throw new ReceiptValidationError(message);
}
