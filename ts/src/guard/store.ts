/** Guard registry and tamper-evident ledger persistence. */

import { createHash, randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { canonicalJson } from "./canonical.js";
import { LedgerCorrupt, ResourceIdMismatch } from "./errors.js";

export type GuardGraph = Record<string, string[]>;
export type EdgePredicates = Record<string, Array<Record<string, unknown>>>;

export type GuardRegistryFields = {
  resource_id: string;
  graph: GuardGraph;
  edge_predicates: EdgePredicates;
  initial: string;
  terminal?: string[];
  stakes?: Record<string, string>;
  checksum?: string;
  graph_version?: number;
  workspace_root?: string | null;
  current_state?: string;
};

export type LedgerEntryFields = {
  ts_ms: number;
  from_state: string;
  to_state: string;
  outcome: string;
  kind: string;
  resolved_by?: string;
  idempotency_key?: string | null;
  payload_digest?: string | null;
  rationale?: string | null;
  verdict?: Record<string, unknown> | null;
  prev_digest?: string;
  entry_digest?: string;
};

export type LedgerEntryCore = Omit<Required<LedgerEntryFields>, "entry_digest">;

// Module-global and read at call time, matching Python's monkeypatchable GUARDS_DIR.
export let GUARDS_DIR = join(homedir(), ".stratum", "guards");

export function setGuardsDir(path: string): void {
  GUARDS_DIR = path;
}

export function resourceHash(resourceId: string): string {
  return createHash("sha256").update(resourceId, "utf8").digest("hex").slice(0, 32);
}

function validateResourceId(resourceId: unknown): asserts resourceId is string {
  if (typeof resourceId !== "string" || resourceId.length === 0) {
    throw new TypeError("resource_id must be a non-empty string");
  }
  if (resourceId.includes("\0")) throw new TypeError("resource_id must not contain NUL");
  if (resourceId === "." || resourceId === "..") throw new TypeError("resource_id cannot be '.' or '..'");
}

export function resourceDir(resourceId: string): string {
  validateResourceId(resourceId);
  return join(GUARDS_DIR, resourceHash(resourceId));
}

const STATE_NAME_RE = /^[A-Za-z0-9_.-]+$/;

export function isValidStateName(name: unknown): name is string {
  return typeof name === "string" && STATE_NAME_RE.test(name);
}

function requiredField<T>(record: Record<string, unknown>, name: string): T {
  if (!Object.hasOwn(record, name)) throw new TypeError(`missing required field ${name}`);
  return record[name] as T;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("expected an object");
  }
  return value as Record<string, unknown>;
}

export class GuardRegistry {
  resource_id: string;
  graph: GuardGraph;
  edge_predicates: EdgePredicates;
  initial: string;
  terminal: string[];
  stakes: Record<string, string>;
  checksum: string;
  graph_version: number;
  workspace_root: string | null;
  current_state: string;

  constructor(fields: GuardRegistryFields) {
    this.resource_id = fields.resource_id;
    this.graph = fields.graph;
    this.edge_predicates = fields.edge_predicates;
    this.initial = fields.initial;
    this.terminal = fields.terminal ?? [];
    this.stakes = fields.stakes ?? {};
    this.checksum = fields.checksum ?? "";
    this.graph_version = fields.graph_version ?? 1;
    this.workspace_root = fields.workspace_root ?? null;
    this.current_state = fields.current_state ?? "";
  }

  toDict(): Required<GuardRegistryFields> {
    return {
      resource_id: this.resource_id,
      graph: this.graph,
      edge_predicates: this.edge_predicates,
      initial: this.initial,
      terminal: this.terminal,
      stakes: this.stakes,
      checksum: this.checksum,
      graph_version: this.graph_version,
      workspace_root: this.workspace_root,
      current_state: this.current_state,
    };
  }

  static fromDict(value: unknown): GuardRegistry {
    const record = asRecord(value);
    return new GuardRegistry({
      resource_id: requiredField<string>(record, "resource_id"),
      graph: requiredField<GuardGraph>(record, "graph"),
      edge_predicates: requiredField<EdgePredicates>(record, "edge_predicates"),
      initial: requiredField<string>(record, "initial"),
      ...(Object.hasOwn(record, "terminal") ? { terminal: record.terminal as string[] } : {}),
      ...(Object.hasOwn(record, "stakes") ? { stakes: record.stakes as Record<string, string> } : {}),
      ...(Object.hasOwn(record, "checksum") ? { checksum: record.checksum as string } : {}),
      ...(Object.hasOwn(record, "graph_version") ? { graph_version: record.graph_version as number } : {}),
      ...(Object.hasOwn(record, "workspace_root") ? { workspace_root: record.workspace_root as string | null } : {}),
      ...(Object.hasOwn(record, "current_state") ? { current_state: record.current_state as string } : {}),
    });
  }
}

export class LedgerEntry {
  ts_ms: number;
  from_state: string;
  to_state: string;
  outcome: string;
  kind: string;
  resolved_by: string;
  idempotency_key: string | null;
  payload_digest: string | null;
  rationale: string | null;
  verdict: Record<string, unknown> | null;
  prev_digest: string;
  entry_digest: string;

  constructor(fields: LedgerEntryFields) {
    this.ts_ms = fields.ts_ms;
    this.from_state = fields.from_state;
    this.to_state = fields.to_state;
    this.outcome = fields.outcome;
    this.kind = fields.kind;
    this.resolved_by = fields.resolved_by ?? "agent";
    this.idempotency_key = fields.idempotency_key ?? null;
    this.payload_digest = fields.payload_digest ?? null;
    this.rationale = fields.rationale ?? null;
    this.verdict = fields.verdict ?? null;
    this.prev_digest = fields.prev_digest ?? "";
    this.entry_digest = fields.entry_digest ?? "";
  }

  core(): LedgerEntryCore {
    const { entry_digest: _entryDigest, ...core } = this.toDict();
    return core;
  }

  toDict(): Required<LedgerEntryFields> {
    return {
      ts_ms: this.ts_ms,
      from_state: this.from_state,
      to_state: this.to_state,
      outcome: this.outcome,
      kind: this.kind,
      resolved_by: this.resolved_by,
      idempotency_key: this.idempotency_key,
      payload_digest: this.payload_digest,
      rationale: this.rationale,
      verdict: this.verdict,
      prev_digest: this.prev_digest,
      entry_digest: this.entry_digest,
    };
  }

  static fromDict(value: unknown): LedgerEntry {
    const record = asRecord(value);
    return new LedgerEntry({
      ts_ms: requiredField<number>(record, "ts_ms"),
      from_state: requiredField<string>(record, "from_state"),
      to_state: requiredField<string>(record, "to_state"),
      outcome: requiredField<string>(record, "outcome"),
      kind: requiredField<string>(record, "kind"),
      ...(Object.hasOwn(record, "resolved_by") ? { resolved_by: record.resolved_by as string } : {}),
      ...(Object.hasOwn(record, "idempotency_key") ? { idempotency_key: record.idempotency_key as string | null } : {}),
      ...(Object.hasOwn(record, "payload_digest") ? { payload_digest: record.payload_digest as string | null } : {}),
      ...(Object.hasOwn(record, "rationale") ? { rationale: record.rationale as string | null } : {}),
      ...(Object.hasOwn(record, "verdict") ? { verdict: record.verdict as Record<string, unknown> | null } : {}),
      ...(Object.hasOwn(record, "prev_digest") ? { prev_digest: record.prev_digest as string } : {}),
      ...(Object.hasOwn(record, "entry_digest") ? { entry_digest: record.entry_digest as string } : {}),
    });
  }
}

export function computeEntryDigest(entryCore: LedgerEntryCore | Record<string, unknown>, prevDigest: string): string {
  return createHash("sha256").update(canonicalJson(entryCore) + prevDigest, "utf8").digest("hex");
}

function prettyCanonicalJson(value: unknown): string {
  const compact = canonicalJson(value);
  let output = "";
  let indent = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < compact.length; index += 1) {
    const char = compact[index]!;
    if (inString) {
      output += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      output += char;
    } else if (char === "{" || char === "[") {
      output += char;
      if (compact[index + 1] !== (char === "{" ? "}" : "]")) {
        indent += 1;
        output += `\n${"  ".repeat(indent)}`;
      }
    } else if (char === "}" || char === "]") {
      if (compact[index - 1] !== (char === "}" ? "{" : "[")) {
        indent -= 1;
        output += `\n${"  ".repeat(indent)}`;
      }
      output += char;
    } else if (char === ",") {
      output += `,\n${"  ".repeat(indent)}`;
    } else if (char === ":") {
      output += ": ";
    } else {
      output += char;
    }
  }
  return output;
}

export function atomicWrite(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporaryPath = join(dirname(path), `.${randomUUID()}.tmp`);
  let descriptor: number | undefined;
  try {
    descriptor = openSync(temporaryPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    writeFileSync(descriptor, content, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, path);
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The temporary file may not have been created or may already be renamed.
    }
    throw error;
  }
}

export function registryExists(resourceId: string): boolean {
  return existsSync(join(resourceDir(resourceId), "registry.json"));
}

export function persistRegistry(registry: GuardRegistry): void {
  atomicWrite(join(resourceDir(registry.resource_id), "registry.json"), prettyCanonicalJson(registry.toDict()));
}

export function loadRegistryRaw(resourceId: string): GuardRegistry | null {
  const path = join(resourceDir(resourceId), "registry.json");
  if (!existsSync(path)) return null;
  let payload: unknown;
  try {
    payload = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  const registry = GuardRegistry.fromDict(payload);
  if (registry.resource_id !== resourceId) {
    throw new ResourceIdMismatch(
      `registry stores resource_id ${JSON.stringify(registry.resource_id)} but ${JSON.stringify(resourceId)} requested`,
    );
  }
  return registry;
}

function ledgerPath(resourceId: string): string {
  return join(resourceDir(resourceId), "ledger.jsonl");
}

const ENTRY_DIGEST_PREFIX_RE = /^\{"entry_digest":"([0-9a-f]{64})",/;

function splitLedgerLines(raw: string): string[] {
  // Python's splitlines() covers these three ledger line endings. Unicode line
  // separators are not expected in canonical JSONL ledger files.
  return raw.split(/\r\n|\r|\n/).filter((line) => line.trim().length > 0);
}

function digestFromRawLine(line: string, prevDigest: string): { expected: string; stored: string } | null {
  const match = ENTRY_DIGEST_PREFIX_RE.exec(line);
  if (match === null) return null;
  const coreCanonical = line.replace(ENTRY_DIGEST_PREFIX_RE, "{");
  const expected = createHash("sha256").update(coreCanonical + prevDigest, "utf8").digest("hex");
  return { expected, stored: match[1]! };
}

export function readLedger(resourceId: string): LedgerEntry[] {
  const path = ledgerPath(resourceId);
  if (!existsSync(path)) return [];
  const lines = splitLedgerLines(readFileSync(path, "utf8"));
  const entries: LedgerEntry[] = [];
  let prev = "";

  for (let index = 0; index < lines.length; index += 1) {
    const isLast = index === lines.length - 1;
    let entry: LedgerEntry;
    try {
      entry = LedgerEntry.fromDict(JSON.parse(lines[index]!));
    } catch {
      if (isLast) break;
      throw new LedgerCorrupt(`ledger line ${index} is not valid JSON (interior)`);
    }
    // JSON.parse collapses Python's 0.0 to 0, so parsed JS numbers cannot
    // reproduce Python's canonical bytes. Ledger lines are already canonical:
    // excising their alphabetically-first entry_digest preserves the exact core.
    const digest = digestFromRawLine(lines[index]!, prev);
    if (digest === null || digest.stored !== digest.expected || entry.prev_digest !== prev) {
      if (isLast) break;
      throw new LedgerCorrupt(`ledger chain broken at line ${index} (interior tampering)`);
    }
    entries.push(entry);
    prev = digest.stored;
  }
  return entries;
}

export function verifyChain(source: string | readonly string[]): boolean {
  // Unlike Python, JavaScript loses the float-vs-int spelling during JSON.parse.
  // Verification must therefore consume raw canonical lines, never parsed entries.
  const lines = typeof source === "string"
    ? splitLedgerLines(existsSync(source) ? readFileSync(source, "utf8") : source)
    : source.filter((line) => line.trim().length > 0);
  let prev = "";
  for (const line of lines) {
    let entry: LedgerEntry;
    try {
      entry = LedgerEntry.fromDict(JSON.parse(line));
    } catch {
      return false;
    }
    const digest = digestFromRawLine(line, prev);
    if (digest === null || entry.prev_digest !== prev || digest.stored !== digest.expected) return false;
    prev = digest.stored;
  }
  return true;
}

export function appendLedger(resourceId: string, entry: LedgerEntry): string {
  const entries = readLedger(resourceId);
  const prev = entries.at(-1)?.entry_digest ?? "";
  entry.prev_digest = prev;
  entry.entry_digest = computeEntryDigest(entry.core(), prev);

  const path = ledgerPath(resourceId);
  mkdirSync(dirname(path), { recursive: true });
  const line = `${canonicalJson(entry.toDict())}\n`;
  const descriptor = openSync(path, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND, 0o644);
  try {
    writeFileSync(descriptor, line, "utf8");
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  return entry.entry_digest;
}

export function findByIdempotencyKey(resourceId: string, key: string | null | undefined): LedgerEntry | null {
  if (!key) return null;
  const entries = readLedger(resourceId);
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.idempotency_key === key) return entry;
  }
  return null;
}

export function currentStateFromLedger(entries: LedgerEntry[], initial: string): string {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index]!;
    if (entry.outcome === "applied" || entry.outcome === "deviation") return entry.to_state;
  }
  return initial;
}

export function loadRegistry(resourceId: string): GuardRegistry | null {
  const registry = loadRegistryRaw(resourceId);
  if (registry === null) return null;
  registry.current_state = currentStateFromLedger(readLedger(resourceId), registry.initial);
  return registry;
}

// Slice D uses these through the guard store seam: resourceLock supplies the
// token and assertStillHeld fences the append immediately before it is written.
export {
  LockFenceError,
  LockTimeoutError,
  ProcessIdentityUnverifiableError,
  ResourceLockManager,
  assertStillHeld,
  processIdentity,
  resourceLock,
} from "./lock.js";
export type {
  ProcessIdentity,
  ProcessIdentityProvider,
  ResourceLockHandle,
  ResourceLockManagerOptions,
  ResourceLockOptions,
} from "./lock.js";
