# STRAT-DISTILL-APPLY — Design

**Status:** DESIGN (2026-09-22; stub filed 2026-06-14, guardrails adopted 2026-08-06/07) · **Owner:** stratum · **Complexity:** M · **Scope decision (owner, 2026-09-22):** narrow v1 — reuse the memory-class apply path, one asset at a time, deterministic critics only. STRAT-ADMIT's LLM critics, batch admission and batch revalidation stay a follow-up that plugs into the seam this feature creates. **The pool-scoped lock is IN v1** (D7): it is held continuously across pool listing, admission and write, because without it two concurrent applies both pass the collision check and both commit.

## Related Documents

- Roadmap row: `docs/plans/COMPOSE-ROADMAP.md` → Standalone Tickets → STRAT-DISTILL-APPLY (parent `STRAT-DISTILL-TS-1`)
- Staging substrate this applies from: `../STRAT-DISTILL-TS-1/design.md` (§"AssetCandidate and the future admission boundary"; §149 "proposals, not … a final apply allowlist")
- Apply machinery this generalizes: `../STRAT-TS-LEARN/design.md` §3.5 (journal protocol), §5.1 (what memory-class may skip) → `ts/src/learn/apply.ts`
- Admission gate this is the v1 seam for: `../STRAT-ADMIT/design.md` (guardrail 5; §2.3 subset admission, §2.4 lineage are explicitly NOT built here)
- Guard primitive: `ts/src/guard/transition.ts` (`registerGuard`, `guardTransition`), `ts/src/guard/lock.ts` (`resourceLock`)
- Guardrails 1–5 and their rationale: Appendix A below (unchanged from the 2026-08 stub)
- Blueprint (implementation grounding, and the verified corrections to this design — read its `## Corrections` before implementing): [`blueprint.md`](/Users/ruze/reg/my/forge/stratum/docs/features/STRAT-DISTILL-APPLY/blueprint.md)

---

## 0. What the stub got wrong, corrected on disk (2026-09-22)

The 2026-06 stub predates the TS engine. Three of its premises are false today; every claim here was re-read from source.

| Stub said | Reality | Evidence |
|---|---|---|
| `stratum_distill` "already accepts an `apply` flag but it is reserved/no-op" | The TS tool has **no** `apply` field; the request schema is `workspace_root, project_dir?, min_count?, window_days?, write?` and undeclared fields are rejected. `write` means stage-vs-preview. Every result carries literal `applied: false`. | `ts/contracts/mcp-surface.json` (`stratum_distill.request`), `ts/src/distill/runner.ts:21,78` |
| "Any apply path has a TS port of the staging substrate as a precondition" | Shipped: `STRAT-DISTILL-TS-1` (`ts/src/distill/`, sidecar `.stratum/distill/candidates.jsonl`, schema `distill-2.0`). | `ts/src/distill/candidate.ts:96-124` |
| No apply machinery exists; must be built on the guard primitive | A full memory-class apply path exists: 4 deterministic critics, prepare/applying/applied journal, guard-ledger commit, compare-and-swap revert, ledger-authoritative reconcile, default OFF. Hardcoded to `targetKind === "memory"`, `.stratum/learn/**`. | `ts/src/learn/apply.ts:84` (memory-only), `:275` (allowlist), `:351` (`applyCandidate`), `:538` (`revertApply`), `:600` (`reconcile`) |
| The distiller reads the existing pool (the contamination chain's precondition) | The TS distiller **never reads the pool**: `authorCandidate` rejects any non-empty `poolSnapshot` (`:57`), records `poolRead: false` (`:58`), and binds the empty snapshot into `authoringInputsDigest` (`:79`). | `ts/src/distill/candidate.ts:57-58,79` |

The last row is load-bearing. `../STRAT-TS-LEARN/design.md` §5.1 argues that lineage is only required where the authoring edge exists. For distill-2.0 it does not, by construction. So v1 records lineage fields (they are already on the candidate) but has nothing to traverse, and the tripwire is the same one memory-class already carries: **if `authoring.poolRead` ever becomes `true`, full STRAT-ADMIT lineage and batch admission become mandatory before apply.**

### 0.1 What this v1 explicitly supersedes (gate round 1, 2026-09-22)

Appendix A's guardrail 5 says admission must be "per-candidate AND subset-level", and `../STRAT-ADMIT/design.md` §2.3–2.4 make batch-set admission plus a pool-scoped lock with revalidation a hard precondition for any skill-class apply. **This v1 does not meet that bar and does not claim to.** The owner's scope decision (2026-09-22) supersedes it for v1 with these named limits:

- Admission is per-candidate plus name/digest collision against the pool. There is no marginal-gain, pairwise-conflict or pool-size-pressure check, and no batch. A pool of individually-clean, semantically overlapping drafts is therefore possible. Mitigation: every v1 asset is a **non-routable draft** (D3), so an overlapping draft is inert until a human promotes it by hand.
- Lineage is empty by construction (§0 row 4), so lineage-aware revert has nothing to walk. This is a property of today's distiller, with a named tripwire, not a waiver.
- What v1 **does** keep from §2.4: a **pool-scoped lock** held across pool read, admission and write (D7), so two concurrent applies cannot both pass the collision check and both commit. Codex's round-1 review found that the memory path's target-scoped lock alone permits exactly that race.

When STRAT-ADMIT ships, it replaces the asset adapter's `admit()` (D1) and the D3 draft marker becomes the routing decision of the admitted asset rather than a blanket rule. Nothing else in this design moves.

## 1. Problem

Distill stages skill-class drafts and nothing can install them. The gap between "staged" and "in the working tree" is exactly the write that guardrails 1–5 were adopted for, and the memory path already implements guardrails 1–4 plus a deterministic slice of 5. Building a second apply protocol for assets would duplicate ~400 lines of crash-tested recovery logic (30 tests) and fork the journal/ledger semantics that recovery depends on.

## 2. Decisions

### D1 — One apply protocol, two adapters. Memory behavior is byte-identical.

Split `ts/src/learn/apply.ts` into a candidate-agnostic core and per-kind adapters. Codex's read of `apply.ts` (2026-09-22, sol/high) classified every function; the agnostic set is: `realpathOrSelf`, `realpathThroughMissing`, `restore`, `readTarget`, `atomicWriteFile`, `sha`, plus the *algorithms* inside `applyCandidate` / `revertApply` / `reconcile` / `ledgerReceipt` / `abort`. The memory-specific set is: the critics, `noteSubject`, `verifyIdentity`, `renderAfter`, `journalDir`, `assertAllowlisted`, the `learn-apply-*` guard namespace, the `learn-target-*` lock prefix, and the enable flag.

```ts
// ts/src/apply/protocol.ts (new) — the agnostic core, parameterized by an adapter.
// The core never touches a candidate field directly: everything it needs comes
// through the adapter, so the memory adapter can hand back today's exact values.
interface ApplyAdapter<C, E, J extends BaseJournalEntry<E>> {
  kind: "memory" | "asset";
  enabled(options: ApplyOptions): boolean;                 // separate default-OFF flag per kind
  workspaceRoot(candidate: C): string;
  targetPath(candidate: C): string;                        // the core never reads a candidate field directly
  evidenceFor(candidate: C): E[];                          // memory: FailureRecord[]; asset: WorkflowOccurrence[]
  ids(candidate: C): { clusterId: string; revisionId: string };
  verifyIdentity(candidate: C): void;                      // bytes == what the revision id names
  allowlist(workspaceRoot: string, targetPath: string): Promise<string>;   // realpath-checked
  pool(workspaceRoot: string, target: string): Promise<PoolView>;          // memory: target file; asset: .claude/* listing
  admit(candidate: C, pool: PoolView): Promise<AdmissionResult>;
  renderAfter(before: string, candidate: C): string;
  journalDir(workspaceRoot: string): string;               // .stratum/learn/applies | .stratum/distill/applies
  journalEntry(candidate: C, base: BaseJournalEntry): J;   // adapter OWNS the serialized shape
  guardResource(applyId: string): string;                  // learn-apply-<id> | distill-apply-<id>
  guardRegistration(): GuardRegistration;                  // { graph, predicates, initial, terminals } — the FULL registerGuard
                                                           // argument set. `GuardGraph` (guard/store.ts:21) is adjacency
                                                           // ONLY; registerGuard takes predicates separately
                                                           // (guard/transition.ts:396), so a graph alone cannot carry the
                                                           // human-bound predicate D4's falsifier adds.
  transitionArtifacts(entry: J, edge: "applying" | "applied" | "reverted" | "aborted"): Record<string, string>;
  locks(workspaceRoot: string, target: string): string[];  // memory: [learn-target-<sha>]; asset: [distill-pool-<sha(root)>, distill-target-<sha>]
}
```

**The memory journal does not change shape.** `BaseJournalEntry<E>` is exactly today's `JournalEntry` fields with `evidence: E[]` as the only parameterized member (today it is fixed to `FailureRecord[]` at `apply.ts:214`, while assets carry `WorkflowOccurrence[]` — `distill/candidate.ts:15`); `BaseJournalEntry<FailureRecord>` is structurally identical to today's type, so the memory tests' typed literal still checks. the asset journal is an extension type (`AssetJournalEntry = BaseJournalEntry & { kind: "asset"; lineage: … }`). No field is added to serialized memory journals, because the journal digest is committed to the ledger (`apply.ts:423`) and the ledger receipt is re-derived from the exact `applying → applied` payload (`apply.ts:464-502`); a new serialized field would silently orphan every existing memory receipt. Transition artifacts, guard resource names (`learn-apply-*`) and the guard graph are adapter-owned so the memory adapter emits byte-identical payloads. **The regression gate is that `ts/tests/learn/apply.test.ts` passes unchanged**, including the tests that pin the resource name (`apply.test.ts:357`) and construct a typed `JournalEntry` literal and a legacy payload digest (`:452`). `ts/src/learn/apply.ts` keeps its public exports by re-exporting through the adapter.

*Rejected alternative:* copy `apply.ts` into `ts/src/distill/apply.ts` and edit. Faster to write, and the reconcile matrix would drift between the two copies the first time either is fixed (`../STRAT-ADMIT/design.md` §5 Q7 flags exactly this).

### D2 — Distill proposes real install paths; apply writes exactly what was admitted. (owner decision)

`targetPathFor` in `ts/src/distill/candidate.ts:29` moves the three targets under the directory Claude Code actually discovers:

| kind | today (never loaded by Claude Code) | after |
|---|---|---|
| skill | `<root>/skills/<name>/SKILL.md` | `<root>/.claude/skills/<name>/SKILL.md` |
| subagent | `<root>/agents/<name>.md` | `<root>/.claude/agents/<name>.md` |
| command | `<root>/commands/<name>.md` | `<root>/.claude/commands/<name>.md` |

`targetPath` is hashed into `revisionId` (`candidate.ts:85`) and re-derived by `verifyCandidateIdentity` (`:88`), so this re-keys every staged row. Rather than let existing rows read as *corrupt*, bump `schemaVersion` to `distill-2.1`. Today's sidecar reader discards unsupported rows outright (`candidate.ts:104`) and the CLI has no sidecar-oriented `list` (`top` ranks freshly detected workflows, `distill.ts:31`), so S2 adds: a raw-row reader that keeps `{schemaVersion, revisionId, clusterId, targetKind, assetName}` for well-formed legacy rows, a `stratum distill list` verb over the sidecar that marks them `legacy (distill-2.0; re-run extract)`, and a fixed apply error `revision <id> is schema distill-2.0; not apply-eligible, re-run extract`. `top` keeps its meaning. The sidecar is append-only staging, so re-staging costs one `stratum distill extract`. The `runner.test.ts:22` sentinel list moves with the paths.

Apply writes the admitted bytes to the admitted `targetPath`, no remapping. The journal, ledger `modifiedFiles`, and the candidate all name the same path.

### D3 — Drafts install as user-invoked only; auto-routing requires a real trigger. (owner decision)

A distill candidate is a draft: its template description is the constant `"Draft for review when considering this recurring tool workflow."` (`candidate.ts:73`). Installed as-is under `.claude/`, Claude Code would route to it on that description — the "description states no trigger condition" reject in `../STRAT-ADMIT/design.md` §2.2, and the pool pollution guardrail 5 exists to prevent.

v1 rule, enforced by the structural critic (§D5) and satisfied by the distill template (bump `templateVersion` → `2`):

- **skill / command:** frontmatter MUST carry `disable-model-invocation: true` unless the description states a trigger condition. Since the template cannot produce a trigger, every v1 draft carries the marker; it is loadable only by explicit `/name`. A human promoting the draft edits the file in place, which is an ordinary edit outside this path and does not touch the journal (the revert CAS then correctly refuses, because the bytes moved).
  *Evidence the marker is honored:* it is in live use by installed plugin commands (`~/.claude/plugins/cache/openai-codex/codex/1.0.6/commands/*.md`) and documented in the local skill-authoring template as "Block Skill tool" (`~/.claude/skills/create-skill/SKILL.md`). Official docs (https://code.claude.com/docs/en/skills.md): `disable-model-invocation: true` — "Only you can invoke the skill. Use this for workflows with side effects or that you want to control timing." Note the same page lists `.claude/commands/<name>.md` as the **legacy** command location; v1 still targets it because Claude Code still loads it, but a follow-up may fold distill's `command` kind into a skill.
- **subagent:** there is **no** frontmatter field that stops automatic delegation to a `.claude/agents/*.md` subagent (https://code.claude.com/docs/en/sub-agents.md offers only a minimal description, a `permissions.deny` entry, or explicit @-mention — none of which the asset file itself can carry). **v1 refuses `targetKind: "subagent"` at admission** with a named finding (`"subagent drafts have no non-delegation marker; not apply-eligible in v1"`). Falsifier: a documented frontmatter field with that semantic — then subagents join D3's rule with no other change.

### D4 — Authorization: default OFF, operator-gated, and honestly agent-mintable. (owner decision, gate round 1)

The 2026-06 stub required apply to be "not agent-mintable". **v1 does not deliver that, and says so.** The gate: `STRATUM_DISTILL_APPLY_ENABLED=1` or `ApplyOptions.enabled` — the same shape as the memory path (`apply.ts:31`, `learn.ts:145`). `STRATUM_DISTILL_APPLY_ENABLED=1 stratum distill apply <id>` is one shell line, so any agent with Bash can mint it; the guard registration carries an empty predicate map (`apply.ts:418`), so the ledger records the write but does not authorize it. The owner accepted this posture on 2026-09-22 for these reasons:

- It is the posture the memory-note apply already ships with; a stronger primitive for assets alone would leave the two paths inconsistent, and a human-bound approval that shell access cannot forge is a new authorization design (`STRAT-GUARD` predicates + an out-of-band grant), not a v1 line item. Filed as the falsifier below.
- Every v1 asset is a **non-routable draft** (D3). A minted apply installs an inert file that only an explicit `/name` loads, so the worst case of a rogue apply is a draft in `.claude/`, visible in the ledger and revertible by id, not an active instruction in the routing pool.
- The real control is the operator: keep the flag unset (default), and optionally deny the verb to agents at the harness (`permissions.deny: ["Bash(stratum distill apply*)"]` in Claude Code settings, documented in `stratum distill --help`).

Surface: `stratum distill apply <revision-id> [--root]`, `stratum distill revert <apply-id>`, `stratum distill reconcile`, `stratum distill list` (CLI, `ts/src/cli/distill.ts`). Separate flag from learn's, so enabling memory notes does not enable executable assets. `stratum_distill` (MCP) is unchanged; `applied: false` stays literal; no MCP apply surface.

The ledger entry records: `revision_id`, `journal_digest`, `after_digest`, `evidence_ids` digest, `verdicts` digest, `pool_digest`, and the lineage fields (D6). Same guard graph as memory (`staged → applying → applied → reverted`, `aborted`), own namespace `distill-apply-<id>`.

**Falsifier / follow-up:** when a human-bound grant exists as a guard predicate (a `STRAT-GUARD` evidence kind that a Bash-capable agent cannot satisfy), the asset adapter's `guardRegistration()` adds it as an edge predicate on `staged → applying` and D3's blanket draft marker can be relaxed to a per-asset routing decision. Until then this section is the honest statement of what protects the pool: the flag, the draft marker, and the ledger.

### D5 — Critics for asset kind (deterministic, no model)

Same four critic names as memory (`CriticName` in `apply.ts:40`), asset-shaped bodies:

| Critic | Rejects when |
|---|---|
| structural-validity | frontmatter absent or unparseable; `description` empty; **D3 marker rule violated**; `targetKind === "subagent"` (v1); content > 16 KB; `insertion.mode !== "create"`; `schemaVersion !== "distill-2.1"`. **Kind-specific:** skill — `name` must equal `assetName` and the parent directory; command — frontmatter must **omit** `name` (legacy `.claude/commands` accepts skill frontmatter except `name` and `paths`, per the skills doc), the runtime name is the filename, which must equal `assetName`. The distill template (S2) emits per-kind frontmatter accordingly. The `$ARGUMENTS` rule from round 1 is dropped: the template only ever places mined commands inside escaped `<pre>` data and identity reconstruction forbids body mutation, so no valid candidate can violate it. |
| behavioral-harmlessness | the existing `HAZARDS` denylist (`apply.ts:64`) matches the rendered content. Assets are instructions by definition, so this critic is load-bearing, not advisory. |
| semantic-consistency | **Evidence is re-resolved at admission by re-running the real harvester, not trusted from the sidecar and not spot-checked field by field.** For each cited occurrence: re-open `<projectDir>/<transcriptFile>`, re-run `loadSessions`/`description`/`workflowFromEvidence` over the cited lines, and compare the **complete normalized step** — all seven fields (`toolName`, `canonicalInput`, `lineNo`, `blockIndex`, `toolUseId`, `cwd`, `lineDigest`) — by canonical JSON. A subset check is insufficient: `occurrenceId` binds neither `canonicalInput` nor `cwd` (`detector.ts:37`), so a rehashed staged row could otherwise claim an input or cwd the cited block never contained. Recompute each occurrence id and the workflow description and compare canonically; fail closed on a missing file, a moved line, or any mismatch (`../STRAT-DISTILL-TS-1/design.md:81` requires exactly this of any future admission). Then the internal checks: `recurrence.records ≠ evidence.length`; `recurrence.distinctSessions ≠` distinct `sessionId`s; any `evidence[].projectDir ≠ scope.transcriptProjectDir`. `verifyCandidateIdentity` is retained but is tautological on its own (it regenerates the object from itself; round 1) and is not counted as evidence verification. |
| subset-marginal-gain | an asset with the same `name` exists in **any** of the three `.claude/` dirs; an asset with the same content digest exists; the target path already exists (v1 is create-only — existing assets are never overwritten by this path) |

`PoolView` for assets is keyed **by path** — `entries: Map<path, { kind, name, contentDigest }>` — with derived multimap indexes `byName: Map<name, path[]>` and `byDigest: Map<digest, path[]>`, listed from `.claude/{skills,agents,commands}` in sorted order and digested deterministically into `poolDigest`. (A single-valued name map would drop a record when a skill, command and agent share a name, and lose its digest from the duplicate check — Codex round 1.) Genuine semantic overlap/conflict detection stays in STRAT-ADMIT.

### D5a — Source provenance is bound into identity; only workspace-derived evidence auto-applies. (round 2)

Round 1's "must be the dir distill derives for that root" was wrong about the code: `loadSessions` accepts **any** real directory (`distill/harvest.ts:16`) and the CLI deliberately supports arbitrary `--project` and `--all --projects-root` sources (`runner.ts:29,40`). A candidate records only the resolved `transcriptProjectDir` (`candidate.ts:12`), not how that directory was chosen — so "evidence came from this workspace's own transcripts" is not currently a checkable claim, and a blanket default-dir rule would also break the golden flow, which mines a fixture transcript dir.

distill-2.1 therefore adds `scope.sourceMode: "workspace" | "explicit-project" | "projects-root"`, set by `resolveDistillRequest` from the branch it actually took, and bound into `revisionId` like every other scope field. Admission policy:

- `sourceMode === "workspace"` (transcript dir derived from the apply root, `runner.ts:47`) → apply-eligible.
- any other mode → **refused** unless the operator passes `stratum distill apply <id> --trust-source`, which is recorded as ledger artifact `source_trust: "operator-asserted"` and `source_mode`. Cross-workspace installs become a deliberate, auditable act rather than a silent one.
- `candidate.scope.workspaceRoot` must equal the apply root in every mode. That check is unconditional.

The golden flow mines a fixture project dir, so it exercises the `--trust-source` path; a sibling test asserts the same candidate is refused without the flag.

### D6 — Lineage is recorded, and in v1 provably empty.

`JournalEntry.lineage = { poolSnapshot, authoringInputsDigest, poolDigestAtAdmission }` copied from the candidate at prepare time (`../STRAT-ADMIT/design.md` §2.4 phase 1 — captured where it exists, not reconstructed). Revert lists descendants = journals whose `poolSnapshot` names the reverted asset's `contentDigest`. For distill-2.1 that set is empty by construction (`authoring.poolRead: false`), which the design states rather than hides: the CLI prints `descendants: 0 (distiller does not read the pool)`. Tripwire test: `authorCandidate` still rejects a non-empty snapshot (exists: `candidate.ts:57`), plus a new test that an apply journal's `poolSnapshot` is `[]`.

### D7 — Allowlist, scope, immutable core (guardrails 1, 4)

**Locking:** the asset adapter holds `resourceLock("distill-pool-<sha(realpath(root))>")` across pool listing, admission and write, and inside it the target lock `distill-target-<sha>` (same nesting order everywhere; `resourceLock` is the cross-process primitive (`ts/src/guard/lock.ts:385`) that `apply.ts:368` (apply) and `:552` (revert) already use). Revert and reconcile take the same pair.

`assertAllowlisted` for assets: realpath of the deepest existing ancestor must sit under realpath(`<root>/.claude/<skills|agents|commands>`), the `.claude` dir itself must resolve inside the workspace (same symlink defenses as `apply.ts:275-296`), file must be `.md`, and for skills the parent dir name must equal `name`. Project scope only; no user/global promotion in v1 (guardrail 1). `ts/src/{guard,judge}`, specs, `docs/judgment` are outside the allowlist by construction and additionally on the HAZARDS denylist as content.

## 3. Non-goals

- LLM critics, subset selection beyond name/digest collision, pool-size pressure, batch manifest, and STRAT-ADMIT's batch protocol — admission evaluated over a candidate *set*, critics run outside the lock, and verdict revalidation against a moved pool digest — `../STRAT-ADMIT/design.md` §2.3–2.4, §5. **Not deferred:** the pool-scoped lock itself (D7).
- Editing or overwriting an existing asset (v1 is create-only; `insertion.mode` stays `"create"`).
- Promotion to user scope (`~/.claude`).
- An MCP `apply` surface; auto-apply (`STRAT-DISTILL-AUTO` composed with apply stays gated on STRAT-ADMIT).
- Subagent installs (D3), until a non-delegation marker is verified.
- Backfilling or migrating `distill-2.0` sidecar rows.

## 4. Acceptance criteria

- [ ] `ts/src/apply/protocol.ts` (new) holds the agnostic journal/ledger/CAS/reconcile core; `ts/src/learn/apply.ts` (existing) becomes the memory adapter + re-exports; **`ts/tests/learn/apply.test.ts` passes without modification**
- [ ] `ts/src/distill/apply.ts` (new): asset adapter with the four D5 critics, `.claude/` allowlist (D7), `distill-apply-*` guard namespace, `.stratum/distill/applies` journal, separate enable flag (D4)
- [ ] `ts/src/distill/candidate.ts` (existing): `targetPathFor` → `.claude/…` (D2); `schemaVersion: "distill-2.1"`; template v2 emits `disable-model-invocation: true` for skill and command (D3); `verifyCandidateIdentity` still round-trips
- [ ] `ts/src/cli/distill.ts` (existing): `list` (sidecar), `apply <revision-id>`, `revert <apply-id>`, `reconcile`; legacy `distill-2.0` rows reported by `list` and refused by `apply` with the fixed message (D2)
- [ ] `ts/contracts/mcp-surface.json` (existing): request unchanged; `applied: false` literal unchanged. The contract grammar carries types not literals (`ts/src/mcp/contracts.ts:47`), so `distill-2.1` is documented in the tool **description** and pinned by a contract test, not by the schema (surface bump only if the contract test demands it)
- [ ] Golden flow (real fs, real guard store, fixture transcripts from `ts/tests/fixtures/distill/`; mines an explicit project dir, so it runs with `--trust-source` per D5a): extract → stage → `apply` under the flag → asset exists at `.claude/skills/<name>/SKILL.md` with the marker, journal `applied`, ledger receipt binds `after_digest` + `modifiedFiles` → `revert` restores non-existence and the ledger records it → re-apply of the same revision succeeds after revert
- [ ] `ts/src/distill/runner.ts` + `candidate.ts`: `scope.sourceMode` recorded and bound into `revisionId` (D5a)
- [ ] Guardrail tests, one per gate: default OFF writes nothing (also with `STRATUM_LEARN_APPLY_ENABLED=1` set — flags are independent); symlinked `.claude` refused; target outside the three dirs refused; existing asset never overwritten; every D5 reject has a test with a real-shaped candidate; **evidence drift refused** (edit one cited transcript line → apply fails closed; delete the transcript → fails closed; **change only `canonicalInput` or `cwd` in a rehashed staged row → fails closed**, the case a subset check misses); non-`workspace` `sourceMode` refused without `--trust-source` and admitted with it (D5a); `scope.workspaceRoot ≠` apply root refused; subagent refused with the named finding; `poolSnapshot` in the journal is `[]`; two concurrent applies of same-named candidates to different kinds → exactly one commits (pool lock)
- [ ] Reconcile matrix: the memory recovery tests re-run against the asset adapter through the shared core (parameterized, not copied)
- [ ] `runner.test.ts` "stages only the sidecar" still holds with the new paths, and additionally with `STRATUM_DISTILL_APPLY_ENABLED=1` (staging must never apply)
- [ ] CHANGELOG entry; `stratum distill --help` documents the verbs and the flag; D3's marker rule stated in the emitted asset body ("remove `disable-model-invocation` only after supplying a trigger description")

## 5. Test strategy

Golden flow and guardrail tests as above, real backends only (tmp workspace, real `.stratum/guard` store, real fixture transcripts). No mocking of the guard or the filesystem. The shared-core refactor is verified by the existing 30 memory tests passing untouched, which is the only honest proof that memory semantics did not move.

## 6. Risk

Medium-low. D4 states the authorization posture plainly: agent-mintable, mitigated by default-OFF, the D3 draft marker, and the ledger. The apply protocol is proven; the new surface area is the asset critics, the `.claude/` allowlist, and the distill re-key (D2), which invalidates staged rows once. The one behavioral change visible to users is that `stratum distill extract` now proposes `.claude/…` paths. Draft assets are installed non-routable (D3), so a bad draft costs nothing until a human promotes it.

## 7. Open questions for the design gate

1. ~~**Marker citation.**~~ Resolved 2026-09-22: official docs cited in D3. Residual: `.claude/commands/` is documented as legacy; decide at blueprint whether distill's `command` kind should emit a skill instead (recommendation: keep v1 as-is, file a follow-up).
2. **Should `distill-2.0` rows be auto-restaged** by `extract` (detect legacy rows, re-emit as 2.1) or simply reported? Recommendation: report only; re-extract is one command.
3. ~~**Command `$ARGUMENTS` rule.**~~ Resolved (round 1): dropped as unexercisable under template identity; see D5 structural.
4. **Command kind and legacy `.claude/commands`.** The skills doc calls that directory legacy. v1 keeps the kind but a follow-up should consider emitting commands as skills, which would also remove the per-kind frontmatter split in D5.

5. ~~**D4 posture.**~~ Resolved 2026-09-22 (owner): memory-path posture, stated plainly in D4 with the falsifier.

## 8. Slice plan

| Slice | Deliverable | Files |
|---|---|---|
| S1 | Extract agnostic core; memory adapter; memory tests green unchanged | `ts/src/apply/protocol.ts` (new), `ts/src/learn/apply.ts` (existing) |
| S2 | distill-2.1: `.claude/` paths, template v2 marker, legacy-row handling | `ts/src/distill/candidate.ts`, `ts/src/distill/runner.ts`, `ts/tests/distill/*.test.ts` (existing) |
| S3 | Asset adapter: critics, allowlist, journal, guard namespace, flag | `ts/src/distill/apply.ts` (new), `ts/tests/distill/apply.test.ts` (new) |
| S4 | CLI verbs, golden flow, CHANGELOG, contract doc | `ts/src/cli/distill.ts`, `ts/contracts/mcp-surface.json`, `CHANGELOG.md` (existing) |

S1 and S2 are independent; S3 depends on both; S4 on S3.

---

## Appendix A — Stub history and adopted guardrails (verbatim from 2026-06/08; superseded facts corrected in §0)

**Original scope (2026-06-14):** graduate `apply=True` to actually scaffold the chosen asset file(s) from a staged `AssetCandidate`, gated behind STRAT-GUARD-style authorization (not agent-mintable): a guarded transition with a human/authorized-token approval and a tamper-evident ledger entry, since this writes executable scaffold into the user's config. Verify emitted paths + referenced symbols post-write.

**Engine note (2026-08-06), now stale:** claimed no TS distill implementation existed; `STRAT-DISTILL-TS-1` shipped it (§0).

## Apply-path guardrails (adopted 2026-08-06, IDEA-1199)

Acceptance criteria for ANY self-modification apply path (this feature and
STRAT-LEARN-INLINE-APPLY share them). Gates 1-4 adopted from the prime-agent `/refine`
continual-harness constraint set (smart-memory-docs ideabox IDEA-1199); gate 5 added
2026-08-07 (see "Pre-commit admission" below). Together they turn "is self-modification
safe to enable" into five checkable gates:

- [ ] **Session/project-local scope by default** — an applied patch lands in project
  scope; promotion to global/user scope is a separate explicit authorized step
- [ ] **Small evidence-backed deltas only** — every applied patch carries the staged
  candidate's evidence (failed predicate / recurrence trace) in the ledger entry;
  no evidence, no apply
- [ ] **Snapshot + rollback by id** — before/after snapshot of every touched asset,
  persisted with the ledger entry; a revert tool restores by refinement/apply id.
  **Necessary but NOT sufficient** — see gate 5: per-asset rollback does not undo what
  descendants distilled from the asset while it was live
- [ ] **Immutable core** — the base spec, judge kernel, and guard config are never
  apply targets; applies only ever write skills / MEMORY / scaffolded assets
  (enforce as a path allowlist, not a convention)
- [ ] **Pre-commit admission gate + lineage-aware rollback** — no candidate reaches an
  applied asset pool on recurrence count alone. Two sub-criteria, both required:
  - [ ] **Admission is pre-commit, per-candidate AND subset-level.** Each candidate
    passes independent critics before it is written (structural validity of the emitted
    asset, behavioral harmlessness of what it instructs, semantic consistency with the
    evidence it claims to generalize). Beyond individual filtering, admission considers
    the candidate's *marginal* contribution to the existing pool — the existing
    extend-not-duplicate inventory check is per-candidate and does not cover pairwise or
    combinatorial interaction between individually-clean assets.
  - [ ] **Applies record lineage, and rollback walks it.** Every apply records which
    pool assets were in the distiller's context when the candidate was produced. Revert
    by id must surface (and offer to revert or re-gate) the descendants distilled while
    the reverted asset was live, not just the asset itself.

### Pre-commit admission — rationale (added 2026-08-07)

Source: *"When Self-Evolution Backfires: Pre-Commit Gating against Skill Contamination
in LLM Agents"* (Shang et al., arXiv:2608.05810, Aug 2026). Single-preprint, evaluated
on Terminal-Bench 2 plus one transfer benchmark — treat the **mechanism** as load-bearing
and the reported magnitudes (72% pass@1, ~5x smaller pool) as indicative only.

Three findings, and why each binds here:

1. **Skill accumulation is non-monotonic.** Past a critical pool size, newly distilled
   skills degrade agent performance rather than improving it; unconditional accumulation
   peaks and then gives back most of its gains. Gates 1-4 constrain *what a write may
   touch*; none of them ask whether admitting the asset makes the pool better. STRAT-DISTILL
   v1's bar (recurred >=2x with stable inputs, not already covered by an existing asset) is
   a relevance test, not a quality test.
2. **Contamination is cross-round and structurally irreversible.** A defective asset in
   the decision context becomes reference material when distilling later assets, so the
   flaw is inherited by descendants; post-hoc removal of the source recovers only a small
   fraction of the lost performance. **The precondition holds for us**: STRAT-DISTILL's
   Phase 2 is "inventory existing assets (extend-not-duplicate)" — the distiller reads the
   pool to produce the next asset. This is the same loop shape, not an analogy. It is also
   what demotes gate 3 from sufficient to necessary: rollback is per-asset by id with no
   lineage, which recovers exactly the small fraction the paper measures.
3. **Therefore admission must be pre-commit.** Their VaG gate composes three heterogeneous
   critics (structural validity / behavioral harmlessness / semantic consistency), reported
   as complementary and mutually non-substitutable in ablation, each intercepting a largely
   disjoint class of harmful skill, plus marginal-gain subset selection at the top tier to
   remove combinatorial contamination before skills reach the runtime context. Gate 5
   adopts the shape, not the implementation — critic count/decomposition is a design-gate
   question, not settled here.

Scope note: the contamination argument is strongest for assets that re-enter the
decision context and are read when authoring the next asset (`SKILL.md`, `agent/*.md`,
`command/*.md`). It is weaker for MEMORY patches, which are smaller and less often
reference material. Gate 5 still applies to both — a split, if justified, should be
argued at the design gate with evidence, not assumed.

**Related:** `../STRAT-DISTILL/design.md` (the inventory step that forms the chain),
`../STRAT-DISTILL-AUTO/design.md` (gate 5 is a hard precondition on composing an auto
trigger with an apply path — staging-only auto-run is unaffected),
`../STRAT-LEARN-INLINE/report.md` §7.
