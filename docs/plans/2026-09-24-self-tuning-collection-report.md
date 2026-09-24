# Self-Tuning Step 1 — Collection Evidence Report

**Plan:** [2026-09-24-self-tuning-close-loop-plan.md](2026-09-24-self-tuning-close-loop-plan.md) (Step 1a/1b; 1c/1d below)
**Produced by:** Codex gpt-6-astra/medium, read-only, 2026-09-24. **Controller verification (independent):**
`ts-agent-harness.js:237-238` connects with no state root (confirmed); `flow_cancel_edges.test.ts:37`
uses `createMcpServer({})` (confirmed); flow store census by workspaceRoot = 1,422 tmp / 59 forge /
5 other / 1 none (matches the 1,423-fixture / 58-real split); **15 tmp-root runs written in the last
24h — contamination is live today**; `dd6a8104…` lock file present (Sep 18). `C#` tags below refer to
Codex's read-only census commands (in the session log, not reproduced).

---

## Step 1a–1b findings
**The clean corpus yields three durable lessons, all predating their fixes. Contamination is still being produced by Compose tests.** Of 1,487 runs, 1,423 are candidate fixtures, six are ambiguous, and 58 are classified as real. No files were changed and no tests or `compose start` were run. [Audit output C4–C5]
Paths below are relative to `/Users/ruze/reg/my/forge`. `C#` references identify the labelled read-only census command outputs produced during this audit. Dates are UTC unless an offset is shown.
## 1a — Collector table
| Collector | Source, volume and time range | Contamination | Defect and status today |
|---|---|---|---|
| **Flow store** | `~/.stratum/ts/flows/*.json`: **1,487 runs**; event range **2026-07-10 10:16:21.598Z–2026-09-24 00:40:28.076Z**. Also one lock and one temporary save file. [C4] | **1,423 candidate fixtures**, **6 ambiguous**, **58 real**. Identification uses temporary-workspace prefixes, fixture inputs/specs and test-source matches—not flow name alone. [C2, C4, C13] | **Live.** `StateStore` defaults to the real home store; `StratumEngine` passes only `options.stateRoot`. Vitest supplies no isolation root. Compose’s two GSD goldens still connect without an isolated root. Stratum has a default-server test that writes a real-store lock; details below. [`stratum/ts/src/engine/state.ts:309`; `engine/engine.ts:386`; `ts/vitest.config.ts:5`; `compose/test/helpers/ts-agent-harness.js:238`] |
| **Routing ledger** | `compose/.compose/routing/ledger.jsonl`: **24 historical rows, 22 distinct issuances**, five real runs. Materialization range **Sep 15 02:10:08.355Z–Sep 19 09:13:44.681Z**. **Zero post-Sep-23 calls**. [C6, C10–C11] | **0 fixture-owned rows** after joining owner run IDs to the manifest. Two issuances have two revisions; these are history, not contamination. [C6, C11] | All **24 call observations** lack reported effort, hence executed tier is null. This is an execution-attribution limitation, **not a rule that shadow mode forces null**. [`compose/lib/routing-ledger.js:1154`; C6] |
| **Usage receipts** | Embedded `receipts[]` in flow JSONs: **285**, all `egress:"pending"`; **Aug 30 06:56:32.025Z–Sep 24 00:40:20.533Z**. [C3, C7] | **195 fixture receipts**, each in a fixture run, model `claude-test`; **31 ambiguous-run receipts** excluded; **59 real-run receipts** retained. [C7, C10] | **Live fixture contamination** through GSD goldens. **Live cost-presence defect:** missing/invalid provider cost becomes zero in streaming telemetry; the return path drops both zero and absent cost. Pending egress alone does not prove failure: delivery requires explicit opt-in and credentials. [`stratum/ts/src/connectors/claude.ts:178`, `:192`, `:211`; `connectors/base.ts:94`; `learn/smartmemory_egress.ts:118`] |
| **Distill transcripts** | Default Stratum project directory: **0 JSONLs**. Compose: **68**, **Aug 15 15:24:11.862Z–Sep 19 09:13:41.961Z**. Parent Forge directory: **103**; `stratum/ts`: **18**. [C8] | **0 temporary-workspace-only sessions** and **0 malformed JSON lines** in those scanned directories. This is a path/parse screen, not proof that every tool call is production activity. [C8] | **Live source-selection gap.** Default lookup encodes the canonical repo root into one Claude project-directory name. It misses Stratum work recorded under parent Forge or `stratum/ts`. Explicit `projectDir` is supported. [`stratum/ts/src/distill/runner.ts:33`, `:48`, `:53`] |
| **Judge events** | Flow `events[]`: **0 `judged` events** across all 1,487 runs, and **0** across the 58 real runs. Therefore no judge-event time range. [C4] | **0 events to contaminate**. Also **0 persisted specs containing a `judged` predicate**. [C9] | No evidence of a broken event writer: evaluated judged predicates emit audits. The proposed judge-only learning trigger does not match this corpus. Current judge fixtures use isolated roots. [`stratum/ts/src/engine/engine.ts:2546`, `:2604`; `ts/tests/judge/fixture_judged.test.ts:142`; C9] |
### Exact test write paths today
**Compose: confirmed live run/receipt contamination paths, with ordinary inherited environment and no external `STRATUM_STATE_ROOT` override:**
- `compose/test/gsd-stuck-resume-golden.test.js:165` and `:266`.
- `compose/test/gsd-budget-terminal-golden.test.js:152`.
- Both call `runGsdWithAgentFactory()`, which constructs `StratumMcpClient` and connects without setting a state root at `compose/test/helpers/ts-agent-harness.js:237–238`.
- The connection resolver supplies command, args and cwd only; the client inherits the environment. MCP then constructs the default engine, which falls through to the home store. [`compose/lib/stratum-engine.js:248`; `compose/lib/stratum-mcp-client.js:538`; `stratum/ts/src/mcp/server.ts:99`; `engine/state.ts:309`]
The corresponding fixture families have persisted events **today, Sep 24**, independently corroborating that these are not merely historical leaks. [C9]
**Compose: historical leaks whose present behavior differs:**
- `compose/test/build.test.js:206` still uses the unisolated build harness (`helpers/ts-agent-harness.js:208–209`). However, its fixture input declares only `featureCode` and `description`, while current Compose also supplies the two agent-role fields. Current Stratum rejects undeclared input keys **before allocating a run**. Therefore this remains unsafe wiring, but should not create those historical fixture JSONs on today’s code path. [`compose/test/build.test.js:54`; `compose/lib/build.js:7593`; `stratum/ts/src/ir/validate.ts:188`; `engine/engine.ts:564–597`]
- The quarantine fixture now explicitly supplies an invalid legacy pipeline and expects refusal before planning. Its historical stored run does not establish a current write. [`compose/test/pipeline-ts-engine-guard.test.js:267–285`; C9]
**Stratum:**
- The direct `new StratumEngine(...)` / `new StateStore(...)` scan found no constructor lacking an explicit root in the checked `ts/tests` calls. MCP factories require separate scrutiny; constructor isolation does not cover them.
- **Live real-store filesystem write:** `ts/tests/mcp/flow_cancel_edges.test.ts:37` constructs `createMcpServer({})`, then cancels `no-such-run-xyz` at `:42`. `flowCancel()` acquires the run lock **before** loading the missing JSON. Lock acquisition creates the directory and publishes a lock file in the default real store. It does **not** mint a run JSON. [`engine/engine.ts:1163`, `:1174`, `:502`; `engine/run_lock.ts:346–351`, `:169`]
- The historical scalar-input fixture matches `ts/tests/mcp/p5.test.ts:734`. Today that request is rejected as malformed; it should no longer persist a run. The default-server calls at `:56` and subprocess at `:901` list tools/initialize rather than plan valid runs. [`p5.test.ts:55–64`, `:727–743`, `:912`]
- The real stdio planning test explicitly passes an isolated root. [`ts/tests/mcp/stdio-planning.test.ts:23–24`]
### Routing interpretation
The observed reason is **`missing-reported-execution` on all 24 observations**, with `reportedEffort:null` throughout. The tier function can resolve a tier in shadow mode when reported model/effort uniquely match the pinned mappings; it contains no shadow-mode exclusion. Local SDK transport has a separate deliberate “effort unavailable” branch, but all observed calls here use MCP. [`compose/lib/routing-ledger.js:1154–1160`; C6]
Latest revision per `recordId` gives:
```text
22 issuances = 2 positive + 11 negative + 9 excluded
```
Counting every historical row instead gives 2/11/11; the extra two exclusions are earlier revisions subsequently marked accepted. [C11]
The labels match downstream acceptance semantics: acceptance requires acknowledged retention of the successful issuance token; same-epoch retry and acknowledged failure are negative; cancellation/uncertain lineage are excluded. Application completion alone is not acceptance. [`compose/lib/routing-ledger.js:1092–1119`]
### Claude receipt classification
These categories distinguish recorded evidence from provider facts that the receipt cannot recover. [C7]
| Classification | Count | Interpretation |
|---|---:|---|
| Fixture Claude receipts | **195** | `claude-test`, positive reported `$0.03`, attributable to fixture runs |
| Real Claude receipts with positive reported cost | **22** | 15 Sonnet-4-6; 7 Sonnet-5 |
| Real Claude receipts with **missing recorded cost** | **9** | All Sonnet-4-6, Aug 30; neither `amount.usd` nor `usdSource` |
| Explicit zero-cost Claude receipts | **0** | No persisted Claude receipt has `amount.usd === 0` |
| Claude receipts in ambiguous runs | **30** | Positive reported costs; excluded from production analysis |
| Other receipts | **29** | Model `unknown`: 28 real, one ambiguous; missing cost |
**Missing provider cost versus explicit provider zero cannot be reconstructed for those nine receipts.** Current code collapses missing/invalid provider values to zero, emits `"reported"` in streaming metadata, and omits zero from the final result. Calling all nine “provider reported zero” or “provider omitted cost” would exceed the evidence. [`connectors/base.ts:94–95`; `connectors/claude.ts:178–193`, `:211–221`]
The nine Aug-30 receipts also predate the Sep-12 provenance revision `e1074aa` (**2026-09-12 14:29:42+08:00**). This is a **date-based pre-fix classification**, not proof of their installed binary version: persisted runs expose a spec `revisionDigest`, not a runtime revision. [Git log output; C9, C12]
**COMP-MODEL-ROUTE-2 window:**
- Recorded revision bounds: `603ec78`, **Sep 15 13:34:17+08:00**, through `f250d9e`, **Sep 17 08:18:26+08:00**. [Stratum git log]
- Within that wall-clock interval: **16 non-fixture-labelled Claude receipts**—two real and 14 ambiguous experiment receipts. Actual receipt dates span **Sep 15 07:25:07.619Z–Sep 16 13:27:19.327Z**. [C9]
- One experimental receipt has **554,693 cache-creation tokens**, `$3.357147`, run `97a0cc34-e6b0-4757-92fa-eb8da3810185`, receipt 9. This is a high-cost observation, not sufficient proof of inflation by itself. [C9]
- Exact affected membership remains unproven: it also requires the explicit tool-list contents, MCP configuration, continuation behavior and executed version. The feature design explicitly warns against treating the entire date window as affected. The current fix adds `ToolSearch` unless deliberately disallowed. [`compose/docs/features/COMP-MODEL-ROUTE-2/design.md:16`; `stratum/ts/src/connectors/claude.ts:114–123`; `git show f250d9e`]
## Fixture manifest summary
A candidate manifest was constructed **in memory**, one record per candidate with:
{id, reason, flags[], sha256, restorePath}
No quarantine or manifest file was written. Classification and quarantine eligibility are separate: a fixture may still be resumable. [C4]
| Reason | Candidates | Marked RESUMABLE | Identification |
|---|---:|---:|---|
| `tmp:gsd-stuck-resume` | 888 | 445 | Temporary prefix matches scaffold at `compose/test/gsd-stuck-resume-golden.test.js:98` |
| `tmp:gsd-budget-terminal` | 438 | 0 | Prefix matches scaffold at `compose/test/gsd-budget-terminal-golden.test.js:83` |
| `tmp:build-test` | 91 | 4 | Prefix and fixture pipeline match `compose/test/build.test.js:25`, `:186` |
| `tmp:probe` | 4 | 0 | Temporary probe roots; `COMP-GSD-4-FIX` fixture inputs/gates |
| `p5 scalar-input fixture` | 1 | 0 | Missing workspace, `input:1`, matching simple test spec |
| `tmp:compose-quarantine` | 1 | 0 | Temporary quarantine workspace and probe input |
| **Total** | **1,423** | **449** | **974 terminal candidates** |
Counts and per-run classifications: [C4, C13].
**Protected/uncertain categories:**
- **LEASE-OWNED: 0 observed `.driver` files.** Lease path definition: `stratum/ts/src/engine/run_lock.ts:104`. [C10]
- **LOCK-PRESENT:** `dd6a8104-5dfc-47d7-b6f4-74ddbb18e415`, also RESUMABLE; lock names PID 30352 and has a Sep-18 timestamp. A temporary save file accompanies it. **Liveness was not established; preserve it.** [C4, C9; lock-file read output]
- **AMBIGUOUS: 6**, excluded from harvest:
  - Host-audit experiments: `012a529e-935e-4293-8595-ca9ab87d96ed` **RESUMABLE**, `97a0cc34-e6b0-4757-92fa-eb8da3810185`, `99d76a27-c5f1-4b10-bbea-7d527e9f147d` **RESUMABLE**.
  - Cost reproductions: `64f8c243-f1a0-4660-9c2c-db48e0dc3615`, `d99082ba-8647-490f-82b0-afee75268a12`.
  - Real-root `research` run with `FOO-1`: `f86a763b-6462-47fa-aeab-69e5426ece96` **RESUMABLE**. [C4]
- The **58 real runs include 12 running/resumable runs**. They remain untouched and may contribute already-persisted failure evidence. [C4, C13]
First 20 candidate IDs, lexicographically sorted; `R` means RESUMABLE. [C4]
```csv
run_id,reason,flag
0010928a-aa02-48c4-93be-ccab650783de,tmp:build-test,
00359003-aac2-4fdd-ac75-8ed452c76509,tmp:gsd-stuck-resume,
00b624be-7e51-45db-8e60-bbc4013832c2,tmp:gsd-stuck-resume,R
0102f7df-6498-4745-85bf-a744ead02d0f,tmp:gsd-budget-terminal,
011cde0c-e161-4132-a78d-47621e6b5e1e,tmp:gsd-stuck-resume,R
01353fa9-a965-4f20-b820-ee4d784a0612,tmp:gsd-stuck-resume,R
01540a7c-d7e9-4ffa-a83f-8d9cabe7b05c,tmp:gsd-stuck-resume,
01b58466-45d3-420f-a001-857a4855ac56,tmp:gsd-stuck-resume,R
01c3a446-3d34-4654-9f9c-a6ac8c0ea83d,tmp:gsd-budget-terminal,
022f97a3-e0f8-4247-af7c-fe926af02c24,tmp:gsd-stuck-resume,R
023cc1b3-0c8f-4ab7-903d-92068c85d315,tmp:gsd-budget-terminal,
024cf723-ea68-4a42-a0f1-f7ff22fbd605,tmp:gsd-stuck-resume,R
02fd72ad-3d08-47bb-8d6b-fdb3ef4442eb,tmp:gsd-stuck-resume,R
031f88ea-0053-4a51-bddd-27c3f90ad6cd,tmp:gsd-stuck-resume,R
036b923b-ca72-4d8c-baef-e7b84282cb3c,tmp:gsd-stuck-resume,
03966302-21aa-451b-ab29-bb82f28e66df,tmp:gsd-stuck-resume,
03a4d1ec-1095-479a-b941-3206c2560089,tmp:gsd-stuck-resume,R
04be5a2e-07ad-4421-b74b-7ec34b28c99e,tmp:build-test,
04d5c603-db89-47ca-ba45-89fb1c6227bb,tmp:gsd-stuck-resume,
05080566-2cac-4112-8c35-eea449aa29f5,tmp:gsd-stuck-resume,
## 1b — Real-only lessons
I executed the current `harvest()` and `classify()` implementations using TypeScript transpiled **in memory**, replacing only harvest’s filesystem reads with an in-memory map of the 58 selected real JSONs. No CLI staging, temporary corpus or store mutation occurred. Results were filtered by **exact repo root**, matching the CLI’s attribution rule. [`stratum/ts/src/cli/learn.ts:59–78`; audit execution C5]
All real runs: 58
Harvest records: 39
Skipped runs: 0
Dropped failure events: 0
Stratum root: 15 runs, 14 records, 14 recovered
Compose root: 34 runs, 23 records, 12 recovered
Other real roots: 9 runs, 2 records
[C4–C5]
| Repo root / flow | Durable contract | Records / runs / run-step pairs | First occurrence | Last occurrence |
|---|---|---:|---|---|
| `/Users/ruze/reg/my/forge/stratum` / `build` | `outcome` must be `complete\|failed\|skipped` | **14 / 2 / 6** | Jul 18 11:06:36.649Z | Jul 18 12:55:46.796Z |
| `/Users/ruze/reg/my/forge/compose` / `build` | Same `outcome` enum | **9 / 8 / 9** | Aug 18 12:08:54.637Z | Sep 15 07:25:07.702Z |
| `/Users/ruze/reg/my/forge/compose` / `build` | `commit_hash`: expected string, received null | **7 / 6 / 7** | Aug 18 12:08:54.637Z | Sep 15 03:08:49.437Z |
All three are apply-eligible under the existing classifier. Cluster counts overlap because one failure can violate multiple contracts. [C5; `stratum/ts/src/learn/classify.ts:30`, `:66`, `:90`]
**Coverage limitation:** six real `fanout_attempt_result` failure events are outside today’s harvester input. They include ownership violations and malformed agent results. They were **not silently added** to the lesson counts above. [`stratum/ts/src/engine/engine.ts:2458`; `learn/harvest.ts:104`, `:126`; C12]
## Staleness result
| Lesson | Verified fix | Recurs after fix? |
|---|---|---|
| Outcome enum | Compose **`ed8e333`**, **2026-09-17 01:58:16+08:00** / Sep 16 17:58:16Z. Object output fields rendered in prompts; pipe enums emitted as string enums. | **No observed recurrence** in either repo’s real corpus. |
| `commit_hash:null` | Stratum **`2968930`**, **2026-09-15 11:23:44+08:00** / 03:23:44Z. Both contract compilation paths changed to `.nullish()`. | **No observed recurrence**. Last failure is about 15 minutes before the commit. |
Evidence: `git log` / `git show` for those commits; C5; current fixes at `compose/lib/step-prompt.js:106`, `compose/lib/result-normalizer.js:144`, and `stratum/ts/src/ir/validate.ts:157`, `:184`.
**These are stale historical clusters, but the corpus does not prove prevention.** After the outcome fix, the only real runs with later events are Compose `bug_fix` and Stratum `model_validate` / `compose_feature`; none is a matching `build` run. Nevertheless, the unbounded historical harvest still surfaces all three clusters today. Retirement needs explicit handling. [C9; `stratum/ts/src/learn/harvest.ts:55`; `learn/classify.ts:178`]
## Trigger recommendation
**Trigger after a flow reaches a terminal state, when its persisted history contains at least one `result` event with a valid `detail.failure.reason`. Include recovered failures, even when the flow completes successfully.**
The judge-path requirement at `STRAT-LEARN-INLINE-TS-1/design.md:88` conflicts with both the observed **zero judged events** and the harvester’s actual inputs. All 14 Stratum failure records recovered; triggering only on terminal failure would miss that waste. [C4–C5; `learn/harvest.ts:104–122`]
**Concrete hook:** the beginning of `StratumEngine.emitFlowTerminal()` at `stratum/ts/src/engine/engine.ts:3525`, **before** its `bundle_id === undefined` return.
Persistence precedes this hook in every inspected terminal path:
| Terminal path | Persist → hook |
|---|---|
| Terminal gate completion | `engine.ts:1408 → :1409` |
| Ordinary completion | `:1630 → :1631` |
| Budget exhaustion | `:3470 → :3471` |
| Cancellation | `:3489 → :3490` |
| Failure | `:3502 → :3503` |
`persist()` awaits `store.save()`; saving writes a temporary JSON and renames it into place. Thus the hook follows successful persistence rather than merely an in-memory event append. [`engine.ts:3613–3624`; `state.ts:313–319`]
The proposed hook should:
- Use **`this.store.root`**, and attribute/filter by persisted **`run.workspaceRoot`**.
- Run harvest/classification/staging fail-open, with repeat-trigger deduplication.
- Keep budget-only failures transient under existing classification.
- Treat fanout failure support as a separate source-extension decision, with item/stage identity defined first.
This terminal trigger intentionally delays lessons from unfinished runs; some historical evidence is in resumable runs. If earlier delivery is required, add a debounced **post-persistence failure-settlement** trigger separately. [C5, C13; `learn/classify.ts:30`; `engine.ts:3615`]
## Defects and proposed fixes for 1c
| Defect / gap | Root cause and evidence | Proposed fix |
|---|---|---|
| **Live Compose fixture writes to production flows and receipts** | GSD harness connects without an isolated root: `compose/test/helpers/ts-agent-harness.js:238`; affected tests at `gsd-stuck-resume-golden.test.js:165`, `:266`, `gsd-budget-terminal-golden.test.js:152`. Today’s fixture events corroborate it. [C9] | Allocate a root per fixture and pass it explicitly in the MCP child environment. Fix the build harness at `:209` too. |
| **Live Stratum test writes locks in production store** | Default server in `stratum/ts/tests/mcp/flow_cancel_edges.test.ts:37`; lock-before-load at `engine.ts:1163`; publication at `run_lock.ts:169`. | Inject `flowStateRoot` or an explicitly isolated engine into this test and other default-server helpers. |
| **No universal test-store safeguard** | Engine ignores ambient state-root overrides unless the caller maps them into options: `engine.ts:386`; default at `state.ts:309`; Vitest config at `ts/vitest.config.ts:5`. | Explicitly isolate direct constructors and subprocesses. Add the plan’s production run-ID/hash invariant; also detect lock/temp writes, which a JSON-only invariant misses. |
| **Historical fixture contamination remains consumable** | Harvest enumerates every JSON without a fixture predicate: `learn/harvest.ts:55–76`; 1,423 candidate fixtures. [C4] | Use the verified manifest for filtered analysis. Any later quarantine must exclude ambiguous, resumable and ownership-protected records and retain hashes/restore paths. |
| **Missing Claude cost and explicit zero lose their distinction** | `finiteNonnegative()` converts absence to zero; streaming labels it reported; return path drops zero: `connectors/base.ts:94`; `claude.ts:178`, `:192–193`, `:211–221`. | Preserve a validated optional provider-cost value; emit reported zero only when explicitly supplied; leave absent cost absent. |
| **Insufficient provenance to classify historical inflated-cost receipts exactly** | Receipt construction lacks runtime revision/tool-policy evidence: `engine/receipts.ts:25–57`; affected-row qualifications at `compose/docs/features/COMP-MODEL-ROUTE-2/design.md:16`. | Record connector/runtime revision and effective tool-policy evidence for future dispatches. Mark historical uncertainty/exclusions rather than inventing corrected costs. |
| **Executed tier unavailable** | All observed effort fields are null; tier requires reported execution: `compose/lib/routing-ledger.js:1157`; `routing-runtime.js:53–56`. [C6] | Preserve intended versus reported effort separately. Capture reported effort where supported; retain explicit “unknown” otherwise. Do not substitute selected tier as execution evidence. |
| **Stratum distill misses actual transcript locations** | Single encoded-root default: `stratum/ts/src/distill/runner.ts:53`; parent/subdirectory transcripts found. [C8] | Configure explicit sources or add reviewed multi-source discovery with cwd attribution and deduplication. |
| **Harvester omits fanout-attempt failures** | Writer emits at `engine.ts:2458`; reader handles `result` and `budget_exhausted` only at `learn/harvest.ts:104`, `:126`. Six real omissions observed. [C12] | Add an explicit item/stage-aware failure source, including recovery semantics and aggregate deduplication. |
| **Trigger specification and stale-lesson handling are incomplete** | Judge-only criterion at `STRAT-LEARN-INLINE-TS-1/design.md:88`; historical-only clusters still emitted. [C5, C9] | Amend the design to the persisted terminal trigger above; add reviewed retirement/reactivation before automatic staging repeatedly resurrects fixed lessons. |
