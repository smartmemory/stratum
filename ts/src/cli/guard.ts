/** CLI boundary for the guarded state-machine API. */

import { AUTHORIZATION_NAMESPACES, authorizationPayload, type AuthorizationKind } from "../guard/authorization.js";
import { inspectDescriptorFile } from "../guard/descriptors.js";
import { GuardError, GuardNotFound, GuardTampered } from "../guard/errors.js";
import { guardChecksum } from "../guard/fingerprint.js";
import { loadRegistry } from "../guard/store.js";
import {
  _ledgerHead,
  guardHistory,
  guardMigrate,
  guardOverride,
  guardApplyUpgrade,
  guardTransition,
  guardUpgrade,
  payloadDigestForVersion,
  registerGuard,
  type GuardJudge,
} from "../guard/transition.js";

const ACTIONS = new Set(["register", "transition", "override", "migrate", "upgrade", "apply-upgrade", "authorize", "descriptors", "history", "policy", "digest"]);

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

function requiredStringRecord(payload: Record<string, unknown>, key: string): Record<string, string> {
  const value = required<unknown>(payload, key);
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.values(value).some((entry) => typeof entry !== "string")) {
    throw new TypeError(`guard argument ${JSON.stringify(key)} must be a record of strings`);
  }
  return value as Record<string, string>;
}

function optionalStringArray(payload: Record<string, unknown>, key: string, fallback: string[]): string[] {
  const value = optional<unknown>(payload, key, fallback);
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new TypeError(`guard argument ${JSON.stringify(key)} must be an array of strings`);
  }
  return value;
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
      assertOnlyKeys(payload, ["resource_id", "from_state", "to_state", "authorization", "rationale", "resolved_by"]);
      return guardOverride(
        required<string>(payload, "resource_id"), required<string>(payload, "from_state"), required<string>(payload, "to_state"),
        required<string>(payload, "authorization"), required<string>(payload, "rationale"), optional<string>(payload, "resolved_by", "human"),
      );
    case "migrate":
      assertOnlyKeys(payload, ["resource_id", "new_graph", "new_edge_predicates", "authorization", "rationale", "new_terminal", "new_stakes"]);
      return guardMigrate(
        required<string>(payload, "resource_id"), required<Record<string, string[]>>(payload, "new_graph"),
        required<Record<string, Array<Record<string, unknown>>>>(payload, "new_edge_predicates"), required<string>(payload, "authorization"),
        required<string>(payload, "rationale"), optional<string[]>(payload, "new_terminal", []), optional<Record<string, string>>(payload, "new_stakes", {}),
      );
    case "upgrade":
      assertOnlyKeys(payload, ["resource_id", "new_graph", "new_edge_predicates", "rationale", "new_terminal", "new_stakes"]);
      return guardUpgrade(
        required<string>(payload, "resource_id"), required<Record<string, string[]>>(payload, "new_graph"),
        required<Record<string, Array<Record<string, unknown>>>>(payload, "new_edge_predicates"),
        required<string>(payload, "rationale"), optional<string[]>(payload, "new_terminal", []), optional<Record<string, string>>(payload, "new_stakes", {}),
      );
    // Descriptor location is caller-controlled, but authorization is a signed
    // artifact verified against the in-source trust root. See Decision 6.
    case "apply-upgrade":
      assertOnlyKeys(payload, ["resource_id", "descriptor_id"]);
      return guardApplyUpgrade(required<string>(payload, "resource_id"), required<string>(payload, "descriptor_id"));
    case "authorize": {
      // Prints the exact bytes to sign for an override or migrate. Grants
      // nothing: it reads the resource's ledger head, which is not a secret, and
      // produces a payload that is worthless without the operator's signature.
      assertOnlyKeys(payload, ["kind", "resource_id", "from_state", "to_state", "rationale", "new_graph", "new_edge_predicates", "new_terminal", "new_stakes"]);
      const kind = required<AuthorizationKind>(payload, "kind");
      if (kind !== "override" && kind !== "migrate") throw new TypeError('guard authorize kind must be "override" or "migrate"');
      const resourceId = required<string>(payload, "resource_id");
      const rationale = required<string>(payload, "rationale");
      const ledgerHead = _ledgerHead(resourceId);
      const fields = kind === "override"
        ? {
          resource_id: resourceId,
          from_state: required<string>(payload, "from_state"),
          to_state: required<string>(payload, "to_state"),
          rationale,
          ledger_head: ledgerHead,
        }
        : {
          resource_id: resourceId,
          policy_checksum: guardChecksum(
            required<Record<string, string[]>>(payload, "new_graph"),
            required<Record<string, Array<Record<string, unknown>>>>(payload, "new_edge_predicates"),
            optional<string[]>(payload, "new_terminal", []),
            optional<Record<string, string>>(payload, "new_stakes", {}),
          ),
          rationale,
          ledger_head: ledgerHead,
        };
      const body = authorizationPayload(kind, fields);
      return {
        status: "ok",
        namespace: AUTHORIZATION_NAMESPACES[kind],
        payload: body,
        instructions: [
          `printf '%s' ${JSON.stringify(body)} > /tmp/guard-authz`,
          `ssh-keygen -Y sign -f <your signing key> -n ${AUTHORIZATION_NAMESPACES[kind]} /tmp/guard-authz`,
          "pass the contents of /tmp/guard-authz.sig as the \"authorization\" argument",
        ],
        note: "valid only while this resource's ledger head is unchanged — re-run this after any further transition",
      };
    }
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
    case "policy": {
      assertOnlyKeys(payload, ["resource_id"]);
      const resourceId = required<string>(payload, "resource_id");
      const registry = loadRegistry(resourceId);
      if (registry === null) throw new GuardNotFound(`no guard registered for ${JSON.stringify(resourceId)}`);
      if (guardChecksum(registry.graph, registry.edge_predicates, registry.terminal, registry.stakes) !== registry.checksum) {
        throw new GuardTampered(`guard ${JSON.stringify(resourceId)} policy checksum mismatch`);
      }
      return {
        status: "ok",
        resource_id: resourceId,
        checksum: registry.checksum,
        graph: registry.graph,
        edge_predicates: registry.edge_predicates,
        terminal: registry.terminal,
        stakes: registry.stakes,
        initial: registry.initial,
        graph_version: registry.graph_version,
        current_state: registry.current_state,
      };
    }
    case "digest": {
      // Grants nothing, reads no state: it only canonicalizes caller-provided envelope material.
      assertOnlyKeys(payload, ["from_state", "to_state", "artifacts", "modified_files", "resolved_by", "policy_checksum"]);
      const policyChecksum = required<string>(payload, "policy_checksum");
      if (!/^[0-9a-f]{64}$/.test(policyChecksum)) {
        throw new TypeError('guard argument "policy_checksum" must be 64 lowercase hexadecimal characters');
      }
      return {
        status: "ok",
        payload_digest: payloadDigestForVersion(
          required<string>(payload, "from_state"),
          required<string>(payload, "to_state"),
          requiredStringRecord(payload, "artifacts"),
          optionalStringArray(payload, "modified_files", []),
          optional<string>(payload, "resolved_by", "agent"),
          policyChecksum,
          2,
        ),
        payload_digest_version: 2,
      };
    }
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
