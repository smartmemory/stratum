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
  IncompatiblePolicyUpgrade,
  InvalidStateName,
  InvalidWorkspaceRoot,
  OverrideUnavailable,
  ParanoidEdgeNeedsTrustedEvidence,
  StaleFromState,
  UpgradeDescriptorMismatch,
} from "./errors.js";
import { verifyAuthorization } from "./authorization.js";
import { findDescriptor, loadDescriptorFile } from "./descriptors.js";
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
import { guardEdgePredicatesFor, sourceFromPredicate, validateBundle } from "../policy/bundle.js";
import { buildGuardTransitionEvent } from "../policy/events.js";
import { emitPolicyEvent } from "../policy/smartmemory_client.js";
import type { PolicyBundle, RuleVerdict } from "../policy/types.js";

const TRUSTED_TYPE = "deterministic";
const RESERVED_STATE_NAMES = new Set(["__proto__", "constructor", "prototype"]);
const LLM_TYPES = new Set(["verified", "judged"]);

type Predicate = Record<string, unknown> & { id?: unknown; type?: unknown; statement?: unknown };
type Verdict = Record<string, unknown>;
type TransitionStatus = "applied" | "refused";

export type GuardJudge = (predicate: JudgedPredicate, context: JudgedContext) => Promise<JudgedResult>;

type LockFunction = typeof resourceLock;
type FenceFunction = typeof assertStillHeld;
let acquireResourceLock: LockFunction = resourceLock;
let fenceResourceLock: FenceFunction = assertStillHeld;
let warnedGuardRunIdFallback = false;
const legacyDigestMatchesLogged = new Set<string>();

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
  /** Flow correlation ID for policy events; resourceId remains the legacy fallback. */
  runId?: string;
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
  policyChecksum: string,
): string {
  return payloadDigestForVersion(fromState, toState, artifacts, modifiedFiles, resolvedBy, policyChecksum, 2);
}

/** Recompute persisted digest material according to the entry that owns it. */
export function payloadDigestForVersion(
  fromState: string,
  toState: string,
  artifacts: Record<string, string>,
  modifiedFiles: string[],
  resolvedBy: string,
  policyChecksum: string,
  digestVersion: 1 | 2,
): string {
  // The registry checksum covers graph, source-stamped edge predicates,
  // terminal states, and effective stakes. Signing it into every transition
  // payload makes the enforced policy replay-stable ledger material.
  const material: Record<string, unknown> = {
    from_state: fromState,
    to_state: toState,
    artifacts,
    modified_files: [...modifiedFiles].sort(),
    resolved_by: resolvedBy,
  };
  if (digestVersion === 2) material.policy_checksum = policyChecksum;
  const canonical = canonicalJson(material);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function noteLegacyDigestMatch(resourceId: string): void {
  if (legacyDigestMatchesLogged.has(resourceId)) return;
  legacyDigestMatchesLogged.add(resourceId);
  console.info(`guard ${resourceId}: matched legacy payload digest version 1`);
}

type PayloadDigests = Readonly<{ 1: string; 2: string }>;

function payloadDigests(
  fromState: string,
  toState: string,
  artifacts: Record<string, string>,
  modifiedFiles: string[],
  resolvedBy: string,
  policyChecksum: string,
): PayloadDigests {
  return {
    1: payloadDigestForVersion(fromState, toState, artifacts, modifiedFiles, resolvedBy, policyChecksum, 1),
    2: payloadDigestForVersion(fromState, toState, artifacts, modifiedFiles, resolvedBy, policyChecksum, 2),
  };
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
  evaluations: Array<{ predicate: Predicate; met: boolean }>;
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
  // Shape before names. The MCP contract types graph/terminal as "object" and
  // "array", so an adjacency value can arrive as a bare string — and a string
  // is iterable (its chars pass the name check) while
  // `String.prototype.includes` matches SUBSTRINGS, so a string adjacency
  // would make the edge-legality check accept states nobody declared.
  // Rejecting the shape here covers register, migrate and upgrade at once.
  if (!Array.isArray(terminal) || terminal.some((name) => typeof name !== "string")) {
    throw new InvalidStateName("terminal must be an array of state names");
  }
  // Duplicates would make `terminal` a multiset, so "frozen exactly" could not
  // be checked by set equality (`["shipped"]` vs `["shipped","shipped"]` is a
  // token-free change that set comparison waves through).
  if (new Set(terminal).size !== terminal.length) {
    throw new InvalidStateName("terminal must not contain duplicate state names");
  }
  for (const [state, targets] of Object.entries(graph)) {
    if (!Array.isArray(targets) || targets.some((target) => typeof target !== "string")) {
      throw new InvalidStateName(`graph[${JSON.stringify(state)}] must be an array of state names`);
    }
  }
  for (const [edge, predicates] of Object.entries(edgePredicates)) {
    if (!Array.isArray(predicates)
      || predicates.some((predicate) => typeof predicate !== "object" || predicate === null || Array.isArray(predicate))) {
      throw new EvidenceParseError(`edge_predicates[${JSON.stringify(edge)}] must be an array of predicate objects`);
    }
  }
  for (const [edge, stake] of Object.entries(stakes)) {
    if (typeof stake !== "string") throw new InvalidStateName(`stakes[${JSON.stringify(edge)}] must be a string`);
  }

  const names = new Set([...Object.keys(graph), ...terminal, initial]);
  for (const targets of Object.values(graph)) for (const target of targets) names.add(target);
  for (const name of names) {
    if (!isValidStateName(name)) {
      throw new InvalidStateName(`invalid state name ${JSON.stringify(name)} (allowed: [A-Za-z0-9_.-])`);
    }
    // `__proto__` and friends pass the character class but are not ordinary
    // object keys: a policy carrying one behaves differently depending on
    // whether it is read as an own property or through the prototype chain, and
    // a guard policy must mean exactly one thing. Same reservation the IR schema
    // applies to contract field names.
    if (RESERVED_STATE_NAMES.has(name)) {
      throw new InvalidStateName(`reserved state name ${JSON.stringify(name)}`);
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
    if (["server_file_exists", "server_file_contains", "git_commit_exists", "command_exit_zero"].includes(parsed.name)) needsWorkspace = true;
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
  policyBundle?: PolicyBundle,
): Promise<{ guard_id: string; checksum: string; status: "registered" | "exists" }> {
  const bundle = policyBundle === undefined ? undefined : validateBundle(policyBundle);
  let effectivePredicates = edgePredicates;
  const effectiveStakes = structuredClone(stakes);
  if (bundle !== undefined) {
    effectivePredicates = structuredClone(edgePredicates);
    for (const [fromState, targets] of Object.entries(graph)) {
      for (const toState of targets) effectivePredicates[`${fromState}->${toState}`] ??= [];
    }
    effectivePredicates = guardEdgePredicatesFor(bundle, resourceId, effectivePredicates, effectiveStakes);
  }
  _validatePolicy(graph, effectivePredicates, initial, terminal, effectiveStakes, workspaceRoot);
  const checksum = guardChecksum(graph, effectivePredicates, terminal, effectiveStakes);
  const resourceDirectoryExisted = existsSync(resourceDir(resourceId));

  const status = await acquireResourceLock(resourceId, async ({ token }) => {
    const owner = readEngineOwner(resourceId);
    if (owner !== "ts") {
      if (resourceDirectoryExisted || owner !== null) assertTsOwnedForMutation(resourceId);
      writeTsOwnerMarker(resourceId);
    }
    const existing = loadRegistryRaw(resourceId);
    if (existing !== null) {
      if (existing.checksum === checksum) {
        if (bundle !== undefined && existing.bundle_id !== bundle.bundle_id) {
          const previousBundleId = existing.bundle_id;
          existing.bundle_id = bundle.bundle_id;
          await fenceResourceLock(resourceId, token);
          persistRegistry(existing);
          console.info(`guard ${resourceId}: refreshed bundle_id from ${previousBundleId ?? "<unset>"} to ${bundle.bundle_id}`);
        }
        return "exists" as const;
      }
      throw new GuardAlreadyRegistered(
        `guard ${JSON.stringify(resourceId)} already registered with a different policy; use migrate`,
      );
    }
    const registry = new GuardRegistry({
      resource_id: resourceId,
      graph,
      edge_predicates: effectivePredicates,
      initial,
      terminal,
      stakes: effectiveStakes,
      checksum,
      graph_version: 1,
      workspace_root: workspaceRoot,
      current_state: initial,
      ...(bundle !== undefined ? { bundle_id: bundle.bundle_id } : {}),
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
  digests: PayloadDigests,
): { status: "replayed"; verdict: Verdict; ledger_ref: string; current_state: string; entry_digest: string; prev_digest: string; payload_digest: string } | null {
  if (!idempotencyKey) return null;
  const prior = findByIdempotencyKey(registry.resource_id, idempotencyKey);
  if (prior === null) return null;
  if (prior.payload_digest !== digests[prior.payload_digest_version]) {
    throw new IdempotencyConflict(`idempotency_key ${JSON.stringify(idempotencyKey)} reused with a different payload`);
  }
  if (prior.payload_digest_version === 1) noteLegacyDigestMatch(registry.resource_id);
  const verdict = prior.verdict ?? _evidenceToVerdictDict(
    { met: prior.outcome === "applied", perPredicate: [] },
    registry.stakes[_edgeKey(prior.from_state, prior.to_state)] ?? "default",
    "replayed idempotent transition",
  );
  return {
    status: "replayed",
    verdict,
    ledger_ref: prior.entry_digest,
    current_state: registry.current_state,
    entry_digest: prior.entry_digest,
    prev_digest: prior.prev_digest,
    payload_digest: prior.payload_digest ?? "",
  };
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
    evaluations: results.map(({ predicate, result }) => ({ predicate, met: result.holds })),
  };
}

export async function guardTransition(
  resourceId: string,
  fromState: string,
  toState: string,
  options: GuardTransitionOptions = {},
): Promise<{ status: TransitionStatus | "replayed"; verdict: Verdict; ledger_ref: string; current_state: string; entry_digest: string; prev_digest: string; payload_digest: string }> {
  const artifacts = options.artifacts ?? {};
  const modifiedFiles = options.modifiedFiles ?? [];
  const idempotencyKey = options.idempotencyKey ?? null;
  const resolvedBy = options.resolvedBy ?? "agent";
  if (resolvedBy !== "agent" && resolvedBy !== "human") {
    throw new EvidenceParseError(`resolved_by must be "agent" or "human", got ${JSON.stringify(resolvedBy)}`);
  }
  // Phase 1: cheap structural checks while holding the resource lock.
  const snapshot = await acquireResourceLock(resourceId, () => {
    assertTsOwnedForMutation(resourceId);
    const registry = loadRegistry(resourceId); // may throw LedgerCorrupt
    if (registry === null) throw new GuardNotFound(`no guard registered for ${JSON.stringify(resourceId)}`);
    if (guardChecksum(registry.graph, registry.edge_predicates, registry.terminal, registry.stakes) !== registry.checksum) {
      throw new GuardTampered(`guard ${JSON.stringify(resourceId)} policy checksum mismatch`);
    }
    const digests = payloadDigests(fromState, toState, artifacts, modifiedFiles, resolvedBy, registry.checksum);
    const replay = _maybeReplay(registry, idempotencyKey, digests);
    if (replay !== null) return { replay } as const;
    if (fromState !== registry.current_state) {
      throw new StaleFromState(`from_state ${JSON.stringify(fromState)} != current_state ${JSON.stringify(registry.current_state)}`);
    }
    if (!_declaresEdge(registry.graph, fromState, toState)) {
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
      payloadDigests: digests,
    } as const;
  });
  if (snapshot.replay !== null) return snapshot.replay;
  const digests = snapshot.payloadDigests;
  const payloadDigest = digests[2];

  // Phase 2: evidence and judge evaluation deliberately run outside the lock.
  const trusted = snapshot.predicates.filter((predicate) => _ptype(predicate) === TRUSTED_TYPE);
  const llm = snapshot.predicates.filter((predicate) => LLM_TYPES.has(_ptype(predicate)));
  const evidence = await evaluateEvidence(trusted as EvidencePredicate[], snapshot.workspaceRoot, snapshot.ledgerEntries);
  const predicateResults = new Map<Predicate, boolean>();
  trusted.forEach((predicate, index) => predicateResults.set(predicate, evidence.perPredicate[index]?.met ?? false));

  let combinedMet: boolean;
  let verdict: Verdict;
  if (llm.length === 0) {
    combinedMet = evidence.met;
    verdict = _evidenceToVerdictDict(evidence, snapshot.stakes, "guard transition verdict");
  } else if (options.judge === null) {
    combinedMet = false;
    for (const predicate of llm) predicateResults.set(predicate, false);
    verdict = _evidenceToVerdictDict(
      { met: false, perPredicate: evidence.perPredicate },
      snapshot.stakes,
      "LLM-tier predicates present but no verifier available",
    );
  } else {
    const judged = await evaluateLlmPredicates(llm, snapshot.stakes, options.judge ?? defaultJudge(), {
      result: { resource_id: resourceId, edge: snapshot.edge, artifacts, modified_files: modifiedFiles },
    });
    for (const evaluation of judged.evaluations) predicateResults.set(evaluation.predicate, evaluation.met);
    [combinedMet, verdict] = _mergeVerdict(evidence, judged, snapshot.stakes);
  }
  verdict = normalizeVerdictForLedger(verdict);
  const ruleVerdicts = ruleVerdictsFor(snapshot.predicates, predicateResults);

  // Phase 3: optimistic commit under a newly-acquired lock.
  return acquireResourceLock(resourceId, async ({ token }) => {
    assertTsOwnedForMutation(resourceId);
    const registry = loadRegistry(resourceId);
    if (registry === null) throw new GuardNotFound(`no guard registered for ${JSON.stringify(resourceId)}`);
    const replay = _maybeReplay(registry, idempotencyKey, digests);
    if (replay !== null) return replay;
    if (registry.current_state !== fromState) {
      throw new StaleFromState(`current_state advanced to ${JSON.stringify(registry.current_state)} during evaluation`);
    }
    if (guardChecksum(registry.graph, registry.edge_predicates, registry.terminal, registry.stakes) !== registry.checksum) {
      throw new GuardTampered(`guard ${JSON.stringify(resourceId)} policy checksum mismatch during commit`);
    }
    if (!_declaresEdge(registry.graph, fromState, toState)) {
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
    if (registry.bundle_id !== undefined) {
      firePolicyEvent(buildGuardTransitionEvent({
        runId: guardEventRunId(options.runId, resourceId),
        bundleId: registry.bundle_id,
        resourceId,
        entry,
        rulesEvaluated: ruleVerdicts,
      }));
    }
    return {
      status: outcome,
      verdict,
      ledger_ref: ledgerRef,
      current_state: registry.current_state,
      entry_digest: entry.entry_digest,
      prev_digest: entry.prev_digest,
      payload_digest: entry.payload_digest ?? "",
    };
  });
}

function ruleVerdictsFor(predicates: Predicate[], results: Map<Predicate, boolean>): RuleVerdict[] {
  const verdicts: RuleVerdict[] = [];
  for (const predicate of predicates) {
    const source = sourceFromPredicate(predicate);
    if (source === undefined) continue;
    const type = _ptype(predicate);
    verdicts.push({
      rule_id: typeof predicate.id === "string" ? predicate.id : source.record_id,
      source: structuredClone(source),
      met: results.get(predicate) ?? false,
      predicate_type: type === "judged" || type === "verified" ? type : "deterministic",
    });
  }
  return verdicts;
}

function firePolicyEvent(event: ReturnType<typeof buildGuardTransitionEvent>): void {
  void emitPolicyEvent(event).catch((error) => {
    console.warn(`policy event ${event.event_id} delivery failed: ${error instanceof Error ? error.message : String(error)}`);
  });
}

function guardEventRunId(runId: string | undefined, resourceId: string): string {
  if (runId !== undefined) return runId;
  if (!warnedGuardRunIdFallback) {
    warnedGuardRunIdFallback = true;
    console.warn("WARNING: guard events are using resource_id as run_id; pass run_id to preserve flow correlation");
  }
  return resourceId;
}

/**
 * The resource's current ledger head, or `""` for an untouched resource. Signed
 * into every one-shot authorization so it is valid at exactly one point in this
 * resource's history and cannot be replayed afterwards.
 */
export function _ledgerHead(resourceId: string): string {
  const ledger = readLedger(resourceId);
  return ledger.length === 0 ? "" : ledger[ledger.length - 1]!.entry_digest;
}

export async function guardOverride(
  resourceId: string,
  fromState: string,
  toState: string,
  authorization: string,
  rationale: string,
  resolvedBy = "human",
  userId?: string,
  runId?: string,
): Promise<{ status: "deviation"; ledger_ref: string; current_state: string; rationale: string; authorized_by: string; entry_digest: string; prev_digest: string; payload_digest: string }> {
  if (resolvedBy !== "human") throw new OverrideUnavailable("override requires resolved_by='human'");
  if (!rationale || !rationale.trim()) throw new OverrideUnavailable("override requires a non-empty rationale");

  return acquireResourceLock(resourceId, async ({ token }) => {
    assertTsOwnedForMutation(resourceId);
    const registry = loadRegistry(resourceId);
    if (registry === null) throw new GuardNotFound(`no guard registered for ${JSON.stringify(resourceId)}`);
    // Inside the lock: the ledger head must be the one this call will append to,
    // so a concurrent mutation invalidates the authorization rather than letting
    // it apply to a history the operator did not sign for.
    const authorizedBy = verifyAuthorization("override", {
      resource_id: resourceId,
      from_state: fromState,
      to_state: toState,
      rationale,
      ledger_head: _ledgerHead(resourceId),
    }, authorization);
    if (fromState !== registry.current_state) {
      throw new StaleFromState(`from_state ${JSON.stringify(fromState)} != current_state ${JSON.stringify(registry.current_state)}`);
    }
    if (!_declaresEdge(registry.graph, fromState, toState)) {
      throw new IllegalEdge(`${_edgeKey(fromState, toState)} is not a legal edge (override bypasses predicates, not the graph)`);
    }
    const entry = new LedgerEntry({
      ts_ms: _nowMs(),
      from_state: fromState,
      to_state: toState,
      outcome: "deviation",
      kind: "deviation",
      resolved_by: resolvedBy,
      payload_digest: _payloadDigest(fromState, toState, {}, [], resolvedBy, registry.checksum),
      rationale: `authorized by ${authorizedBy.principal} (${authorizedBy.fingerprint}): ${rationale}`,
    });
    await fenceResourceLock(resourceId, token);
    const ledgerRef = appendLedger(resourceId, entry);
    registry.current_state = toState;
    persistRegistry(registry);
    if (registry.bundle_id !== undefined) {
      if (userId === undefined) {
        console.warn("WARNING: guard deviation has no user_id; SmartMemory will reject the enforcement event");
      }
      firePolicyEvent(buildGuardTransitionEvent({
        runId: guardEventRunId(runId, resourceId),
        bundleId: registry.bundle_id,
        resourceId,
        entry,
        rulesEvaluated: [],
        ...(userId !== undefined ? { resolvedByUserId: userId } : {}),
      }));
    }
    return {
      status: "deviation", ledger_ref: ledgerRef, current_state: registry.current_state, rationale,
      authorized_by: `${authorizedBy.principal} (${authorizedBy.fingerprint})`,
      entry_digest: entry.entry_digest,
      prev_digest: entry.prev_digest,
      payload_digest: entry.payload_digest ?? "",
    };
  });
}

export async function guardMigrate(
  resourceId: string,
  newGraph: GuardGraph,
  newEdgePredicates: EdgePredicates,
  authorization: string,
  rationale: string,
  newTerminal: string[] = [],
  newStakes: Record<string, string> = {},
): Promise<{ status: "migrated"; checksum: string; graph_version: number; ledger_ref: string; rationale: string; authorized_by: string }> {
  if (!rationale || !rationale.trim()) throw new OverrideUnavailable("migrate requires a non-empty rationale");

  return acquireResourceLock(resourceId, async ({ token }) => {
    assertTsOwnedForMutation(resourceId);
    const registry = loadRegistry(resourceId);
    if (registry === null) throw new GuardNotFound(`no guard registered for ${JSON.stringify(resourceId)}`);
    // The authorization names the RESULTING policy, so a signature for one
    // migration cannot be spent on a different one.
    const authorizedBy = verifyAuthorization("migrate", {
      resource_id: resourceId,
      policy_checksum: guardChecksum(newGraph, newEdgePredicates, newTerminal, newStakes),
      rationale,
      ledger_head: _ledgerHead(resourceId),
    }, authorization);
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
      rationale: `authorized by ${authorizedBy.principal} (${authorizedBy.fingerprint}): ${rationale}`,
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
    return {
      status: "migrated", checksum, graph_version: graphVersion, ledger_ref: ledgerRef, rationale,
      authorized_by: `${authorizedBy.principal} (${authorizedBy.fingerprint})`,
    };
  });
}

/**
 * Edge legality, robust to a malformed stored adjacency. `_validatePolicy`
 * rejects a non-array adjacency on the way in, but registries are long-lived
 * and load through unchecked casts, so one written before that check exists
 * must still fail closed here: `["b"].includes("x")` is membership, but
 * `"bxyz".includes("xyz")` is a SUBSTRING match and would legalize an
 * undeclared, unguarded state.
 */
function _declaresEdge(graph: GuardGraph, fromState: string, toState: string): boolean {
  const targets = graph[fromState];
  return Array.isArray(targets) && targets.includes(toState);
}

function _graphEdgeKeys(graph: GuardGraph): Set<string> {
  const keys = new Set<string>();
  for (const [fromState, targets] of Object.entries(graph)) {
    for (const toState of targets) keys.add(_edgeKey(fromState, toState));
  }
  return keys;
}

function _policyNodes(graph: GuardGraph, terminal: string[], initial: string): Set<string> {
  const names = new Set([...Object.keys(graph), ...terminal, initial]);
  for (const targets of Object.values(graph)) for (const target of targets) names.add(target);
  return names;
}

/**
 * Every way the submitted policy is NOT an additive-only extension of the
 * stored one, as human-readable reasons (empty = compatible).
 *
 * Deliberately stricter than strictly necessary, because this classifier is
 * the only thing standing between a token-free call and a policy change:
 * existing edges must be byte-identical (even ADDING a predicate to one is
 * refused — "strengthening" is an ordering this code declines to reason
 * about), and `terminal` is frozen in both directions — no state may be added
 * to it or removed from it, and no new edge may enter OR leave a terminal
 * state. Anything it refuses remains reachable through `guardMigrate` with the
 * override token.
 */
export function _upgradeIncompatibilities(
  registry: GuardRegistry,
  newGraph: GuardGraph,
  newEdgePredicates: EdgePredicates,
  newTerminal: string[],
  newStakes: Record<string, string>,
): string[] {
  const reasons: string[] = [];

  for (const [fromState, targets] of Object.entries(registry.graph)) {
    if (!Object.hasOwn(newGraph, fromState)) {
      reasons.push(`node ${JSON.stringify(fromState)} is missing from the new graph`);
      continue;
    }
    const newTargets = new Set(newGraph[fromState] ?? []);
    for (const toState of targets) {
      if (!newTargets.has(toState)) reasons.push(`edge ${_edgeKey(fromState, toState)} was removed`);
    }
  }

  // Keys of the OLD policy only: predicates/stakes on brand-new edges are the
  // point of an upgrade, while any pre-existing key must survive untouched —
  // including "absent stays absent", so a new entry on an old edge is refused.
  const existingKeys = new Set([
    ..._graphEdgeKeys(registry.graph),
    ...Object.keys(registry.edge_predicates),
    ...Object.keys(registry.stakes),
  ]);
  // Own-property reads only: a caller-supplied object still inherits
  // Object.prototype, so `newEdgePredicates["constructor"]` would otherwise
  // resolve to an inherited value instead of "absent".
  const own = <T>(source: Record<string, T>, key: string): T | null => (Object.hasOwn(source, key) ? source[key]! : null);
  for (const key of existingKeys) {
    if (canonicalJson(own(registry.edge_predicates, key)) !== canonicalJson(own(newEdgePredicates, key))) {
      reasons.push(`predicates changed on existing edge ${key}`);
    }
    if (own(registry.stakes, key) !== own(newStakes, key)) {
      reasons.push(`stakes changed on existing edge ${key}`);
    }
  }

  // Additive-only does NOT mean harmless: an added edge that lands on a state
  // the old policy already had is a new ROUTE to it, and routes around the
  // predicates on the old route. `draft -> shipped` guarded by evidence is
  // worthless if a token-free call can add `draft -> rubber_stamp -> shipped`.
  // So new edges may only terminate at states that did not exist before —
  // which keeps the reachability of every pre-existing state exactly as
  // registered, and still allows grafting a new subgraph (the requesting case).
  const oldEdges = _graphEdgeKeys(registry.graph);
  const oldNodes = _policyNodes(registry.graph, registry.terminal, registry.initial);
  const oldTerminal = new Set(registry.terminal);
  for (const [fromState, targets] of Object.entries(newGraph)) {
    for (const toState of targets) {
      if (oldEdges.has(_edgeKey(fromState, toState))) continue;
      if (oldNodes.has(toState)) {
        reasons.push(`new edge ${_edgeKey(fromState, toState)} adds a route into pre-existing state ${JSON.stringify(toState)}`);
      }
      // Terminal EGRESS, not just membership. Freezing the terminal set stops a
      // caller inventing a new way to be done; it does not stop `shipped ->
      // reopened` with a brand-new `reopened`, which walks a completed resource
      // back OUT of its terminal state — token-free, over an edge whose
      // predicates the caller also chose. A terminal state has no outgoing
      // edges by contract, so growing one is a policy change either way.
      if (oldTerminal.has(fromState)) {
        reasons.push(`new edge ${_edgeKey(fromState, toState)} leaves terminal state ${JSON.stringify(fromState)}`);
      }
    }
  }

  // `terminal` is frozen — not "grows only with new nodes". Stratum never reads
  // it for edge legality, but consumers read it as COMPLETABILITY, so adding a
  // terminal state is granting a new way to be done. A token-free caller who
  // could add one would simply declare its own success state, reach it over a
  // new edge whose predicates it also chose (an empty predicate list evaluates
  // as met), and be complete without passing any gate that existed at
  // registration. Rule 4 does not help there: the bypass never touches an old
  // state. Granting completability is an authorization decision, so it stays
  // on the token-gated `guardMigrate`.
  const newTerminalSet = new Set(newTerminal);
  for (const name of oldTerminal) {
    if (!newTerminalSet.has(name)) reasons.push(`terminal state ${JSON.stringify(name)} was removed`);
  }
  for (const name of newTerminalSet) {
    if (!oldTerminal.has(name)) reasons.push(`terminal state ${JSON.stringify(name)} was added`);
  }

  return reasons;
}

export type GuardUpgradeResult =
  | { status: "unchanged"; checksum: string; graph_version: number; rationale: string }
  | { status: "migrated"; checksum: string; graph_version: number; ledger_ref: string; rationale: string };

/**
 * Routine, token-free policy upgrade: idempotent on an identical policy and
 * additive-only otherwise. The complement of `guardMigrate`, which keeps the
 * override token for everything this refuses. See
 * `docs/features/STRAT-GUARD-UPGRADE/design.md`.
 */
export async function guardUpgrade(
  resourceId: string,
  newGraph: GuardGraph,
  newEdgePredicates: EdgePredicates,
  rationale: string,
  newTerminal: string[] = [],
  newStakes: Record<string, string> = {},
): Promise<GuardUpgradeResult> {
  if (!rationale || !rationale.trim()) throw new OverrideUnavailable("upgrade requires a non-empty rationale");

  return acquireResourceLock(resourceId, async ({ token }) => {
    assertTsOwnedForMutation(resourceId);
    const registry = loadRegistry(resourceId);
    if (registry === null) throw new GuardNotFound(`no guard registered for ${JSON.stringify(resourceId)}`);
    // Before ANY comparison: a tampered registry whose stored checksum happened
    // to match the submitted policy would otherwise return "unchanged" and
    // silently bless the tampering.
    if (guardChecksum(registry.graph, registry.edge_predicates, registry.terminal, registry.stakes) !== registry.checksum) {
      throw new GuardTampered(`guard ${JSON.stringify(resourceId)} policy checksum mismatch`);
    }
    _validatePolicy(
      newGraph,
      newEdgePredicates,
      registry.initial,
      newTerminal,
      newStakes,
      registry.workspace_root,
    );
    const checksum = guardChecksum(newGraph, newEdgePredicates, newTerminal, newStakes);
    if (checksum === registry.checksum) {
      // No ledger entry and no version bump: compose re-runs this per resource
      // on every cold-server touch, and the steady state must write nothing.
      return { status: "unchanged", checksum, graph_version: registry.graph_version, rationale };
    }

    const reasons = _upgradeIncompatibilities(registry, newGraph, newEdgePredicates, newTerminal, newStakes);
    if (reasons.length > 0) {
      throw new IncompatiblePolicyUpgrade(
        `policy upgrade is not additive-only (${reasons.join("; ")}); use a signed upgrade descriptor, or guard migrate with a signed authorization`,
      );
    }
    // Unreachable under an additive-only policy (old nodes all survive), kept
    // as defence in depth against a classifier gap.
    if (!Object.hasOwn(newGraph, registry.current_state) && !newTerminal.includes(registry.current_state)) {
      throw new InvalidStateName(`current_state ${JSON.stringify(registry.current_state)} is not a node in the new graph`);
    }

    const graphVersion = registry.graph_version + 1;
    const entry = new LedgerEntry({
      ts_ms: _nowMs(),
      from_state: registry.current_state,
      to_state: registry.current_state,
      outcome: "graph_version",
      kind: "graph_version",
      // The one ledger-visible difference from guardMigrate, which writes
      // "human": that call means a person held the override token.
      resolved_by: "agent",
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

export type GuardApplyUpgradeResult =
  | { status: "unchanged"; checksum: string; graph_version: number; descriptor_id: string }
  | { status: "applied"; checksum: string; graph_version: number; ledger_ref: string; descriptor_id: string };

/**
 * Apply a server-owned, digest-pinned, human-reviewed upgrade descriptor.
 *
 * The middle of the three policy-change capabilities. `guardUpgrade` needs no
 * authorization because it is provably non-weakening; `guardMigrate` needs the
 * break-glass token because it can do anything. This path can do anything the
 * descriptor spells out — including granting a terminal state, which
 * `guardUpgrade` refuses precisely because it is a completability grant — and it
 * is safe because a human read that exact resulting policy before installing it
 * and pinned the file's digest into the server environment.
 *
 * No additive-only classifier runs here, deliberately. See
 * `docs/features/STRAT-GUARD-DESCRIPTOR/design.md`.
 */
export async function guardApplyUpgrade(
  resourceId: string,
  descriptorId: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<GuardApplyUpgradeResult> {
  // Authorization first, outside the lock: a caller with no descriptor set
  // configured must not even be able to probe which resources exist.
  const descriptorFile = loadDescriptorFile(env);
  const descriptor = findDescriptor(descriptorFile, descriptorId);
  const { graph, edge_predicates: edgePredicates, terminal, stakes } = descriptor.to_policy;

  return acquireResourceLock(resourceId, async ({ token }) => {
    assertTsOwnedForMutation(resourceId);
    const registry = loadRegistry(resourceId);
    if (registry === null) throw new GuardNotFound(`no guard registered for ${JSON.stringify(resourceId)}`);
    if (guardChecksum(registry.graph, registry.edge_predicates, registry.terminal, registry.stakes) !== registry.checksum) {
      throw new GuardTampered(`guard ${JSON.stringify(resourceId)} policy checksum mismatch`);
    }
    const checksum = guardChecksum(graph, edgePredicates, terminal, stakes);
    // Destination check BEFORE the from_checksum check: a resource already at the
    // target is a success, not a mismatch. That is what makes a fleet batch
    // re-runnable after a partial failure.
    if (checksum === registry.checksum) {
      return { status: "unchanged", checksum, graph_version: registry.graph_version, descriptor_id: descriptor.id };
    }
    if (registry.checksum !== descriptor.from_checksum) {
      throw new UpgradeDescriptorMismatch(
        `descriptor ${JSON.stringify(descriptor.id)} is authorized for policy ${descriptor.from_checksum}, `
        + `but ${JSON.stringify(resourceId)} currently holds ${registry.checksum}`,
      );
    }
    // Authorized is not the same as well-formed.
    _validatePolicy(graph, edgePredicates, registry.initial, terminal, stakes, registry.workspace_root);
    if (!Object.hasOwn(graph, registry.current_state) && !terminal.includes(registry.current_state)) {
      throw new InvalidStateName(`current_state ${JSON.stringify(registry.current_state)} is not a node in the new graph`);
    }

    const graphVersion = registry.graph_version + 1;
    const entry = new LedgerEntry({
      ts_ms: _nowMs(),
      from_state: registry.current_state,
      to_state: registry.current_state,
      outcome: "graph_version",
      kind: "graph_version",
      // A human authorized this exact policy, so the ledger says so — and names
      // which authorization, pinned by the descriptor file's digest.
      resolved_by: "human",
      // Names WHO authorized it and WHICH artifact, from the file verified
      // ABOVE — a re-read could name a digest other than the one authorized.
      rationale: `descriptor ${descriptor.id} signed by ${descriptorFile.signedBy.principal} `
        + `(${descriptorFile.signedBy.fingerprint}, file sha256 ${descriptorFile.digest}): ${descriptor.rationale}`,
    });
    await fenceResourceLock(resourceId, token);
    const ledgerRef = appendLedger(resourceId, entry);
    registry.graph = graph;
    registry.edge_predicates = edgePredicates;
    registry.terminal = terminal;
    registry.stakes = stakes;
    registry.checksum = checksum;
    registry.graph_version = graphVersion;
    persistRegistry(registry);
    return { status: "applied", checksum, graph_version: graphVersion, ledger_ref: ledgerRef, descriptor_id: descriptor.id };
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
