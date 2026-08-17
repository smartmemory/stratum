/** CLI boundary for the guarded state-machine API. */

import { inspectDescriptorFile } from "../guard/descriptors.js";
import { GuardError } from "../guard/errors.js";
import {
  guardHistory,
  guardMigrate,
  guardOverride,
  guardApplyUpgrade,
  guardTransition,
  guardUpgrade,
  registerGuard,
  type GuardJudge,
} from "../guard/transition.js";

const ACTIONS = new Set(["register", "transition", "override", "migrate", "upgrade", "descriptors", "history"]);

let testJudge: GuardJudge | undefined;

/** Replace only the CLI transition judge in isolated tests. */
export function setGuardJudgeForTests(judge: GuardJudge | undefined): () => void {
  const previous = testJudge;
  testJudge = judge;
  return () => { testJudge = previous; };
}

async function readStdin(): Promise<string> {
  let raw = "";
  for await (const chunk of process.stdin) raw += String(chunk);
  return raw;
}

function writeJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function errorEnvelope(error: unknown): { status: "error"; error_type: string; message: string } {
  if (error instanceof GuardError) return error.toEnvelope();
  if (error instanceof Error) return { status: "error", error_type: error.name || "unexpected_error", message: error.message };
  return { status: "error", error_type: "unexpected_error", message: String(error) };
}

function objectPayload(raw: string): Record<string, unknown> {
  const value: unknown = raw.trim() ? JSON.parse(raw) : {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("guard stdin payload must be a JSON object");
  }
  return value as Record<string, unknown>;
}

function assertOnlyKeys(payload: Record<string, unknown>, allowed: readonly string[]): void {
  const unknown = Object.keys(payload).find((key) => !allowed.includes(key));
  if (unknown) throw new TypeError(`unexpected guard argument ${JSON.stringify(unknown)}`);
}

function required<T>(payload: Record<string, unknown>, key: string): T {
  if (!(key in payload)) throw new TypeError(`missing required guard argument ${JSON.stringify(key)}`);
  return payload[key] as T;
}

function optional<T>(payload: Record<string, unknown>, key: string, fallback: T): T {
  const value = payload[key];
  return value === undefined || value === null ? fallback : value as T;
}

async function dispatch(action: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  switch (action) {
    case "register":
      assertOnlyKeys(payload, ["resource_id", "graph", "edge_predicates", "initial", "terminal", "stakes", "workspace_root"]);
      return registerGuard(
        required<string>(payload, "resource_id"), required<Record<string, string[]>>(payload, "graph"),
        required<Record<string, Array<Record<string, unknown>>>>(payload, "edge_predicates"), required<string>(payload, "initial"),
        optional<string[]>(payload, "terminal", []), optional<Record<string, string>>(payload, "stakes", {}),
        optional<string | null>(payload, "workspace_root", null),
      );
    case "transition":
      assertOnlyKeys(payload, ["resource_id", "from_state", "to_state", "artifacts", "modified_files", "idempotency_key", "resolved_by"]);
      return guardTransition(required<string>(payload, "resource_id"), required<string>(payload, "from_state"), required<string>(payload, "to_state"), {
        artifacts: required<Record<string, string>>(payload, "artifacts"),
        modifiedFiles: optional<string[]>(payload, "modified_files", []),
        idempotencyKey: optional<string | null>(payload, "idempotency_key", null),
        resolvedBy: optional<string>(payload, "resolved_by", "agent"),
        ...(testJudge ? { judge: testJudge } : {}),
      });
    case "override":
      assertOnlyKeys(payload, ["resource_id", "from_state", "to_state", "override_token", "rationale", "resolved_by"]);
      return guardOverride(
        required<string>(payload, "resource_id"), required<string>(payload, "from_state"), required<string>(payload, "to_state"),
        required<string>(payload, "override_token"), required<string>(payload, "rationale"), optional<string>(payload, "resolved_by", "human"),
      );
    case "migrate":
      assertOnlyKeys(payload, ["resource_id", "new_graph", "new_edge_predicates", "override_token", "rationale", "new_terminal", "new_stakes"]);
      return guardMigrate(
        required<string>(payload, "resource_id"), required<Record<string, string[]>>(payload, "new_graph"),
        required<Record<string, Array<Record<string, unknown>>>>(payload, "new_edge_predicates"), required<string>(payload, "override_token"),
        required<string>(payload, "rationale"), optional<string[]>(payload, "new_terminal", []), optional<Record<string, string>>(payload, "new_stakes", {}),
      );
    case "upgrade":
      assertOnlyKeys(payload, ["resource_id", "new_graph", "new_edge_predicates", "rationale", "new_terminal", "new_stakes"]);
      return guardUpgrade(
        required<string>(payload, "resource_id"), required<Record<string, string[]>>(payload, "new_graph"),
        required<Record<string, Array<Record<string, unknown>>>>(payload, "new_edge_predicates"),
        required<string>(payload, "rationale"), optional<string[]>(payload, "new_terminal", []), optional<Record<string, string>>(payload, "new_stakes", {}),
      );
    // NO `apply-upgrade` action, deliberately. A CLI process inherits the
    // CALLER's environment, so a caller could point both descriptor variables
    // at a file it wrote itself and mint its own authorization — and the ledger
    // would stamp it `resolved_by: "human"`. The privileged apply exists only on
    // the MCP surface, inside the server that owns the pinned environment.
    // See docs/features/STRAT-GUARD-DESCRIPTOR/design.md, "Decision 6".
    case "descriptors": {
      // Operator-facing, deliberately NOT on the MCP surface: an agent has no
      // reason to enumerate what it may ask for, and the digest this prints is
      // what the operator pins into the server env.
      assertOnlyKeys(payload, []);
      return { status: "ok", ...inspectDescriptorFile() };
    }
    case "history":
      assertOnlyKeys(payload, ["resource_id"]);
      return guardHistory(required<string>(payload, "resource_id"));
    default:
      throw new Error(`unreachable guard action ${JSON.stringify(action)}`);
  }
}

export async function guardCommand(argv: string[]): Promise<number> {
  const action = argv[0];
  if (!action || !ACTIONS.has(action)) {
    process.stderr.write(`Unknown guard action: ${action ?? "(none)"}. Expected one of: ${[...ACTIONS].sort().join(", ")}.\n`);
    return 1;
  }
  try {
    writeJson(await dispatch(action, objectPayload(await readStdin())));
    return 0;
  } catch (error) {
    writeJson(errorEnvelope(error));
    return 1;
  }
}
