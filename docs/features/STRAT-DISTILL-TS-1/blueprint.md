# STRAT-DISTILL-TS-1 Blueprint

**Related:** [design.md](./design.md), [Python delivery report](../STRAT-DISTILL/report.md), [future apply](../STRAT-DISTILL-APPLY/design.md), [future admission](../STRAT-ADMIT/design.md)
**Status:** PLANNED — design/blueprint only; no implementation or design-gate approval claimed
**Repo:** `stratum/ts` (`@smartmemory/stratum` 0.6.0, ESM, Node ≥22.15, vitest)

References verified 2026-09-19 against `main` commit `8231e6d1467394ac9f230c6a930e9e0d8b61e489` and `python-legacy` commit `642dda33be0a80bb27644412b1a4fa10fe0ad665`. A `python-legacy:<path>:<lines>` reference means `git show python-legacy:<path> | nl -ba`; it is not a file to restore or edit.

---

## Overlap scan

- `rg -n -i 'distill|stratum_decompose' ts/src ts/contracts` returned no matches. There is no existing TS detector, transcript loader, candidate schema, CLI verb or MCP registration to extend under those names.
- Historical STRAT-DISTILL design/blueprint/plan are not an accurate implementation manifest; the report and archived code resolve deviations. `docs/plans/2026-07-11-strat-py-retire-progress.md:603–613,657–676` explains the parked transcript-family port. This dispatch selects only the distill closure; no broader provenance restoration.
- `STRAT-LEARN-INLINE-TS-1/design.md` is the pending automatic-trigger ticket. Reuse the shape of its existing `learn/` machinery, leaving its trigger and all learning source files unchanged.
- `STRAT-DISTILL-APPLY` and `STRAT-ADMIT` overlap in **future consumption of staged candidates**, not ownership of this implementation. This blueprint produces their input, including resolvable evidence and authoring context. It adds no gate, asset write, journal or rollback.
- A repository scan of feature blueprints for `distill`, transcript paths, `learn/*`, and the shared CLI/MCP paths found the historical distill plan and shared entry-point consumers. `STRAT-AGENT-PEER-1`, `STRAT-FLOW-CANCEL-FG`, `STRAT-LOOP-CARRY`, and `STRAT-LEARN-COST` are COMPLETE in their feature metadata. Shared `server.ts`, CLI routing and surface-version tests must be rechecked when implementation starts; this is a dated overlap scan, not a reservation of those files.
- **Concurrent-work update during this pass:** unrelated working-tree changes advanced the surface from the audited 21 to 22 and modified both grammar tests. Newly authored `STRAT-AGENT-PEER-2/blueprint.md` also plans edits to `server.ts`, the surface, README and CHANGELOG. These files were left untouched by this dispatch. Rebase the implementation plan against that work and choose the next available surface version (23 if the observed surface-22 changes land unchanged); baseline citations below remain commit-bound.

---

## File Plan

**Every row below describes future implementation work. This dispatch creates only `design.md` and `blueprint.md` in this folder.** Existing files are explicitly marked existing; no changes to `ts/src` occur in this pass.

| # | File | Kind | Change |
|---|---|---|---|
| 1 | `ts/src/distill/harvest.ts` | new | Minimal Claude JSONL tool-use reader, source/window resolution, physical locators/digests and diagnostic counters. Analog of `learn/harvest.ts`, with a different source model. |
| 2 | `ts/src/distill/detector.ts` | new | Pure redaction/canonicalization, `toolSteps`, workflow description/occurrence types, attributed singleton and 2–4-gram clustering. Analog of `learn/classify.ts`; do not import its failure classifier. |
| 3 | `ts/src/distill/candidate.ts` | new | `AssetCandidate`, versioned full-file templates, `authorCandidate`, identity validation, target/sidecar path helpers, `readCandidates`, `appendCandidates`, `latestPerCluster`. Follow `learn/candidate.ts`'s authoring + storage boundary; use the existing explicit-root file lock for storage. |
| 4 | `ts/src/distill/synthesize.ts` | new | `synthesize` and injectable `FormSelector`: smallest-form table, strict enum acceptance, fallback on invalid/throwing selector; delegates immutable authoring to candidate module. No production model call. |
| 5 | `ts/src/distill/runner.ts` | new | `resolveDistillRequest`, `inspectWorkflows`, `runDistill`; shared options, root/source partitioning, diagnostics, preview/stage orchestration and result semantics. |
| 6 | `ts/src/cli/distill.ts` | new | `distillCommand(args): Promise<number>`; strict option parsing for extract/top/stats, human/JSON output, root reporting and error exits. |
| 7 | `ts/src/cli/stratum.ts` | existing | Add lazy `distillCommand` routing and usage entry beside `learn` at lines 23–37. |
| 8 | `ts/src/mcp/server.ts` | existing | Import/call runner, extend `ToolName`, add stateless `stratum_distill` switch case and domain validation/error mapping. Mirror `stratum_compile_speckit`, not a nonexistent decompose implementation. |
| 9 | `ts/contracts/mcp-surface.json` | existing | Add exact request and `ok`/`error` response shapes; advance to the next available surface version after resolving concurrent work (see Overlap scan). Recursively declare candidate arrays/objects. |
| 10 | `ts/tests/distill/harvest.test.ts` | new | JSONL parsing, sidechain/noise/malformed handling, physical lines/block indexes, mtime window, source confinement and error reporting. |
| 11 | `ts/tests/distill/detector.test.ts` | new | Golden recurrence, canonicalization/redaction, overlapping windows, ordering, project/session isolation and threshold tests. |
| 12 | `ts/tests/distill/candidate.test.ts` | new | Template/identity/recurrence validation, common-envelope compatibility, pool context, independent schema, dedup/concurrency/torn-tail and write-confinement tests. |
| 13 | `ts/tests/distill/synthesize.test.ts` | new | All three forms, below-bar/unknown workflows, selector override/fallback, deterministic authoring. |
| 14 | `ts/tests/distill/runner.test.ts` | new | End-to-end staging and preview; shared result counts, source partitions, no-flow/no-guard/no-asset mutations. |
| 15 | `ts/tests/cli/distill.test.ts` | new | Public `main(["distill", ...])` route, all subcommands/flags, root/subdirectory behavior, JSON/error exits, missing/empty corpus. |
| 16 | `ts/tests/mcp/distill.test.ts` | new | Dispatcher plus real SDK/InMemoryTransport tool listing/calls, nested contract shapes, errors, empty success and no implicit apply. |
| 17 | `ts/tests/mcp/p5.test.ts` | existing | Exercise both new response statuses in the all-tools SDK status sweep; its lines 258–260 require every non-guard tool's declared statuses to be observed. |
| 18 | `ts/tests/mcp/contracts-grammar.test.ts` | existing | Update pinned surface version at lines 81–83 and stale test title together; retain strict undeclared-field validation. |
| 19 | `ts/tests/mcp/schema-grammar.test.ts` | existing | Update the second pinned surface assertion at baseline lines 85–90 alongside the contract and other grammar test. |
| 20 | `README.md` | existing | Future CLI/MCP usage, explicit workspace/source distinction, staged-only output, schema location, and correction of retired-tool inventory for distill alone. |
| 21 | `CHANGELOG.md` | existing | Future `[Unreleased]` entry describing the staging port and intentional legacy differences. |

`ts/src/mcp/contracts.ts` already supports strict records and typed arrays; read it, but no change is planned. `ts/scripts/prepare-dist.mjs` already copies the contract, and ordinary TS modules compile without a new executable/shebang. No changes to `learn/*`, `guard/*`, engine state, package dependencies, skill installers, legacy Python, or the future-feature docs. The Python wrapper's human presentation moves into CLI/MCP descriptions and README; restoring the retired skill installer is not required to expose the tool.

### Slices and concrete contracts

**S0 — transcript harvest and recurrence (files 1, 2, 10, 11).**

`loadSessions(projectDir, { windowDays, nowMs })` returns `{ sessions, diagnostics }`. A `TranscriptSession` contains source project/path identity, session ID, observed cwds, and ordered tool-use observations. Ignore unrelated record types, thinking/text blocks and sidechain records. File enumeration is sorted and nonrecursive. Each tool observation retains original `lineNo`, content `blockIndex`, optional tool-use ID and line digest; raw input is transient and is redacted before detector output. Treat malformed input as empty input, invalid tool names as dropped events. Preserve one-based physical line numbers, including blank/malformed lines; source-relative filenames cannot escape `projectDir` via traversal or symlinks.

Missing directories return an empty corpus. Default `windowDays=30`; `0` means no mtime filter, matching Python's falsy-window behavior; negative/non-finite/non-integer values are invalid. An unreadable mtime retains the session and increments a diagnostic. Unreadable files are counted and reported; a directory-level permission/I/O failure is an error. A partly usable corpus may produce candidates but must report every drop; it cannot masquerade as a clean scan.

`detect(sessions, { minCount=2, minSessions=2, ngramRange=[2,4] })` returns deterministic `WorkflowCandidate[]`. Public CLI/MCP expose only `minCount` and fix `minSessions=2`, retaining Python's public bar. Programmatic `minSessions` is a test/internal seam. The grouping key includes source project plus singleton `(tool, canonicalInput)` or ordered sequence tool names. Whole-session, overlapping contiguous windows are preserved; no cross-session or cross-project n-grams. Repeated input sessions/occurrences are deduplicated by source identity before counting. Sorting uses explicit code-point comparison rather than environment-dependent locale order.

`WorkflowCandidate` contains `workflow: WorkflowDescription`, `scope: { transcriptProjectDir, observedCwds }`, `evidence: WorkflowOccurrence[]`, `recurrence: { records, distinctSessions }`, and `sourceHandle`. `WorkflowDescription` has the exact `single/step` versus `sequence/tools` union declared in design.md. The first handle is the first deterministic traversal occurrence, not the earliest timestamp. Every occurrence stores `sourceKind`, `projectDir`, `sessionId`, `transcriptFile`, `cwd: string|null`, and ordered step handles with `toolName`, redacted `canonicalInput`, `lineNo`, `blockIndex`, `toolUseId: string|null`, `cwd: string|null`, `lineDigest`; its `id` hashes source identity plus the ordered locators/digests. Step cwd comes from that source record only, with no carry-forward when missing. Occurrence cwd is null unless all steps share one known cwd; candidate `observedCwds` is the sorted unique non-null cwd set from its own evidence steps, not from unrelated session events. All counts must be recomputable from these records. `TranscriptHandle` is `{ projectDir, sessionId, transcriptFile, lineNo, blockIndex }`.

Canonicalization ports priority, secret regex categories and redaction-before-truncation, with 120 Unicode code points for the preview (avoid UTF-16 surrogate truncation). Fallback JSON recursively sorts keys and uses a documented deterministic representation; fixtures pin Python-compatible ordinary JSON previews, with any numeric/Unicode serialization difference explicitly golden-tested. Do not claim that the regexes detect every possible secret. Never add raw inputs, prompts or tool outputs to public/staged objects.

**S1 — immutable authoring, form selection and sidecar (files 3, 4, 12, 13).**

Use the exact envelope in design.md. `synthesize(workflow, context, formSelector?)` returns `AssetCandidate | null`; `authorCandidate(workflow, selectedForm, context)` re-derives recurrence and rejects missing/inconsistent evidence, wrong source attribution, or below-bar input. A singleton chooses command regardless of tool name; read-only sequences choose subagent; other sequences choose skill. Unknown kind produces no candidate. A selector sees only normalized workflow data and returns one valid enum or falls back; synchronous exceptions/invalid/ambiguous results use the heuristic. No selector is wired to CLI/MCP providers.

Authoring context contains the resolved destination root, fixed detector/canonicalizer/template/form-selector versions and detection parameters. Persist these in `authoring`; compute the canonical authoring digest from all actual normalized inputs as specified in design.md. Record `poolRead:false` and `poolSnapshot:[]`; reject attempts to supply unrecorded pool context rather than silently inventing an empty parent set. Fixed templates and recurrence facts produce inspectable draft files, not operational claims absent from the evidence. YAML values and Markdown observations must be escaped as data. No asset contents or live inventory enter authoring.

`targetPathFor(root, kind, assetName)` constructs only the three plural, project-local target shapes in the design. Names are normalized slugs plus a cluster prefix. These are inert intended paths; do not create their directories, inspect them as authoring context, install files, or invoke memory `renderAfter`. `rendered.insertion` is exactly `{ mode:"create" }`, with full proposed bytes in `rendered.content`. A later apply must define create-vs-existing semantics and its own allowlist; “create” here never authorizes overwriting.

`sidecarPath(root)` is exactly `<root>/.stratum/distill/candidates.jsonl`. `readCandidates(root)` returns `{ candidates, malformedRows, unsupportedRows }`; supported rows undergo schema, identity, target-scope and evidence/count validation. `latestPerCluster` uses valid append order. No legacy import or memory-sidecar read.

`appendCandidates(root, candidates)` returns `{ written, malformedRows, unsupportedRows }`. Validate incoming rows before acquiring a lock. Empty batch returns zero without I/O mutation. Validate the canonical workspace and existing path ancestors; refuse symlink components in `.stratum/distill` and a symlink/nonregular candidate file. Recheck after directory creation and lock acquisition. Only ENOENT is absence. Use `acquireRunLock(distillDir, "distill-candidates", { timeoutMs:10_000 })`, released in `finally`; it writes synchronization files only under that root. Do not call `lockedSave`, driver-lease APIs, guard locks or any guard registration.

Under the lock, read/validate existing rows, deduplicate by `revisionId` (including within this batch), append a newline if required to isolate an unterminated tail, append each fresh serialized row plus newline, flush the file before reporting success. Never rewrite/delete an old row. A truncated JSON tail is reported and skipped; a complete valid last row without newline is still recognized. Cooperating concurrent writers share the same canonical directory/key. Identity-unavailable, lock-timeout, corruption of an incoming row, and write failures are reported explicitly; a retry can safely deduplicate any completed rows from a partial append. File-path checks protect the staging boundary; they are not a sandbox against a hostile process replacing ancestors concurrently.

**S2 — shared runner and CLI (files 5–7, 14, 15).**

`resolveDistillRequest` distinguishes workspace root from transcript directories, normalizes paths and options once, and computes the sidecar path. MCP supplies an explicit root; the CLI's omitted-root rule is Git worktree root, then cwd outside Git. Use an argument-array `git -C <cwd> rev-parse --show-toplevel`, never shell interpolation. Explicit `--root` bypasses discovery. Default source locator is the archived slash-to-hyphen convention applied to that chosen root; a missing default source is reported with its exact path, never interpreted as evidence that the detector is ineffective.

`inspectWorkflows(resolvedRequest)` performs load/detect per source directory and returns one deterministic combined shortlist and diagnostics. `runDistill(resolvedRequest, { write })` additionally synthesizes and optionally appends. Both use the same grouping rules. `evaluated` counts qualified workflow clusters, `written` counts newly appended revisions, and `candidates.length` counts authored proposals returned, including existing revisions. `reason` distinguishes empty corpus/no recurrence, no authorable workflows, preview, fresh staging and already-staged results. `applied` is always false. No per-run state or audit-event carriers are introduced.

CLI contract:

```text
stratum distill extract [--root DIR] [--project DIR | --all]
    [--projects-root DIR] [--min-count 2] [--window-days 30] [--json]
stratum distill top [same source/root/count/window options] [--n 50] [--json]
stratum distill stats [same source/root/count/window options] [--json]
```

`extract` stages, `top` prints the first N detected workflows, `stats` reports session/singleton/sequence counts; the latter two never synthesize or write. `--all` enumerates all transcript project directories but still partitions detection by project. Require `--projects-root` to accompany `--all`; reject conflicting/unknown options, missing values, `--out`, `--apply`, nonpositive `--min-count`/`--n`, and invalid windows. Exit 0 for valid empty/repeated/no-new-row runs, 2 for usage/validation, 1 for I/O/staging failures. Root/source/output paths and diagnostics are included in JSON and readable output. `--json` yields one JSON document on stdout; errors go to stderr.

**S3 — MCP and publication contract (files 8, 9, 16–21).**

Register `stratum_distill` using the contract-driven server. Proposed wire request:

```text
{ workspace_root: string, project_dir?: string,
  window_days?: number, min_count?: number, write?: boolean }
```

`workspace_root` must be nonempty, absolute and an existing directory; normalize it before use. `project_dir` defaults as above, and when supplied must be nonempty/absolute (missing directory is a valid empty scan). Defaults are 30, 2, true. No `apply`, model, arbitrary output path, flow ID or caller-supplied candidate is accepted. Public MCP is single-source as in Python; CLI owns `--all`.

The success payload is:

```text
{ status:"ok", candidates: AssetCandidate[], evaluated:number, written:number,
  reason:string, out_path:string, workspace_root:string, project_dirs:string[],
  applied:false, diagnostics:{ sessions:number, skippedFiles:number,
    droppedLines:number, droppedEvents:number, mtimeFailures:number,
    malformedRows:number, unsupportedRows:number, authoringSkipped:number } }
```

An expected operational/domain failure returns `{ status:"error", error_type:string, message:string }`, with `error_type` one of `invalid_options`, `source_read_error`, `candidate_error`, `staging_error`. No false empty success after a lock or write failure. Wrong wire types/undeclared keys use existing request-validation behavior; runner domain constraints cover integers, thresholds and path policy. Error messages must not echo raw transcript inputs. A source scan with individual skipped files may return `ok` with nonzero diagnostics, visibly degraded rather than silently complete.

`mcp-surface.json` declares these exact nested fields using `$array` and strict record shapes, including occurrence step records and candidate metadata; do not use opaque `"array"`/`"object"` for the candidate. Use `$oneOf` only for the structurally distinct singleton/sequence workflow descriptions. Literal values/enums, finite integer bounds, create-only operation and schema/digest invariants need domain validators because the contract grammar's string/number leaves do not express them. Success returns a status; the registry strips it before validating the selected `ok` shape.

`server.ts` adds one dispatcher case with no engine call or flow identity. Tool listing and JSON Schema advertising follow automatically from the contract. A packaged-code smoke test must confirm the entry is advertised after build. The README should explain shortlist/staged/skipped/nothing-to-distill presentation formerly provided by the Python skill wrapper, and clearly label a staged draft as requiring review. No new skill installer or user-home file writes.

---

## Grounding: what the code does today

### Live TS sibling and boundaries

| Reference | Verified behavior and implication |
|---|---|
| `ts/src/learn/harvest.ts:20–47,56–84` | `FailureRecord` and read diagnostics; persisted flow source. Mirror separation of read and interpretation, not the input type. |
| `ts/src/learn/classify.ts:23–55,146–168,171–200,208–273` | Run/pair thresholds, attributed grouping, deterministic clusters/evidence; do not import memory thresholds of 2 runs/3 pairs into distill. |
| `ts/src/learn/candidate.ts:25–50,73–139` | Common candidate envelope, deterministic templates, cluster/revision separation and authoring digest. |
| `ts/src/learn/candidate.ts:58–71,180–224` | Lexical project target validation, dedicated append-only sidecar and latest-per-cluster. Existing append is not cross-process locked and cannot substitute for Python flock guarantees. |
| `ts/src/learn/apply.ts:78–119,128–159,163–200` | Current critics and identity checks assume memory/flow/run semantics; `admit` accepts only `PatchCandidate`. Semantic conflict remains future work. |
| `ts/src/learn/apply.ts:269–321,323–342,351–447` | Real-path checking is private; memory insertion and prepare/write/ledger-commit are apply-specific. Learn from these boundaries; do not import apply into staging. |
| `ts/src/cli/learn.ts:30–38,59–101,104–117` | Current CLI wrapper, resolved root, optional staging and listing. Its cwd default is not subdirectory-safe by itself. |
| `ts/src/guard/transition.ts:541–668` | Guard transition evaluates policy and appends a ledger receipt; it does not author/write proposed asset bytes. Reserved for future apply. |
| `ts/src/guard/store.ts:57–82,357–443`; `ts/src/guard/lock.ts:317–325` | Guard resources/ledger and lock live under the guard store. Do not create one just to append inert candidates. |
| `ts/src/engine/run_lock.ts:94–102,240–257,332–375`; `ts/src/engine/state.ts:261–268` | Existing filesystem lock accepts an explicit root and safe key; local lock/tmp/recovery files only. Driver-lease operations start separately after this primitive. |

### Retired Python — behavioral authority

| Reference on `python-legacy` | Verified behavior |
|---|---|
| `src/stratum/judge/distill/__init__.py:1–29`; `__main__.py:1–5` | Public distill exports, recurrence complement, CLI module entry. |
| `src/stratum/judge/postmortem/loader.py:128–169,193–242` | Assistant tool-use extraction, physical line numbers, sorted nonrecursive transcripts and sidechain exclusion. |
| `src/stratum/judge/distill/detector.py:17–78` | Canonical-key priority, redaction-before-120-character preview, whole-session steps. |
| `src/stratum/judge/distill/detector.py:81–112,115–203` | Workflow fields/representative handle, minCount/minSessions, 2–4 n-grams, overlapping windows, deterministic result order. |
| `src/stratum/judge/distill/candidate.py:17–49` | Create-only asset description, evidence IDs and additive first-source handle. |
| `src/stratum/judge/distill/synthesize.py:17–75,78–128` | Form table, safe slug/plural paths, described suggestion, injected enum override, form-sensitive cluster ID and confidence heuristic. No inventory or model call by default. |
| `src/stratum/judge/distill/runner.py:19–36,39–84` | Mtime window, missing-source empty, shared orchestration, destination cwd separate from transcript source, conditional sidecar append and return semantics. |
| `src/stratum/judge/postmortem/corpus.py:109–171` | `distill-1.0` nested envelope, own path, flock covering read/dedup/append, within-batch dedup and no guard ledger. |
| `src/stratum/judge/distill/cli.py:14–38,41–118` | Old extract/top/stats flags and all-project inconsistency; private author-specific source default. |
| `stratum-mcp/src/stratum_mcp/server.py:3472–3497`; `skills/distill/SKILL.md:1–56` under the same package | Stateless tool, reserved no-op apply, manual skill wrapper, evidence/shortlist/staged/nothing presentation. |

### Live entry points and tests

- `ts/src/cli/stratum.ts:23–37`: lazy CLI family routing. `ts/src/cli/learn.ts` is the current template, not retired `postmortem/cli.py`.
- `ts/src/mcp/server.ts:57–62,235–256,468–470,549–560`: `ToolName`, contract validation, real stateless compile tool, response check and registry-driven listing. `ts/contracts/mcp-surface.json:111–126` is its `ok/error` shape.
- `ts/src/mcp/contracts.ts:32–35,42–87,90–133,140–158`: generic contract loading, strict objects, typed arrays/exact-one alternatives and request/response checking. `server.ts:665–696` advertises the corresponding JSON Schema.
- `ts/tests/learn/candidate.test.ts:1–80`: temporary directories and deterministic authoring assertions. `ts/tests/mcp/p5.test.ts:258–260` demands all registered non-guard response statuses; `ts/tests/mcp/contracts-grammar.test.ts:81–83` and `ts/tests/mcp/schema-grammar.test.ts:85–90` both pin surface 21 at the audited commit (concurrent work has moved both to 22).
- `ts/scripts/prepare-dist.mjs:40–44`: existing contract packaging; `ts/package.json:22–31` supplies build/test/typecheck commands.

---

## Corrections table (spec assumption vs reality)

| Original assumption | Reality | Resolution |
|---|---|---|
| Distill detects failures or proven successful workflows | Detector consumes only repeated tool-use observations, no judge/tool-result verdict | Preserve recurrence; never claim verified success. Memory harvesting is structural precedent only. |
| TS machinery exists; only apply is absent | No distill hits in source or contract; no generic transcript loader in live TS | Port the minimal Claude reader plus detector/author/stager. No broader provenance family. |
| Reuse segmenter work spans, 2–5 n-grams, stopping-condition signal | Shipped whole-session stream, 2–4, no stopping-condition test (`report.md:34–37`) | Preserve shipped defaults and state known cross-goal limitation. |
| Token-overlap/user-phrase clustering and asset inventory shipped | Neither appears in actual detector/synthesis | Do not add them under a parity claim; preserve known-empty pool context now. |
| Python `suggested_content` was a complete asset | It was a short described suggestion | Explicit TS adaptation to inspectable whole-file drafts; still never installed. |
| Existing `PatchCandidate`/`admit` can accept asset kind | Literal `targetKind:"memory"`, run/flow evidence and note formatting | Same envelope, genuine source/render differences, future discriminated union; no current admission call or generalization. |
| Reuse `distill-1.0` and cluster-only ID | Legacy nested schema and cluster dedup cannot represent TS revisions | Flat `distill-2.0` in `.stratum/distill/candidates.jsonl`; immutable revision dedup, legacy file untouched. |
| Copy live learning append helper verbatim | No cross-process lock there; Python used flock | Reuse explicit-root filesystem lock around read/dedup/append; no guard state. |
| Mirror `stratum_decompose` | No current implementation or registration by that name | Mirror registered `stratum_compile_speckit` and contract-first dispatch. |
| Mirror postmortem CLI, use personal directory and arbitrary `--out` | Retired CLI, live `cli/learn.ts`, independent source/destination roots | Live wrapper/routing, explicit MCP root, CLI root discovery/override, fixed staging directory. |
| `top/stats --all` describe the same groups extract stages | Python aggregated sources for inspection but staged per source | All three commands detect per source project; aggregate only results. |
| Reserved `apply` can harmlessly imply future behavior | Python silently ignored even true; TS apply does not exist | Omit/reject the field and always return `applied:false`. |
| Context/lineage can be filled in at apply | STRAT-ADMIT requires author-time parents | Stage exact authoring digest and known-empty pool snapshot; future pool-reading authors must populate it at authoring. |
| “No guards” means no locks or no writes | Python staging appended an inert sidecar under flock | Only staging file/storage-lock mutations; no authorization, asset, flow or ledger mutation. |
| Engine-note line numbers and tool templates are still current | Guard and MCP source moved; old note also predates live MEMORY machinery | Use the current grounding ranges above; leave historical/future docs read-only. |

---

## Boundary Map

Dependency order: **S0 → S1 → S2 → S3**, with S3 contract/tests work able to proceed against the agreed S2 interface. Storage and synthesis tests can run independently once S0 types are fixed. No work unit owns apply or admission.

| Symbol | Kind | File | Produced by | Consumed by |
|---|---|---|---|---|
| `TranscriptSession`, `TranscriptHandle`, `HarvestDiagnostics` | types | `ts/src/distill/harvest.ts` | S0 | S0 detector; S2 runner; S1 evidence serialization |
| `loadSessions` | function | `ts/src/distill/harvest.ts` | S0 | S2 `inspectWorkflows` |
| `WorkflowDescription`, `WorkflowOccurrence`, `WorkflowCandidate` | types | `ts/src/distill/detector.ts` | S0 | S1 author/synthesis; S2 inspection output |
| `canonicalizeInput`, `toolSteps`, `detect` | functions | `ts/src/distill/detector.ts` | S0 | S0 tests; S2 runner |
| `AssetKind`, `AssetCandidate`, `AuthoringContext` | types | `ts/src/distill/candidate.ts` | S1 | S1 synthesize; S2 runner; S3 contract/tests |
| `authorCandidate`, `verifyCandidateIdentity`, `targetPathFor` | functions | `ts/src/distill/candidate.ts` | S1 | S1 synthesis/storage and tests |
| `sidecarPath`, `readCandidates`, `appendCandidates`, `latestPerCluster` | functions | `ts/src/distill/candidate.ts` | S1 | S2 runner; future apply reads exact revisions, not implemented here |
| `FormSelector`, `synthesize` | type/function | `ts/src/distill/synthesize.ts` | S1 | S2 runner; S1 injected-selector tests |
| `DistillOptions`, `ResolvedDistillRequest`, `DistillInspection`, `DistillResult`, `DistillError` | types/class | `ts/src/distill/runner.ts` | S2 | S2 CLI; S3 MCP adapter/tests |
| `resolveDistillRequest`, `inspectWorkflows`, `runDistill` | functions | `ts/src/distill/runner.ts` | S2 | S2 CLI; S3 MCP |
| `distillCommand` | function | `ts/src/cli/distill.ts` | S2 | Existing CLI `main` |
| `acquireRunLock` | existing function | `ts/src/engine/run_lock.ts` | Existing engine | S1 candidate sidecar only, with explicit local root/key |

The MCP wire fields, JSONL schema, root/source policy, identity recipes and diagnostic counters are contracts specified above, not extra symbol-map entries. Existing `PatchCandidate`, `admit`, guard transitions and ledger APIs remain read-only integration context. The future union must preserve these candidate identities and source semantics instead of converting transcripts into fake failure records.

---

## Verification Table

### Grounding verification performed for this design

| Check/reference | Result |
|---|---|
| Git branch/tree before authoring; main and archival commits | `main`, clean; commits recorded above. |
| All seven requested Python distill modules, skill wrapper, five tests; historical design/blueprint/plan/report | Read in full from the archive/main respectively. Loader, corpus writer and Python MCP registration/tests also checked to resolve their dependencies. |
| All four live `learn` modules, `cli/learn.ts`, TS-1 design precedent | Read in full; memory data model and apply-only assumptions confirmed. |
| `guard/{transition,store,lock}.ts`, `mcp/{server,contracts}.ts` | Read in full; storage concurrency distinguished from guarded authorization; real MCP registration path identified. |
| `rg -n -i 'distill\|stratum_decompose' ts/src ts/contracts` | No matches; absence is verified, runtime yield is unmeasured. |
| Grounding ranges in the tables above | Checked against the recorded revisions; archived paths are branch references, not current source files. |
| `STRAT-DISTILL-APPLY/design.md`; `STRAT-ADMIT/design.md` | Read-only requirements incorporated; neither edited. |
| Runtime tests / real transcript measurement | Not run for this documentation-only pass; no implementation exists to certify. The following rows are future acceptance work, not passing results. |

### Implementation acceptance tests

| Boundary/change | Test file(s) and action | Required evidence; legacy precedent |
|---|---|---|
| JSONL/source reader | Add `tests/distill/harvest.test.ts` | Sorted files, correct physical lines/block indexes, sidechain/noise skip, malformed data, default/zero/stale window, mtime failure diagnostics, missing vs unreadable source, symlink/path confinement. Legacy loader `:128–169,193–242`; runner `:19–36`. |
| Canonicalization/detection | Add `tests/distill/detector.test.ts` | Repeated singleton/sequence across ≥2 sessions; one-off and one-session loops empty; n-grams 2–4, overlaps counted, deterministic order, benign inputs unchanged, secret redaction before truncation/output; duplicated source input not double-counted. `python-legacy:tests/test_distill_detector.py:38–122`. |
| Evidence handles | Add harvest/detector/candidate tests | First source handle survives all boundaries; every occurrence/step resolves to original line/block and digest; recurrence recomputes exactly. Cwd changes/missing values within a sequence retain step-local attribution and a null aggregate cwd; unrelated session cwds do not widen candidate scope. Missing/changed source remains detectable for future admission. `python-legacy:tests/test_distill_handle.py:38–74`. |
| Form and authoring | Add `tests/distill/synthesize.test.ts`, `candidate.test.ts` | Three-form table including non-Bash singleton, unknown/below-bar null, valid override, absent/throwing/ambiguous selector fallback. Parse rendered frontmatter and inspect exact draft content; escaped observations cannot inject instructions/metadata. `python-legacy:tests/test_distill_synthesize.py:24–79`. |
| Candidate contract and future union | Add `tests/distill/candidate.test.ts` | Every common envelope field; full-file create semantics; no fake run/flow data; same inputs same IDs, new evidence/template/path/form/context changes identity as specified, scope isolation; tampered rows rejected. A test-local `PatchCandidate \| AssetCandidate` consumer narrows kinds; no change/call to live `admit`. |
| Authoring context | Add candidate/synthesis tests | No pool reads/model/network calls, `poolSnapshot:[]` and `poolRead:false`; input digest verifies exact evidence/template/selection; attempted unrecorded context rejected. ADMIT design `:139–169`. |
| Sidecar persistence | Add `tests/distill/candidate.test.ts` | Independent `distill-2.0` file; second append and within-batch duplicates write zero; eight concurrent subprocess writers produce no losses/duplicates; new revisions retained; malformed/foreign/torn-tail handling, complete non-newline tail dedup, lock errors and permission failures. `python-legacy:tests/test_distill_corpus.py:31–96`. |
| Shared runner/no mutations | Add `tests/distill/runner.test.ts` | Empty/no-recurrence success creates nothing; preview creates nothing; sidecar-only extract; counts/reasons correct when all rows already exist; snapshot intended assets, other corpora, flows and guard state before/after. Assert no calls to admission/apply/guard, including with `STRATUM_LEARN_APPLY_ENABLED=1`. Python runner `:39–84`, MCP tests `:51–78`. |
| Root and all-project policy | Add runner/CLI tests | Root invocation and nested `ts/` invocation resolve same Git workspace; explicit nested root respected; non-Git fallback disclosed; source override; two projects cannot meet recurrence by one session each; all three subcommands expose identical per-project grouping. |
| CLI | Add `tests/cli/distill.test.ts` | Public routing for extract/top/stats, source flags, JSON document, count/window/N validation, resolved paths, zero-result exit 0, usage 2, operational 1; no arbitrary output/apply flag. `python-legacy:tests/test_distill_cli.py:32–75`. |
| MCP | Add `tests/mcp/distill.test.ts`; update `p5.test.ts`, `contracts-grammar.test.ts`, `schema-grammar.test.ts` | SDK listing and both statuses, exact nested output validation, malformed/tampered candidate rejection, unknown keys/apply rejected, absent root rejected, default staging vs preview, no flow mutation, both surface version assertions and all-tools sweep. Legacy MCP tests `:37–78`; live integration references above. |
| Build/docs | Existing build; README/CHANGELOG updates | Published contract advertises tool; CLI route in built output; documented defaults/schema/limits match tests. No separate installer or Python runtime needed. |

From `ts/`, planned focused checks after each owning slice:

```bash
npm test -- tests/distill/harvest.test.ts tests/distill/detector.test.ts
npm test -- tests/distill/candidate.test.ts tests/distill/synthesize.test.ts
npm test -- tests/distill/runner.test.ts tests/cli/distill.test.ts
npm test -- tests/mcp/distill.test.ts tests/mcp/p5.test.ts tests/mcp/contracts-grammar.test.ts tests/mcp/schema-grammar.test.ts
npm run typecheck
npm run build
```

At implementation integration, run `npm test` once to cover shared routing/contracts and unchanged learning/guard behavior; report actual results and any blocked checks. Do not claim historical Python suite counts as TS verification. Documentation acceptance is README/CHANGELOG accuracy plus review of this feature's scope; feature registration/status changes remain a human triage decision, and no `feature.json` is created by this dispatch.
