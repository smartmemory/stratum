# STRAT-DISTILL-APPLY S1 implementation blueprint

Status: plan only. This blueprint covers only the future extraction of the candidate-agnostic apply protocol and the byte-identical memory adapter. It does not plan the distill schema, asset adapter, or CLI slices.

The baseline is green before the refactor: from `ts/`, `npx tsc --noEmit` succeeds and `npx vitest run tests/learn/apply.test.ts` passes all 30 tests without modifications.

## A. Function-by-function split

“Re-export” below means a literal export from `learn/apply.ts` with no signature change. “Wrapper” means the public memory signature stays in `learn/apply.ts`, but delegates to a differently named, adapter-first protocol function; those functions cannot be literal re-exports.

| Current top-level symbol | Current anchor | Destination | Why |
|---|---:|---|---|
| `ApplyError` | `ts/src/learn/apply.ts:23` | `apply/protocol.ts`; re-export from `learn/apply.ts` | All adapters and the shared recovery core need one error identity; re-export preserves current imports and `instanceof`. |
| `ApplyRefused` | `ts/src/learn/apply.ts:24` | `apply/protocol.ts`; re-export from `learn/apply.ts` | Refusal is protocol-wide, while the memory wrapper preserves the current messages. |
| `ApplyOptions` | `ts/src/learn/apply.ts:26` | `apply/protocol.ts`; re-export from `learn/apply.ts` | The explicit `enabled?: boolean` override is common protocol input. |
| `isEnabled` | `ts/src/learn/apply.ts:31` | `learn/apply.ts` memory adapter | It reads the memory-only `STRATUM_LEARN_APPLY_ENABLED` flag. Expose it to the adapter as `enabled`; do not export it. |
| `CriticName` | `ts/src/learn/apply.ts:40` | `learn/apply.ts` memory adapter | Its four literal names describe memory-note critics. Keep its current public export. |
| `Verdict` | `ts/src/learn/apply.ts:46` | `learn/apply.ts` memory adapter | Its `critic` member is the memory-only `CriticName`. Keep its current public export and use it to narrow the memory `JournalEntry`. |
| `AdmissionResult` | `ts/src/learn/apply.ts:52` | Agnostic base in `apply/protocol.ts`; narrower public specialization in `learn/apply.ts` | The core needs the four fields with `critic: string`, while the existing memory export must retain `verdicts: Verdict[]`. |
| `HAZARDS` | `ts/src/learn/apply.ts:64` | `learn/apply.ts` memory adapter | These patterns police memory-note prose and named memory/guard paths. |
| `structuralValidity` | `ts/src/learn/apply.ts:78` | `learn/apply.ts` memory adapter | It directly reads `PatchCandidate.rendered`, `targetKind`, and `evidence`. |
| `behavioralHarmlessness` | `ts/src/learn/apply.ts:89` | `learn/apply.ts` memory adapter | It applies the memory-specific `HAZARDS` to rendered note content. |
| `semanticConsistency` | `ts/src/learn/apply.ts:101` | `learn/apply.ts` memory adapter | It knows the memory candidate's flow, recurrence, and `FailureRecord.runId` structure. |
| `subsetMarginalGain` | `ts/src/learn/apply.ts:128` | `learn/apply.ts` memory adapter | It compares note text and memory markers against the target-file pool. |
| `noteSubject` | `ts/src/learn/apply.ts:157` | `learn/apply.ts` memory adapter | Its regex parses the current generated memory-note sentence format. |
| `verifyIdentity` | `ts/src/learn/apply.ts:163` | `learn/apply.ts` memory adapter | It hashes `PatchCandidate` fields and validates memory evidence recurrence. Keep its current public export. |
| `admit` | `ts/src/learn/apply.ts:187` | `learn/apply.ts` memory adapter | It selects and orders the four memory critics and computes their current digests. Keep its current public export. |
| `JournalState` | `ts/src/learn/apply.ts:206` | `apply/protocol.ts`; re-export from `learn/apply.ts` | The state machine is shared by the journal/ledger protocol. |
| `JournalEntry` | `ts/src/learn/apply.ts:214` | `learn/apply.ts` memory adapter | Define it as `BaseJournalEntry<FailureRecord>` with `verdicts: Verdict[]`; it remains a memory public type, not a protocol re-export. |
| `journalDir` | `ts/src/learn/apply.ts:231` | `learn/apply.ts` memory adapter | `.stratum/learn/applies` is adapter-owned. Keep its current public export. |
| `journalPath` | `ts/src/learn/apply.ts:235` | `learn/apply.ts` memory wrapper | The protocol helper requires an adapter; retain the current two-argument public function and delegate using the memory adapter. |
| `readJournal` | `ts/src/learn/apply.ts:239` | `learn/apply.ts` memory wrapper | Parsing/recovery iteration moves to the generic core, while the public one-argument function must still return `Promise<JournalEntry[]>`. |
| `writeJournal` | `ts/src/learn/apply.ts:257` | `apply/protocol.ts` agnostic core | Atomic pretty-printed journal persistence is common, parameterized by `adapter.journalDir`. Keep it private to the protocol. |
| `assertAllowlisted` | `ts/src/learn/apply.ts:275` | `learn/apply.ts` memory adapter | The `.md` rule, `.stratum/learn` root, and error names are memory policy. |
| `realpathOrSelf` | `ts/src/learn/apply.ts:298` | `learn/apply.ts` memory adapter | Contrary to D1's classification, this is used only to implement the adapter-owned memory allowlist. Moving it to the protocol would put memory path policy in the core. |
| `realpathThroughMissing` | `ts/src/learn/apply.ts:307` | `learn/apply.ts` memory adapter | Contrary to D1's classification, this is likewise an allowlist implementation detail, not journal/ledger/CAS protocol. |
| `renderAfter` | `ts/src/learn/apply.ts:324` | `learn/apply.ts` memory adapter | It understands memory-note insertion modes and Markdown section placement. Keep its current public export. |
| `AppliedResult` | `ts/src/learn/apply.ts:345` | `apply/protocol.ts`; re-export from `learn/apply.ts` | The returned apply id, ledger ref, and resolved target are protocol outputs. |
| `applyCandidate` | `ts/src/learn/apply.ts:351` | Algorithm in `apply/protocol.ts`; same-signature wrapper in `learn/apply.ts` | The transaction is generic after all candidate reads and policy values go through the adapter. A wrapper is required to preserve `(PatchCandidate, ApplyOptions)`. |
| `Receipt` | `ts/src/learn/apply.ts:451` | `apply/protocol.ts`; re-export from `learn/apply.ts` | Ledger authority has the same committed/absent/unreadable result for every journal kind. |
| `ledgerReceipt` | `ts/src/learn/apply.ts:464` | Algorithm in `apply/protocol.ts`; same-signature wrapper in `learn/apply.ts` | Digest re-derivation is generic, but current callers pass only `JournalEntry`; the wrapper injects the adapter. |
| `guardState` | `ts/src/learn/apply.ts:524` | `apply/protocol.ts` agnostic core | It reads the adapter-selected guard resource to choose a legal abort edge. Keep it private. |
| `revertApply` | `ts/src/learn/apply.ts:538` | Algorithm in `apply/protocol.ts`; same-signature wrapper in `learn/apply.ts` | Compare-and-swap revert is common; the wrapper preserves `(applyId, workspaceRoot, ApplyOptions)`. |
| `restore` | `ts/src/learn/apply.ts:576` | `apply/protocol.ts` agnostic core | Restoring exact bytes or prior non-existence depends only on the base journal. Keep it private. |
| `ReconcileReport` | `ts/src/learn/apply.ts:589` | `apply/protocol.ts`; re-export from `learn/apply.ts` | Recovery counters are shared protocol output. |
| `reconcile` | `ts/src/learn/apply.ts:600` | Algorithm in `apply/protocol.ts`; same-signature wrapper in `learn/apply.ts` | The ledger-authoritative recovery matrix is common; the wrapper preserves `(workspaceRoot, ApplyOptions)`. |
| `abort` | `ts/src/learn/apply.ts:692` | `apply/protocol.ts` agnostic core | Abort is part of generic recovery and becomes a protocol export with an adapter parameter as D1 requests. |
| `guardResource` | `ts/src/learn/apply.ts:710` | `learn/apply.ts` memory adapter | `learn-apply-` is an observable memory namespace. |
| `readTarget` | `ts/src/learn/apply.ts:714` | `apply/protocol.ts` agnostic core | Exact target re-reads for pre-write CAS, revert, and reconciliation are common. Keep it private. |
| `atomicWriteFile` | `ts/src/learn/apply.ts:722` | `apply/protocol.ts` agnostic core | Atomic target writes are common journal protocol mechanics. Keep it private. |
| `sha` | `ts/src/learn/apply.ts:729` | `apply/protocol.ts` agnostic core, plus a private memory-local equivalent | Protocol digests and ids need it, while identity, admission, and lock/resource values in the adapter also need the identical SHA-256 operation. A small duplicate private helper avoids exporting core internals; changing either implementation is forbidden. |

The D1 error on the two realpath helpers is intentional: D1 simultaneously makes `allowlist` adapter-owned and assigns its private implementation helpers to the core. Actual call sites at `ts/src/learn/apply.ts:279` and `ts/src/learn/apply.ts:291` show that they belong with the memory allowlist.

## B. Concrete protocol signatures

Create `ts/src/apply/protocol.ts`. These are the planned exported declarations. `journalPath` and `readJournal` are exported solely so the memory module can keep thin same-signature wrappers; journal writes, target reads/writes, lock nesting, guard-state lookup, and hashing remain private.

```ts
import { registerGuard } from "../guard/transition.js";

export class ApplyError extends Error {}
export class ApplyRefused extends ApplyError {}

export interface ApplyOptions {
  enabled?: boolean;
}

export type JournalState =
  | "prepared"
  | "applying"
  | "applied"
  | "reverting"
  | "reverted"
  | "aborted";

export interface AdmissionResult {
  admitted: boolean;
  verdicts: Array<{
    critic: string;
    passes: boolean;
    findings: string[];
  }>;
  candidateDigest: string;
  poolDigest: string;
}

export interface BaseJournalEntry<E> {
  applyId: string;
  state: JournalState;
  clusterId: string;
  revisionId: string;
  targetPath: string;
  before: string;
  beforeDigest: string;
  after: string;
  afterDigest: string;
  existedBefore: boolean;
  evidence: E[];
  verdicts: AdmissionResult["verdicts"];
  ledgerRef?: string;
  at: string;
}

export interface PoolView {
  target: {
    content: string;
    existed: boolean;
  };
  admissionInput: unknown;
}

export interface GuardRegistration {
  graph: Parameters<typeof registerGuard>[1];
  edgePredicates: Parameters<typeof registerGuard>[2];
  initial: Parameters<typeof registerGuard>[3];
  terminal?: Parameters<typeof registerGuard>[4];
  stakes?: Parameters<typeof registerGuard>[5];
  workspaceRoot?: Parameters<typeof registerGuard>[6];
  policyBundle?: Parameters<typeof registerGuard>[7];
}

export interface ApplyAdapter<C, E, J extends BaseJournalEntry<E>> {
  kind: "memory" | "asset";
  enabled(options: ApplyOptions): boolean;
  workspaceRoot(candidate: C): string;
  targetPath(candidate: C): string;
  evidenceFor(candidate: C): E[];
  ids(candidate: C): { clusterId: string; revisionId: string };
  verifyIdentity(candidate: C): void;
  allowlist(workspaceRoot: string, targetPath: string): Promise<string>;
  pool(workspaceRoot: string, target: string): Promise<PoolView>;
  admit(candidate: C, pool: PoolView): Promise<AdmissionResult>;
  renderAfter(before: string, candidate: C): string;
  journalDir(workspaceRoot: string): string;
  journalEntry(candidate: C, base: BaseJournalEntry<E>): J;
  guardResource(applyId: string): string;
  guardRegistration(): GuardRegistration;
  transitionArtifacts(
    entry: J,
    edge: "applying" | "applied" | "reverted" | "aborted",
  ): Record<string, string>;
  locks(workspaceRoot: string, target: string): string[];
}

export interface AppliedResult {
  applyId: string;
  ledgerRef: string;
  targetPath: string;
}

export type Receipt =
  | { kind: "committed"; state: "applied" | "reverted" }
  | { kind: "absent" }
  | { kind: "unreadable" };

export interface ReconcileReport {
  completed: number;
  rolledBack: number;
  reverted: number;
  diverged: number;
}

export function journalPath<C, E, J extends BaseJournalEntry<E>>(
  adapter: ApplyAdapter<C, E, J>,
  workspaceRoot: string,
  applyId: string,
): string;

export function readJournal<C, E, J extends BaseJournalEntry<E>>(
  adapter: ApplyAdapter<C, E, J>,
  workspaceRoot: string,
): Promise<J[]>;

export function applyCandidate<C, E, J extends BaseJournalEntry<E>>(
  adapter: ApplyAdapter<C, E, J>,
  candidate: C,
  options: ApplyOptions,
): Promise<AppliedResult>;

export function revertApply<C, E, J extends BaseJournalEntry<E>>(
  adapter: ApplyAdapter<C, E, J>,
  applyId: string,
  workspaceRoot: string,
  options: ApplyOptions,
): Promise<void>;

export function reconcile<C, E, J extends BaseJournalEntry<E>>(
  adapter: ApplyAdapter<C, E, J>,
  workspaceRoot: string,
  options: ApplyOptions,
): Promise<ReconcileReport>;

export function ledgerReceipt<C, E, J extends BaseJournalEntry<E>>(
  adapter: ApplyAdapter<C, E, J>,
  entry: J,
): Receipt;

export function abort<C, E, J extends BaseJournalEntry<E>>(
  adapter: ApplyAdapter<C, E, J>,
  workspaceRoot: string,
  entry: J,
): Promise<void>;
```

Type provenance and compatibility anchors:

- `ApplyOptions`, `JournalState`, `AppliedResult`, `Receipt`, and `ReconcileReport` preserve the declarations at `ts/src/learn/apply.ts:26`, `ts/src/learn/apply.ts:206`, `ts/src/learn/apply.ts:345`, `ts/src/learn/apply.ts:451`, and `ts/src/learn/apply.ts:589`.
- `BaseJournalEntry<E>` preserves the field set and order of `JournalEntry` at `ts/src/learn/apply.ts:214`; the only generic field is the `evidence` currently typed from the `FailureRecord` import at `ts/src/learn/apply.ts:8` and used at `ts/src/learn/apply.ts:225`.
- The memory specialization uses `PatchCandidate`, imported at `ts/src/learn/apply.ts:9`, and `FailureRecord`, imported at `ts/src/learn/apply.ts:8`: `ApplyAdapter<PatchCandidate, FailureRecord, JournalEntry>`.
- `GuardRegistration` derives all non-resource parameters from the verified `registerGuard` signature at `ts/src/guard/transition.ts:396`. Its actual parameters continue through `policyBundle` at `ts/src/guard/transition.ts:404`; this is why the four-field D1 sketch is insufficient.
- The core acquires every string returned by `locks` by nesting `resourceLock` calls in array order and releases them in reverse order. That matches the callback-shaped API at `ts/src/guard/lock.ts:385` and preserves the single memory lock exactly. It must not sort or hash the returned resource ids.
- `adapter.pool(...)` is called only after every returned lock is held, matching the current target-lock-before-snapshot order at `ts/src/learn/apply.ts:368` and `ts/src/learn/apply.ts:377`.
- `PoolView.target` is the one initial snapshot used for `before`, `existedBefore`, admission, and journal construction. The core must not read once for admission and again for journaling; it must still perform the separate current-target read immediately before the write for the existing CAS check at `ts/src/learn/apply.ts:429`. `admissionInput` is deliberately opaque because D1 fixes `ApplyAdapter` at three generic parameters while adapters own different pool representations.
- In `learn/apply.ts`, retain `export interface AdmissionResult extends ProtocolAdmissionResult { verdicts: Verdict[] }` and `export interface JournalEntry extends BaseJournalEntry<FailureRecord> { verdicts: Verdict[] }`. These narrower declarations preserve the typed memory API while remaining assignable to protocol types.

The memory public wrappers retain these exact signatures:

```ts
export function journalPath(workspaceRoot: string, applyId: string): string;
export function readJournal(workspaceRoot: string): Promise<JournalEntry[]>;
export function applyCandidate(candidate: PatchCandidate, options: ApplyOptions): Promise<AppliedResult>;
export function ledgerReceipt(entry: JournalEntry): Receipt;
export function revertApply(applyId: string, workspaceRoot: string, options: ApplyOptions): Promise<void>;
export function reconcile(workspaceRoot: string, options: ApplyOptions): Promise<ReconcileReport>;
```

These signatures are pinned by imports and calls in `ts/tests/learn/apply.test.ts:14`, `ts/tests/learn/apply.test.ts:103`, `ts/tests/learn/apply.test.ts:190`, `ts/tests/learn/apply.test.ts:257`, `ts/tests/learn/apply.test.ts:365`, and `ts/tests/learn/apply.test.ts:497`.

## C. Memory adapter concrete values

Define one private `memoryApplyAdapter: ApplyAdapter<PatchCandidate, FailureRecord, JournalEntry>` in `ts/src/learn/apply.ts`. Every member returns the following exact value or delegates to the named current function:

| Adapter member | Exact memory value/expression | Current evidence |
|---|---|---:|
| `kind` | `"memory" as const` | Memory-only rejection at `ts/src/learn/apply.ts:84` |
| `enabled` | `(options) => options.enabled === true || process.env.STRATUM_LEARN_APPLY_ENABLED === "1"` | `ts/src/learn/apply.ts:31` |
| `workspaceRoot` | `(candidate) => candidate.scope.workspaceRoot` | `ts/src/learn/apply.ts:361` |
| `targetPath` | `(candidate) => candidate.targetPath` | `ts/src/learn/apply.ts:362` |
| `evidenceFor` | `(candidate) => candidate.evidence` | `ts/src/learn/apply.ts:404` |
| `ids` | `(candidate) => ({ clusterId: candidate.clusterId, revisionId: candidate.revisionId })` | `ts/src/learn/apply.ts:396` |
| `verifyIdentity` | `(candidate) => verifyIdentity(candidate)` | `ts/src/learn/apply.ts:360` |
| `allowlist` | `(workspaceRoot, targetPath) => assertAllowlisted(workspaceRoot, targetPath)` | `ts/src/learn/apply.ts:275` |
| `pool` | `async (_workspaceRoot, target) => { try { const content = await readFile(target, "utf8"); return { target: { content, existed: true }, admissionInput: content }; } catch { return { target: { content: "", existed: false }, admissionInput: "" }; } }` | This is the exact behavior of `readTarget` at `ts/src/learn/apply.ts:714`; its result is first consumed at `ts/src/learn/apply.ts:377` |
| `admit` | `(candidate, pool) => admit(candidate, pool.admissionInput as string)` | `ts/src/learn/apply.ts:187` |
| `renderAfter` | `(before, candidate) => renderAfter(before, candidate)` | `ts/src/learn/apply.ts:324` |
| `journalDir` | `(workspaceRoot) => join(workspaceRoot, ".stratum", "learn", "applies")` | `ts/src/learn/apply.ts:231` |
| `journalEntry` | `(_candidate, base) => ({ applyId: base.applyId, state: base.state, clusterId: base.clusterId, revisionId: base.revisionId, targetPath: base.targetPath, before: base.before, beforeDigest: base.beforeDigest, after: base.after, afterDigest: base.afterDigest, existedBefore: base.existedBefore, evidence: base.evidence, verdicts: base.verdicts as Verdict[], at: base.at })` | This preserves the prepared literal's field set/order at `ts/src/learn/apply.ts:393`; `ledgerRef` is absent until the core's applied write corresponding to `ts/src/learn/apply.ts:444` |
| `guardResource` | ``(applyId) => `learn-apply-${applyId}``` | `ts/src/learn/apply.ts:710` |
| `guardRegistration` | `() => ({ graph: { staged: ["applying", "aborted"], applying: ["applied", "aborted"], applied: ["reverted"], aborted: [], reverted: [] }, edgePredicates: {}, initial: "staged", terminal: ["aborted", "reverted"] })` | `ts/src/learn/apply.ts:412` |
| `transitionArtifacts(..., "applying")` | `{ journal_digest: sha(JSON.stringify(entry)), revision_id: entry.revisionId }` in that property order | `ts/src/learn/apply.ts:422` |
| `transitionArtifacts(..., "applied")` | `{ after_digest: entry.afterDigest }` | `ts/src/learn/apply.ts:436` |
| `transitionArtifacts(..., "reverted")` | `{ reverted_to: entry.beforeDigest }` | `ts/src/learn/apply.ts:565` |
| `transitionArtifacts(..., "aborted")` | `{ aborted: "reconcile" }` | `ts/src/learn/apply.ts:698` |
| `locks` | ``(_workspaceRoot, target) => [`learn-target-${sha(target).slice(0, 32)}`]`` | `ts/src/learn/apply.ts:368` and `ts/src/learn/apply.ts:552` |

The adapter must also preserve these call-site values, which are protocol mechanics rather than adapter fields:

- Per-attempt id: `sha(randomUUID()).slice(0, 32)` (`ts/src/learn/apply.ts:390`).
- Applying transition: from `"staged"` to `"applying"`, idempotency key ``${applyId}:applying`` (`ts/src/learn/apply.ts:422`).
- Commit transition: from `"applying"` to `"applied"`, `modifiedFiles: [target]`, idempotency key ``${applyId}:applied`` (`ts/src/learn/apply.ts:436`).
- Revert transition: from `"applied"` to `"reverted"`, `modifiedFiles: [target]`, idempotency key ``${applyId}:reverted`` (`ts/src/learn/apply.ts:565`).
- Abort transition: current ledger state to `"aborted"`, idempotency key ``${entry.applyId}:aborted`` (`ts/src/learn/apply.ts:696`).
- Journal bytes: `JSON.stringify(entry, null, 2)` with no appended newline, UTF-8, followed by rename (`ts/src/learn/apply.ts:257`).

The enabled check alone cannot preserve both current disabled messages. Therefore each memory public wrapper performs the current check and throws its current message before delegating with `{ ...options, enabled: true }`: the long apply message at `ts/src/learn/apply.ts:355`, and `"learn apply is disabled"` for revert/reconcile at `ts/src/learn/apply.ts:543` and `ts/src/learn/apply.ts:604`. The protocol still checks `adapter.enabled` for direct callers.

## D. Byte-identity risk register

| Risk: byte or observable may drift | Required preservation | Regression coverage |
|---|---|---|
| Prepared journal field set and property order | The adapter-owned entry must serialize fields in the exact order at `ts/src/learn/apply.ts:393`; do not add `kind`, omit an existing field, or insert `ledgerRef: undefined`. | **UNCOVERED — add a test** that reads the prepared journal bytes at the applying crash window or unit-tests the exact serialized fixture. The assertions at `ts/tests/learn/apply.test.ts:196` inspect parsed fields, not bytes. |
| Journal formatting and filename | Preserve two-space `JSON.stringify`, no newline, UTF-8, `${applyId}.json`, and `.stratum/learn/applies`. | Directory/name are exercised indirectly at `ts/tests/learn/apply.test.ts:440`; formatting is **UNCOVERED — add a test**. |
| Applying transition's `journal_digest` | Hash `JSON.stringify(preparedEntry)` before changing state, using the adapter-produced property order; artifact key remains `journal_digest`. This digest is committed to the ledger. | **UNCOVERED — add a test** that reads the applying ledger row and compares its artifact payload/digest to a known pre-refactor journal. No current test asserts this artifact. |
| `applying -> applied` receipt emission | Preserve `{ after_digest }`, `[target]`, resolver default `"agent"`, idempotency key, and guard policy checksum inputs. | Normal emission/recovery is exercised at `ts/tests/learn/apply.test.ts:433`; legacy payload v1 is pinned at `ts/tests/learn/apply.test.ts:452`. A simultaneous matching change to emission and re-derivation could still pass: **UNCOVERED — add a fixed current-version receipt fixture test**. |
| Applied receipt re-derivation | Preserve `payloadDigestForVersion("applying", "applied", { after_digest }, [targetPath], "agent", policyChecksum, row.payload_digest_version)` and legacy-match notification. | The seeded v1 receipt at `ts/tests/learn/apply.test.ts:452` catches legacy drift; committed-journal recovery at `ts/tests/learn/apply.test.ts:433` catches one live path. Current-version fixture compatibility remains uncovered as above. |
| Reverted receipt re-derivation | Preserve `"applied" -> "reverted"`, `{ reverted_to: beforeDigest }`, `[targetPath]`, resolver and checksum inputs; a reverted receipt must win. | External revert receipt and recovery are pinned at `ts/tests/learn/apply.test.ts:350`; exact current-version pre-refactor digest compatibility is **UNCOVERED — add a fixed fixture test**. |
| Guard resource name | Always ``learn-apply-${applyId}`` for registration, transitions, receipt reads, raw-ledger path, and guard-state lookup. | Explicitly pinned by the external transition at `ts/tests/learn/apply.test.ts:357` and legacy registry at `ts/tests/learn/apply.test.ts:468`. |
| Guard graph, predicates, initial state, terminal list | Preserve adjacency order/contents, `{}` edge predicates, `"staged"`, and `["aborted", "reverted"]`; these influence legal transitions and the registry checksum used by payload digests. | Revert legality is covered at `ts/tests/learn/apply.test.ts:290`; abort recovery at `ts/tests/learn/apply.test.ts:500`. Exact registry checksum/serialized registry bytes are **UNCOVERED — add a test**. |
| Lock resource name and acquisition behavior | Preserve one resource named ``learn-target-${sha(target).slice(0, 32)}``; do not hash the workspace root, reorder ids, or expose an apply-scoped lock. | Same-target behavior is exercised at `ts/tests/learn/apply.test.ts:271` and unreconciled blocking at `ts/tests/learn/apply.test.ts:544`, but the actual lock id is **UNCOVERED — add a test** if its external observability is contractual. |
| Resolved target name | Continue journaling, locking, writing, returning, and using in `modifiedFiles` the result of `assertAllowlisted`, not the lexical candidate path. | Lexical escape refusal at `ts/tests/learn/apply.test.ts:225` and symlink refusal at `ts/tests/learn/apply.test.ts:402`; resolved in-workspace symlink/canonical-path identity is **UNCOVERED — add a test**. |
| Allowlist errors and policy | Preserve `.md`, `.stratum/learn`, realpath-through-missing behavior, and symlink-out refusal. | Covered at `ts/tests/learn/apply.test.ts:225` and `ts/tests/learn/apply.test.ts:402`; exact error strings are **UNCOVERED — add a test** only if messages are API. |
| Rendered target bytes | Preserve create/empty formatting, missing-section formatting, insertion before the next heading, and final-newline normalization. | Same-section append at `ts/tests/learn/apply.test.ts:204` and later-heading placement at `ts/tests/learn/apply.test.ts:325`; exact create/missing-section full strings are **UNCOVERED — add tests**. |
| Before/after SHA-256 digests | Continue hashing UTF-8 strings with Node SHA-256 and lower-case hex; no canonicalization or newline changes. | CAS restore and refusal at `ts/tests/learn/apply.test.ts:247`; third-state divergence at `ts/tests/learn/apply.test.ts:528`. Exact digest literals are not pinned: **UNCOVERED — add a fixture assertion**. |
| Journal evidence and verdict bytes | Preserve evidence array identity/order, critic order (`structural`, `behavioral`, `semantic`, `subset`), finding text, and object property order. | Critic names are checked at `ts/tests/learn/apply.test.ts:109`; journal evidence presence at `ts/tests/learn/apply.test.ts:196`. Full serialized arrays are **UNCOVERED — add a test**. |
| Typed `JournalEntry` memory surface | `JournalEntry` must still accept exactly the literal at `ts/tests/learn/apply.test.ts:453`, including optional `ledgerRef` and `FailureRecord[]` evidence. | The Vitest gate only transpiles it, but the existing literal is checked by `npx tsc --noEmit`; run that command without editing the test. |
| Public export names and function arity/order | Keep all imports at `ts/tests/learn/apply.test.ts:14` and the current memory call shapes. | The unmodified test file catches missing exports and runtime call-shape drift, starting at `ts/tests/learn/apply.test.ts:14`. Type-only exports still require typechecking. |
| Per-attempt apply id | Preserve SHA-256 of `randomUUID()` truncated to 32 hex characters; do not make it revision-deterministic. | Re-apply uniqueness is covered at `ts/tests/learn/apply.test.ts:391`. Exact random value is intentionally not pin-able. |
| Journal state write timing | Preserve prepared before registration, applying after its receipt, bytes before applied receipt, ledger before final applied journal, reverting before receipt/restore, and aborted after the abort attempt. | Committed-but-unfinished recovery at `ts/tests/learn/apply.test.ts:433`, genuine rollback at `ts/tests/learn/apply.test.ts:500`, and revert crash completion at `ts/tests/learn/apply.test.ts:350`. The prepared-to-registration crash window is **UNCOVERED — add a fault-injection test**. |
| Raw ledger truncation detection | Preserve raw nonblank line count versus parsed entry count; a partial/corrupt ledger must be unreadable, never absent. | Corrupt-ledger divergence at `ts/tests/learn/apply.test.ts:370`. A malformed trailing line specifically is **UNCOVERED — add a test**. |
| Restore of prior non-existence | Continue deleting a created target rather than writing an empty file. | Covered at `ts/tests/learn/apply.test.ts:302` and recovery rollback at `ts/tests/learn/apply.test.ts:500`. |
| Default-OFF flag and refusal names | Preserve explicit `enabled: true`, `STRATUM_LEARN_APPLY_ENABLED === "1"`, and the current apply versus revert/reconcile messages. | Default-off no-write behavior is covered at `ts/tests/learn/apply.test.ts:99`; environment enablement and exact messages are **UNCOVERED — add tests**. |
| Public admission and identity behavior | Keep candidate identity field order/separator, recurrence check, candidate/pool digests, critic order, and finding strings. | Identity content and insertion mode at `ts/tests/learn/apply.test.ts:311` and `ts/tests/learn/apply.test.ts:412`; admission cases at `ts/tests/learn/apply.test.ts:109`. Exact digest and error/finding bytes are only partially covered: **UNCOVERED — add fixture assertions**. |
| Error class identity | `learn/apply.ts` must re-export the protocol classes, never subclass or duplicate them. | `toThrow(ApplyError)` and `toThrow(ApplyRefused)` at `ts/tests/learn/apply.test.ts:234` and `ts/tests/learn/apply.test.ts:242` catch class/export drift. |

The additional tests named above must be new S1 protocol/compatibility tests if implemented. `ts/tests/learn/apply.test.ts` remains byte-for-byte unchanged.

## E. Ordered implementation steps

1. **Characterize the byte contract before moving code.**
   - Files: add a new S1-only test file such as `ts/tests/apply/protocol-memory-compat.test.ts`; do not edit `ts/tests/learn/apply.test.ts`.
   - Against the current implementation, pin prepared-journal key order/serialization and `journal_digest`, current-version applied/reverted receipt re-derivation, guard registration inputs/checksum, and any other practical uncovered byte risks from §D. Use deterministic literals or seeded guard records where time/random ids would otherwise make a golden unstable. Let `npx tsc --noEmit` check the existing typed `JournalEntry` literal. Do not add asset tests or production hooks solely for testing.
   - Proof from `ts/`: first `npx tsc --noEmit`; then `npx vitest run tests/apply/protocol-memory-compat.test.ts tests/learn/apply.test.ts`; finally `npx vitest run tests/learn/apply.test.ts` as the isolated unmodified gate.

2. **Introduce the protocol types and private generic helpers.**
   - Files: create `ts/src/apply/protocol.ts` only.
   - Add the declarations in §B, then move the unchanged implementations of hashing, target read/write/restore, journal path/read/write, raw-ledger receipt reading, guard-state lookup, and lock nesting behind adapter inputs. Preserve statement order and error handling from `ts/src/learn/apply.ts`.
   - Do not yet change the memory module's exports or add any asset branch.
   - Proof from `ts/`: first `npx tsc --noEmit` to compile the otherwise not-yet-wired module; then `npx vitest run tests/apply/protocol-memory-compat.test.ts tests/learn/apply.test.ts`; finally `npx vitest run tests/learn/apply.test.ts`.

3. **Move the five transaction algorithms behind the adapter.**
   - Files: edit `ts/src/apply/protocol.ts` only.
   - Implement the exact signatures in §B for `applyCandidate`, `revertApply`, `ledgerReceipt`, `reconcile`, and `abort`. Build the base journal in current property order, then call `adapter.journalEntry`; acquire every lock before the one `PoolView.target` initial snapshot and retain the separate pre-write CAS re-read; pass every candidate-derived value through the adapter; nest locks in returned order; spread no objects into transition artifacts.
   - Preserve the current ledger-authority matrix line-for-line in branch order. Do not add asset branches or distill names.
   - Proof from `ts/`: first `npx tsc --noEmit`; then `npx vitest run tests/apply/protocol-memory-compat.test.ts tests/learn/apply.test.ts`; finally `npx vitest run tests/learn/apply.test.ts`.

4. **Turn `learn/apply.ts` into the memory adapter without changing its public surface.**
   - Files: edit `ts/src/learn/apply.ts` only.
   - Retain the critics, identity check, admission, Markdown renderer, allowlist plus realpath helpers, memory journal directory, exact enabled behavior, and private memory hashing helper. Define the adapter with every value in §C.
   - Replace transaction bodies with same-signature wrappers that delegate to aliased protocol functions. Re-export shared classes/types; retain memory-local `CriticName`, `Verdict`, `AdmissionResult`, `JournalEntry`, `verifyIdentity`, `admit`, `journalDir`, and `renderAfter`; wrap `journalPath` and `readJournal` to inject the adapter.
   - Do not literally re-export an adapter-first function under a current memory name. Do not touch `ts/tests/learn/apply.test.ts`.
   - Proof from `ts/`: first `npx tsc --noEmit`; then `npx vitest run tests/apply/protocol-memory-compat.test.ts tests/learn/apply.test.ts`; finally `npx vitest run tests/learn/apply.test.ts`, which must still report all 30 tests passing.

5. **Final S1 scope and diff verification.**
   - Files allowed in the implementation diff: `ts/src/apply/protocol.ts`, `ts/src/learn/apply.ts`, and the new S1 compatibility test from step 4. `ts/tests/learn/apply.test.ts` must have no diff. No distill, CLI, contract, changelog, or dependency files may change.
   - Inspect the diff specifically for serialized field/order changes, renamed guard/lock resources, changed transition payloads, added runtime dependencies, or edits outside S1.
   - Proof from `ts/`: first `npx tsc --noEmit`; then `npx vitest run tests/learn/apply.test.ts`. It must report the same 30 passing tests with the test file unmodified.

## Corrections

1. D1 classifies `realpathOrSelf` and `realpathThroughMissing` as candidate-agnostic core. Their only actual callers are the adapter-owned memory allowlist at `ts/src/learn/apply.ts:279` and `ts/src/learn/apply.ts:291`; they should remain in `learn/apply.ts`.
2. D1's `GuardRegistration` description is not the full `registerGuard` argument set. The real signature also accepts `stakes`, `workspaceRoot`, and `policyBundle` after singular `terminal` (`ts/src/guard/transition.ts:396` through `ts/src/guard/transition.ts:404`). It also calls the fields “predicates” and “terminals,” whereas the implementation names are `edgePredicates` and `terminal`.
3. D1 writes `journalEntry(candidate: C, base: BaseJournalEntry): J`, but `BaseJournalEntry` requires its evidence parameter. The compiling signature is `journalEntry(candidate: C, base: BaseJournalEntry<E>): J`.
4. D1 says the memory public exports can be kept “by re-exporting through the adapter.” `applyCandidate`, `revertApply`, `reconcile`, `ledgerReceipt`, `journalPath`, and `readJournal` cannot be literal re-exports because their protocol forms need an adapter argument while existing callers do not. They require thin same-signature memory wrappers.
5. D1 does not define `PoolView`. The current algorithm uses one initial target snapshot for admission and journal construction at `ts/src/learn/apply.ts:377`, then a separate pre-write CAS read at `ts/src/learn/apply.ts:429`; a later asset pool is not the target file. S1 must define both `target: { content, existed }` and opaque `admissionInput`; otherwise an implementation either double-reads during preparation or cannot represent both cases under the settled three-parameter adapter.
6. D1's `enabled(options): boolean` is insufficient by itself to preserve the two existing observable refusal messages: apply uses the detailed message at `ts/src/learn/apply.ts:355`, while revert and reconcile use the shorter message at `ts/src/learn/apply.ts:543` and `ts/src/learn/apply.ts:604`. Same-signature memory wrappers must retain these checks/messages, or the interface needs another adapter member. This blueprint chooses wrappers to avoid changing D1.
7. D1 says `BaseJournalEntry<E>` differs from today's journal only in `evidence`, but today's `verdicts` is typed as the memory-specific `Verdict[]` (`ts/src/learn/apply.ts:226`). A candidate-agnostic core must broaden the base admission verdict's `critic` to `string`, then narrow `JournalEntry.verdicts` back to `Verdict[]` in the memory adapter. D1 does not state that necessary type split.
8. D1 does not classify current top-level `journalPath`, `readJournal`, `writeJournal`, `guardState`, or the exported error/result/report/state types. Section A supplies the missing split so the extraction does not accidentally move policy or break public imports.
9. D1's `locks(...): string[]` does not say how multiple resources are acquired through the callback-shaped one-resource API at `ts/src/guard/lock.ts:385`. The core must nest them in adapter order and release in reverse order; for S1 the single-element memory list preserves behavior. Sorting or parallel acquisition would be an observable semantic change.
10. The design treats the typed `JournalEntry` literal at `ts/tests/learn/apply.test.ts:453` as part of the unchanged Vitest regression gate. Vitest transpiles TypeScript but is not itself a compile-time type assertion, so that gate alone does not prove structural type compatibility. Run the already-green `npx tsc --noEmit`, which checks that literal, while leaving the existing test untouched.
