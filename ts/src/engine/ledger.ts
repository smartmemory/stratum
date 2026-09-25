import type { AttemptTelemetry } from "./state.js";

export const BUDGET_KEYS = ["usd", "tokens", "dispatches", "ms"] as const;
export type BudgetKey = (typeof BUDGET_KEYS)[number];
export type Budget = Partial<Record<BudgetKey, number | undefined>>;

export interface LedgerSnapshot {
  limits?: Budget;
  spent: Budget;
}

function copyBudget(budget: Budget | undefined): Budget {
  return budget ? { ...budget } : {};
}

/** A small, serializable budget ledger. Limits are only imposed for declared keys.
 * Unknown amounts make no debit (existing policy); spent is a known-amount subtotal,
 * not proof of complete cost or a free call. USD caps cannot bound unreported cost.
 * Receipts, not these sparse totals, retain the distinction between unknown and zero.
 */
export class BudgetLedger {
  readonly limits?: Budget;
  readonly spent: Budget;

  constructor(limits?: Budget, spent: Budget = {}) {
    if (limits) this.limits = copyBudget(limits);
    this.spent = copyBudget(spent);
  }

  canDebit(amount: Budget): boolean {
    return BUDGET_KEYS.every((key) => {
      const limit = this.limits?.[key];
      return limit === undefined || (this.spent[key] ?? 0) + (amount[key] ?? 0) <= limit;
    });
  }

  debit(amount: Budget): void {
    for (const key of BUDGET_KEYS) {
      const value = amount[key];
      if (value !== undefined && value !== 0) this.spent[key] = (this.spent[key] ?? 0) + value;
    }
  }

  snapshot(): LedgerSnapshot {
    return { ...(this.limits ? { limits: copyBudget(this.limits) } : {}), spent: copyBudget(this.spent) };
  }
}

export function validUsage(value: unknown): value is Budget {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  return Object.entries(value).every(([key, amount]) =>
    (BUDGET_KEYS as readonly string[]).includes(key) && typeof amount === "number" && Number.isFinite(amount) && amount >= 0,
  );
}

export function validConnectorTelemetry(value: unknown): value is AttemptTelemetry | undefined {
  if (value === undefined) return true;
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const telemetry = value as Record<string, unknown>;
  if (Object.keys(telemetry).some((key) => !["durationMs", "model", "effort"].includes(key))) return false;
  return typeof telemetry.durationMs === "number" && Number.isFinite(telemetry.durationMs) && telemetry.durationMs >= 0
    && typeof telemetry.model === "string" && telemetry.model.length > 0
    && (telemetry.effort === undefined || (typeof telemetry.effort === "string" && telemetry.effort.length > 0));
}
