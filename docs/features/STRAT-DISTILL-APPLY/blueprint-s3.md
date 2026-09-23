# STRAT-DISTILL-APPLY — S3 implementation blueprint

Status: plan only. Nothing in this document is implemented yet. This slice adds only the asset adapter and its focused tests. S1's protocol and memory adapter and S2's `distill-2.1` candidate format are treated as settled inputs. S4 owns candidate selection from the sidecar, CLI parsing and output, the golden flow, help/contract text, and the CHANGELOG.

No runtime dependency is added. Asset apply remains one-candidate-at-a-time, deterministic, default OFF, project-scoped, and create-only. It does not add LLM critics, batch admission, pool-size pressure, lineage traversal, user-scope promotion, an MCP write surface, or subagent installation.

## A. Asset adapter, member by member

### Types and the S4 boundary

Create `ts/src/distill/apply.ts`. Its protocol specialization is:

```ts
export interface AssetApplyOptions extends ApplyOptions {
  applyRoot: string;
  trustSource?: boolean;
}

interface AssetApplyRequest {
  candidate: AssetCandidate;
  applyRoot: string;
  sourceTrust: "operator-asserted" | null;
}

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

const assetApplyAdapter: ApplyAdapter<
  AssetApplyRequest,
  WorkflowOccurrence,
  AssetJournalEntry
> = { /* members below */ };
```

The internal request wrapper is necessary: the settled `ApplyAdapter` has only three generic parameters and its `admit` method receives no options (`blueprint-s1.md:123-144`), while D5a requires comparison with an independently supplied apply root and needs the operator's trust decision to survive into journal/ledger artifacts. It would be unsafe to use `candidate.scope.workspaceRoot` as both sides of that comparison.

Type anchors:

- `ApplyOptions`, `BaseJournalEntry<E>`, `PoolView`, `GuardRegistration`, and `ApplyAdapter<C,E,J>` are the authoritative post-S1 declarations in `docs/features/STRAT-DISTILL-APPLY/blueprint-s1.md:65-68`, `:88-103`, `:105-111`, `:113-121`, and `:123-144`. S3 imports them from `ts/src/apply/protocol.ts`; it does not recreate them.
- `AssetKind`, `AssetCandidate`, and `AuthoringContext` are declared at `ts/src/distill/candidate.ts:9`, `:10-20`, and `:21-25`. S2 adds `SourceMode` and `scope.sourceMode` as specified at `docs/features/STRAT-DISTILL-APPLY/blueprint-s2.md:32-38` and `:64-78`.
- `WorkflowStep`, `WorkflowDescription`, `WorkflowOccurrence`, and `WorkflowCandidate` are declared at `ts/src/distill/detector.ts:30-33`.
- `TranscriptHandle`, `ToolObservation`, `TranscriptSession`, and `HarvestDiagnostics` are declared at `ts/src/distill/harvest.ts:5-8`.
- The protocol's `AdmissionResult` has string critic names at `docs/features/STRAT-DISTILL-APPLY/blueprint-s1.md:77-86`; the asset module narrows those names with its own `AssetCriticName`/`AssetVerdict`, exactly as the memory adapter narrows its public types.

S3 exports only adapter-facing library functions/types needed by S4:

```ts
export async function applyAssetCandidate(
  candidate: AssetCandidate,
  options: AssetApplyOptions,
): Promise<AppliedResult>;

export function readAssetJournal(applyRoot: string): Promise<AssetJournalEntry[]>;
export function revertAssetApply(
  applyId: string,
  applyRoot: string,
  options: ApplyOptions,
): Promise<void>;
export function reconcileAssetApplies(
  applyRoot: string,
  options: ApplyOptions,
): Promise<ReconcileReport>;
```

`AppliedResult` and `ReconcileReport` are the post-S1 protocol types at `blueprint-s1.md:146-150` and `:157-162`. S4 must translate its `--root` and `--trust-source` inputs into the exact `AssetApplyOptions` interface above and call `applyAssetCandidate`; S3 does not plan the CLI parser, sidecar lookup, or error presentation.

The wrapper performs the asset-specific disabled check before calling the core:

```ts
if (!(options.enabled === true || process.env.STRATUM_DISTILL_APPLY_ENABLED === "1")) {
  throw new ApplyRefused(
    "distill apply is disabled; enable it explicitly (STRATUM_DISTILL_APPLY_ENABLED=1)",
  );
}
const request: AssetApplyRequest = {
  candidate,
  applyRoot: options.applyRoot,
  sourceTrust: options.trustSource === true ? "operator-asserted" : null,
};
return protocolApplyCandidate(assetApplyAdapter, request, { ...options, enabled: true });
```

The revert and reconcile wrappers use the shorter existing memory-shaped refusal string, changed only for the feature name: `"distill apply is disabled"`.

### Concrete member table

Every member of the authoritative S1 `ApplyAdapter` is supplied as follows:

| Member | Concrete asset expression |
|---|---|
| `kind` | `"asset" as const` |
| `enabled` | `(options) => options.enabled === true || process.env.STRATUM_DISTILL_APPLY_ENABLED === "1"` |
| `workspaceRoot` | `({ applyRoot }) => applyRoot` |
| `targetPath` | `({ candidate }) => candidate.targetPath` |
| `evidenceFor` | `({ candidate }) => candidate.evidence` |
| `ids` | `({ candidate }) => ({ clusterId: candidate.clusterId, revisionId: candidate.revisionId })` |
| `verifyIdentity` | `(request) => verifyAssetApplyRequest(request)`; exact checks are below |
| `allowlist` | `(applyRoot, targetPath) => assertAssetAllowlisted(applyRoot, targetPath)` |
| `pool` | `(applyRoot, target) => buildAssetPool(applyRoot, target)`; it returns the target snapshot plus an `AssetPoolView` in `admissionInput` |
| `admit` | `({ candidate }, pool) => admitAsset(candidate, pool.admissionInput as AssetPoolView)` |
| `renderAfter` | `(_before, { candidate }) => candidate.rendered.content`; no newline or frontmatter normalization is permitted |
| `journalDir` | `(applyRoot) => join(applyRoot, ".stratum", "distill", "applies")` |
| `journalEntry` | `(request, base) => assetJournalEntry(request, base)`; the exact serialized literal is below |
| `guardResource` | ``(applyId) => `distill-apply-${applyId}``` |
| `guardRegistration` | `() => ({ graph: { staged: ["applying", "aborted"], applying: ["applied", "aborted"], applied: ["reverted"], aborted: [], reverted: [] }, edgePredicates: {}, initial: "staged", terminal: ["aborted", "reverted"], stakes: {}, workspaceRoot: null, policyBundle: undefined })` |
| `transitionArtifacts` | The four exact edge expressions below |
| `locks` | ``(applyRoot, target) => [`distill-pool-${sha(realpathSync(applyRoot))}`, `distill-target-${sha(target)}`]`` |

`verifyAssetApplyRequest` has this order and these fixed errors:

```ts
function verifyAssetApplyRequest({ candidate, applyRoot, sourceTrust }: AssetApplyRequest): void {
  if (!verifyCandidateIdentity(candidate)) {
    throw new ApplyError(
      "candidate identity does not match distill-2.1 staged bytes",
    );
  }
  if (candidate.scope.workspaceRoot !== applyRoot) {
    throw new ApplyRefused("candidate workspace root does not match apply root");
  }
  if (candidate.scope.sourceMode === "workspace") {
    if (candidate.scope.transcriptProjectDir !== workspaceTranscriptDir(applyRoot)) {
      throw new ApplyRefused(
        "workspace source mode does not match the apply root transcript directory",
      );
    }
  } else if (sourceTrust !== "operator-asserted") {
    throw new ApplyRefused(
      `source mode ${candidate.scope.sourceMode} requires --trust-source`,
    );
  }
}
```

`workspaceTranscriptDir` re-derives S2's workspace branch (`blueprint-s2.md:53-56`) and resolves it with the same source-path semantics as staging. This prevents an edited and rehashed row from merely relabelling an arbitrary directory as `sourceMode: "workspace"`.

The journal literal does not spread `base`, because serialized key order contributes to `journal_digest`:

```ts
function assetJournalEntry(
  request: AssetApplyRequest,
  base: BaseJournalEntry<WorkflowOccurrence>,
): AssetJournalEntry {
  const entry: AssetJournalEntry = {
    applyId: base.applyId,
    state: base.state,
    clusterId: base.clusterId,
    revisionId: base.revisionId,
    targetPath: base.targetPath,
    before: base.before,
    beforeDigest: base.beforeDigest,
    after: base.after,
    afterDigest: base.afterDigest,
    existedBefore: base.existedBefore,
    evidence: base.evidence,
    verdicts: base.verdicts,
    at: base.at,
    kind: "asset",
    lineage: {
      poolSnapshot: structuredClone(request.candidate.poolSnapshot),
      authoringInputsDigest: request.candidate.authoringInputsDigest,
      poolDigestAtAdmission: base.verdicts.length === 4
        ? currentAdmissionPoolDigest(base.verdicts)
        : failJournalConstruction(),
    },
    sourceMode: request.candidate.scope.sourceMode,
    ...(request.sourceTrust === null ? {} : { sourceTrust: request.sourceTrust }),
  };
  return entry;
}
```

That sketch exposes an S1 interface defect: `journalEntry(candidate, base)` receives verdicts but not the `AdmissionResult.poolDigest`, so `currentAdmissionPoolDigest(base.verdicts)` cannot be implemented honestly. S3 must make the smallest protocol correction before defining the adapter:

```ts
journalEntry(candidate: C, base: BaseJournalEntry<E>, admission: AdmissionResult): J;
```

The core passes the already-computed `admission`; the memory adapter ignores the third argument and remains byte-identical. The asset implementation uses `admission.poolDigest` directly. It must not recompute or smuggle the digest through a verdict. With that correction, the actual field is simply `poolDigestAtAdmission: admission.poolDigest`.

The exact transition artifacts are:

```ts
case "applying":
  return {
    journal_digest: sha(JSON.stringify(entry)),
    revision_id: entry.revisionId,
    evidence_ids: sha(canonicalJson(entry.evidence.map((o) => o.id))),
    verdicts: sha(canonicalJson(entry.verdicts)),
    pool_digest: entry.lineage.poolDigestAtAdmission,
    pool_snapshot: sha(canonicalJson(entry.lineage.poolSnapshot)),
    authoring_inputs_digest: entry.lineage.authoringInputsDigest,
    pool_digest_at_admission: entry.lineage.poolDigestAtAdmission,
    source_mode: entry.sourceMode,
    ...(entry.sourceTrust === undefined
      ? {}
      : { source_trust: entry.sourceTrust }),
  };
case "applied":
  return { after_digest: entry.afterDigest };
case "reverted":
  return { reverted_to: entry.beforeDigest };
case "aborted":
  return { aborted: "reconcile" };
```

`evidence_ids`, `verdicts`, and `pool_snapshot` are lowercase SHA-256 digests of canonical JSON, not ordinary `JSON.stringify`; `pool_digest` intentionally repeats `pool_digest_at_admission` because D4 names the former receipt artifact while D6 names the latter lineage field. `source_trust` is absent for workspace-derived evidence and exactly `"operator-asserted"` otherwise. Receipt derivation remains based only on the existing `applied` and `reverted` payloads, so recovery behavior stays in the S1 core.

## B. The four deterministic critics

Define this asset-local narrowing; it uses the same four literal names as the memory type at `ts/src/learn/apply.ts:40-50`:

```ts
type AssetCriticName =
  | "structural-validity"
  | "behavioral-harmlessness"
  | "semantic-consistency"
  | "subset-marginal-gain";

interface AssetVerdict {
  critic: AssetCriticName;
  passes: boolean;
  findings: string[];
}
```

`admitAsset` always runs all four in this order and never short-circuits:

```ts
const verdicts = [
  structuralValidity(candidate),
  behavioralHarmlessness(candidate),
  await semanticConsistency(candidate),
  subsetMarginalGain(candidate, pool),
];
return {
  admitted: verdicts.every((v) => v.passes),
  verdicts,
  candidateDigest: sha(candidate.rendered.content),
  poolDigest: pool.poolDigest,
};
```

### `structural-validity`

Parse only the flat frontmatter emitted by S2. No YAML package is added. `parseDraftFrontmatter` requires an opening `---` on line 1, one closing `---`, unique `key: value` lines, JSON string values for `name`/`description`, and the literal boolean `true`/`false` for `disable-model-invocation`. Blank lines, nested values, duplicate keys, multiline values, or invalid JSON make parsing fail. Body text is not interpreted as frontmatter.

The critic appends findings in this exact order:

```ts
if (candidate.schemaVersion !== "distill-2.1")
  findings.push("asset schema must be distill-2.1");
if (candidate.rendered.insertion.mode !== "create")
  findings.push("asset insertion mode must be create");
if (Buffer.byteLength(candidate.rendered.content, "utf8") > 16 * 1024)
  findings.push("rendered content exceeds 16 KB");
if (candidate.targetKind === "subagent")
  findings.push("subagent drafts have no non-delegation marker; not apply-eligible in v1");

const parsed = parseDraftFrontmatter(candidate.rendered.content);
if (parsed.kind === "missing") {
  findings.push("rendered content has no YAML frontmatter");
} else if (parsed.kind === "invalid") {
  findings.push("rendered frontmatter is not parseable");
} else {
  const fm = parsed.value;
  if (typeof fm.description !== "string" || fm.description.trim() === "")
    findings.push("frontmatter description is empty");
  if (fm["disable-model-invocation"] !== true)
    findings.push("frontmatter must set disable-model-invocation: true");

  if (candidate.targetKind === "skill") {
    if (fm.name !== candidate.assetName)
      findings.push("skill frontmatter name must equal assetName");
    if (basename(dirname(candidate.targetPath)) !== candidate.assetName)
      findings.push("skill assetName must equal target parent directory");
  }
  if (candidate.targetKind === "command") {
    if (Object.hasOwn(fm, "name"))
      findings.push("command frontmatter must omit name");
    if (basename(candidate.targetPath, ".md") !== candidate.assetName)
      findings.push("command filename must equal assetName");
  }
}
```

The D3 rule is an unconditional marker requirement for a valid S2 candidate. Although the design phrases it as marker-or-real-trigger, S2 emits a constant non-trigger description and `verifyCandidateIdentity` reconstructs those exact bytes. S3 does not invent a trigger-language classifier or accept a mutated body. The fixed subagent finding is exactly `"subagent drafts have no non-delegation marker; not apply-eligible in v1"`.

### `behavioral-harmlessness`

Use the existing `HAZARDS` policy exactly as written at `ts/src/learn/apply.ts:64-76`, with the same regexes, order, and finding strings. Because S1 deliberately leaves that constant memory-private, S3 declares an asset-local copy in `distill/apply.ts`; it does not import through the memory adapter and does not extend the list. An asset-specific extension would silently make the two adapters disagree about the already-settled destructive commands and immutable-core paths, while instructions are precisely the content on which the existing denylist is most important.

Code shape:

```ts
for (const [pattern, description] of ASSET_HAZARDS) {
  pattern.lastIndex = 0;
  if (pattern.test(candidate.rendered.content)) findings.push(description);
}
```

The verdict is `{ critic: "behavioral-harmlessness", passes: findings.length === 0, findings }`. There is no model call, severity score, or advisory mode.

### `semantic-consistency`

This critic re-harvests every cited transcript with `loadSessions(projectDir, { windowDays: 0 })` (`ts/src/distill/harvest.ts:15-24`), normalizes observations with `toolSteps` (`ts/src/distill/detector.ts:34-36`), reconstructs each occurrence with `occurrenceId` and `description` (`detector.ts:37-48`), and reconstructs the complete candidate evidence view with `workflowFromEvidence` (`detector.ts:49-59`). `windowDays: 0` is required: admission validates cited evidence, not whether it still falls within the default 30-day discovery window.

For each occurrence, locate the exact session by both `sessionId` and `transcriptFile`, then locate every step by the pair `(lineNo, blockIndex)`. Rebuild the occurrence-level `cwd` with the detector rule at `detector.ts:71`, and compare these seven normalized step fields by `canonicalJson`, as one object and in this exact field set:

```ts
{
  toolName: step.toolName,
  canonicalInput: step.canonicalInput,
  lineNo: step.lineNo,
  blockIndex: step.blockIndex,
  toolUseId: step.toolUseId,
  cwd: step.cwd,
  lineDigest: step.lineDigest,
}
```

The critic appends these fixed findings and continues where doing so remains meaningful:

```ts
`evidence ${occurrence.id}: transcript file is missing or unreadable`
`evidence ${occurrence.id}: cited line or block moved`
`evidence ${occurrence.id}: normalized step does not match transcript`
`evidence ${occurrence.id}: occurrence cwd does not match transcript`
`evidence ${occurrence.id}: occurrence id does not match re-harvested evidence`
`evidence ${occurrence.id}: workflow description does not match re-harvested evidence`
"candidate workflow does not match re-harvested evidence"
`recurrence claims ${candidate.recurrence.records} records, evidence carries ${candidate.evidence.length}`
`recurrence claims ${candidate.recurrence.distinctSessions} sessions, evidence carries ${actualDistinctSessions}`
"evidence project directory does not match candidate scope"
```

Any thrown harvest/read/normalization error becomes the first transcript finding for that occurrence; it is never converted to an empty successful harvest. Missing file, skipped/unreadable file, moved line/block, duplicate locator, missing locator, extra re-resolved locator, any of the seven field mismatches, occurrence-level `cwd` mismatch, occurrence-id mismatch, description mismatch, or rebuilt workflow/scope/evidence/recurrence/source-handle mismatch makes the verdict fail.

The final whole-view comparison is:

```ts
const rebuilt = workflowFromEvidence(resolvedEvidence);
canonicalJson({
  workflow: rebuilt.workflow,
  scope: rebuilt.scope,
  evidence: rebuilt.evidence,
  recurrence: rebuilt.recurrence,
  sourceHandle: rebuilt.sourceHandle,
}) === canonicalJson({
  workflow: candidate.workflow,
  scope: {
    transcriptProjectDir: candidate.scope.transcriptProjectDir,
    observedCwds: candidate.scope.observedCwds,
  },
  evidence: candidate.evidence,
  recurrence: candidate.recurrence,
  sourceHandle: candidate.sourceHandle,
});
```

A subset comparison is insufficient because `occurrenceId` actually binds `sourceKind`, `projectDir`, `sessionId`, `transcriptFile`, and only each step's `lineNo`, `blockIndex`, and `lineDigest` (`detector.ts:37-39`). It does **not** bind `toolName`, `canonicalInput`, `toolUseId`, step `cwd`, or occurrence `cwd`. Therefore an attacker can alter only `canonicalInput` or `cwd`, recompute the unkeyed candidate hashes, leave the cited line digest and occurrence id unchanged, and pass identity-only or occurrence-id-only validation. Re-harvesting and comparing the complete seven-field normalized step closes that gap.

### `subset-marginal-gain`

The critic consumes the path-keyed `AssetPoolView` from §C and appends all applicable findings in this order:

```ts
const sameName = pool.byName.get(candidate.assetName) ?? [];
if (sameName.length > 0) {
  findings.push(
    `pool already contains asset name ${JSON.stringify(candidate.assetName)} at ${sameName.join(", ")}`,
  );
}
const contentDigest = sha(candidate.rendered.content);
const sameDigest = pool.byDigest.get(contentDigest) ?? [];
if (sameDigest.length > 0) {
  findings.push(`pool already contains identical content at ${sameDigest.join(", ")}`);
}
if (pool.target.existed) {
  findings.push("target path already exists; asset apply is create-only");
}
```

`byName` and `byDigest` are multimaps whose path arrays are already sorted. A `Map<name, entry>` is wrong: `.claude/skills/foo/SKILL.md`, `.claude/agents/foo.md`, and `.claude/commands/foo.md` can coexist on disk. A later insertion would overwrite the earlier record, making the collision report incomplete and, if digest indexing were derived from that map, dropping content from duplicate detection. `entries`, keyed by path, is authoritative; indexes never own or discard entries.

## C. `PoolView` construction and `poolDigest`

The opaque `PoolView.admissionInput` contains:

```ts
interface AssetPoolEntry {
  kind: AssetKind;
  name: string;
  contentDigest: string;
}

interface AssetPoolView {
  target: { content: string; existed: boolean };
  entries: Map<string, AssetPoolEntry>;
  byName: Map<string, string[]>;
  byDigest: Map<string, string[]>;
  poolDigest: string;
}
```

`buildAssetPool(applyRoot, target)` runs only after both adapter locks are held. It performs these operations:

1. Read `target` as UTF-8 for the one S1 `PoolView.target` snapshot. Only `ENOENT` becomes `{ content: "", existed: false }`; permission, directory, encoding/I/O, or symlink errors fail closed.
2. Inspect `.claude/skills`, `.claude/agents`, and `.claude/commands` in that fixed kind order. A missing directory contributes no entries. Any other enumeration error fails admission.
3. Skills contribute only direct `<name>/SKILL.md` regular files. Agents and commands contribute only direct `*.md` regular files. Do not follow symlink directories or symlink files; encountering one at a discoverable asset location is an error, not an omission. Ignore unrelated non-discoverable files.
4. Derive the runtime name as the skill parent directory or the agent/command filename without `.md`. Key `entries` by the canonical absolute file path returned by `realpath`; require it to remain beneath the corresponding real allowlist root.
5. Hash the exact file bytes with SHA-256 lowercase hex. The content digest is byte-based; it does not normalize UTF-8, line endings, or frontmatter.
6. Sort the collected records by code-unit path order using `compare` (`ts/src/distill/harvest.ts:9`). Insert into `entries` in that order. Build `byName` and `byDigest` from the ordered records and sort every path array with the same comparator.
7. Compute `poolDigest` as:

   ```ts
   sha(canonicalJson(records.map(({ path, kind, name, contentDigest }) => ({
     path,
     kind,
     name,
     contentDigest,
   }))))
   ```

The ordered `records` array, not `Map` serialization or directory enumeration order, is the hash input. Consequently the digest is stable across filesystem enumeration order. If all three directories are absent, `entries`, both indexes, and `records` are empty and `poolDigest === sha("[]")`; the separately read target is also absent for an allowlisted create target.

The protocol-facing return is:

```ts
return {
  target: assetPool.target,
  admissionInput: assetPool,
};
```

## D. Allowlist, locking, and guard registration

### Shared realpath mechanics and asset-owned policy

Create `ts/src/apply/paths.ts` and move, without semantic changes, these two helpers from `learn/apply.ts`:

```ts
export function realpathOrSelf(path: string): Promise<string>;
export function realpathThroughMissing(path: string): Promise<string>;
```

Their current bodies are at `ts/src/learn/apply.ts:298-320`. Both the memory and asset adapters import them. This is the controller override to S1 correction #1. The helpers provide path mechanics only: the memory adapter retains the `.stratum/learn` and `.md` policy at `learn/apply.ts:275-296`; the asset adapter owns the rules below.

`assertAssetAllowlisted(applyRoot, targetPath)`:

1. Requires `applyRoot` to be absolute, existing, a directory, and equal to its realpath. Resolve `targetPath` and require a `.md` suffix.
2. If `<applyRoot>/.claude` exists, reject it when `lstat(...).isSymbolicLink()` with `".claude must not be a symbolic link"`. Then require its realpath to remain under the real workspace root. A missing `.claude` is allowed because apply may create it.
3. Form the three allowed roots under real `<applyRoot>/.claude`: `skills`, `agents`, and `commands`. For each existing root, reject a symlink and require its realpath to remain inside the real workspace. For a missing root, retain its lexical path through `realpathOrSelf`.
4. Resolve the target through its deepest existing ancestor with shared `realpathThroughMissing`. Accept only one exact shape:
   - skill: `<skills>/<slug>/SKILL.md`;
   - agent: `<agents>/<slug>.md`;
   - command: `<commands>/<slug>.md`.
   The slug must match `^[a-z0-9]+(?:-[a-z0-9]+)*$`. No nested command/agent path and no extra file in a skill directory is accepted.
5. Return the resolved target. Otherwise throw `new ApplyError(`target is outside the asset allowlist: ${realTarget}`)`.

The allowlist deliberately recognizes agents for safe pool inspection and recovery-path validation, even though structural admission refuses every new subagent in v1. It never accepts `~/.claude`, `.stratum`, `ts/src`, specs, or docs.

### Lock order

The S1 core calls `allowlist` before `locks`, so `target` is already the resolved target. It nests the returned resources in array order through the callback-shaped, one-resource-per-call API exported at `ts/src/guard/lock.ts:385-391`:

```ts
return resourceLock(poolResource, () =>
  resourceLock(targetResource, () => action()),
);
```

The outer resource is ``distill-pool-${sha(realpathSync(applyRoot))}``; the inner resource is ``distill-target-${sha(target)}``. Both hashes are full 64-character lowercase SHA-256. The target lock releases first and the pool lock releases last by callback unwinding. The core must not sort, truncate, parallelize, or independently release this list.

Apply holds both continuously across unreconciled-journal inspection, pool listing, all four critics, journal preparation, guard registration, CAS re-read, target write, ledger commit, and final journal update. Revert takes the same pair around its target CAS, ledger transition, restore, and journal update. Reconcile takes the same pair for each journal entry before receipt/target inspection and holds it through that entry's recovery action. This serializes every asset pool mutation and keeps the nesting order identical across apply, revert, and reconcile.

`locks` is synchronous in S1 (`blueprint-s1.md:143`), so S3 must use `realpathSync` after the async allowlist has validated the root. An async `realpath` call cannot compile in that member without changing the settled interface.

### Guard registration

`registerGuard` takes all eight arguments at `ts/src/guard/transition.ts:396-404`; `GuardRegistration` carries the seven non-resource arguments. The asset adapter supplies:

```ts
{
  graph: {
    staged: ["applying", "aborted"],
    applying: ["applied", "aborted"],
    applied: ["reverted"],
    aborted: [],
    reverted: [],
  },
  edgePredicates: {},
  initial: "staged",
  terminal: ["aborted", "reverted"],
  stakes: {},
  workspaceRoot: null,
  policyBundle: undefined,
}
```

The empty predicate map is intentional: v1's shell flag is an operator convention, not a human-bound guard authorization. D4's falsifier seam is the existing `edgePredicates` member: once a non-agent-mintable grant evidence kind exists, only `"staged->applying"` gains that predicate (and the corresponding `workspaceRoot`, `stakes`, or `policyBundle` values if its evidence requires them). S3 does not invent or plan that predicate.

## E. Provenance admission

The asset wrapper constructs `AssetApplyRequest`; the adapter's `verifyIdentity` hook performs provenance checks before any allowlist, lock, pool read, journal write, or guard write:

- `candidate.scope.workspaceRoot === request.applyRoot` is unconditional and uses exact string equality.
- `sourceMode === "workspace"` additionally re-derives and matches the workspace transcript directory; it needs no trust artifact.
- `sourceMode === "explicit-project"` or `"projects-root"` requires `request.sourceTrust === "operator-asserted"`, otherwise it throws ``source mode ${candidate.scope.sourceMode} requires --trust-source``.

S4's only provenance interface is `AssetApplyOptions.trustSource?: boolean`: `--trust-source` maps to `true` and absence maps to `false`/`undefined`. S3 records accepted non-workspace provenance in the prepared journal as `sourceTrust: "operator-asserted"` and in the applying transition as `source_trust: "operator-asserted"`; every applying transition records `source_mode: entry.sourceMode`. S3 stops at that library interface and does not plan S4's option parser or display.

`sourceMode` is identity-bound by S2 through `scope` and `authoringInputsDigest` (`blueprint-s2.md:80-95`), but the digest is not an authenticity proof. That is why S3 both re-derives the workspace source path and fully re-harvests the cited evidence.

## F. Test plan

Add `ts/tests/distill/apply.test.ts` and a single reusable reconcile matrix helper under `ts/tests/apply/reconcile-matrix.ts`. Tests use temporary absolute workspace roots, real files, the real cross-process lock, and the real `.stratum/guard` store. Candidate fixtures are authored through S2 `authorCandidate` from real transcript JSONL fixtures, except for explicitly malformed structural cases and the one impossible-by-construction collision race described below. Every enabled apply test clears both enable variables first and opts in explicitly.

Required focused tests, with their real-shaped fixture:

```ts
it("is default OFF even when STRATUM_LEARN_APPLY_ENABLED=1", async () => { /* identity-valid distill-2.1 workspace candidate; assert no .claude target, journal, or distill guard resource */ });
it("uses STRATUM_DISTILL_APPLY_ENABLED independently of the learn flag", async () => { /* same fixture; distill flag admits */ });
it("refuses a symlinked .claude directory", async () => { /* .claude symlink to another temp directory, identity-valid candidate targeting its lexical skill path */ });
it("refuses a target outside .claude skills agents and commands", async () => { /* re-authored candidate-shaped row targeting <root>/docs/x.md; identity verifier stubbed only to reach allowlist */ });
it("never overwrites an existing asset", async () => { /* pre-create exact target with sentinel bytes; assert bytes unchanged and no commit */ });
it("accepts a missing asset directory as an empty deterministic pool", async () => { /* no .claude dirs; assert sha(\"[]\") pool digest */ });
```

Structural critic cases each start from an identity-valid S2 skill or command candidate, mutate only the named field/content, and call the critic directly so the malformed shape reaches the intended gate:

```ts
it("structural-validity refuses missing frontmatter", async () => {});
it("structural-validity refuses unparseable frontmatter", async () => {});
it("structural-validity refuses an empty description", async () => {});
it("structural-validity enforces the D3 non-routing marker", async () => {});
it("structural-validity refuses subagent with the fixed finding", async () => {});
it("structural-validity refuses rendered content over 16 KB", async () => {});
it("structural-validity refuses non-create insertion", async () => {});
it("structural-validity refuses schemas other than distill-2.1", async () => {});
it("structural-validity requires skill name to equal assetName and parent directory", async () => {});
it("structural-validity requires command frontmatter to omit name", async () => {});
it("structural-validity requires command filename to equal assetName", async () => {});
```

The subagent assertion is exact:

```ts
expect(verdict.findings).toContain(
  "subagent drafts have no non-delegation marker; not apply-eligible in v1",
);
```

The other three critics receive at least one complete real-shaped rejection plus their boundary cases:

```ts
it("behavioral-harmlessness reports the existing hazard finding unchanged", async () => { /* identity-valid rendered draft whose observed data contains git reset --hard; expect exact HAZARDS message */ });
it("semantic-consistency accepts an unchanged full re-harvest", async () => { /* two real sessions, real JSONL tool_use rows */ });
it("semantic-consistency fails closed when a cited transcript line is edited", async () => { /* author, then rewrite one cited raw line */ });
it("semantic-consistency fails closed when a cited transcript is deleted", async () => { /* author, unlink one <session>.jsonl */ });
it("semantic-consistency fails closed when only canonicalInput is changed in a rehashed row", async () => { /* preserve occurrence id/lineDigest, recompute authoringInputsDigest and revisionId */ });
it("semantic-consistency fails closed when only cwd is changed in a rehashed row", async () => { /* change step and occurrence/scope cwd consistently enough to pass identity, preserve occurrence id, then rehash */ });
it("semantic-consistency fails closed when a cited line or block moves", async () => { /* insert/reorder JSONL so locator no longer resolves */ });
it("subset-marginal-gain refuses a name collision in any asset kind", async () => { /* candidate skill plus pre-existing command with the same runtime name */ });
it("subset-marginal-gain reports every path for a duplicated name", async () => { /* skill, agent, and command named foo; assert sorted three-path finding */ });
it("subset-marginal-gain refuses an identical digest under a different name", async () => { /* different path/name, exact candidate bytes */ });
it("subset-marginal-gain refuses an existing empty target", async () => { /* zero-byte target proves existence, not truthiness, controls create-only */ });
```

The rehashed drift fixtures use the same canonical hash functions and post-S2 candidate shape; each test first asserts `verifyCandidateIdentity(mutated) === true`, then asserts admission fails. This proves the semantic critic, rather than identity validation, closes the gap. It does not weaken an assertion.

Provenance and lineage tests:

```ts
it("refuses explicit-project source without trustSource", async () => {});
it("admits explicit-project source with trustSource and records source_trust and source_mode", async () => {});
it("refuses projects-root source without trustSource", async () => {});
it("refuses a workspace sourceMode that does not match the derived transcript directory", async () => {});
it("refuses when candidate scope.workspaceRoot differs from applyRoot", async () => {});
it("writes an asset journal whose lineage poolSnapshot is []", async () => { /* assert the array itself, authoringInputsDigest, and poolDigestAtAdmission */ });
it("records source_mode without source_trust for workspace evidence", async () => {});
```

Allowlist/transaction/locking tests:

```ts
it("writes exactly the admitted bytes to the admitted path", async () => { /* compare Buffer bytes, journal targetPath, ledger modifiedFiles */ });
it("uses distill-apply namespace and the full empty-predicate guard registration", async () => {});
it("acquires the pool lock outside the target lock and releases in reverse", async () => { /* instrument only the lock callback order; retain real lock integration test below */ });
it("two concurrent applies of same-named candidates to different kinds allow exactly one commit", async () => {});
it("revert takes the pool and target locks and restores prior non-existence", async () => {});
it("reconcile takes the pool and target locks for each journal entry", async () => {});
```

The same-name/different-kind full race cannot be produced by S2 authoring: `selectedForm` is part of `clusterId` (`ts/src/distill/candidate.ts:64-68`), and the first 12 cluster hex characters are part of `assetName`; asking `authorCandidate` for skill and command therefore produces different names except for an impractical 48-bit collision. For this one lock-isolation test, use two structurally complete post-S2 candidate objects with the same runtime name and valid rendered frontmatter, and a Vitest module stub that returns `true` only from `verifyCandidateIdentity` for those two frozen fixtures. Do not alter or add a bypass to production code. Run the real `applyAssetCandidate`, critics, filesystem, journal, guard store, and resource locks concurrently; assert `Promise.allSettled` has one fulfillment and one `ApplyRefused`, exactly one target exists, exactly one journal is `applied`, and exactly one `distill-apply-*` ledger commits. A separate test with ordinary authored candidates pins the real identity verifier.

### Parameterized reconcile matrix

Define one table-driven `runReconcileMatrix(adapterHarness)` and invoke it for `memory` and `asset`; do not copy the scenarios into a second asset-only suite. Keep `ts/tests/learn/apply.test.ts` byte-for-byte unchanged as S1 requires, and place this shared protocol matrix beside S1's protocol compatibility tests. The asset harness varies only journal directory, allowlist target, guard namespace/registration, locks, and journal extension fields.

Parameterize every memory recovery case whose expected outcome is defined by `(journal state, receipt, current target)` rather than memory Markdown rendering:

- prepared/applying + absent receipt + before bytes -> abort and `rolledBack`;
- prepared/applying + absent receipt + after bytes -> restore, abort, and `rolledBack`;
- either of those + third-state bytes -> `diverged` with no mutation;
- applying + committed applied receipt + before bytes -> redo `after` and `completed`;
- applying + committed applied receipt + after bytes -> finish journal and `completed`;
- applied + matching applied receipt + after bytes -> settled no-op;
- reverting/applied + absent revert receipt + after bytes -> preserve apply and `completed`;
- any live state + committed reverted receipt + after bytes -> restore and `reverted`;
- any live state + committed reverted receipt + matching before bytes/existence -> finish journal and `reverted`;
- any committed receipt + third-state bytes -> `diverged`;
- unreadable/truncated ledger -> `diverged` with no mutation;
- allowlist revalidation failure -> `diverged` with no mutation;
- created-target rollback removes the file, while existed-before rollback restores exact bytes.

Memory-only byte fixtures, Markdown insertion tests, memory critic tests, and `learn-*` exact error strings remain in memory tests and are not parameterized. Asset-only pool, provenance, frontmatter, hazard, and full re-harvest tests remain in `tests/distill/apply.test.ts`.

## G. Ordered implementation steps

1. **Share path mechanics without moving policy.** Create `ts/src/apply/paths.ts`; move the two helper bodies; update only their imports/call sites in `learn/apply.ts`. Run typecheck and the unchanged memory apply suite.
2. **Pass admission into journal construction.** Change the S1 protocol `journalEntry` call/signature to include the already-computed `AdmissionResult`; make the memory adapter ignore it. Add a byte-identity assertion showing memory prepared journal and `journal_digest` do not move.
3. **Add asset types, preflight, allowlist, pool, and four critics.** Create `ts/src/distill/apply.ts`; first prove critic/allowlist/pool tests with no transaction write.
4. **Wire the complete asset adapter.** Add journal construction, lineage/provenance artifacts, guard registration, nested locks, and thin apply/revert/reconcile wrappers. Run focused asset and protocol matrix tests after each transaction surface.
5. **Final S3 gate.** Run typecheck, unchanged memory tests, protocol compatibility/matrix tests, and the asset suite. Inspect the diff: only `src/apply/paths.ts`, the narrow S1 integration edits in `src/apply/protocol.ts` and `src/learn/apply.ts`, `src/distill/apply.ts`, and S3 tests/helpers may change. No CLI, candidate/runner, MCP contract, CHANGELOG, package/dependency, or S4 golden-flow file belongs in this slice.

## Corrections

1. Controller override: S1 correction #1 (`blueprint-s1.md:331`) says `realpathOrSelf` and `realpathThroughMissing` remain memory-private. They instead move unchanged to `ts/src/apply/paths.ts` and are imported by both adapters. Path policy remains adapter-owned.
2. D7's `guard/lock.ts:237` anchor is wrong. The callback-shaped exported `resourceLock` is at `ts/src/guard/lock.ts:385-391` and takes one resource per call.
3. D7's `learn/apply.ts:364` anchor calls out a comment, not a lock call. The actual memory apply and revert call sites are `ts/src/learn/apply.ts:368` and `:552`.
4. D5 says to re-run `loadSessions`/`description`/`workflowFromEvidence` “over the cited lines” but does not state that the default harvester window is 30 days (`harvest.ts:16-18`). Admission must pass `{ windowDays: 0 }` or old but still cited evidence disappears for age rather than drift.
5. D5 says `occurrenceId` binds neither `canonicalInput` nor `cwd`; it is broader than that. The real hash at `detector.ts:37-39` also omits `toolName`, `toolUseId`, and occurrence-level `cwd`. S3 compares all seven step fields plus occurrence `cwd` and the rebuilt whole view.
6. D5 says “frontmatter absent or unparseable” but does not define a parser or duplicate/multiline behavior. S3 uses a dependency-free strict parser for S2's flat emitted subset and fails closed on everything outside it.
7. D3's marker-or-trigger phrasing is under-specified for deterministic admission because there is no trigger-language classifier. Under S2 identity, valid v1 bytes always use the constant draft description and marker, so S3 requires `disable-model-invocation: true` unconditionally.
8. D5's 16 KB cap does not say characters or bytes. S3 uses `Buffer.byteLength(content, "utf8") > 16 * 1024`, because the installed artifact and journal digests bind bytes.
9. D5/D7 do not say how unreadable pool entries or non-`ENOENT` target reads behave. S3 fails closed; only a genuinely missing directory/file is treated as absent.
10. D7 says `.claude` must resolve inside the workspace, while §4 explicitly requires a symlinked `.claude` to be refused. S3 follows the stronger acceptance criterion and rejects `.claude` whenever it is itself a symlink, even if it points back inside the workspace.
11. S1's synchronous `locks(workspaceRoot, target): string[]` (`blueprint-s1.md:143`) cannot await the D7-required `realpath(root)`. S3 uses `realpathSync` after async allowlist validation; changing `locks` to async would be a wider protocol change.
12. S1's `journalEntry(candidate, base)` omits `AdmissionResult`, but D6 requires `poolDigestAtAdmission` copied at prepare time. It cannot be recovered from `base.verdicts` or safely recomputed. The compiling/correct signature adds `admission: AdmissionResult`; the memory adapter ignores it, preserving bytes.
13. D5a says `sourceMode` is identity-bound, but `verifyCandidateIdentity` rebuilds from candidate-owned values (`candidate.ts:88-94`) and the hashes are unkeyed. A rehashed row can falsely relabel an arbitrary project as `workspace`; S3 therefore re-derives the workspace transcript directory before granting no-trust admission.
14. D6 asks revert to list descendants even while proving the set is empty. Lineage traversal and CLI descendant output are outside S3 and explicitly excluded by §3. S3 records the complete empty lineage (`poolSnapshot: []`) so S4 may print the settled constant result; the adapter does not scan descendants.
15. The §4 concurrency fixture (“same-named candidates to different kinds”) is not constructible through identity-valid S2 authoring because `selectedForm` contributes to `clusterId` and therefore `assetName` (`candidate.ts:64-68`). The test uses a verifier stub for exactly two frozen, real-shaped collision fixtures while retaining real critics, files, guards, locks, and transactions; production identity validation is neither weakened nor given a bypass.
16. The design's shorthand guard registration omits real parameters. `registerGuard` actually takes `graph`, `edgePredicates`, `initial`, `terminal`, `stakes`, `workspaceRoot`, and `policyBundle` after `resourceId` (`transition.ts:396-404`). S3 supplies all seven explicitly, including `{}`, `null`, and `undefined`.
17. S2 correction #5 observes that command frontmatter omission of `name` comes from D5 rather than D3 (`blueprint-s2.md:279`). S3 enforces that split and derives the command runtime name from the filename; it does not reintroduce shared frontmatter.

## Tests

| Changed code | Test file | Action |
|---|---|---|
| `ts/src/apply/paths.ts`, `ts/src/learn/apply.ts` | `ts/tests/learn/apply.test.ts`, S1 protocol compatibility test | Run unchanged memory regression and byte-identity checks |
| `ts/src/apply/protocol.ts` | `ts/tests/apply/reconcile-matrix.ts` | Add one matrix parameterized over memory and asset harnesses |
| `ts/src/distill/apply.ts` | `ts/tests/distill/apply.test.ts` | Add critic, re-harvest, provenance, allowlist, pool, lock, journal, guard, revert, and reconcile coverage |

Commands from `ts/`:

```bash
npx tsc --noEmit
npx vitest run tests/learn/apply.test.ts
npx vitest run tests/apply/protocol-memory-compat.test.ts tests/apply/reconcile-matrix.test.ts
npx vitest run tests/distill/apply.test.ts
```

Do not weaken any existing assertion, edit `ts/tests/learn/apply.test.ts`, or use mocked filesystem/guard backends.

## Documentation

- No documentation file changes in S3.
- `CHANGELOG.md`, `stratum distill --help`, the MCP contract description/test, and the end-to-end golden flow are explicitly owned by S4 and stop at the `AssetApplyOptions`/wrapper interfaces named above.
