/** Guarded-transition orchestration with evaluation outside the resource lock. */

import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { canonicalJson } from "./canonical.js";
import {
  commandsAllowed,
  evaluateEvidence,
  parsePredicateStatement,
  type EvidencePredicate,
  type EvidenceResult,
} from "./evidence.js";
import {
  CommandExecutionDisabled,
  EvidenceParseError,
  GuardAlreadyRegistered,
  GuardEngineOwned,
  GuardNotFound,
  GuardTampered,
  IdempotencyConflict,
  IllegalEdge,
  InvalidStateName,
  InvalidWorkspaceRoot,
  OverrideUnavailable,
  ParanoidEdgeNeedsTrustedEvidence,
  StaleFromState,
} from "./errors.js";
import { guardChecksum } from "./fingerprint.js";
import {
  GuardRegistry,
  LedgerEntry,
  appendLedger,
  assertStillHeld,
  findByIdempotencyKey,
  isValidStateName,
  loadRegistry,
  loadRegistryRaw,
  persistRegistry,
  readEngineOwner,
  readLedger,
  resourceDir,
  resourceLock,
  writeTsOwnerMarker,
  type EdgePredicates,
  type GuardGraph,
} from "./store.js";
import { evaluateJudgedViaCodex } from "../judge/codex_judged.js";
import {
  evaluateJudged,
  type JudgedContext,
  type JudgedPredicate,
  type JudgedResult,
  type Stakes,
} from "../judge/judged.js";
import { judgeBackend } from "../mcp/server.js";

const TRUSTED_TYPE = "deterministic";
const LLM_TYPES = new Set(["verified", "judged"]);

type Predicate = Record<string, unknown> & { id?: unknown; type?: unknown; statement?: unknown };
type Verdict = Record<string, unknown>;
type TransitionStatus = "applied" | "refused";

export type GuardJudge = (predicate: JudgedPredicate, context: JudgedContext) => Promise<JudgedResult>;

type LockFunction = typeof resourceLock;
type FenceFunction = typeof assertStillHeld;
let acquireResourceLock: LockFunction = resourceLock;
let fenceResourceLock: FenceFunction = assertStillHeld;

/** Replace only the orchestration lock seams in isolated tests. */
export function setGuardLockingForTests(lock: LockFunction, fence: FenceFunction): () => void {
  const previousLock = acquireResourceLock;
  const previousFence = fenceResourceLock;
  acquireResourceLock = lock;
  fenceResourceLock = fence;
  return () => {
    acquireResourceLock = previousLock;
    fenceResourceLock = previousFence;
  };
}

export interface GuardTransitionOptions {
  artifacts?: Record<string, string>;
  modifiedFiles?: string[];
  idempotencyKey?: string | null;
  resolvedBy?: string;
  /** `undefined` selects the configured production backend; `null` means unavailable. */
  judge?: GuardJudge | null;
}

export function _ptype(predicate: Predicate): string {
  if (!Object.hasOwn(predicate, "type")) return TRUSTED_TYPE;
  return typeof predicate.type === "string" ? predicate.type : String(predicate.type);
}

export function _nowMs(): number {
  return Date.now();
}

export function _edgeKey(fromState: string, toState: string): string {
  return `${fromState}->${toState}`;
}

export function _payloadDigest(
  fromState: string,
  toState: string,
  artifacts: Record<string, string>,
  modifiedFiles: string[],
  resolvedBy: string,
): string {
  const canonical = canonicalJson({
    from_state: fromState,
    to_state: toState,
    artifacts,
    modified_files: [...modifiedFiles].sort(),
    resolved_by: resolvedBy,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function assertTsOwnedForMutation(resourceId: string): void {
  if (readEngineOwner(resourceId) === "ts") return;
  throw new GuardEngineOwned(
    `guard ${JSON.stringify(resourceId)} is not owned by the TypeScript engine; run the Python-side guard handoff first`,
  );
}

/**
 * TS-written verdicts deliberately normalize float telemetry to integers.
 * JavaScript cannot preserve Python's `0.0` shape, no guard consumer reads
 * these telemetry fields, and chain verification uses the C1 raw-line path.
 */
function normalizeVerdictForLedger(verdict: Verdict): Verdict {
  const active = new WeakSet<object>();
  const normalize = (value: unknown): unknown => {
    if (value === null || typeof value === "string" || typeof value === "boolean") return value;
    if (typeof value === "number") {
      if (!Number.isFinite(value)) return 0;
      // Round deterministically, then clamp so canonicalJson always receives a safe integer.
      return Math.max(Number.MIN_SAFE_INTEGER, Math.min(Number.MAX_SAFE_INTEGER, Math.round(value)));
    }
    if (typeof value !== "object") return null;
    if (active.has(value)) return null;
    active.add(value);
    try {
      // Array.from also fills sparse holes with normalized nulls.
      if (Array.isArray(value)) return Array.from(value, normalize);
      return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, normalize(item)]));
    } finally {
      active.delete(value);
    }
  };
  return normalize(verdict) as Verdict;
}

function baseVerdict(met: boolean, summary: string, stakes: string, predicates: Verdict[], meta: Verdict): Verdict {
  return {
    clean: met,
    summary,
    findings: [],
    meta,
    consensus: [],
    claude_only: [],
    codex_only: [],
    lenses_run: [],
    auto_fixes: [],
    asks: [],
    judge_version: "1.0",
    met,
    stakes,
    predicates,
    tier_disagreements: [],
    budget_consumed: { dollars: 0, turns: 0, wall_clock_s: 0 },
    judge_kernel_meta: { decomposer_mode: "user", degraded_judged: false, smartmemory_priors_consulted: 0 },
  };
}

function evidencePredicates(evidence: EvidenceResult): Verdict[] {
  return evidence.perPredicate.map((predicate, index) => ({
    id: String(predicate.id || `e${index}`),
    type: TRUSTED_TYPE,
    statement: predicate.statement,
    verdict: predicate.met ? "met" : "not_met",
    confidence: 10,
    applied_gate: 0,
    evidence: [],
    tier_history: [],
    t3: null,
  }));
}

function serializableEvidence(evidence: EvidenceResult): Verdict[] {
  return evidence.perPredicate.map((predicate) => ({
    id: predicate.id ?? null,
    statement: predicate.statement,
    met: predicate.met,
    evidence: predicate.evidence,
  }));
}

export function _evidenceToVerdictDict(evidence: EvidenceResult, stakes: string, summary: string): Verdict {
  return baseVerdict(evidence.met, summary, stakes, evidencePredicates(evidence), {
    agent_type: "guard",
    source: "evidence",
    guard_evidence: serializableEvidence(evidence),
  });
}

type JudgeAggregate = {
  met: boolean;
  summary: string;
  predicates: Verdict[];
  findings: Verdict[];
  meta: Verdict;
  dollars: number;
  turns: number;
};

export function _mergeVerdict(evidence: EvidenceResult, judgeResult: JudgeAggregate, stakes: string): [boolean, Verdict] {
  const combined = evidence.met && judgeResult.met;
  const verdict = baseVerdict(
    combined,
    judgeResult.summary || "guard transition verdict",
    stakes,
    [...evidencePredicates(evidence), ...judgeResult.predicates],
    { ...judgeResult.meta, agent_type: "guard", guard_evidence: serializableEvidence(evidence) },
  );
  verdict.findings = judgeResult.findings;
  verdict.budget_consumed = { dollars: judgeResult.dollars, turns: judgeResult.turns, wall_clock_s: 0 };
  return [combined, verdict];
}

export function* _allEdgePredicates(edgePredicates: EdgePredicates): Generator<[string, Predicate]> {
  for (const [edge, predicates] of Object.entries(edgePredicates)) {
    for (const predicate of predicates) yield [edge, predicate as Predicate];
  }
}

export function _validatePolicy(
  graph: GuardGraph,
  edgePredicates: EdgePredicates,
  initial: string,
  terminal: string[],
  stakes: Record<string, string>,
  workspaceRoot: string | null,
): void {
  const names = new Set([...Object.keys(graph), ...terminal, initial]);
  for (const targets of Object.values(graph)) for (const target of targets) names.add(target);
  for (const name of names) {
    if (!isValidStateName(name)) {
      throw new InvalidStateName(`invalid state name ${JSON.stringify(name)} (allowed: [A-Za-z0-9_.-])`);
    }
  }
  if (!Object.hasOwn(graph, initial) && !terminal.includes(initial)) {
    throw new InvalidStateName(`initial state ${JSON.stringify(initial)} is not a node in the graph`);
  }

  let needsWorkspace = false;
  let usesCommand = false;
  for (const [, predicate] of _allEdgePredicates(edgePredicates)) {
    const type = _ptype(predicate);
    const statement = typeof predicate.statement === "string" ? predicate.statement : "";
    if (LLM_TYPES.has(type)) continue;
    if (type !== TRUSTED_TYPE) {
      throw new EvidenceParseError(`unknown predicate type ${JSON.stringify(type)} (expected deterministic|verified|judged)`);
    }
    const parsed = parsePredicateStatement(statement);
    if (parsed.name === "command_exit_zero") usesCommand = true;
    if (["server_file_exists", "git_commit_exists", "command_exit_zero"].includes(parsed.name)) needsWorkspace = true;
  }

  if (usesCommand && !commandsAllowed()) {
    throw new CommandExecutionDisabled(
      "guard declares command_exit_zero predicates; set STRATUM_GUARD_ALLOW_COMMANDS=1 to register",
    );
  }
  if (needsWorkspace && !workspaceRoot) {
    throw new InvalidWorkspaceRoot("guard declares file/git/command evidence but no workspace_root given");
  }
  if (workspaceRoot) {
    let isDirectory = false;
    try {
      isDirectory = existsSync(workspaceRoot) && statSync(workspaceRoot).isDirectory();
    } catch {
      isDirectory = false;
    }
    if (!isAbsolute(workspaceRoot) || !isDirectory) {
      throw new InvalidWorkspaceRoot(`workspace_root must be an existing absolute directory: ${JSON.stringify(workspaceRoot)}`);
    }
  }
  for (const [edge, predicates] of Object.entries(edgePredicates)) {
    if (stakes[edge] === "paranoid" && !predicates.some((predicate) => _ptype(predicate as Predicate) === TRUSTED_TYPE)) {
      throw new ParanoidEdgeNeedsTrustedEvidence(`paranoid edge ${JSON.stringify(edge)} has no trusted-evidence predicate`);
    }
  }
}

export async function registerGuard(
  resourceId: string,
  graph: GuardGraph,
  edgePredicates: EdgePredicates,
  initial: string,
  terminal: string[] = [],
  stakes: Record<string, string> = {},
  workspaceRoot: string | null = null,
): Promise<{ guard_id: string; checksum: string; status: "registered" | "exists" }> {
  _validatePolicy(graph, edgePredicates, initial, terminal, stakes, workspaceRoot);
  const checksum = guardChecksum(graph, edgePredicates, terminal, stakes);
  const resourceDirectoryExisted = existsSync(resourceDir(resourceId));

  const status = await acquireResourceLock(resourceId, async ({ token }) => {
    const owner = readEngineOwner(resourceId);
    if (owner !== "ts") {
      if (resourceDirectoryExisted || owner !== null) assertTsOwnedForMutation(resourceId);
      writeTsOwnerMarker(resourceId);
    }
    const existing = loadRegistryRaw(resourceId);
    if (existing !== null) {
      if (existing.checksum === checksum) return "exists" as const;
      throw new GuardAlreadyRegistered(
        `guard ${JSON.stringify(resourceId)} already registered with a different policy; use migrate`,
      );
    }
    const registry = new GuardRegistry({
      resource_id: resourceId,
      graph,
      edge_predicates: edgePredicates,
      initial,
      terminal,
      stakes,
      checksum,
      graph_version: 1,
      workspace_root: workspaceRoot,
      current_state: initial,
    });
    await fenceResourceLock(resourceId, token);
    persistRegistry(registry);
    return "registered" as const;
  });
  return { guard_id: resourceId, checksum, status };
}

export function _maybeReplay(
  registry: GuardRegistry,
  idempotencyKey: string | null | undefined,
  payloadDigest: string,
): { status: "replayed"; verdict: Verdict; ledger_ref: string; current_state: string } | null {
  if (!idempotencyKey) return null;
  const prior = findByIdempotencyKey(registry.resource_id, idempotencyKey);
  if (prior === null) return null;
  if (prior.payload_digest !== payloadDigest) {
    throw new IdempotencyConflict(`idempotency_key ${JSON.stringify(idempotencyKey)} reused with a different payload`);
  }
  const verdict = prior.verdict ?? _evidenceToVerdictDict(
    { met: prior.outcome === "applied", perPredicate: [] },
    registry.stakes[_edgeKey(prior.from_state, prior.to_state)] ?? "default",
    "replayed idempotent transition",
  );
  return { status: "replayed", verdict, ledger_ref: prior.entry_digest, current_state: registry.current_state };
}

function defaultJudge(): GuardJudge {
  return judgeBackend() === "openai"
    ? (predicate, context) => evaluateJudged(predicate, context)
    : (predicate, context) => evaluateJudgedViaCodex(predicate, context);
}

async function evaluateLlmPredicates(
  predicates: Predicate[],
  stakes: string,
  judge: GuardJudge,
  context: JudgedContext,
): Promise<JudgeAggregate> {
  const results: Array<{ predicate: Predicate; result: JudgedResult }> = [];
  for (const predicate of predicates) {
    const statement = typeof predicate.statement === "string" ? predicate.statement : "";
    const result = await judge({ statement, stakes: stakes as Stakes }, context);
    results.push({ predicate, result });
  }
  return {
    met: results.every(({ result }) => result.holds),
    summary: results.map(({ result }) => result.reason).filter(Boolean).join("; ") || "guard transition verdict",
    predicates: results.map(({ predicate, result }, index) => ({
      id: String(predicate.id || `j${index}`),
      type: _ptype(predicate),
      statement: typeof predicate.statement === "string" ? predicate.statement : "",
      verdict: result.holds ? "met" : "not_met",
      confidence: result.holds ? 10 : 0,
      applied_gate: 0,
      evidence: [],
      tier_history: [],
      t3: null,
    })),
    findings: [],
    meta: {
      source: "judge",
      judge_results: results.map(({ result }) => ({
        holds: result.holds,
        reason: result.reason,
        stakes: result.stakes,
        model: result.model,
        usage: { tokens: result.usage.tokens ?? 0 },
      })),
    },
    // Guard canonical JSON intentionally rejects floats. The TS judge's USD
    // estimate remains operational telemetry rather than ledger material.
    dollars: 0,
    turns: results.length,
  };
}

export async function guardTransition(
  resourceId: string,
  fromState: string,
  toState: string,
  options: GuardTransitionOptions = {},
): Promise<{ status: TransitionStatus | "replayed"; verdict: Verdict; ledger_ref: string; current_state: string }> {
  const artifacts = options.artifacts ?? {};
  const modifiedFiles = options.modifiedFiles ?? [];
  const idempotencyKey = options.idempotencyKey ?? null;
  const resolvedBy = options.resolvedBy ?? "agent";
  const payloadDigest = _payloadDigest(fromState, toState, artifacts, modifiedFiles, resolvedBy);

  // Phase 1: cheap structural checks while holding the resource lock.
  const snapshot = await acquireResourceLock(resourceId, () => {
    assertTsOwnedForMutation(resourceId);
    const registry = loadRegistry(resourceId); // may throw LedgerCorrupt
    if (registry === null) throw new GuardNotFound(`no guard registered for ${JSON.stringify(resourceId)}`);
    if (guardChecksum(registry.graph, registry.edge_predicates, registry.terminal, registry.stakes) !== registry.checksum) {
      throw new GuardTampered(`guard ${JSON.stringify(resourceId)} policy checksum mismatch`);
    }
    const replay = _maybeReplay(registry, idempotencyKey, payloadDigest);
    if (replay !== null) return { replay } as const;
    if (fromState !== registry.current_state) {
      throw new StaleFromState(`from_state ${JSON.stringify(fromState)} != current_state ${JSON.stringify(registry.current_state)}`);
    }
    if (!(registry.graph[fromState] ?? []).includes(toState)) {
      throw new IllegalEdge(`${_edgeKey(fromState, toState)} is not a legal edge`);
    }
    const edge = _edgeKey(fromState, toState);
    return {
      replay: null,
      edge,
      predicates: [...(registry.edge_predicates[edge] ?? [])] as Predicate[],
      stakes: registry.stakes[edge] ?? "default",
      workspaceRoot: registry.workspace_root,
      ledgerEntries: readLedger(resourceId),
    } as const;
  });
  if (snapshot.replay !== null) return snapshot.replay;

  // Phase 2: evidence and judge evaluation deliberately run outside the lock.
  const trusted = snapshot.predicates.filter((predicate) => _ptype(predicate) === TRUSTED_TYPE);
  const llm = snapshot.predicates.filter((predicate) => LLM_TYPES.has(_ptype(predicate)));
  const evidence = await evaluateEvidence(trusted as EvidencePredicate[], snapshot.workspaceRoot, snapshot.ledgerEntries);

  let combinedMet: boolean;
  let verdict: Verdict;
  if (llm.length === 0) {
    combinedMet = evidence.met;
    verdict = _evidenceToVerdictDict(evidence, snapshot.stakes, "guard transition verdict");
  } else if (options.judge === null) {
    combinedMet = false;
    verdict = _evidenceToVerdictDict(
      { met: false, perPredicate: evidence.perPredicate },
      snapshot.stakes,
      "LLM-tier predicates present but no verifier available",
    );
  } else {
    const judged = await evaluateLlmPredicates(llm, snapshot.stakes, options.judge ?? defaultJudge(), {
      result: { resource_id: resourceId, edge: snapshot.edge, artifacts, modified_files: modifiedFiles },
    });
    [combinedMet, verdict] = _mergeVerdict(evidence, judged, snapshot.stakes);
  }
  verdict = normalizeVerdictForLedger(verdict);

  // Phase 3: optimistic commit under a newly-acquired lock.
  return acquireResourceLock(resourceId, async ({ token }) => {
    assertTsOwnedForMutation(resourceId);
    const registry = loadRegistry(resourceId);
    if (registry === null) throw new GuardNotFound(`no guard registered for ${JSON.stringify(resourceId)}`);
    const replay = _maybeReplay(registry, idempotencyKey, payloadDigest);
    if (replay !== null) return replay;
    if (registry.current_state !== fromState) {
      throw new StaleFromState(`current_state advanced to ${JSON.stringify(registry.current_state)} during evaluation`);
    }
    if (guardChecksum(registry.graph, registry.edge_predicates, registry.terminal, registry.stakes) !== registry.checksum) {
      throw new GuardTampered(`guard ${JSON.stringify(resourceId)} policy checksum mismatch during commit`);
    }
    if (!(registry.graph[fromState] ?? []).includes(toState)) {
      // Python has the same latent eval-outside-lock race; Slice E should add this re-check there too.
      throw new IllegalEdge(`${_edgeKey(fromState, toState)} is no longer a legal edge after evaluation`);
    }
    const outcome: TransitionStatus = combinedMet ? "applied" : "refused";
    const entry = new LedgerEntry({
      ts_ms: _nowMs(),
      from_state: fromState,
      to_state: toState,
      outcome,
      kind: "transition",
      resolved_by: resolvedBy,
      idempotency_key: idempotencyKey,
      payload_digest: payloadDigest,
      verdict,
    });
    await fenceResourceLock(resourceId, token);
    const ledgerRef = appendLedger(resourceId, entry);
    if (combinedMet) {
      registry.current_state = toState;
      persistRegistry(registry);
    }
    return { status: outcome, verdict, ledger_ref: ledgerRef, current_state: registry.current_state };
  });
}

export function _checkOverrideToken(token: string): void {
  const expected = process.env.STRATUM_GUARD_OVERRIDE_TOKEN;
  if (!expected) {
    throw new OverrideUnavailable("override unavailable: STRATUM_GUARD_OVERRIDE_TOKEN not set in server env");
  }
  if (token !== expected) throw new OverrideUnavailable("override token mismatch");
}

export async function guardOverride(
  resourceId: string,
  fromState: string,
  toState: string,
  overrideToken: string,
  rationale: string,
  resolvedBy = "human",
): Promise<{ status: "deviation"; ledger_ref: string; current_state: string; rationale: string }> {
  _checkOverrideToken(overrideToken);
  if (resolvedBy !== "human") throw new OverrideUnavailable("override requires resolved_by='human'");
  if (!rationale || !rationale.trim()) throw new OverrideUnavailable("override requires a non-empty rationale");

  return acquireResourceLock(resourceId, async ({ token }) => {
    assertTsOwnedForMutation(resourceId);
    const registry = loadRegistry(resourceId);
    if (registry === null) throw new GuardNotFound(`no guard registered for ${JSON.stringify(resourceId)}`);
    if (fromState !== registry.current_state) {
      throw new StaleFromState(`from_state ${JSON.stringify(fromState)} != current_state ${JSON.stringify(registry.current_state)}`);
    }
    if (!(registry.graph[fromState] ?? []).includes(toState)) {
      throw new IllegalEdge(`${_edgeKey(fromState, toState)} is not a legal edge (override bypasses predicates, not the graph)`);
    }
    const entry = new LedgerEntry({
      ts_ms: _nowMs(),
      from_state: fromState,
      to_state: toState,
      outcome: "deviation",
      kind: "deviation",
      resolved_by: resolvedBy,
      rationale,
    });
    await fenceResourceLock(resourceId, token);
    const ledgerRef = appendLedger(resourceId, entry);
    registry.current_state = toState;
    persistRegistry(registry);
    return { status: "deviation", ledger_ref: ledgerRef, current_state: registry.current_state, rationale };
  });
}

export async function guardMigrate(
  resourceId: string,
  newGraph: GuardGraph,
  newEdgePredicates: EdgePredicates,
  overrideToken: string,
  rationale: string,
  newTerminal: string[] = [],
  newStakes: Record<string, string> = {},
): Promise<{ status: "migrated"; checksum: string; graph_version: number; ledger_ref: string; rationale: string }> {
  _checkOverrideToken(overrideToken);
  if (!rationale || !rationale.trim()) throw new OverrideUnavailable("migrate requires a non-empty rationale");

  return acquireResourceLock(resourceId, async ({ token }) => {
    assertTsOwnedForMutation(resourceId);
    const registry = loadRegistry(resourceId);
    if (registry === null) throw new GuardNotFound(`no guard registered for ${JSON.stringify(resourceId)}`);
    _validatePolicy(
      newGraph,
      newEdgePredicates,
      registry.initial,
      newTerminal,
      newStakes,
      registry.workspace_root,
    );
    if (!Object.hasOwn(newGraph, registry.current_state) && !newTerminal.includes(registry.current_state)) {
      throw new InvalidStateName(`current_state ${JSON.stringify(registry.current_state)} is not a node in the new graph`);
    }
    const checksum = guardChecksum(newGraph, newEdgePredicates, newTerminal, newStakes);
    const graphVersion = registry.graph_version + 1;
    const entry = new LedgerEntry({
      ts_ms: _nowMs(),
      from_state: registry.current_state,
      to_state: registry.current_state,
      outcome: "graph_version",
      kind: "graph_version",
      resolved_by: "human",
      rationale,
    });
    await fenceResourceLock(resourceId, token);
    const ledgerRef = appendLedger(resourceId, entry);
    registry.graph = newGraph;
    registry.edge_predicates = newEdgePredicates;
    registry.terminal = newTerminal;
    registry.stakes = newStakes;
    registry.checksum = checksum;
    registry.graph_version = graphVersion;
    persistRegistry(registry);
    return { status: "migrated", checksum, graph_version: graphVersion, ledger_ref: ledgerRef, rationale };
  });
}

export function guardHistory(resourceId: string): {
  resource_id: string;
  current_state: string;
  graph_version: number;
  ledger: Array<ReturnType<LedgerEntry["toDict"]>>;
} {
  const registry = loadRegistry(resourceId);
  if (registry === null) throw new GuardNotFound(`no guard registered for ${JSON.stringify(resourceId)}`);
  return {
    resource_id: resourceId,
    current_state: registry.current_state,
    graph_version: registry.graph_version,
    ledger: readLedger(resourceId).map((entry) => entry.toDict()),
  };
}
