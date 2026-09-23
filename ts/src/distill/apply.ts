import { realpathSync } from "node:fs";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { realpathOrSelf, realpathThroughMissing } from "../apply/paths.js";
import {
  ApplyError, ApplyRefused, applyCandidate, readJournal, reconcile, revertApply,
  type AdmissionResult, type AppliedResult, type ApplyAdapter, type ApplyOptions,
  type BaseJournalEntry, type PoolView, type ReconcileReport,
} from "../apply/protocol.js";
import { verifyCandidateIdentity, type AssetCandidate, type AssetKind, type SourceMode } from "./candidate.js";
import { canonicalJson, description, occurrenceId, toolSteps, workflowFromEvidence, type WorkflowOccurrence, type WorkflowStep } from "./detector.js";
import { compare, digest as sha, loadSessions, missing } from "./harvest.js";

export { ApplyError, ApplyRefused };
export interface AssetApplyOptions extends ApplyOptions { applyRoot: string; trustSource?: boolean }
interface AssetApplyRequest { candidate: AssetCandidate; applyRoot: string; sourceTrust: "operator-asserted" | null }
export interface AssetLineage {
  poolSnapshot: AssetCandidate["poolSnapshot"];
  authoringInputsDigest: string;
  poolDigestAtAdmission: string;
}
export interface AssetJournalEntry extends BaseJournalEntry<WorkflowOccurrence> {
  kind: "asset";
  lineage: AssetLineage;
  sourceMode: SourceMode;
  sourceTrust?: "operator-asserted";
}
export type AssetCriticName = "structural-validity" | "behavioral-harmlessness" | "semantic-consistency" | "subset-marginal-gain";
export interface AssetVerdict { critic: AssetCriticName; passes: boolean; findings: string[] }
interface AssetPoolEntry { kind: AssetKind; name: string; contentDigest: string }
export interface AssetPoolView {
  target: { content: string; existed: boolean };
  entries: Map<string, AssetPoolEntry>;
  byName: Map<string, string[]>;
  byDigest: Map<string, string[]>;
  poolDigest: string;
}
const verdict = (critic: AssetCriticName, findings: string[]): AssetVerdict => ({ critic, passes: findings.length === 0, findings });

// Keep the settled memory hazard policy, including finding order and wording.
const ASSET_HAZARDS: Array<[RegExp, string]> = [
  [/git\s+checkout\s+--\s/i, "discards uncommitted work (git checkout --)"],
  [/git\s+reset\s+--hard/i, "discards committed work (git reset --hard)"],
  [/git\s+clean\s+-[a-z]*f/i, "deletes untracked files (git clean -f)"],
  [/git\s+push\s+--force/i, "rewrites published history (git push --force)"],
  [/\brm\s+-[a-z]*r[a-z]*f\b/i, "recursive force delete (rm -rf)"],
  [/curl[^\n]*\|\s*(ba)?sh/i, "pipes remote content into a shell"],
  [/\b(api[_-]?key|secret|token|password|credential)s?\b/i, "handles credentials"],
  [/ts\/src\/(guard|judge)\//i, "instructs a write to the immutable core"],
  [/docs\/judgment\//i, "instructs a write that bypasses the judgment tools"],
  [/\.stratum\.yaml/i, "instructs a spec edit"],
  [/guard\s+(registry|ledger)/i, "instructs a write to guard state"],
];

type Frontmatter = { kind: "missing" } | { kind: "invalid" } | { kind: "parsed"; value: Record<string, string | boolean> };
function parseDraftFrontmatter(content: string): Frontmatter {
  const lines = content.split("\n");
  if (lines[0] !== "---") return { kind: "missing" };
  const end = lines.indexOf("---", 1);
  if (end < 0) return { kind: "invalid" };
  const value: Record<string, string | boolean> = Object.create(null);
  for (const line of lines.slice(1, end)) {
    const match = /^([a-z][a-z-]*): (.+)$/.exec(line);
    if (!match || Object.hasOwn(value, match[1]!)) return { kind: "invalid" };
    const key = match[1]!, raw = match[2]!;
    if (key === "disable-model-invocation" && /^(true|false)$/.test(raw)) value[key] = raw === "true";
    else if (key === "name" || key === "description") {
      try {
        const parsed: unknown = JSON.parse(raw);
        if (typeof parsed !== "string") return { kind: "invalid" };
        value[key] = parsed;
      } catch { return { kind: "invalid" }; }
    } else return { kind: "invalid" };
  }
  return { kind: "parsed", value };
}

export function structuralValidity(candidate: AssetCandidate): AssetVerdict {
  const findings: string[] = [];
  if (candidate.schemaVersion !== "distill-2.1") findings.push("asset schema must be distill-2.1");
  if (candidate.rendered.insertion.mode !== "create") findings.push("asset insertion mode must be create");
  if (Buffer.byteLength(candidate.rendered.content, "utf8") > 16 * 1024) findings.push("rendered content exceeds 16 KB");
  if (candidate.targetKind === "subagent") findings.push("subagent drafts have no non-delegation marker; not apply-eligible in v1");
  const parsed = parseDraftFrontmatter(candidate.rendered.content);
  if (parsed.kind === "missing") findings.push("rendered content has no YAML frontmatter");
  else if (parsed.kind === "invalid") findings.push("rendered frontmatter is not parseable");
  else {
    const fm = parsed.value;
    if (typeof fm.description !== "string" || fm.description.trim() === "") findings.push("frontmatter description is empty");
    if (fm["disable-model-invocation"] !== true) findings.push("frontmatter must set disable-model-invocation: true");
    if (candidate.targetKind === "skill") {
      if (fm.name !== candidate.assetName) findings.push("skill frontmatter name must equal assetName");
      if (basename(dirname(candidate.targetPath)) !== candidate.assetName) findings.push("skill assetName must equal target parent directory");
    }
    if (candidate.targetKind === "command") {
      if (Object.hasOwn(fm, "name")) findings.push("command frontmatter must omit name");
      if (basename(candidate.targetPath, ".md") !== candidate.assetName) findings.push("command filename must equal assetName");
    }
  }
  return verdict("structural-validity", findings);
}
export function behavioralHarmlessness(candidate: AssetCandidate): AssetVerdict {
  const findings: string[] = [];
  for (const [pattern, message] of ASSET_HAZARDS) {
    pattern.lastIndex = 0;
    if (pattern.test(candidate.rendered.content)) findings.push(message);
  }
  return verdict("behavioral-harmlessness", findings);
}
function canonicalStep(step: WorkflowStep): string {
  return canonicalJson({ toolName: step.toolName, canonicalInput: step.canonicalInput, lineNo: step.lineNo,
    blockIndex: step.blockIndex, toolUseId: step.toolUseId, cwd: step.cwd, lineDigest: step.lineDigest });
}
export async function semanticConsistency(candidate: AssetCandidate): Promise<AssetVerdict> {
  const findings: string[] = [], resolvedEvidence: WorkflowOccurrence[] = [];
  const harvests = new Map<string, ReturnType<typeof loadSessions>>();
  for (const occurrence of candidate.evidence) {
    const prefix = `evidence ${occurrence.id}: `;
    try {
      if (!harvests.has(occurrence.projectDir)) harvests.set(occurrence.projectDir, loadSessions(occurrence.projectDir, { windowDays: 0 }));
      const { sessions } = await harvests.get(occurrence.projectDir)!;
      const sessionsAtHandle = sessions.filter(s => s.sessionId === occurrence.sessionId && s.transcriptFile === occurrence.transcriptFile);
      if (sessionsAtHandle.length !== 1) { findings.push(prefix + "transcript file is missing or unreadable"); continue; }
      const allSteps = toolSteps(sessionsAtHandle[0]!);
      const steps: WorkflowStep[] = [], locators = new Set<string>();
      for (const cited of occurrence.steps) {
        const locator = canonicalJson([cited.lineNo, cited.blockIndex]);
        const matches = allSteps.filter(s => s.lineNo === cited.lineNo && s.blockIndex === cited.blockIndex);
        if (locators.has(locator) || matches.length !== 1) { findings.push(prefix + "cited line or block moved"); continue; }
        locators.add(locator);
        const step = matches[0]!;
        if (canonicalStep(step) !== canonicalStep(cited)) findings.push(prefix + "normalized step does not match transcript");
        steps.push(step);
      }
      if (!steps.length || steps.length !== occurrence.steps.length) continue;
      const firstIndex = allSteps.indexOf(steps[0]!);
      // Detector occurrences are contiguous windows, not arbitrary subsets of a session.
      if (canonicalJson(allSteps.slice(firstIndex, firstIndex + steps.length)) !== canonicalJson(steps)) {
        findings.push(prefix + "cited line or block moved");
      }
      const cwd = steps[0]!.cwd !== null && steps.every(s => s.cwd === steps[0]!.cwd) ? steps[0]!.cwd : null;
      if (cwd !== occurrence.cwd) findings.push(prefix + "occurrence cwd does not match transcript");
      const source = { sourceKind: "claude-transcript" as const, projectDir: sessionsAtHandle[0]!.projectDir,
        sessionId: occurrence.sessionId, transcriptFile: occurrence.transcriptFile, cwd, steps };
      const rebuilt = { ...source, id: occurrenceId(source) };
      if (rebuilt.id !== occurrence.id) findings.push(prefix + "occurrence id does not match re-harvested evidence");
      if (canonicalJson(description(steps)) !== canonicalJson(candidate.workflow)) findings.push(prefix + "workflow description does not match re-harvested evidence");
      resolvedEvidence.push(rebuilt);
    } catch { findings.push(prefix + "transcript file is missing or unreadable"); }
  }
  const claimed = { workflow: candidate.workflow, scope: { transcriptProjectDir: candidate.scope.transcriptProjectDir,
    observedCwds: candidate.scope.observedCwds }, evidence: candidate.evidence, recurrence: candidate.recurrence, sourceHandle: candidate.sourceHandle };
  if (!resolvedEvidence.length || canonicalJson(workflowFromEvidence(resolvedEvidence)) !== canonicalJson(claimed)) {
    findings.push("candidate workflow does not match re-harvested evidence");
  }
  if (candidate.recurrence.records !== candidate.evidence.length) findings.push(`recurrence claims ${candidate.recurrence.records} records, evidence carries ${candidate.evidence.length}`);
  const actualDistinctSessions = new Set(candidate.evidence.map(o => o.sessionId)).size;
  if (candidate.recurrence.distinctSessions !== actualDistinctSessions) findings.push(`recurrence claims ${candidate.recurrence.distinctSessions} sessions, evidence carries ${actualDistinctSessions}`);
  if (candidate.evidence.some(o => o.projectDir !== candidate.scope.transcriptProjectDir)) findings.push("evidence project directory does not match candidate scope");
  return verdict("semantic-consistency", findings);
}
export function subsetMarginalGain(candidate: AssetCandidate, pool: AssetPoolView): AssetVerdict {
  const findings: string[] = [];
  const names = pool.byName.get(candidate.assetName) ?? [];
  if (names.length) findings.push(`pool already contains asset name ${JSON.stringify(candidate.assetName)} at ${names.join(", ")}`);
  const digests = pool.byDigest.get(sha(candidate.rendered.content)) ?? [];
  if (digests.length) findings.push(`pool already contains identical content at ${digests.join(", ")}`);
  if (pool.target.existed) findings.push("target path already exists; asset apply is create-only");
  return verdict("subset-marginal-gain", findings);
}
export async function admitAsset(candidate: AssetCandidate, pool: AssetPoolView): Promise<AdmissionResult> {
  const verdicts = [structuralValidity(candidate), behavioralHarmlessness(candidate), await semanticConsistency(candidate), subsetMarginalGain(candidate, pool)];
  return { admitted: verdicts.every(v => v.passes), verdicts, candidateDigest: sha(candidate.rendered.content), poolDigest: pool.poolDigest };
}

async function statOrMissing(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
  try { return await lstat(path); } catch (error) { if (missing(error)) return null; throw error; }
}
async function assetRoots(applyRoot: string): Promise<string[]> {
  if (!isAbsolute(applyRoot) || await realpath(applyRoot) !== applyRoot || !(await lstat(applyRoot)).isDirectory()) {
    throw new ApplyError("apply root must be an existing canonical absolute directory");
  }
  const claude = join(applyRoot, ".claude");
  for (const path of [claude, ...["skills", "agents", "commands"].map(kind => join(claude, kind))]) {
    const stat = await statOrMissing(path);
    if (stat?.isSymbolicLink()) throw new ApplyError(path === claude ? ".claude must not be a symbolic link" : `asset directory must not be a symbolic link: ${path}`);
    if (stat && (!stat.isDirectory() || !(await realpath(path)).startsWith(applyRoot + sep))) throw new ApplyError(`invalid asset directory: ${path}`);
  }
  return Promise.all(["skills", "agents", "commands"].map(kind => realpathOrSelf(join(claude, kind))));
}
export async function assertAssetAllowlisted(applyRoot: string, targetPath: string): Promise<string> {
  const roots = await assetRoots(applyRoot);
  const target = resolve(targetPath);
  // Refuse discoverable symlinks, including dangling links, before resolving them.
  for (const path of [dirname(target), target]) {
    if ((await statOrMissing(path))?.isSymbolicLink()) throw new ApplyError(`asset path must not be a symbolic link: ${path}`);
  }
  const realTarget = await realpathThroughMissing(target);
  const slug = "[a-z0-9]+(?:-[a-z0-9]+)*";
  if (!roots.some((root, index) => new RegExp(index === 0 ? `^${slug}/SKILL\\.md$` : `^${slug}\\.md$`).test(relative(root, realTarget)))) {
    throw new ApplyError(`target is outside the asset allowlist: ${realTarget}`);
  }
  return realTarget;
}
export async function buildAssetPool(applyRoot: string, target: string): Promise<PoolView> {
  const roots = await assetRoots(applyRoot);
  let snapshot: AssetPoolView["target"];
  try {
    const stat = await lstat(target);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new ApplyError(`invalid asset target: ${target}`);
    snapshot = { content: new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(await readFile(target)), existed: true };
  } catch (error) { if (!missing(error)) throw error; snapshot = { content: "", existed: false }; }
  const records: Array<AssetPoolEntry & { path: string }> = [];
  const kinds: AssetKind[] = ["skill", "subagent", "command"];
  for (const [index, root] of roots.entries()) {
    let names: string[];
    try { names = await readdir(root); } catch (error) { if (missing(error)) continue; throw error; }
    for (const name of names.sort(compare)) {
      let path = join(root, name);
      if (index === 0) {
        const stat = await lstat(path);
        if (stat.isSymbolicLink()) throw new ApplyError(`symlink in asset pool: ${path}`);
        if (!stat.isDirectory()) continue;
        path = join(path, "SKILL.md");
      } else if (!name.endsWith(".md")) continue;
      const stat = await statOrMissing(path);
      if (!stat) continue;
      if (stat.isSymbolicLink()) throw new ApplyError(`symlink in asset pool: ${path}`);
      if (!stat.isFile()) throw new ApplyError(`non-regular asset pool entry: ${path}`);
      const canonical = await realpath(path);
      if (!canonical.startsWith(root + sep)) throw new ApplyError(`asset pool entry escaped its directory: ${path}`);
      records.push({ path: canonical, kind: kinds[index]!, name: index === 0 ? name : basename(name, ".md"), contentDigest: sha(await readFile(path)) });
    }
  }
  records.sort((a, b) => compare(a.path, b.path));
  const entries = new Map<string, AssetPoolEntry>(), byName = new Map<string, string[]>(), byDigest = new Map<string, string[]>();
  for (const { path, ...entry } of records) {
    entries.set(path, entry);
    for (const [map, key] of [[byName, entry.name], [byDigest, entry.contentDigest]] as const) map.set(key, [...(map.get(key) ?? []), path]);
  }
  const pool: AssetPoolView = { target: snapshot, entries, byName, byDigest, poolDigest: sha(canonicalJson(records)) };
  return { target: snapshot, admissionInput: pool };
}
function workspaceTranscriptDir(applyRoot: string): string {
  const path = join(homedir(), ".claude", "projects", applyRoot.replace(/\//g, "-"));
  try { return realpathSync(path); } catch (error) { if (missing(error)) return resolve(path); throw error; }
}
function verifyAssetApplyRequest({ candidate, applyRoot, sourceTrust }: AssetApplyRequest): void {
  if (!verifyCandidateIdentity(candidate)) throw new ApplyError("candidate identity does not match distill-2.1 staged bytes");
  if (candidate.scope.workspaceRoot !== applyRoot) throw new ApplyRefused("candidate workspace root does not match apply root");
  // Identity hashes are unkeyed: independently derive workspace provenance.
  if (candidate.scope.sourceMode === "workspace") {
    if (candidate.scope.transcriptProjectDir !== workspaceTranscriptDir(applyRoot)) throw new ApplyRefused("workspace source mode does not match the apply root transcript directory");
  } else if (sourceTrust !== "operator-asserted") throw new ApplyRefused(`source mode ${candidate.scope.sourceMode} requires --trust-source`);
}
function assetJournalEntry(request: AssetApplyRequest, base: BaseJournalEntry<WorkflowOccurrence>, admission: AdmissionResult): AssetJournalEntry {
  return {
    applyId: base.applyId, state: base.state, clusterId: base.clusterId, revisionId: base.revisionId,
    targetPath: base.targetPath, before: base.before, beforeDigest: base.beforeDigest, after: base.after,
    afterDigest: base.afterDigest, existedBefore: base.existedBefore, evidence: base.evidence, verdicts: base.verdicts, at: base.at,
    kind: "asset", lineage: { poolSnapshot: structuredClone(request.candidate.poolSnapshot),
      authoringInputsDigest: request.candidate.authoringInputsDigest, poolDigestAtAdmission: admission.poolDigest },
    sourceMode: request.candidate.scope.sourceMode,
    ...(request.sourceTrust === null ? {} : { sourceTrust: request.sourceTrust }),
  };
}
const isEnabled = (options: ApplyOptions): boolean => options.enabled === true || process.env.STRATUM_DISTILL_APPLY_ENABLED === "1";
const assetApplyAdapter: ApplyAdapter<AssetApplyRequest, WorkflowOccurrence, AssetJournalEntry> = {
  kind: "asset", enabled: isEnabled, workspaceRoot: request => request.applyRoot,
  targetPath: ({ candidate }) => candidate.targetPath, evidenceFor: ({ candidate }) => candidate.evidence,
  ids: ({ candidate }) => ({ clusterId: candidate.clusterId, revisionId: candidate.revisionId }),
  verifyIdentity: verifyAssetApplyRequest, allowlist: assertAssetAllowlisted, pool: buildAssetPool,
  admit: ({ candidate }, pool) => admitAsset(candidate, pool.admissionInput as AssetPoolView),
  renderAfter: (_before, { candidate }) => candidate.rendered.content,
  journalDir: root => join(root, ".stratum", "distill", "applies"), journalEntry: assetJournalEntry,
  guardResource: id => `distill-apply-${id}`,
  guardRegistration: () => ({ graph: { staged: ["applying", "aborted"], applying: ["applied", "aborted"], applied: ["reverted"], aborted: [], reverted: [] },
    edgePredicates: {}, initial: "staged", terminal: ["aborted", "reverted"], stakes: {}, workspaceRoot: null, policyBundle: undefined }),
  transitionArtifacts: (entry, edge) => {
    if (edge === "applying") return {
      journal_digest: sha(JSON.stringify(entry)), revision_id: entry.revisionId,
      evidence_ids: sha(canonicalJson(entry.evidence.map(o => o.id))), verdicts: sha(canonicalJson(entry.verdicts)),
      pool_digest: entry.lineage.poolDigestAtAdmission, pool_snapshot: sha(canonicalJson(entry.lineage.poolSnapshot)),
      authoring_inputs_digest: entry.lineage.authoringInputsDigest, pool_digest_at_admission: entry.lineage.poolDigestAtAdmission,
      source_mode: entry.sourceMode, ...(entry.sourceTrust === undefined ? {} : { source_trust: entry.sourceTrust }),
    };
    if (edge === "applied") return { after_digest: entry.afterDigest };
    if (edge === "reverted") return { reverted_to: entry.beforeDigest };
    return { aborted: "reconcile" };
  },
  locks: (root, target) => [`distill-pool-${sha(realpathSync(root))}`, `distill-target-${sha(target)}`],
};
export async function applyAssetCandidate(candidate: AssetCandidate, options: AssetApplyOptions): Promise<AppliedResult> {
  if (!isEnabled(options)) throw new ApplyRefused("distill apply is disabled; enable it explicitly (STRATUM_DISTILL_APPLY_ENABLED=1)");
  return applyCandidate(assetApplyAdapter, { candidate, applyRoot: options.applyRoot,
    sourceTrust: options.trustSource === true && candidate.scope.sourceMode !== "workspace" ? "operator-asserted" : null }, { ...options, enabled: true });
}
export function readAssetJournal(applyRoot: string): Promise<AssetJournalEntry[]> { return readJournal(assetApplyAdapter, applyRoot); }
export async function revertAssetApply(applyId: string, applyRoot: string, options: ApplyOptions): Promise<void> {
  if (!isEnabled(options)) throw new ApplyRefused("distill apply is disabled");
  return revertApply(assetApplyAdapter, applyId, applyRoot, { ...options, enabled: true });
}
export async function reconcileAssetApplies(applyRoot: string, options: ApplyOptions): Promise<ReconcileReport> {
  if (!isEnabled(options)) throw new ApplyRefused("distill apply is disabled");
  return reconcile(assetApplyAdapter, applyRoot, { ...options, enabled: true });
}
