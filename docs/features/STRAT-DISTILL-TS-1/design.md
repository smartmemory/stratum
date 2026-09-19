# STRAT-DISTILL-TS-1 — Port the workflow-to-asset staging substrate to TS

**Status:** PLANNED
**Priority:** HIGH — prerequisite for the skill-class apply and admission work
**Created:** 2026-09-19
**Supersedes-in-part:** [`STRAT-DISTILL/report.md`](../STRAT-DISTILL/report.md) (SHIPPED, Python)

## Related Documents

- Historical specification and delivery: [`STRAT-DISTILL/design.md`](../STRAT-DISTILL/design.md), [`blueprint.md`](../STRAT-DISTILL/blueprint.md), [`plan.md`](../STRAT-DISTILL/plan.md), [`report.md`](../STRAT-DISTILL/report.md).
- Future consumers: [`STRAT-DISTILL-APPLY/design.md`](../STRAT-DISTILL-APPLY/design.md) and [`STRAT-ADMIT/design.md`](../STRAT-ADMIT/design.md).
- Port precedent: [`STRAT-LEARN-INLINE-TS-1/design.md`](../STRAT-LEARN-INLINE-TS-1/design.md).
- Live structural template: [`learn/harvest.ts`](../../../ts/src/learn/harvest.ts), [`learn/classify.ts`](../../../ts/src/learn/classify.ts), [`learn/candidate.ts`](../../../ts/src/learn/candidate.ts), [`learn/apply.ts`](../../../ts/src/learn/apply.ts); operator wrapper: [`cli/learn.ts`](../../../ts/src/cli/learn.ts).
- Cutover history: [`2026-07-11-strat-py-retire-progress.md`](../../plans/2026-07-11-strat-py-retire-progress.md), especially lines 603–613 and 657–676.
- Implementation handoff: [blueprint.md](./blueprint.md).
- Archived source: `git show python-legacy:src/stratum/judge/distill/<module>.py`; the branch remains archival and untouched.

## The finding

**The TS engine has no distill staging pipeline.** Python v1 shipped on 2026-06-14 with detection, synthesis, sidecar persistence, a CLI, and a stateless MCP tool. The 2026-07 retirement removed the runtime that provided them. The MEMORY-class machinery subsequently present in `ts/src/learn/` does not restore this skill-class machinery.

The cutover record is more specific than an accidental missing trigger: distill was deliberately parked on 2026-07-12 with the transcript-substrate family, after scoping found its dependency on the Claude transcript loader and sidecar writer. The later cutover decision retired that family and proposed provenance verbs with a SmartMemory backend. This dispatch selects a narrower, local TS home for the distill staging closure. It does not restore the whole postmortem/provenance family or introduce a SmartMemory dependency. See the retirement progress document at lines 603–613 and 672–676, and `README.md:19–24,519`.

There is also a terminology correction: **shipped DISTILL detects repeated observed workflows, not recurring judge failures.** Python's detector explicitly disclaims judge-verdict dependence. “Success-pattern complement” was the feature's description; its implementation did not check tool-result success. `learn/` supplies the TS architecture and candidate-envelope precedent, while Python distill supplies the detection semantics. Replacing the transcript source with `learn/harvest()` would implement a different feature.

The apply stub's 2026-08 engine note is now partly stale: `learn/` exists, including MEMORY admission and application, but distill is still absent. This document records the correction without editing that stub or STRAT-ADMIT.

## The verification (2026-09-19) — absence, not a yield measurement

Audited `main` at `8231e6d1467394ac9f230c6a930e9e0d8b61e489`; archived source at `python-legacy` / `642dda33be0a80bb27644412b1a4fa10fe0ad665`.

| Check | Observation |
|---|---|
| `rg -n -i 'distill\|stratum_decompose' ts/src ts/contracts` | No matches; exit status 1. No distill implementation or registered tool, and no live `stratum_decompose` template. |
| `ts/src/learn/{harvest,classify,candidate,apply}.ts` | Existing failure-record → cluster → rendered MEMORY candidate → optional admission/apply pipeline. |
| `ts/src/learn/harvest.ts:5–15,20–36,56–84` | Reads persisted engine runs, not conversation transcripts; its records do not contain the tool names/inputs distill needs. |
| Archived modules, five requested test files, and distill skill wrapper | Recoverable and read in full; behavior grounded in source and tests, not inferred from the old plan. |
| Historical report | Reports 32 new tests at shipping time. This is historical evidence, not a test run performed for this design. |

**There is no live distill yield measurement to run today because nothing runs in TS.** No private transcript sweep, model invocation, or runtime implementation was performed in this pass. A later implementation must demonstrate fixture parity and report any real-corpus evaluation separately; absence of a tool is not a measured zero-candidate yield.

## What v1 actually did

1. Load sorted, top-level Claude Code `*.jsonl` transcripts from a project directory. Session identity is the filename stem. Preserve physical, one-based line numbers; discard sidechain records and malformed/noise records. Apply the default 30-day window using file mtime, retaining a session if its mtime cannot be read.
2. Extract the whole session's ordered `tool_use` stream. Canonicalize input using `command`, `file_path`, `path`, `pattern`, `url`, then `notebook_path`, falling back to sorted-key JSON. Redact secret patterns before the 120-character preview limit and before any grouping/output.
3. Count single `(tool, canonical input)` invocations and contiguous **tool-name-only n-grams of lengths 2–4**. Overlapping windows count separately. Require at least two occurrences across at least two distinct sessions; sort by count descending, session count descending, kind, then signature.
4. Choose the smallest form: every singleton → `command`; a sequence containing only `Read/Grep/Glob/LS/WebFetch/WebSearch/NotebookRead` → `subagent`; other sequences → `skill`. An optional injected `llm_form` could override the form; exceptions or invalid/ambiguous replies fell back to the heuristic. Production default was deterministic, with no model call.
5. Author a create-only **described suggestion**, with proposed name/path, rationale, recurrence, heuristic confidence, evidence session IDs and a first-occurrence source handle. Targets were plural `skills/<name>/SKILL.md`, `agents/<name>.md`, `commands/<name>.md`.
6. Append candidates to `.stratum/postmortem/distill_candidates.jsonl`, using its own `distill-1.0` envelope, flock serialization and cluster-level deduplication. The shared runner returned candidates, workflows evaluated, rows newly written, reason and output path. Empty input was a successful “nothing to distill.” CLI `extract` staged; `top` and `stats` only read. MCP always staged; its `apply` flag was a reserved no-op.

Whole-session extraction, an injected synchronous form selector, and the shared runner were documented shipping deviations. Goal segmentation, lengths 2–5, stopping-condition verification, user-text clustering, asset inventory/extend-not-duplicate, and operational full-file authoring were proposals, not shipped behavior. Sequence recurrence does not establish stable inputs or successful outcomes. Those limits must remain visible rather than becoming unsupported claims in a candidate.

## Scope and pipeline

```text
Claude transcript files (read only)
  → harvest.ts: narrow tool-use reader + source diagnostics
  → detector.ts: pure recurrence clusters
  → synthesize.ts: form selection
  → candidate.ts: deterministic whole-file proposal + evidence + identity
  → runner.ts: result / optional append to .stratum/distill/candidates.jsonl
       ↑ CLI distill extract|top|stats     ↑ MCP stratum_distill
```

This is an operator-invoked staging service. No flow/judge edge, scheduler or automatic trigger is added. The new transcript reader ports only the input closure distill requires; it does not recreate postmortem calibration, transcript search, centered-read tools or replay.

Preserve the detector's recurrence thresholds, whole-session behavior, redaction, deterministic ordering, form table and valid empty result. Preserve all occurrences in evidence, including overlapping n-grams, so a later critic can recompute the count. CLI and MCP share the same runner and authoring code.

### Workspace and transcript scope

Keep the destination workspace and transcript source separate. The runner requires a canonical absolute `workspaceRoot`; MCP requires `workspace_root`. CLI accepts `--root`; if omitted, use the enclosing Git worktree root, falling back to cwd outside Git, and print the resolved root. An explicit root always wins, including for intentionally nested workspaces. Resolve symlinks once before selecting sources and paths. The subdirectory regression highlighted by STRAT-LEARN-INLINE-TS-1 must have a fixture test.

`--project` / `project_dir` names a transcript project directory. When omitted, use `~/.claude/projects/<encoded-workspace-root>` with the archived slash-to-hyphen convention, never the author's personal hard-coded directory. Report the selected source path even when missing, and support explicit source override because this naming convention is only a locator. Do not infer a trustworthy workspace by reversing a directory's encoded name.

Retain CLI `--all --projects-root`: enumerate project directories in sorted order, **detect separately per source project**, then merge results deterministically for all three subcommands. Python already did this for `extract`, but combined projects for `top/stats`; TS removes that inconsistency. All staged rows still land in the one explicitly selected destination workspace. `scope.workspaceRoot` is the proposed destination; `scope.transcriptProjectDir` and `observedCwds` state where the evidence came from. A candidate mined from another project must say so, never claim local origin or cross-project generality. Source-directory identity is included in clustering; identical workflows in unrelated projects cannot pool their recurrence counts. Future admission must assess any source/destination scope mismatch.

### Input and evidence contract

The reader reports sessions read, files skipped, malformed tool events/lines dropped, and mtime-read failures. A missing source is an empty corpus; permission/I/O errors are reported, not disguised as a clean empty scan. Keep physical line numbers even across dropped lines; retain content-block indexes because one line can contain multiple tool calls. Missing tool input canonicalizes to empty input as in Python; missing/invalid tool name is dropped.

Each occurrence carries `sourceKind: "claude-transcript"`, canonical `projectDir`, `sessionId`, source-relative `transcriptFile`, observed cwd or null, and its ordered steps. Each step carries `lineNo`, `blockIndex`, `toolUseId` or null, `toolName`, redacted `canonicalInput`, its source record's `cwd: string|null`, and SHA-256 of the original JSONL line bytes excluding the line terminator. Missing cwd stays null rather than inheriting an earlier record's cwd. An occurrence's cwd is non-null only when every constituent step has the same known cwd; otherwise it is null. Derive candidate `scope.observedCwds` from only its evidence steps, sorted and deduplicated, excluding null. This preserves attribution when whole-session sequences cross cwd changes. An occurrence ID hashes the source identity and ordered step locators/digests. Paths resolve only within the selected transcript directory, including symlink checks. Do not copy raw transcript text/inputs into the sidecar or tool result.

This is a resolvable reference, not a durable copy of private transcripts: deleting or changing source lines can make future evidence resolution fail. A future admission consumer must resolve and verify those handles, failing closed if the cited bytes are unavailable. Line digests, block indexes and all occurrence records are additive TS improvements over Python's representative session/line handle. Preserve a first-occurrence `sourceHandle` for review convenience; it is not the entire evidence set.

## AssetCandidate and the future admission boundary

Proposed TS contract, not an implementation in this pass:

```ts
type AssetKind = "skill" | "subagent" | "command";

interface AssetCandidate {
  clusterId: string;
  revisionId: string;
  schemaVersion: "distill-2.0";
  targetKind: AssetKind;
  targetPath: string;
  scope: {
    workspaceRoot: string;
    transcriptProjectDir: string;
    observedCwds: string[];
  };
  claim: string;
  rendered: {
    content: string;
    templateId: string;
    templateVersion: string;
    insertion: { mode: "create" };
  };
  evidence: WorkflowOccurrence[];
  recurrence: { records: number; distinctSessions: number };
  authoringInputsDigest: string;
  poolSnapshot: Array<{ assetId: string; contentDigest: string }>;
  assetName: string;
  workflow: WorkflowDescription;
  rationale: string;
  confidence: number;
  sourceHandle: TranscriptHandle;
  authoring: {
    detectorVersion: string;
    canonicalizerVersion: string;
    formSelectorVersion: string;
    minCount: number;
    minSessions: number;
    ngramRange: [number, number];
    selectedBy: "heuristic" | "override";
    poolRead: false;
  };
}
```

`WorkflowDescription` is `{ kind:"single", signature:string, step:{ toolName:string, canonicalInput:string } } | { kind:"sequence", signature:string, tools:string[] }`. Its shape is grounded in the evidence rather than a second freeform claim; the distinct `step`/`tools` keys also allow the MCP shape grammar to distinguish the variants without literal-enum support. `WorkflowOccurrence` and `TranscriptHandle` are specified above and in the blueprint.

| Shared field | Compatibility with `PatchCandidate` | Necessary skill-class difference |
|---|---|---|
| `clusterId`, `revisionId`, `schemaVersion` | Stable subject identity, immutable revision identity, explicit schema | New `distill-2.0`, not the incompatible Python envelope or `learn-1.0` |
| `targetKind`, `targetPath` | Kind discriminator and exact intended target | `skill/subagent/command` branches alongside future `memory` branch |
| `scope`, `claim` | Explicit workspace and evidence-bounded statement | Transcript project/cwds, not fabricated flow names/step IDs/spec digests |
| `rendered` | Actual content plus template identity and insertion intent | A complete proposed file with `mode: create`; no meaningless memory section |
| `evidence`, `recurrence` | Resolvable support and reproducible counts | Transcript occurrences/sessions, not invented `FailureRecord.runId` or run-step pairs |
| `authoringInputsDigest` | Identifies the inputs that produced the proposal | Binds exact workflow/evidence, selection, scope, templates and pool context |

A later type can be `PatchCandidate | AssetCandidate`, narrowing on `targetKind`. Shared consumers can read `rendered.content`, `claim`, scope and identity; kind-specific consumers validate file format, evidence and operation semantics. This does **not** make the new type assignable to today's `PatchCandidate`, nor eligible for today's `admit()`: it requires memory, rejects headings, assumes flow/run evidence, and implements memory-section insertion. No cast, overload, shared-base refactor, or change to `learn/apply.ts` belongs in this port. The explicit semantic-conflict limitation currently sits on `noteSubject()` below `subsetMarginalGain()` (`learn/apply.ts:151–159`), confirming that the richer gate remains future work.

### Rendering and identity

Following `learn/candidate.ts:15–17`, stage complete inspectable Markdown bytes rather than only a description. This is an intentional adaptation, not a claim that Python rendered operational assets. Each template supplies escaped YAML frontmatter (`name`, trigger-bearing `description`), an observed-workflow section, source scope, recurrence/evidence, and an explicit draft/review instruction. Skill and subagent templates describe observed tool steps without inventing missing arguments, goals or stopping conditions. A command template can mention literal `$ARGUMENTS` as caller-provided context, but must not substitute it into or execute a mined shell command. Redacted/truncated examples remain labeled observations. No shell or tool execution occurs during authoring.

Choose plural project-local intended destinations `<root>/skills/<name>/SKILL.md`, `<root>/agents/<name>.md`, `<root>/commands/<name>.md`. These are proposals, not installed/discovered assets or a final apply allowlist. Append a stable cluster prefix to the legacy-style slug to avoid simple slug collisions. Existing-target name/conflict/quality decisions remain admission work; staging neither overwrites nor installs anything.

Use SHA-256 over canonical, recursively key-sorted JSON with deterministic array ordering:

- `clusterId` binds destination workspace, source project, detector/canonicalizer versions, workflow kind/signature and selected target kind. Include form as Python did; a changed form is a distinct proposal.
- `authoringInputsDigest` binds the workflow description, complete deduplicated evidence, recurrence, scope, authoring metadata, selected form, template ID/version, and `poolSnapshot`. The injected selector only chooses an enum from that supplied workflow; no live model or external-context selector is exposed by CLI/MCP.
- `revisionId` binds schema, cluster, target kind/path/name, claim/rationale/confidence, rendered content and operation, source handle, and `authoringInputsDigest`. No extraction timestamp, file mtime or traversal accident enters identity; original source timestamps remain part of the cited line bytes and their digests. Same inputs produce the same bytes and IDs; new evidence or a template/content/path/context change produces a new revision.

Validate recurrence from evidence rather than trusting caller counts. `records` is the number of unique occurrence IDs and `distinctSessions` the number of distinct source-qualified session IDs. Confidence retains Python's `min(95, 50 + 10*records + 5*distinctSessions)` only as heuristic metadata; it is never permission or a quality verdict.

### Authoring-time pool context

STRAT-ADMIT requires lineage inputs to be captured **at authoring**. Actual Python synthesis never read an asset inventory, despite the earlier design's phase-2 sketch. Preserve that narrow default: the TS author reads only the normalized workflow/evidence and versioned templates; persist `poolSnapshot: []` and `authoring.poolRead: false`. This means known-empty context, not unknown/unrecorded context.

Do not implement asset inventory or lineage traversal here. Any later author that supplies asset-pool content must widen the authoring contract, capture every supplied asset's identity/content digest at that moment, and include that snapshot in revision identity. It cannot manufacture the parent set from the pool at apply time. Critic verdicts and an admission-time pool digest do not belong on newly staged, unjudged rows.

## Sidecar, entry points and mutations

The new flat TS sidecar is `<workspaceRoot>/.stratum/distill/candidates.jsonl`, with `schemaVersion: "distill-2.0"` on every candidate. Keep Python `distill-1.0`, canonical postmortem and inline files, and `.stratum/learn/` untouched. No automatic migration/import or arbitrary `--out` override: only the dedicated distill directory may receive staging writes. This deliberately follows the live TS learning layout without mixing incompatible schemas.

Stage append-only revisions, deduplicating both existing rows and duplicates within the incoming batch. Serialize the read/dedup/append critical section across processes using the existing explicit-root `acquireRunLock` primitive with the distill directory and a stable sidecar key. This is storage locking, **not** a guard transition. It creates no flow, driver lease, guard registry, ledger, admission verdict or apply journal. Empty candidates and preview commands create no directories or lock files.

Validate the real destination directory/file and reject symlink escapes, non-regular files and unexpected paths before writing; only ENOENT means absent. Parse old valid rows independently of malformed lines, report corruption, and verify supported schema/identity before using rows for dedup. If a prior append left a non-newline-terminated tail, append a separating newline under the lock so later complete rows remain readable; never truncate or rewrite old bytes. A completed valid tail can still deduplicate; an invalid tail is reported and skipped. Release the lock in `finally`; surface write/lock failures as failures, not “nothing to distill.”

CLI retains `extract`, `top`, `stats`, recurrence/window/source options, `top --n`, and adds the TS `--root`/`--json` convention. `extract` explicitly requests staging; `top/stats` do no authoring or writing. MCP `stratum_distill` explicitly stages by default, with `write:false` for preview, sharing the runner. Requests contain no `apply` flag; old `apply` is rejected as unsupported rather than silently pretending application. Success always states `applied:false`, distinguishes proposals returned from rows newly appended, and includes resolved source/output paths and diagnostics. The new exact request/response contract is in the blueprint.

No staging operation calls `admit()`, `guardTransition()`, `registerGuard()`, `appendLedger()` or `applyCandidate()`. Guardrails 1–4 and STRAT-ADMIT remain necessary before any later asset creation.

## Acceptance criteria

- [ ] Fixture-backed Claude transcript ingestion reaches the same repeated singleton/sequence classes as Python, including redaction and physical source handles.
- [ ] Defaults remain ≥2 occurrences in ≥2 sessions, n-grams 2–4; one-session loops and one-off workflows stage nothing.
- [ ] Whole-file candidates retain the common TS envelope, precise source attribution, all evidence occurrences, deterministic revision identity, and known authoring context.
- [ ] CLI and registered MCP tool share one runner; empty/missing corpus is explicit success, and actual failures remain distinguishable.
- [ ] Repeated extraction writes zero duplicate revisions; concurrent processes neither lose nor duplicate rows. New evidence creates a new immutable revision.
- [ ] Nested cwd/root selection, multiple source projects, malformed input, symlink escapes and torn sidecar tails have meaningful tests.
- [ ] Only the dedicated sidecar and its temporary synchronization files change; intended asset files, flows, guards, learning files and legacy corpora remain byte-identical, even if learning apply is enabled.
- [ ] No model/network call, automatic trigger, admission verdict, installed asset or apply operation is part of the staging path.

## Explicitly out of scope

- STRAT-DISTILL-APPLY: authorization, guarded asset writes, final install paths, snapshots/journals, reconciliation, compare-and-swap revert, global promotion and guardrails 1–4.
- STRAT-ADMIT: generalized `admit()`, three critics, pool/subset quality and conflict decisions, batch selection/manifests, pool locking/revalidation, and lineage-aware rollback. Only the authoring-time context needed by that future work is preserved here.
- STRAT-DISTILL-AUTO and the separate LEARN-INLINE automatic trigger; classifier retuning or replacing failure harvesting with workflow mining.
- General transcript/provenance services, Codex transcript ingestion, postmortem calibration, SmartMemory integration, semantic clustering, goal segmentation, success certification, or asset inventory.
- Implementation in this dispatch. The only present deliverables are this design and its blueprint; no feature registration, `feature.json`, source edits, commits or changes to the two future-feature design documents.
