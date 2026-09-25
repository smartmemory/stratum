import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { appendJsonlUnderLock, canonicalWorkspace, withWorkspaceLock } from "./workspace.js";
import type { FailureRecord, FailureShape } from "./harvest.js";
import type { Cluster, ContractSummary } from "./classify.js";

/**
 * Turns a durable cluster into a staged, immutable candidate.
 *
 * Authoring is TEMPLATED, not model-driven. A template cannot generalize beyond its
 * inputs, which removes the largest source of harm a semantic-consistency critic exists
 * to catch, and it makes candidate identity deterministic — the same evidence always
 * produces the same bytes.
 *
 * The candidate carries the RENDERED note, not merely a description of one. Without the
 * real text there is nothing for the behavioral critic to inspect and no source for the
 * `after` bytes an apply must write and snapshot.
 */

export const SCHEMA_VERSION = "learn-1.0";
export const TEMPLATE_VERSION = "2";

export class CandidateError extends Error {}

export interface RenderedAsset {
  guidance?: string;
  content: string;
  templateId: string;
  templateVersion: string;
  insertion: { mode: "create" | "append-to-section"; section: string };
}

export interface PatchCandidate {
  /** Stable across re-harvests: the lesson's identity. */
  clusterId: string;
  clusterKey: string;
  shape: FailureShape;
  contract: ContractSummary;
  /** Content-addressed: the bytes' identity. Apply always names one of these. */
  revisionId: string;
  schemaVersion: typeof SCHEMA_VERSION;
  targetKind: "memory";
  targetPath: string;
  scope: { workspaceRoot: string; flowName: string; stepIds: string[]; specDigests: string[] };
  claim: string;
  rendered: RenderedAsset;
  evidence: FailureRecord[];
  observedValues: string[];
  recurrence: { records: number; distinctRuns: number; distinctPairs: number };
  groupingKey: Cluster["groupingKey"];
  /** True when the natural fix is a spec edit — which v1 will never perform. */
  requiresHumanAction: boolean;
  authoringInputsDigest: string;
}

const SECTION = "## Harvested notes";

/**
 * v1 writes only inside the project's own `.stratum/learn/`. Promotion to a project's
 * primary memory file, or to user scope, is a separate authorized step by design.
 */
export function targetPathFor(workspaceRoot: string): string {
  if (!isAbsolute(workspaceRoot)) throw new CandidateError("workspaceRoot must be absolute");
  const root = resolve(workspaceRoot);
  const target = resolve(join(root, ".stratum", "learn", "NOTES.md"));
  // Path allowlist, enforced on the RESOLVED path — a convention would not survive
  // a workspaceRoot containing `..`.
  if (target !== root && !target.startsWith(root + sep)) {
    throw new CandidateError(`target escapes workspace root: ${target}`);
  }
  if (root !== workspaceRoot.replace(/\/+$/, "")) {
    throw new CandidateError(`workspaceRoot is not normalized: ${workspaceRoot}`);
  }
  return target;
}

export function authorCandidate(cluster: Cluster): PatchCandidate {
  if (cluster.class !== "durable") {
    throw new CandidateError(`cluster is ${cluster.class}, not durable`);
  }
  if (cluster.evidence.length === 0) {
    throw new CandidateError("cluster carries no evidence");
  }
  // Re-derived, not trusted: `applyEligible` is a computed field on a plain object, so
  // a caller that hand-builds a Cluster (or edits one) must not be able to smuggle an
  // unattributed or mixed-provenance lesson into an apply.
  if (cluster.unattributed || cluster.scope.workspaceRoot === null) {
    throw new CandidateError("cluster is unattributed and cannot authorize a write");
  }
  if (cluster.mixedProvenance) {
    throw new CandidateError("cluster is mixed-provenance and cannot authorize a write");
  }
  if (!cluster.applyEligible) throw new CandidateError("cluster is not apply-eligible");
  const workspaceRoot = cluster.scope.workspaceRoot;
  if (workspaceRoot === null) throw new CandidateError("durable cluster has no workspaceRoot");

  const claim = renderClaim(cluster);
  const guidance = renderGuidance(cluster);
  const rendered: RenderedAsset = {
    ...(guidance === undefined ? {} : { guidance }),
    content: renderNote(cluster, claim, guidance),
    templateId: `learn/${cluster.shape}`,
    templateVersion: TEMPLATE_VERSION,
    insertion: { mode: "append-to-section", section: SECTION },
  };

  const clusterId = sha(cluster.key);
  const candidate = {
    clusterId,
    clusterKey: cluster.key,
    shape: cluster.shape,
    contract: cluster.contract,
    schemaVersion: SCHEMA_VERSION,
    targetKind: "memory",
    targetPath: targetPathFor(workspaceRoot),
    scope: {
      workspaceRoot,
      flowName: cluster.scope.flowName,
      stepIds: cluster.scope.stepIds,
      specDigests: cluster.scope.specDigests,
    },
    claim,
    rendered,
    evidence: cluster.evidence,
    observedValues: cluster.observedValues,
    recurrence: cluster.recurrence,
    groupingKey: cluster.groupingKey,
    // Every lesson v1 can currently derive points at a contract, and contracts live in
    // specs. Surfacing is the deliverable; the fix stays a human's call.
    requiresHumanAction: cluster.shape === "schema" || cluster.shape === "ensure",
    // §5.1 tripwire: exactly what the author read. The memory pool is not among it.
    authoringInputsDigest: sha(
      JSON.stringify({ key: cluster.key, fingerprint: cluster.fingerprint, recurrence: cluster.recurrence }),
    ),
  } satisfies Omit<PatchCandidate, "revisionId">;
  return { ...candidate, revisionId: computeRevisionId(candidate) };
}

/** Binds the write bytes, destination, and guidance scope in a fixed order. */
export function computeRevisionId(candidate: Omit<PatchCandidate, "revisionId">): string {
  return sha([
    candidate.clusterId,
    candidate.rendered.templateVersion,
    candidate.rendered.content,
    candidate.targetPath,
    candidate.rendered.insertion.mode,
    candidate.rendered.insertion.section,
    JSON.stringify({
      guidance: candidate.rendered.guidance ?? null,
      flowName: candidate.scope.flowName,
      stepIds: [...candidate.scope.stepIds].sort(),
      groupingKey: candidate.groupingKey,
      shape: candidate.shape,
      contract: {
        code: candidate.contract.code,
        path: candidate.contract.path,
        expected: [...candidate.contract.expected].sort(),
      },
    }),
  ].join("\u0000"));
}

function renderGuidance(cluster: Cluster): string | undefined {
  const { code, path, expected } = cluster.contract;
  if (cluster.shape !== "schema" || path.length === 0) return undefined;
  if (code === "invalid_enum_value" && expected.length > 0) {
    return `When \`${path}\` has a non-null value, it must be exactly one of: ${expected.map((value) => `\`${value}\``).join(", ")}.`;
  }
  if (code === "invalid_type" && expected.length === 1) {
    return `When \`${path}\` has a non-null value, it must be a \`${expected[0]}\`.`;
  }
  return undefined;
}

function renderClaim(cluster: Cluster): string {
  const steps = cluster.scope.stepIds.map((s) => `\`${s}\``).join(", ");
  const { records, distinctRuns, distinctPairs } = cluster.recurrence;
  const seen = `${records} times across ${distinctRuns} runs / ${distinctPairs} run-step pairs`;
  const { path, expected } = cluster.contract;
  // A note that does not name the offending field is not actionable.
  const field = path.length > 0 ? `\`${path}\`` : "the step output";
  if (cluster.shape === "schema") {
    const allowed = expected.length > 0
      ? ` The contract allows ${expected.map((v) => `\`${v}\``).join(", ")}.`
      : "";
    const observed = cluster.observedValues.length > 0
      ? ` Steps returned ${cluster.observedValues.map((v) => `\`${v}\``).join(", ")}.`
      : "";
    return `In flow \`${cluster.scope.flowName}\`, step(s) ${steps} produced ${field} that the declared contract rejected, ${seen}.${allowed}${observed}`;
  }
  return `In flow \`${cluster.scope.flowName}\`, step(s) ${steps} failed the same \`${cluster.shape}\` check on ${field}, ${seen}.`;
}

function renderNote(cluster: Cluster, claim: string, guidance?: string): string {
  const recovered = cluster.evidence.filter((record) => record.recovered).length;
  // Only claim what the evidence shows. "Recovered on retry" is the invisible-waste
  // story, and it is a different (weaker) finding when most of these actually failed.
  const impact =
    recovered === cluster.evidence.length
      ? "every one recovered on retry, so each cost an extra agent dispatch and nothing surfaced it"
      : recovered === 0
        ? "none recovered on retry"
        : `${recovered} of ${cluster.evidence.length} recovered on retry, so those cost an extra agent dispatch each`;
  const lines = [
    `- **${cluster.scope.flowName}: recurring ${cluster.shape} failure on ${cluster.contract.path || "step output"}** — ${claim}`,
    `  **Why it matters:** ${impact}.`,
    ...(guidance === undefined ? [] : [`  **Agent guidance:** ${guidance}`]),
    `  **Fix target:** the declared contract or the step instruction — a spec change, which this loop deliberately will not make for you.`,
    `  <!-- learn:${sha(cluster.key).slice(0, 12)} -->`,
  ];
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Sidecar: append-only, its own file, its own schema. Never any other corpus.
// ---------------------------------------------------------------------------

export function sidecarPath(dir: string): string {
  return join(dir, "candidates.jsonl");
}

export async function readCandidates(dir: string): Promise<PatchCandidate[]> {
  let raw: string;
  try {
    raw = await readFile(sidecarPath(dir), "utf8");
  } catch {
    return [];
  }
  const out: PatchCandidate[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim().length === 0) continue;
    try {
      out.push(JSON.parse(line) as PatchCandidate);
    } catch {
      // A corrupt line must not hide the rest of the file.
    }
  }
  return out;
}

/** Returns how many rows were newly written. Idempotent on `revisionId`. */
export async function appendCandidates(
  root: string,
  candidates: readonly PatchCandidate[],
): Promise<number> {
  root = await canonicalWorkspace(root);
  return withWorkspaceLock(root, async () => {
    const existing = new Set((await readCandidates(join(root, ".stratum", "learn"))).map((c) => c.revisionId));
    const fresh = candidates.filter((c) => {
      if (existing.has(c.revisionId)) return false;
      existing.add(c.revisionId);
      return true;
    });
    await appendJsonlUnderLock(root, "candidates.jsonl", fresh);
    return fresh.length;
  });
}

/** The newest revision of each cluster, by file order. */
export function latestPerCluster(candidates: readonly PatchCandidate[]): PatchCandidate[] {
  const latest = new Map<string, PatchCandidate>();
  for (const candidate of candidates) latest.set(candidate.clusterId, candidate);
  return [...latest.values()];
}

function sha(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
