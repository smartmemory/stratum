# STRAT-LOOP-CARRY: Blueprint

**Date:** 2026-09-09
**Status:** BLUEPRINT — Phase 4. Grounded against the repo state read 2026-09-09.
**Repo:** `/Users/ruze/reg/my/forge/stratum`. Every path below is relative to that root
(so `ts/src/engine/engine.ts`, not `src/engine/engine.ts`).
**Design:** `docs/features/STRAT-LOOP-CARRY/design.md`.
**Binding decisions:** the controller decision set D1..D13 (2026-09-09). Where this blueprint
differs from a decision, the difference is a numbered row in §1 with its reason. Nothing else
re-opens a decision.

## Related Documents

- `docs/features/STRAT-LOOP-CARRY/design.md` — intent and proposed spec shape
- `/Users/ruze/reg/my/forge/compose/docs/features/COMP-FABLE-ASTRA/design.md` — the first
  consumer; its D1 (loop-carried value), D4 (`files_owned` enforcement at merge) and D6
  (per-item tier resolution) are what this feature has to satisfy. Read-only from here.
- `docs/features/STRAT-TS-FANOUT-CONSUMER/design.md` — the consumer-dispatch descriptor and
  gate-token fencing rules this feature extends without changing
- `docs/features/STRAT-TS-PORT/design.md` — the v1 IR grammar being extended
- `README.md` §"Full Field Reference" / §"References" — the user-facing grammar doc that gains a
  `carry` entry (see §11)
- `/Users/ruze/reg/my/forge/compose/.claude/skills/compose/templates/boundary-map.md` — the
  grammar the Boundary Map in §10 obeys

---

## 1. Corrections

One row per place where the design (or an explorer report) does not match the code as read on
2026-09-09, merged across both explorer passes. Every `path:line` in this table was re-read in
the file before the row was written. "Decision" names the D-number that resolves it; rows with
no D-number are grounding corrections that change a citation, not a decision.

| # | Assumption | Reality | Resolution |
|---|---|---|---|
| C1 | `${wave}` is "a flow-value reference" the grammar already tolerates | A bare identifier parses as nothing: `parseReference` (`ts/src/ir/refs.ts:48-61`) tries `item`, `prev`, `input.`, then `/^([a-z][a-z0-9_-]*)\.output(.*)$/` and returns `undefined`. `extractReferences` (`:64`) then returns `undefined` for the whole string and validate.ts turns that into `REF_INVALID` (`ts/src/ir/validate.ts:382`) | D3. New `Reference` member `{ kind: "carry"; name; path }` and a parse branch (S01-2). Carry names use `STEP_ID_PATTERN` (`refs.ts:1`, via `StepIdSchema` — narrowed from `PATH_FIELD_PATTERN` by R3-2) and may not be `item`, `prev`, `input`, or any step id in the flow |
| C2 | "creates no dependency edge" is purely a feature | It is also an ordering hole. `dependenciesDone` (`ts/src/engine/engine.ts:2287-2294`) activates a step whose dependency set is empty on the first `advance`; a fanout whose only inbound reference is `${wave}` would resolve `undefined`, fail `Array.isArray` at `engine.ts:1233` and burn an attempt via `failAttempt` (`:1238`) | D1. A **static** ordering rule in validate.ts (S01-5a, S01-7): the `initial` source step must reach every step that references the variable over **dependency-only** edges (R1-4 narrowed this from the routing-inclusive `adjacency` used by `reaches`). New code `CARRY_REF_BEFORE_INITIAL`. Rejected: implicit not-ready (hangs when the source is skipped by routing) |
| C3 | The `fanout.over` single-full-reference rule lives in validation and is "unchanged" | It is runtime-only: `over` is a bare `z.string()` (`ts/src/ir/schema.ts:49`) and the rule is `ts/src/engine/engine.ts:2396`, a plain `throw` at execution time | D4. Lift it into validate.ts as `FANOUT_OVER_SINGLE_REF` (S01-9). The runtime check stays as a guard |
| C4 | A `${wave}`-only link decouples the fanout from everything | `CONSUMER_WORKTREE_GATE_REQUIRED` (`ts/src/ir/validate.ts:465-476`) still requires an unconditional, non-routed gate whose `dependencyIds` (`:247-255`) contain the fanout step — `after` or a step-output ref only. So the merge gate must still name the fanout | No code change. Stated as a consumer constraint in §7 and §9: `execute_merge` keeps `after: [execute]`, and (per C2/D1) `execute` keeps `after: [plan]` |
| C5 | The validator and engine reference collectors are exact mirrors | They are not: `referencesInStep` (`ts/src/ir/validate.ts:234`) collects `with` only when `step.run !== undefined`; `stringLeaves` (`ts/src/engine/engine.ts:2894`) collects it unconditionally. Harmless today, but the mirror is maintained by convention | Both keep the `kind === "step"` filter (`validate.ts:251`, `engine.ts:2299`) so carry still adds no edge, and R1-5 adds the same `expression` tag to both so the pair stays literally symmetric (S01-8). Pinned by T-S01-13, which compares them through the exported production collectors so a future carry arm in either one cannot silently reintroduce the `ROUTING_CYCLE` this feature exists to avoid |
| C6 | `initial: ${plan.output.tasks}` is an "expression" | Two distinct languages exist: `${}` references (`ts/src/ir/refs.ts`, resolved by `resolve()`) and the `expr` grammar (`ts/src/eval/expr.ts`), whose identifier set is closed at `ts/src/eval/expr.ts:22` to `result|input|item|prev` with `ExpressionIdentifier` a closed union at `:5` | D2. Carry values are `${}` references only, exactly one full-value token, kinds `step` and `input`. `expr.ts` is untouched; carry is not bound into `when`/`set`/`ensure` in v1 |
| C7 | Adding `item` to the descriptor is a descriptor change | It is also a frozen wire contract in five blocks of `ts/contracts/mcp-surface.json` (lines 135, 257, 428, 543, 692 — `stratum_plan`, `stratum_step_done`, `stratum_revert`, `stratum_resume`, `stratum_gate_resolve`), and `$oneOf` variant matching is complete-strict default-deny (`ts/src/mcp/contracts.ts:122-123`), so an undeclared `item` matches **zero** variants and `assertToolResponse` (`ts/src/mcp/server.ts:297`) throws | D11. All five blocks gain `"item": "any"`; `surface` 17 → 18 |
| C8 | The surface counter is pinned in two places | It is pinned in **three**: `ts/tests/mcp/schema-grammar.test.ts:88`, `ts/tests/mcp/contracts-grammar.test.ts:83`, `ts/tests/engine/p4.test.ts:982`. Neither explorer named `contracts-grammar.test.ts:83` | All three updated in S04 (§6.6) |
| C9 | The p4 contract-freeze counters sit at 980/981/982 | They sit at **981** (`expect(eventsContract.events).toBe(2)`), **982** (`expect(surface.surface).toBe(17)`), **983** (`expect(Object.keys(surface.tools)).toHaveLength(24)`). The explorer's numbers were one low | Use 981/982/983. The tool count stays 24 — no new tool ships |
| C10 | A new `PersistedRun` field is additive | It does not compile until classified: `ts/src/engine/checkpoint.ts:34` is `satisfies Record<Exclude<keyof PersistedRun, CheckpointField>, string>` | D6. `"carry"` joins `CHECKPOINT_FIELDS` (`checkpoint.ts:12-14`) |
| C11 | Adding `"carry"` to `CHECKPOINT_FIELDS` is the whole checkpoint change | `CheckpointSnapshot` is a separate hand-maintained `Pick<PersistedRun, ...>` at `ts/src/engine/state.ts:182-185`. `commitCheckpoint` casts (`checkpoint.ts:38`) so TypeScript will not catch the omission; the snapshot type would silently disagree with the field list. **Neither explorer reported this** | Add `"carry"` to the `Pick` at `state.ts:182-185` in the same edit (§4.3) |
| C12 | "audit reads the value from the run record like any step input" | `audit()` (`ts/src/engine/engine.ts:814-820`) returns a hand-built six-field object and does not spread the run; `auditResponse` (`ts/src/mcp/server.ts:424-426`) whitelists the same fields again | D10. `AuditTrail.carry?`, the `audit()` return, the `auditResponse` whitelist and the four `stratum_audit` variants (`ts/contracts/mcp-surface.json:621-648`) all gain it (§6.4) |
| C13 | "replay" reads carry from the run record | There is no replay surface. `grep -rn replay ts/src` returns only guard hits. The observable history is `flowPoll` (`ts/src/engine/engine.ts:823`) over the persisted event spine plus the receipt spine | Nothing to build. The design sentence means "the persisted event/receipt trail"; no replay invariant is claimed or tested |
| C14 | The revise transaction runs "under the gate token" | `delete state.gateToken` is at `ts/src/engine/engine.ts:927`, eleven lines before the revise branch at `:938` | D6/D8. Provenance uses the `gateToken` **parameter** of `gateResolveLocked` (`:906`), which is proven equal to the consumed token by the check at `:924` |
| C15 | `sourceEpoch` is a run-level epoch | `epoch` is per-step (`ts/src/engine/state.ts:152-153`), bumped only in `resetFrom` (`ts/src/engine/engine.ts:2275`). There is no run-level epoch | Provenance's `sourceEpoch` means the epoch of the **`initial` declaration's** source step, read pre-reset from `scope.steps[sourceStepId].epoch ?? 0`. This is what makes D7's idempotency comparison work |
| C16 | D6's provenance shape covers every legal `initial` | D2 legalises `input` references, which have no source step and no epoch, so `sourceStep: string` / `sourceEpoch: number` cannot be satisfied for them | Shape refinement, not a decision change: both fields become **optional**, present exactly when the resolved reference kind is `step`. Names and meanings are D6's, unchanged (§2.1) |
| C17 | The resolved fanout item is "persisted in the run record" | Nothing about the element is persisted. `FanoutItemState` (`ts/src/engine/state.ts:51-69`) stores `index` only; the six live re-resolution sites are `engine.ts:1232` (activation), `:1457` (`prepareConsumerItem`), `:1546` (consumer settle), `:1594` (`executeFanout`), `:1632` (`settleFanout`), `:2321` (`consumerDescriptor`) | D11. `item` is **computed**, not persisted: `item: values[item.index]` at the descriptor. Persisting it on `FanoutItemState` is out of scope (D13). §6.1 states and pins the invariant that makes computing safe |
| C18 | The persisted run needs a version gate | `StateStore.load` (`ts/src/engine/state.ts:252-256`) is `JSON.parse` plus `migrateLegacyPolicyRules`; `resume` compares `revisionDigest` against `digest(run.spec)` only (`engine.ts:798-802`), which covers the spec, not new run keys | `carry?` is additive; old runs load unchanged, same pattern as `parallel` (`state.ts:228`) and `checkpoints` (`:231`). **But** a spec containing a `carry` block loaded by an older engine throws `"persisted run contains an invalid spec"` (`engine.ts:2651-2654`), because every load re-validates. Carry is a spec-format break in that one direction; it is why D12 takes a minor bump |
| C19 | Carry needs a `resolve` signature change to reach run-level state | `resolve` takes `scope`, not `run` (`engine.ts:2641`) | Add `carry?: Record<string, CarryEntry>` to `ExecutionScope` (`engine.ts:117-124`) and populate it in `rootScope` (`:2449-2451`). `childScope` (`:2453-2465`) is deliberately **not** populated — D5 makes carry root-only and validation forbids a subflow referencing it, so an unpopulated child scope is a second, cheap guarantee |
| C20 | Speckit and migrate need work | `buildSpec` (`ts/src/speckit/compiler.ts:156-160`) emits a fixed flow literal and enumerates no flow keys reflectively; `ts/src/migrate/check.ts` is a report-only classifier with a static `GUIDANCE` table | No change. Emitting `carry` from speckit and a migrate guidance row are D13 out-of-scope |
| C21 | A new bare-identifier parse changes only unparseable strings | It also changes the **error code** for a previously invalid ref such as `${other.notoutput}`: `REF_INVALID` today, `REF_UNKNOWN_CARRY` after the change | Intended and better (it names the actual problem). No existing fixture pins that string — `ts/tests/ir/fixtures.ts:152` uses `${input.bad-name}` and `:160` uses `${other.output}`, both unaffected. A new invalid fixture pins the new code (S01-10) |

---

### Round 1 gate findings (R1-1..R1-11)

Codex `gpt-5.6-sol/high`, 2026-09-09. Eleven findings, all accepted and folded. Three carried a
controller RULING where the finding left a choice; those are marked.

| # | Severity | Finding | Folded into |
|---|---|---|---|
| R1-1 | must-fix | An `on_revise` write is unsound unless the same revise resets every step that reads the variable, and unless the gate is ordered after every such step. Otherwise a consumer keeps a rendering derived from a list that has just been rewritten. | §2.4 (three new codes `CARRY_REVISE_TARGET_NULL`, `CARRY_REVISE_MISSES_CONSUMER`, `CARRY_REVISE_GATE_NOT_AFTER_CONSUMER`), §3 S01-5(b) (the `resetFrom` closure mirrored from `ts/src/engine/engine.ts:2226-2244`), S01-7 (the coverage loop), S01-10 (three fixtures incl. the ready-fanout-plus-sibling-gate case), §6.1 (the invariant now rests on this rule), §7.1 |
| R1-2 | must-fix | **RULING.** `advance`'s top of function is not a universal choke point: `set:` (`engine.ts:1196-1219`) and `evaluate:` (`:1347-1353`) settle *inside* `advanceScopeLoop` and a later fanout activates at `:1229` in the same pass. Keep the top-of-`advance` call **and** add one immediately after each in-loop settlement. | §5 S03-5, which names all three call sites with their anchor lines and shows why the `do:`/fanout/subflow sites need none; tests T-S03-5 and T-S03-6 |
| R1-3 | must-fix | Carry `initial`/`on_revise` references bypassed the type rules every ordinary reference obeys (`validate.ts:388-414`). At runtime, an unresolved value could still create a `CarryEntry`. | §3 S01-4 (the shared `referenceTypeError` helper, signature given), S01-7 (both carry expressions route through it), S01-10 (contractless-source, bad-input-path, bad-output-path fixtures), §5 S03-4 (`carry_initial_unresolved` hard failure), S03-6 (`carry_revise_unresolved` preflight), test T-S03-8 |
| R1-4 | must-fix | `CARRY_REF_BEFORE_INITIAL` used the routing adjacency, so a source reachable only through an `on_fail` route counted as ordering. And a `when`-guarded or gate source can leave the variable permanently unmaterialised. | §2.4 (`CARRY_INITIAL_SOURCE_CONDITIONAL`), §3 S01-5(a) (dependency-only `reachesByDependency`, deliberately excluding routing edges), S01-7, S01-10 (two fixtures) |
| R1-5 | must-fix | Carry is resolved by `resolve()` during template rendering; it is not a binding in the `expr` language, whose identifier set is closed at `ts/src/eval/expr.ts:5,22`. It must be rejected on `when`, `set` and stage `when`. | §2.4 (`CARRY_REF_IN_EXPRESSION`), §3 S01-6 (the guard), S01-8 (the `expression` tag added symmetrically to `referencesInStep` and `stringLeaves`), S01-10 (one fixture per rejected field) |
| R1-6 | must-fix | The revise path consumed the gate token (`engine.ts:927`) and emitted `gate_resolved` (`:929`) before any carry expression was resolved. Because `loadRun` returns the live pinned run while a fanout is active (`engine.ts:311-314`, `:337-341`), a throw after that point wedges the gate permanently. | §5 S03-7, which shows the reordered `gateResolveLocked` in full: target, round limits and all carry resolution run in a mutation-free preflight, then one mutation block; test T-S03-7 retries with the same token under a pinned run |
| R1-7 | must-fix | An `input.`-sourced initial has no step, so `carry_updated` cannot always carry `stepId`. | §2.5 (`"stepId?": "string"`, and the note that `this.event` at `engine.ts:2847-2849` already omits an undefined `stepId`); pinned through the real MCP audit path so `assertEvent` validates it (T-S04-3) |
| R1-8 | should-fix | **RULING: reserve it.** `${wave.output…}` parses as a step reference to a step named `wave` because the step regex wins. Rather than disambiguate, forbid a carry path beginning with the segment `output` and report the collision by name. | §2.4 (`CARRY_PATH_RESERVED`), §3 S01-4 (the check inside `referenceTypeError`), S01-6 (the author-facing rule), S01-10 (one fixture, plus a parse assertion in T-S01-2), §11 (documented in `README.md`) |
| R1-9 | must-fix | File-plan gaps: `validate.ts:1-4` does not import `Reference`; `engine.ts:20` does not import `CarryEntry`/`CarryProvenance`; the events counter is **also** pinned at `ts/tests/mcp/contracts-grammar.test.ts:105` with the frozen value in its test title at `:104`; `ts/server.json` carries `0.4.6` at both `:10` and `:15`. | §3 S01-4 (the import line), §9 File Plan (all four), §6 S04-6 (the second events pin and its title), §11 (both `server.json` fields) |
| R1-10 | should-fix | Test-design gaps: `auditResponse` is private (`server.ts:424`) and cannot be called from a test; only one `stratum_audit` variant would have been exercised; the collector-parity test used hand-built leaf sets rather than the production collectors; the failed-revise test inspected only the disk record. | §6 S04-8 (T-S04-3 drives an in-memory MCP server via `connected(...)` at `ts/tests/mcp/p5.test.ts:40`; T-S04-4 table-tests all four variants), §3 S01-8 (both collectors exported as the named seam) and S01-10 (T-S01-13, T-S01-14), §5 S03-8 (T-S03-7, later sharpened by R2-8 into a same-token retry proof), §7.2 step 9 |
| R1-11 | should-fix | `name in carry` matches inherited `Object.prototype` members, so `${toString}` would validate. | §3 S01-7 (`carryNames` as a `Set`, `Object.hasOwn` in `referenceTypeError`), S01-10 (the `${toString}` fixture) |

---

### Round 2 gate findings (R2-1..R2-8)

Codex `gpt-5.6-sol/high`, 2026-09-09, reviewing the round-1 fixes. Eight findings, all accepted
and folded. Two carried a controller RULING.

| # | Severity | Finding | Folded into |
|---|---|---|---|
| R2-1 | must-fix | The round-1 hook wrote to a carry object the live scope did not hold. `advance` evaluates its default `scope` (`engine.ts:1099`) before the body and hands that object to `advanceScopeLoop` and fanout resolution (`:1232`); a hook that builds a fresh `rootScope` leaves `scope.carry` undefined, so the fanout still fails in the pass the value became available. | §5 S03-1 (the new `carryScope` helper, which patches the *active* root scope and shares one object with `run.carry`, creating it only when the flow declares carry), S03-4 (writes go through `scope.carry`), S03-5 (all three call sites pass `carryScope`), S03-7 (the revise write too), §8 invariant 9; tests T-S03-5a (dispatched `do:` source) and T-S03-5b (input-sourced, the strictest case) |
| R2-2 | must-fix | "Unconditional source" missed routing targets. A step named by `on_fail`, `on_approve` or `on_kill` is inactive until routed (`engine.ts:2217-2221`), can be skipped outright (`:2210-2215`), and a skipped dependency still satisfies its edge (`:2287-2293`) — so ordering alone would not save it. | §2.4 (`CARRY_INITIAL_SOURCE_CONDITIONAL` widened), §3 S01-7 (a `routedTargets` set built once, mirroring the construction at `validate.ts:456-462`), S01-10 (two fixtures: unrouted `on_fail` source, gate-routed source) |
| R2-3 | must-fix | `run.carry?.[name]` and `scope.carry?.[name]` reach inherited `Object.prototype` members, so a variable named `toString` or `constructor` would resolve to a function. | §5 S03-1 (`Object.create(null)` for the runtime map), S03-2 (`Object.hasOwn` in `resolve`), S03-4 (in the staging loop), S03-6 (on the `on_revise` map too), §8 invariant 10; test T-S03-8b drives a carry literally named `toString` end to end including a reload, because a persisted run reloads as a **plain** object (`state.ts:252-256`) and only the own-property check survives that |
| R2-4 | must-fix | The expression-field set was three fields, not six: `iterate.until` (`schema.ts:21-24`), step `ensure[].expr` and stage `ensure[].expr` (`schema.ts:14-19`, `:43`) are also `expr` language, evaluated through `ensurePredicate` (`engine.ts:608`, `:2056`). | §2.4 (`CARRY_REF_IN_EXPRESSION` widened), §3 S01-8 (a six-row table of expression fields; all three added symmetrically to `referencesInStep` and `stringLeaves`, both shown in full), S01-10 (one fixture per new field). Sharpened by R3-1 into a minimal change: tagging exists only to reject carry references on those fields, it adds no lexical scanning of expression source, and it leaves the pre-existing dependency-edge treatment of expression leaves untouched. Verified with `grep -rn 'expr:.*\\${\\|until:.*\\${' ts/tests ts/parity ts/src`, which returns no match |
| R2-5 | should-fix | **RULING.** `materialiseCarry` could throw mid-loop, and `advanceScopeLoop` (`engine.ts:1159`) has no catch while the `set:`/`evaluate:` sources are already marked `succeeded` (`:1213`, `:1347`) — a two-variable block could leave one entry written and one event in the spine. The source step cannot be failed retroactively, so an unresolvable `initial` is a **run-level** failure. | §5 S03-4: the function stages every write, never throws, and returns `{ kind: "unchanged" \\| "written" \\| "failed" }`; each call site (S03-5) turns `failed` into `failScope` (`engine.ts:2593-2602` → `terminalFailure` `:2780-2787`), the same path a flow-output contract failure takes. §8 invariant 11; test T-S03-8 uses two declarations with the second unresolved and asserts no first write and no event, in the pinned run and on disk |
| R2-6 | should-fix | The reservation was a prefix test, so `${wave.outputValue}` and `${wave.outputs}` were wrongly claimed by the step branch. | §3 S01-2: the reservation becomes the exact segment `/^\\.output(?:$\\|\\.\\|\\[)/`, hoisted to module scope; §2.4 (`CARRY_PATH_RESERVED` reworded); test T-S01-2 asserts all four spellings; §11 documents the precise rule |
| R2-7 | should-fix | The reset-closure mirror was a local closure, so the parity test could only re-implement it. | §3 S01-5(b): `resetClosure(flow, target)` is a module-level **export** of `ts/src/ir/validate.ts`, called as `resetClosure(flow, target)` from the carry pass. `engine.resetFrom` keeps its own walk (it traverses live `StepState` and returns epoch transitions, and importing the validator onto the hot reset path is worse than a parity test). T-S01-14 compares them across a four-flow fixture matrix. §9 File Plan and §10 Boundary Map updated |
| R2-8 | should-fix | T-S03-7 proved "no mutation" with `engine.audit`, which reads **disk** and deliberately bypasses the in-memory pin (`engine.ts:814-818`) — so it could not see the live object it was meant to check. And R1-7's optional `stepId` was never exercised on an input-sourced initial. | §5 S03-8: T-S03-7 now uses the same-token retry as the black-box proof, with `max_rounds: 1` so a silently double-counted round would exhaust the budget, plus round and event-count assertions. §6 S04-8: new T-S04-5 drives an input-sourced flow through `stratum_audit` on an in-memory server, where the transport's `assertEvent` (`ts/src/mcp/server.ts:294`) validates that the `carry_updated` event carries no `stepId` at all |

---

### Round 3 gate findings (R3-1..R3-5)

Codex `gpt-5.6-sol/high`, 2026-09-09, reviewing the round-2 fixes. Five findings, all folded. Two
carried a controller RULING. This was the last review round under the three-round budget, so the
fixes below were **not** themselves re-reviewed — see the note in the Review log.

| # | Severity | Finding | Folded into |
|---|---|---|---|
| R3-1 | must-fix | The R2-4 rationale was false. A `${…}` token inside an expression field is not broken today: in `expr: "result.name == '${wave}'"` it sits inside a string literal and evaluates to six characters of literal text. Describing it as something that "never worked" invited an implementer to add lexical scanning of expression source, or to change how expression leaves feed dependency edges. | **RULING: minimal.** §3 S01-8 now states the scope explicitly: no lexical scanning is added (`extractReferences` remains a plain `${…}` scan, `ts/src/ir/refs.ts:66`); the pre-existing dependency-edge treatment of `when`/`set` leaves is unchanged and the three new fields simply join it; and a `${…}` token in an expression field is literal text, not an error. The rule that *is* added is narrower and now stated plainly: a carry reference spelled **anywhere** in an expression field, quoted or unquoted, is `CARRY_REF_IN_EXPRESSION`, because unquoted it cannot resolve (carry is not in the `expr` identifier set, `ts/src/eval/expr.ts:5,22`) and quoted it resolves to the literal characters. Neither can mean what the author intends, so rejecting both loses nothing. The six-field tagging is kept exactly for that purpose |
| R3-2 | should-fix | Carry names used `PATH_FIELD_PATTERN`, which admits `Wave` and `_wave`. The `output` reservation then leaks: `${Wave.output}` declines the carry branch **and** fails the step regex (which requires a lowercase initial), so it reports `REF_INVALID` rather than the promised `CARRY_PATH_RESERVED`. | **RULING: restrict names.** §2.3 / §3 S01-3: the record key becomes `StepIdSchema` (`ts/src/ir/schema.ts:4`, `STEP_ID_PATTERN` `/^[a-z][a-z0-9_-]*$/` at `ts/src/ir/refs.ts:1`), so every legal carry name is a legal step id and the fallback always lands in the step regex. §3 S01-2: the parse regex charset moves to match (`/^([a-z][a-z0-9_-]*)(.*)$/`) — a narrower one would split `${my-wave}` at the hyphen. §3 S01-4: a note that the `CARRY_PATH_RESERVED` arm is total only because of this. S01-10: two fixtures rejecting `Wave` and `_wave` at schema level |
| R3-3 | should-fix | The `on_revise` map was hardened with `Object.hasOwn` (R2-3) but nothing exercised it. A gate step whose id is `toString` with `on_revise: {}` would otherwise read `Object.prototype.toString` as a declaration and throw inside `carryReference`. | §5 S03-8, new T-S03-8c: a revise gate literally named `toString` and an empty `on_revise`; revising must leave `run.carry` byte-identical and emit no `carry_updated`. Complements T-S03-8b, which covers the carry-**name** side of the same hazard |
| R3-4 | should-fix | `on_kill` was in the code on both sides but in neither test. It is the third routing edge in the routed-target set (`validate.ts:456-462`) and in both reset closures (`engine.ts:2237-2238`), and the one most easily dropped in a rewrite. | §3 S01-10: an `on_kill` initial-source rejection fixture beside the `on_fail` and `on_approve` ones; and the T-S01-14 reset-closure parity matrix gains an `on_kill` branch case |
| R3-5 | nit | T-S03-7's rationale attributed the stale-token failure to "a consumed token **or** an appended `gate_resolved`", but only the former makes a retry stale. | §5 S03-8: the wording now names `delete state.gateToken` (`engine.ts:927`) as what a successful retry disproves, and says explicitly that an appended event is invisible to the retry and is caught by the separate event-count assertion. Three assertions, three mutations |

---

## 2. Contract

Everything in this section is exact. An implementer copies it verbatim.

### 2.1 `CarryEntry` — `ts/src/engine/state.ts` (new types)

Inserted immediately after `SubflowState` (`ts/src/engine/state.ts:142-147`) and before
`StepState` (`:149`).

```ts
/** Provenance of one carry write. `sourceStep`/`sourceEpoch` are present exactly when the
 *  evaluated reference was a step reference; an `input.`-sourced initial has neither.
 *  For a revise write they name the INITIAL declaration's source step and its epoch at
 *  write time — that is the pair `materialiseCarry` compares against, so a revise value
 *  survives every advance until the initial's own source is reset. */
export interface CarryProvenance {
  kind: "initial" | "revise";
  sourceStep?: string;
  sourceEpoch?: number;
  /** Revise only: the gate step id that authorised the write. */
  gate?: string;
  /** Revise only: the consumed gate token that fenced the decision. */
  gateToken?: string;
  /** Revise only: `run.rounds` after the bump. */
  round?: number;
  at: string;
}

/** One loop-carried flow value plus the record of who last wrote it. */
export interface CarryEntry {
  value: unknown;
  provenance: CarryProvenance;
}
```

`PersistedRun` (`ts/src/engine/state.ts:195-232`) gains, after `checkpoints` (`:231`):

```ts
  /** Loop-carried flow values keyed by declared name. Optional so runs created before
   *  STRAT-LOOP-CARRY remain loadable. Root-flow only in v1 (D5). */
  carry?: Record<string, CarryEntry>;
```

`CheckpointSnapshot` (`ts/src/engine/state.ts:182-185`) gains `"carry"` — see C11:

```ts
export type CheckpointSnapshot = Pick<PersistedRun,
  | "status" | "output" | "failure" | "flowSpent" | "rounds"
  | "steps" | "events" | "policy_verdicts" | "cancelRequested" | "parallel" | "carry"
>;
```

### 2.2 The new `Reference` union member — `ts/src/ir/refs.ts`

```ts
export type Reference =
  | { kind: "input"; path: PathSegment[] }
  | { kind: "step"; stepId: string; path: PathSegment[] }
  | { kind: "carry"; name: string; path: PathSegment[] }
  | { kind: "item" }
  | { kind: "prev" };
```

Spelled `${<name>}` or `${<name><path>}` where `<path>` is the existing `parsePath` grammar
(`refs.ts:23-44`): `.field` and `[0]` segments. `referenceEdges` (`refs.ts:82-86`) is untouched —
it already filters `kind === "step"`.

### 2.3 `CarrySchema` — `ts/src/ir/schema.ts`

Placed after `GateSchema` (`ts/src/ir/schema.ts:26-31`) but **below** `rejectReservedFields`
(defined at `schema.ts:112-120`), so it goes immediately after `ContractsSchema`
(`schema.ts:126`) and before `FlowOutputSchema` (`:128`). It reuses the same
`custom → superRefine(rejectReservedFields) → pipe(z.record(...))` shape as `ContractSchema`
(`schema.ts:122-125`), which exists so a `__proto__` key cannot be silently dropped by
`z.record`.

```ts
export const CarryVariableSchema = z.object({
  initial: z.string().min(1),
  on_revise: z.record(StepIdSchema, z.string().min(1)).optional(),
}).strict();

export const CarrySchema = z.custom<Record<string, unknown>>(
  (value) => typeof value === "object" && value !== null && !Array.isArray(value),
  "carry must be an object",
).superRefine(rejectReservedFields).pipe(z.record(StepIdSchema, CarryVariableSchema));
```

**Carry names use `StepIdSchema` (`ts/src/ir/schema.ts:4`, i.e. `STEP_ID_PATTERN`
`/^[a-z][a-z0-9_-]*$/` at `ts/src/ir/refs.ts:1`), not `PATH_FIELD_PATTERN` (R3-2).** The reason is
the `output` reservation: when the carry branch declines a source such as `${wave.output}`, the
step regex must be able to claim it, and that regex accepts only lowercase step ids. If a carry
could be named `Wave`, then `${Wave.output}` would fall through **both** branches and report
`REF_INVALID` instead of the promised `CARRY_PATH_RESERVED`. Making the two namespaces lexically
identical — a carry reference and a step id differ only by the `.output` suffix — is what keeps
that guarantee total. `Wave` and `_wave` are rejected at schema level.

`FlowSchema` (`ts/src/ir/schema.ts:133-139`) gains one line between `max_rounds` (`:137`) and
`steps` (`:138`):

```ts
export const FlowSchema = z.object({
  input: ContractSchema,
  output: FlowOutputSchema,
  budget: BudgetSchema.optional(),
  max_rounds: z.number().int().positive().optional(),
  carry: CarrySchema.optional(),
  steps: z.array(StepSchema),
}).strict();
```

The object stays `.strict()`, so `E2_UNKNOWN_FIELD` still fires for any other flow key — the
fixture at `ts/tests/ir/fixtures.ts:273-276` continues to pass unchanged.

### 2.4 New validation error codes

All emitted from `ts/src/ir/validate.ts`. `validateSpec` returns the **first** error, so the
pass order in §3 is part of the contract.

| Code | Path convention | Meaning |
|---|---|---|
| `CARRY_ROOT_ONLY` | `flows.<flow>.carry` | `carry` declared on a non-entry flow (D5) |
| `CARRY_NAME_CONFLICT` | `flows.<flow>.carry.<name>` | the name is `item`, `prev`, `input`, or equal to a step id in the flow (D3) |
| `CARRY_REF_INVALID` | `flows.<flow>.carry.<name>.initial` or `flows.<flow>.carry.<name>.on_revise.<gate>` | the value is not exactly one full-value `${}` reference of kind `step` or `input` (D2) |
| `REF_UNKNOWN_STEP` (reused) | same as above | the reference names a step that does not exist in the flow |
| `CARRY_UNKNOWN_GATE` | `flows.<flow>.carry.<name>.on_revise.<gate>` | the key is not a step id, or that step has no `gate` (D5) |
| `REF_UNKNOWN_CARRY` | the referencing leaf path, e.g. `flows.main.steps[1].fanout.over` | `${name}` names a variable not declared in this flow's `carry` block (D3) |
| `CARRY_REF_BEFORE_INITIAL` | the referencing leaf path | the `initial` source step does not reach the referencing step through `adjacency` (D1) |
| `CARRY_INITIAL_SOURCE_CONDITIONAL` | `flows.<flow>.carry.<name>.initial` | the `initial` source step carries a `when`, is a gate step, or is a routing target (`on_fail`/`on_approve`/`on_kill`), so it may never run (R1-4, R2-2) |
| `CARRY_REF_IN_EXPRESSION` | the referencing leaf path | a carry reference appears on one of the six `expr`-language fields — step `when`, `set`, `iterate.until`, `ensure[].expr`, stage `when`, stage `ensure[].expr` — whose identifiers are closed at `ts/src/eval/expr.ts:5,22` (R1-5, R2-4) |
| `CARRY_PATH_RESERVED` | the referencing leaf path | `${<name>.output}`, `${<name>.output.x}` or `${<name>.output[0]}` parses as a step reference to a step named `<name>`; a carry path may not begin with the **exact** segment `output`, though `${<name>.outputs}` is unaffected (R1-8, R2-6) |
| `CARRY_REVISE_TARGET_NULL` | `flows.<flow>.carry.<name>.on_revise.<gate>` | the gate rewrites the variable but its `on_revise` target is `null`, so nothing would be reset (R1-1a) |
| `CARRY_REVISE_MISSES_CONSUMER` | `flows.<flow>.carry.<name>.on_revise.<gate>` | a step that reads the variable is outside the revise target's reset closure, so it would keep a rendering of the old list (R1-1b) |
| `CARRY_REVISE_GATE_NOT_AFTER_CONSUMER` | `flows.<flow>.carry.<name>.on_revise.<gate>` | the gate is not dependency-ordered after a step that reads the variable, so it could rewrite the list while that step is in flight (R1-1c) |
| `FANOUT_OVER_SINGLE_REF` | `flows.<flow>.steps[<i>].fanout.over` | `over` is not exactly one full-value reference (D4, lifted from runtime) |

`REF_UNKNOWN_STEP` is reused rather than given a carry-specific twin, matching how
`ROUTING_UNKNOWN_TARGET` is reused for revise targets at `validate.ts:485`.

### 2.5 The `carry_updated` event

Union member added to `AuditEvent["type"]` (`ts/src/engine/state.ts:174-177`), appended after
`"checkpoint_reverted"`.

Detail shape — the **value is deliberately absent**; the value lives in the run record and is
read through `audit()` (D9):

```ts
{ name: string; reason: "initial" | "revise"; provenance: CarryProvenance }
```

`stepId` is the step the write is attributed to: the `initial` source step for a step-sourced
initial write, the gate step id for a revise write. An **`input.`-sourced initial has no step at
all**, so the field is optional in the contract (R1-7) and the emitter omits it — `this.event`
(`ts/src/engine/engine.ts:2847-2849`) already spreads `stepId` only when it is defined.

`ts/contracts/events.json` — `"events": 2` becomes `3` (`events.json:2`), and a kind is appended
after `checkpoint_reverted` (`events.json:90-96`):

```json
    "carry_updated": {
      "stepId?": "string",
      "detail": {
        "name": "string",
        "reason": "string",
        "provenance": {
          "kind": "string",
          "sourceStep?": "string",
          "sourceEpoch?": "number",
          "gate?": "string",
          "gateToken?": "string",
          "round?": "number",
          "at": "string"
        }
      }
    }
```

Note on `gateToken` in the spine: the token is already consumed (`engine.ts:927` deletes it
before the revise branch runs) and cannot authorise anything afterwards. Gate tokens already
surface through `audit().steps` — that is the mandated discovery path in
`docs/features/STRAT-TS-FANOUT-CONSUMER/design.md` — so this adds no new exposure class.

### 2.6 Descriptor `item`

`ConsumerDispatchDescriptor` (`ts/src/engine/engine.ts:156-171`) gains one line after
`itemIndex: number;` (`:161`):

```ts
  itemIndex: number;
  /** The resolved fanout element for this item. Computed from `over`, never persisted:
   *  the carried list can only change at a gate that runs after the fanout settles, and
   *  that revise resets the fanout, so no in-flight item can observe a rewritten list. */
  item: unknown;
```

`ts/contracts/mcp-surface.json` — all five descriptor blocks gain `"item": "any"` directly after
their `"itemIndex": "number",` line: **135** (`stratum_plan`), **257** (`stratum_step_done`),
**428** (`stratum_revert`), **543** (`stratum_resume`), **692** (`stratum_gate_resolve`). The
existing context in each is identical:

```json
                  "isFinalStage": "boolean",
                  "itemIndex": "number",
                  "generation": "number",
```

becomes

```json
                  "isFinalStage": "boolean",
                  "itemIndex": "number",
                  "item": "any",
                  "generation": "number",
```

`"any"` is a declared leaf type: `LEAF_TYPES` at `ts/src/mcp/contracts.ts:46` includes it and
`matchesLeaf` returns `true` for it unconditionally (`contracts.ts:171`). It is declared
**required**, not `"item?"`, because `over` must resolve to a JSON array and JSON has no
`undefined`, so `values[item.index]` is always a present key for a valid index. `null` elements
are fine — `matchesLeaf(null, "any")` is `true`.

`"surface": 17` at `ts/contracts/mcp-surface.json:2` becomes `18`.

### 2.7 Audit `carry`

`AuditTrail` (`ts/src/engine/engine.ts:230-237`) gains, after `output?`:

```ts
  carry?: Record<string, CarryEntry>;
```

The four `stratum_audit` response variants (`ts/contracts/mcp-surface.json:621-648`:
`running`, `completed`, `failed`, `budget_exhausted`) each gain `"carry?": "object"` after
`"output?": "any"`:

```json
        "running": {
          "runId": "string",
          "events": "array",
          "steps": "object",
          "flowSpent": "object",
          "output?": "any",
          "carry?": "object"
        },
```

### 2.8 Spec surface, as authored

```yaml
flows:
  entry: main
  main:
    input: { goal: string }
    output: { from: "${assess.output}", contract: WaveDecision }
    max_rounds: 6
    carry:
      wave:
        initial: "${plan.output.tasks}"
        on_revise:
          assess_gate: "${assess.output.tasks}"
    steps:
      - { id: plan, do: "Plan ${input.goal}", out: TaskGraph }
      - id: execute
        after: [plan]                # REQUIRED — see C2/D1 and S01-7
        fanout: { over: "${wave}", dispatch: consumer, isolation: worktree, ... }
      - { id: execute_merge, after: [execute], gate: { on_approve: verify, on_revise: execute, on_kill: null } }
      ...
```

---

## 3. Slice S01 — IR: schema, reference kind, validation

S01 is pure. It touches no engine file and no contract JSON. Its whole surface is
`validateSpec` behaviour, so every test in it is a fixture comparison.

### S01-1 `ts/src/ir/refs.ts` (edit) — the union

Insert the new member into `Reference` at `refs.ts:6-10`, between the `step` and `item` arms.
Existing code being edited:

```ts
export type Reference =
  | { kind: "input"; path: PathSegment[] }
  | { kind: "step"; stepId: string; path: PathSegment[] }
  | { kind: "item" }
  | { kind: "prev" };
```

Result is §2.2.

### S01-2 `ts/src/ir/refs.ts` (edit) — the parse branch

`parseReference` is at `refs.ts:47-61`. Existing code, verbatim:

```ts
/** Parses the complete contents of one `${...}` reference. */
export function parseReference(source: string): Reference | undefined {
  if (source === "item") return { kind: "item" };
  if (source === "prev") return { kind: "prev" };

  if (source.startsWith("input.")) {
    const path = parsePath(source.slice("input".length));
    return path && path.length > 0 ? { kind: "input", path } : undefined;
  }

  const match = /^([a-z][a-z0-9_-]*)\.output(.*)$/.exec(source);
  if (!match?.[1]) return undefined;
  const path = parsePath(match[2] ?? "");
  return path === undefined ? undefined : { kind: "step", stepId: match[1], path };
}
```

Insert the carry branch between the `input.` block (`:52-55`) and the step regex (`:57`), per D3:

```ts
  // A carry variable is a bare flow-value name with an optional path. A step
  // reference is ALWAYS `<id>.output` followed by end-of-source, `.` or `[`, so only
  // that exact first segment is reserved (R2-6): `${wave.outputValue}` and
  // `${wave.outputs}` stay carry references, `${wave.output.tasks}` does not.
  const STEP_OUTPUT_SEGMENT = /^\.output(?:$|\.|\[)/;
  const carry = /^([a-z][a-z0-9_-]*)(.*)$/.exec(source);   // same charset as STEP_ID_PATTERN (R3-2)
  if (carry?.[1] !== undefined && !STEP_OUTPUT_SEGMENT.test(carry[2] ?? "")) {
    const path = parsePath(carry[2] ?? "");
    return path === undefined ? undefined : { kind: "carry", name: carry[1], path };
  }
```

Hoist `STEP_OUTPUT_SEGMENT` to module scope beside `PATH_FIELD_PATTERN` (`refs.ts:2`) rather than
rebuilding it per call.

The name charset is `STEP_ID_PATTERN`'s, not `PATH_FIELD_PATTERN`'s (R3-2, and see S01-3): a carry
name may contain a hyphen, so a narrower parse regex would split `${my-wave}` at the hyphen and
fail. The parser and the schema must accept exactly the same set of names or the two disagree on
what `${x}` even is.

Three behaviours the implementer must preserve, each already covered by an existing test:

- `${input.bad-name}` still returns `undefined`. The `input.` branch runs first and
  `parsePath(".bad-name")` fails. Pinned by `ts/tests/ir/refs.test.ts:15`.
- `${build.output.items[0].name}` still parses as a `step` reference. The remainder is
  `.output.items[0].name`, whose first segment is exactly `output`, so the carry branch declines.
  Pinned by `ts/tests/ir/refs.test.ts:6-11`.
- `${Foo.output}` still returns `undefined`. Both branches require a lowercase initial, and since
  carry names share the step-id charset (R3-2) there is no legal carry named `Foo` to reserve for.
- `${my-wave}` parses as a carry reference named `my-wave`. Hyphens are legal in carry names
  because they are legal in step ids.
- `${wave.outputValue}` and `${wave.outputs}` are ordinary **carry** references (R2-6). Only the
  exact segment `output` is reserved, not every field beginning with those six characters.

The one intentional behaviour change is C21.

### S01-3 `ts/src/ir/schema.ts` (edit) — `CarrySchema` and the flow key

Add the two schemas of §2.3 immediately after `ContractsSchema` (`ts/src/ir/schema.ts:126`),
whose existing line reads:

```ts
export const ContractsSchema = z.record(z.string().regex(PATH_FIELD_PATTERN), ContractSchema);
```

Then add `carry: CarrySchema.optional(),` to `FlowSchema` (`schema.ts:133-139`), between:

```ts
  max_rounds: z.number().int().positive().optional(),
  steps: z.array(StepSchema),
```

`StepIdSchema` is already defined in this file (`schema.ts:4`); `PATH_FIELD_PATTERN` stays
imported at `schema.ts:2` for `ContractsSchema` and is no longer used by carry (R3-2). `rejectReservedFields` is module-local at `schema.ts:113-121`
and needs no export.

### S01-4 `ts/src/ir/validate.ts` (edit) — one shared reference type-checker (R1-3)

The reference-shape rules at `ts/src/ir/validate.ts:388-414` (input path exists, source step
exists, fanout source has a final-stage `out`, source has an output contract, the fanout-array
indexing rule, output path exists) are today inline in the per-step loop. Carry `initial` and
`on_revise` values are references and must obey exactly the same rules, so the block is factored
into one local helper used by both callers. It is declared as a closure inside the per-flow loop,
directly after `add` (`validate.ts:363-367`), so it captures `ids`, `inputFields`, `parsed`,
`flows` and `contracts` without a context object:

```ts
    /** Every type rule an ordinary `${}` reference obeys, shared by the per-step loop
     *  and the carry pass (R1-3). Returns undefined when the reference is well typed.
     *  Edge creation stays at the call site — carry creates no edges. */
    const referenceTypeError = (reference: Reference, path: string): ValidationError | undefined => {
      if (reference.kind === "input" && !containsPathInFields(inputFields, reference.path, parsed)) {
        return { code: "REF_UNKNOWN_PATH", path, message: "unknown input path" };
      }
      if (reference.kind !== "step") return undefined;
      const source = ids.get(reference.stepId);
      // A step id that is a declared carry name can only be the reserved `${name.output…}`
      // spelling (CARRY_NAME_CONFLICT already forbids a real collision) — R1-8. This arm is
      // total only because carry names share the step-id charset (R3-2): every legal carry
      // name is a legal step id, so the step regex always claims the reserved spelling.
      if (!source && Object.hasOwn(flow.carry ?? {}, reference.stepId)) {
        return { code: "CARRY_PATH_RESERVED", path, message: `carry paths may not begin with "output"; ${reference.stepId}.output reads as a step reference` };
      }
      if (!source) return { code: "REF_UNKNOWN_STEP", path, message: `unknown step ${reference.stepId}` };
      if (source.step.fanout !== undefined && !source.step.fanout.steps.at(-1)?.out) {
        return { code: "FANOUT_OUTPUT_REQUIRES_FINAL_OUT", path: `flows.${flowName}.steps[${source.index}].fanout.steps[${source.step.fanout.steps.length - 1}].out`, message: "fanout output requires final stage out" };
      }
      const sourceContract = contractForStep(source.step, flows);
      if (!sourceContract) return { code: "REF_OUTPUT_CONTRACT_REQUIRED", path, message: "referenced output requires an out contract" };
      if (source.step.fanout !== undefined) {
        const [head, ...rest] = reference.path;
        if (reference.path.length > 0 && (typeof head !== "number" || !containsPathInContract(sourceContract, rest, parsed))) {
          return { code: "REF_UNKNOWN_PATH", path, message: "fanout output is an array — index it before accessing fields" };
        }
        return undefined;
      }
      if (!containsPathInContract(sourceContract, reference.path, parsed)) {
        return { code: "REF_UNKNOWN_PATH", path, message: "unknown output path" };
      }
      return undefined;
    };
```

The per-step loop (`validate.ts:388-409`) is rewritten to call it, keeping the `REF_INVALID_SCOPE`
check (`:385-387`) and the edge creation (`:410-413`) at the call site — see S01-6. Every existing
error code, message and path is preserved verbatim, so no existing fixture changes.

`validate.ts:1-4` must gain `type Reference` on the existing `refs.js` import (R1-9), which today
reads:

```ts
import { extractReferences, referenceEdges, type PathSegment } from "./refs.js";
```

becoming

```ts
import { extractReferences, referenceEdges, type PathSegment, type Reference } from "./refs.js";
```

### S01-5 `ts/src/ir/validate.ts` (edit) — dependency-only reachability and the reset closure

Two graph notions are needed that the file does not yet have, both mirrors of engine behaviour.

**(a) Dependency-only reachability (R1-4).** `adjacency` mixes data/`after` edges with routing
edges (`on_fail` at `validate.ts:375-378`, `gate.on_approve`/`on_kill` at `:418-426`). A step
reachable only through an `on_fail` route is *not* guaranteed to run, so it cannot prove that a
carry variable was materialised. `CARRY_REF_BEFORE_INITIAL` and R1-1(c) therefore use a second,
narrower graph built from `dependencyIds` (`validate.ts:247-255`) alone. Declared beside
`adjacency` (`validate.ts:362`):

```ts
    const adjacency = new Map<string, Edge[]>();
    // Dependency-only forward graph: `after` plus step-output refs, NO routing edges.
    // Only these edges guarantee execution, which is what carry ordering needs (R1-4).
    const dependencyEdges = new Map<string, Set<string>>();
    const carryUses: Array<{ name: string; stepId: string; path: string }> = [];
```

populated once, before the carry pass:

```ts
    for (const step of flow.steps) {
      for (const dependency of dependencyIds(step)) {
        if (!dependencyEdges.has(dependency)) dependencyEdges.set(dependency, new Set());
        dependencyEdges.get(dependency)!.add(step.id);
      }
    }
    const reachesByDependency = (from: string, target: string): boolean => {
      const queue = [from];
      const seen = new Set(queue);
      while (queue.length > 0) {
        const current = queue.shift()!;
        if (current === target) return true;
        for (const next of dependencyEdges.get(current) ?? []) if (!seen.has(next)) { seen.add(next); queue.push(next); }
      }
      return false;
    };
```

This is the same BFS shape as `reaches` (`validate.ts:277-292`), whose `from === target` early
return is at `validate.ts:282` — hence the explicit `source === use.stepId` guard below.

**(b) The reset closure (R1-1b).** An `on_revise` write is only sound if the revise it rides also
resets every step that reads the variable; otherwise a step keeps a stale rendering of a list that
has just been rewritten. The closure must be the *same* one `resetFrom` computes at
`ts/src/engine/engine.ts:2226-2244`, whose existing code is:

```ts
    const descendants = new Set<string>([target]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const step of flow.steps) {
        if (descendants.has(step.id)) continue;
        const viaDependency = this.dependencies(step).some((dependency) => descendants.has(dependency));
        const viaRoute = flow.steps.some((router) => descendants.has(router.id)
          && (router.on_fail === step.id || router.gate?.on_approve === step.id || router.gate?.on_kill === step.id));
        if (viaDependency || viaRoute) { descendants.add(step.id); changed = true; }
      }
    }
```

Mirrored in validate.ts as a **module-level exported** function (R2-7) — exported so the parity
test can call the real thing rather than a copy. It uses `dependencyIds`, the validator's mirror of
`engine.dependencies`, and includes routing edges, unlike (a) which excludes them:

```ts
/** Mirrors engine.resetFrom's descendant closure (engine.ts:2226-2244): dependency
 *  edges PLUS on_fail / gate approve+kill routes. Exported as the parity-test seam;
 *  the engine keeps its own walk over live StepState, so the two must be pinned
 *  against each other (T-S01-14). */
export function resetClosure(flow: Flow, target: string): Set<string> {
  const descendants = new Set<string>([target]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const step of flow.steps) {
      if (descendants.has(step.id)) continue;
      const viaDependency = [...dependencyIds(step)].some((dependency) => descendants.has(dependency));
      const viaRoute = flow.steps.some((router) => descendants.has(router.id)
        && (router.on_fail === step.id || router.gate?.on_approve === step.id || router.gate?.on_kill === step.id));
      if (viaDependency || viaRoute) { descendants.add(step.id); grew = true; }
    }
  }
  return descendants;
}
```

It is placed at module scope beside `reaches` (`validate.ts:277`) and called as
`resetClosure(flow, target)` from the carry pass. `engine.resetFrom` (`engine.ts:2224-2244`) is
**not** refactored to call it: it walks live `StepState` inside a scope and returns epoch
transitions, not a name set, and rewriting it would put a validator import on the engine's hot
reset path. The two stay separate implementations with a parity test between them.

### S01-6 `ts/src/ir/validate.ts` (edit) — the carry arm in the main reference loop (R1-5, R1-8)

Existing code at `validate.ts:385-391`:

```ts
          if ((reference.kind === "item" || reference.kind === "prev") && !leaf.fanoutStage) {
            return { ok: false, errors: [{ code: "REF_INVALID_SCOPE", path: leaf.path, message: `${reference.kind} is only available in fanout stages` }] };
          }
          if (reference.kind === "input" && !containsPathInFields(inputFields, reference.path, parsed)) {
            return { ok: false, errors: [{ code: "REF_UNKNOWN_PATH", path: leaf.path, message: "unknown input path" }] };
          }
          if (reference.kind === "step") {
```

becomes (the `input`/`step` type checks now delegate to `referenceTypeError`, and the carry arm is
inserted between them):

```ts
          if ((reference.kind === "item" || reference.kind === "prev") && !leaf.fanoutStage) {
            return { ok: false, errors: [{ code: "REF_INVALID_SCOPE", path: leaf.path, message: `${reference.kind} is only available in fanout stages` }] };
          }
          if (reference.kind === "carry") {
            // Carry is resolved by `resolve()` during template rendering. It is NOT a
            // binding in the `expr` language, whose identifier set is closed at
            // eval/expr.ts:5,22 to result|input|item|prev — so it is illegal on any
            // expression-language field (R1-5).
            if (leaf.expression) {
              return { ok: false, errors: [{ code: "CARRY_REF_IN_EXPRESSION", path: leaf.path, message: "carry references are not available in expressions" }] };
            }
            carryUses.push({ name: reference.name, stepId: step.id, path: leaf.path });
          }
          const typeError = referenceTypeError(reference, leaf.path);
          if (typeError) return { ok: false, errors: [typeError] };
          if (reference.kind === "step") {
            for (const refEdge of referenceEdges(step.id, [extractedReference])) {
              const error = add({ ...refEdge, path: leaf.path });
              if (error) return { ok: false, errors: [error] };
            }
          }
```

`${wave.output}` and `${wave.output.tasks}` are **not** carry references: `parseReference`
declines any remainder beginning `.output` (S01-2), so they parse as step references to a step
named `wave`. Because `CARRY_NAME_CONFLICT` already forbids a carry name equal to a real step id,
such a reference can never resolve, and `referenceTypeError` reports it as `CARRY_PATH_RESERVED`
rather than the misleading `REF_UNKNOWN_STEP` (R1-8). The rule for authors is simply: **a carry
path may not begin with the segment `output`.** It is documented in `README.md` (§11).

### S01-7 `ts/src/ir/validate.ts` (edit) — the carry-block pass (D1, D2, D3, D5, R1-1, R1-4, R1-11)

The pass goes inside the per-flow loop, immediately **before** the revise-gate pass. Existing
anchor at `ts/src/ir/validate.ts:479-480`:

```ts
    const reviseGates = flow.steps.flatMap((step, index) => step.gate?.on_revise ? [{ step, index, target: step.gate.on_revise }] : []);
    if (reviseGates.length > 0 && flow.max_rounds === undefined) {
```

It must run here and not earlier, because it depends on `adjacency`, which is complete only once
the **edge-building** per-step loop (`validate.ts:369-427`) has closed. The second per-step loop
that follows (`validate.ts:429-477`, the consumer-worktree rules) adds no edges, so correctness
alone would allow insertion anywhere from 428 onward. Line 479 is chosen deliberately, after that
loop closes at 477: a spec that trips both `CONSUMER_WORKTREE_*` and a carry rule should report
the consumer-worktree diagnostic, which is the older and more specific one, and `validateSpec`
returns the first error.

The helper it reuses beyond S01-5's two locals:

- `ts/src/ir/validate.ts:247-255` —
  `function dependencyIds(step: Step): Set<string>` — `after` plus `kind === "step"` refs; the
  comment at `:246` states it mirrors `engine.dependencies()`.
- `ts/src/ir/validate.ts:277` —
  `function reaches(adjacency: Map<string, Edge[]>, from: string, target: string): boolean` — the
  routing-inclusive BFS, used only by the pre-existing `GATE_REVISE_NOT_ANCESTOR` rule at `:490`,
  **not** by carry.

New code, inserted at `validate.ts:479` (before `const reviseGates`):

```ts
    // --- STRAT-LOOP-CARRY ---------------------------------------------------
    // Carry is root-only (D5) and adds NO dependency edge, so ordering and reset
    // coverage are both proved statically here rather than discovered at runtime.
    const carry = flow.carry ?? {};
    const carryNames = new Set(Object.keys(carry));      // never `name in carry` — R1-11
    const carryPath = `flows.${flowName}.carry`;
    // Same construction the consumer-worktree rule uses at validate.ts:456-462; built once
    // here because the carry pass needs it too (R2-2).
    const routedTargets = new Set<string>();
    for (const candidate of flow.steps) {
      if (candidate.on_fail !== undefined) routedTargets.add(candidate.on_fail);
      if (candidate.gate?.on_approve) routedTargets.add(candidate.gate.on_approve);
      if (candidate.gate?.on_kill) routedTargets.add(candidate.gate.on_kill);
    }
    if (flow.carry !== undefined && flowName !== spec.flows.entry) {
      return { ok: false, errors: [{ code: "CARRY_ROOT_ONLY", path: carryPath, message: "carry may only be declared on the entry flow" }] };
    }

    // Exactly one full-value ${} reference of kind step|input (D2), typed by the same
    // rules an ordinary reference obeys (R1-3).
    const carryReference = (value: string, path: string): Reference | ValidationError => {
      const extracted = extractReferences(value);
      if (!extracted || extracted.length !== 1 || !extracted[0]!.fullValue) {
        return { code: "CARRY_REF_INVALID", path, message: "carry value must be one full reference" };
      }
      const reference = extracted[0]!.reference;
      if (reference.kind !== "step" && reference.kind !== "input") {
        return { code: "CARRY_REF_INVALID", path, message: "carry value must reference a step output or a flow input" };
      }
      return referenceTypeError(reference, path) ?? reference;
    };

    const carrySources = new Map<string, string | undefined>();   // name -> initial source step id
    for (const [name, declaration] of Object.entries(carry)) {
      if (name === "item" || name === "prev" || name === "input" || ids.has(name)) {
        return { ok: false, errors: [{ code: "CARRY_NAME_CONFLICT", path: `${carryPath}.${name}`, message: "carry name is reserved or collides with a step id" }] };
      }
      const initial = carryReference(declaration.initial, `${carryPath}.${name}.initial`);
      if ("code" in initial) return { ok: false, errors: [initial] };
      if (initial.kind === "step") {
        // The initial source must be UNCONDITIONAL. Three ways a step can fail to run:
        //  - a `when` can skip it (engine advanceScopeLoop);
        //  - a gate step never produces an output;
        //  - a ROUTING target is inactive until routed (engine.isActivated, engine.ts:2217-2221)
        //    and can be skipped outright (unreachableOnFailTarget, :2210-2215) — and a skipped
        //    dependency satisfies its edge (dependenciesDone, :2287-2293), so ordering alone
        //    would not save it. R2-2.
        const source = ids.get(initial.stepId)!.step;
        if (source.when !== undefined || source.gate !== undefined || routedTargets.has(initial.stepId)) {
          return { ok: false, errors: [{ code: "CARRY_INITIAL_SOURCE_CONDITIONAL", path: `${carryPath}.${name}.initial`, message: "carry initial source must be an unconditional, non-gate, non-routed step" }] };
        }
      }
      carrySources.set(name, initial.kind === "step" ? initial.stepId : undefined);
    }

    // Reference-side rules. carryUses was collected by the per-step loop (S01-6).
    for (const use of carryUses) {
      if (!carryNames.has(use.name)) {
        return { ok: false, errors: [{ code: "REF_UNKNOWN_CARRY", path: use.path, message: `unknown carry variable ${use.name}` }] };
      }
      const source = carrySources.get(use.name);
      if (source === undefined) continue;                       // input-sourced: available from step zero
      if (source === use.stepId || !reachesByDependency(source, use.stepId)) {
        return { ok: false, errors: [{ code: "CARRY_REF_BEFORE_INITIAL", path: use.path, message: `carry ${use.name} is not guaranteed materialised before ${use.stepId}` }] };
      }
    }

    // on_revise coverage (R1-1). A gate that rewrites a variable must also reset every
    // consumer of it, and must itself run after every consumer, or a step would keep a
    // rendering derived from a list that has just changed.
    for (const [name, declaration] of Object.entries(carry)) {
      const consumers = carryUses.filter((use) => use.name === name).map((use) => use.stepId);
      for (const [gateId, expression] of Object.entries(declaration.on_revise ?? {})) {
        const gatePath = `${carryPath}.${name}.on_revise.${gateId}`;
        const gateStep = ids.get(gateId)?.step;
        if (gateStep?.gate === undefined) {
          return { ok: false, errors: [{ code: "CARRY_UNKNOWN_GATE", path: gatePath, message: "on_revise key must be a gate step in this flow" }] };
        }
        const revise = carryReference(expression, gatePath);
        if ("code" in revise) return { ok: false, errors: [revise] };
        const target = gateStep.gate.on_revise;
        if (target === null) {
          return { ok: false, errors: [{ code: "CARRY_REVISE_TARGET_NULL", path: gatePath, message: "a gate that rewrites carry must have a revise target" }] };
        }
        const closure = resetClosure(flow, target);
        for (const consumer of consumers) {
          if (!closure.has(consumer)) {
            return { ok: false, errors: [{ code: "CARRY_REVISE_MISSES_CONSUMER", path: gatePath, message: `revise target ${target} does not reset ${consumer}, which reads ${name}` }] };
          }
          if (consumer !== gateId && !reachesByDependency(consumer, gateId)) {
            return { ok: false, errors: [{ code: "CARRY_REVISE_GATE_NOT_AFTER_CONSUMER", path: gatePath, message: `gate ${gateId} is not ordered after ${consumer}, which reads ${name}` }] };
          }
        }
      }
    }
    // --- end STRAT-LOOP-CARRY -----------------------------------------------
```

Why (c) as well as (b): resetting a consumer is not enough if the gate can fire while that
consumer is still in flight. Dependency-only ordering from every consumer to the gate is what
makes the D11 descriptor invariant (§6.1) true — it is the static proof that no live fanout item
can observe a rewritten list.

### S01-8 `ts/src/ir/validate.ts` + `ts/src/engine/engine.ts` (edit) — field-language tagging (R1-5)

Carry references are legal only on fields the engine **renders** through `resolve()`: `do`,
`with`, `evaluate.in`, `fanout.over` and a fanout stage's `do`. They are illegal on every field
evaluated by the `expr` language (`ts/src/eval/expr.ts:5,22`), which is six fields, not three
(R2-4):

| Expression field | Schema | Evaluated by |
|---|---|---|
| step `when` | `ts/src/ir/schema.ts:62` | `engine.ts:1184` |
| step `set` values | `ts/src/ir/schema.ts:64` | `engine.ts:1199` |
| step `iterate.until` | `ts/src/ir/schema.ts:21-24` | `ensurePredicate`, `engine.ts:608` |
| step `ensure[].expr` | `ts/src/ir/schema.ts:14-19` | `ensurePredicate` via `runEnsures`, `engine.ts:2056` |
| fanout stage `when` | `ts/src/ir/schema.ts:45` | `evaluateFanout`, `engine.ts:2423` |
| fanout stage `ensure[].expr` | `ts/src/ir/schema.ts:43` | `ensurePredicate`, `engine.ts:2056` |

**What tagging is and is not for (R3-1).** The tag exists for exactly one purpose: to reject a
carry reference on an expression field. It is deliberately minimal.

- It does **not** change how expression-tagged leaves feed dependency edges. `when` and `set`
  leaves are already collected by both collectors today and already contribute `kind === "step"`
  edges; that behaviour is pre-existing and this feature leaves it exactly as it is. Adding
  `iterate.until` and the two `ensure[].expr` fields extends the same pre-existing treatment to
  three more fields — it does not invent a new one.
- It does **not** introduce lexical scanning of expression source. The collectors keep handing
  whole field strings to `extractReferences`, which is a plain `\$\{([^}]*)\}` scan
  (`ts/src/ir/refs.ts:66`). No `expr` parsing is added anywhere.
- **A `${…}` token inside an expression field is literal text, not an error today.** In
  `expr: "result.name == '${wave}'"` the token sits inside a quoted string literal and the
  evaluator treats it as six characters of text. Do not describe such a token as "broken" or
  "never worked" — it parses fine and evaluates to a literal.

The rule this feature adds is narrower and is worth stating plainly: **a carry reference spelled
anywhere inside an expression-language field — quoted or unquoted — is rejected with
`CARRY_REF_IN_EXPRESSION`.** Unquoted it cannot resolve at all, because carry is not a binding in
the `expr` identifier set (`ts/src/eval/expr.ts:5,22`). Quoted it resolves to the literal
characters `${wave}`, never to the carried value. Neither spelling can ever mean what an author
writing `${wave}` intends, so rejecting both loses nothing and catches a real authoring mistake
early. Only the `expr` variant of an `EnsurePredicate` is collected; `file_exists`,
`file_contains` and `judged` are not expression strings.

**Verified before adopting:** `grep -rn 'expr:.*\${\|until:.*\${' ts/tests ts/parity ts/src`
returns no match, so no fixture, parity YAML or shipped spec changes behaviour.

The legal/illegal distinction is carried on the leaf.

`referencesInStep` (`ts/src/ir/validate.ts:226-244`) gains an `expression` flag. Existing
signature and body:

```ts
function referencesInStep(step: Step, base: readonly (string | number)[]): Array<{ value: string; path: string; fanoutStage: boolean }> {
  const result: Array<{ value: string; path: string; fanoutStage: boolean }> = [];
  const add = (value: unknown, path: readonly (string | number)[], fanoutStage = false) => {
    result.push(...leaves(value, path).map((leaf) => ({ ...leaf, fanoutStage })));
  };
  if (step.do !== undefined) add(step.do, [...base, "do"]);
  if (step.when !== undefined) add(step.when, [...base, "when"]);
  if (step.set !== undefined) add(step.set, [...base, "set"]);
  ...
```

becomes

```ts
export function referencesInStep(step: Step, base: readonly (string | number)[]): Array<{ value: string; path: string; fanoutStage: boolean; expression: boolean }> {
  const result: Array<{ value: string; path: string; fanoutStage: boolean; expression: boolean }> = [];
  const add = (value: unknown, path: readonly (string | number)[], fanoutStage = false, expression = false) => {
    result.push(...leaves(value, path).map((leaf) => ({ ...leaf, fanoutStage, expression })));
  };
  if (step.do !== undefined) add(step.do, [...base, "do"]);
  if (step.when !== undefined) add(step.when, [...base, "when"], false, true);
  if (step.set !== undefined) add(step.set, [...base, "set"], false, true);
  if (step.iterate?.until !== undefined) add(step.iterate.until, [...base, "iterate", "until"], false, true);
  step.ensure?.forEach((predicate, index) => {
    if ("expr" in predicate) add(predicate.expr, [...base, "ensure", index, "expr"], false, true);
  });
  if (step.run !== undefined && step.with !== undefined) add(step.with, [...base, "with"]);
  if (step.evaluate?.in !== undefined) add(step.evaluate.in, [...base, "evaluate", "in"]);
  if (step.fanout !== undefined) {
    add(step.fanout.over, [...base, "fanout", "over"]);
    step.fanout.steps.forEach((stage, index) => {
      add(stage.do, [...base, "fanout", "steps", index, "do"], true);
      if (stage.when !== undefined) add(stage.when, [...base, "fanout", "steps", index, "when"], true, true);
      stage.ensure?.forEach((predicate, ensureIndex) => {
        if ("expr" in predicate) add(predicate.expr, [...base, "fanout", "steps", index, "ensure", ensureIndex, "expr"], true, true);
      });
    });
  }
  return result;
}
```

It becomes `export`ed as the test seam R1-10 requires. `dependencyIds` (`validate.ts:249`) reads
only `leaf.value` and is unaffected.

The engine mirror `stringLeaves` (`ts/src/engine/engine.ts:2881-2904`) takes the same tag **and
the same three new fields**, so the pair stays literally symmetric (C5, R2-4). Its return type
changes from `string[]` to `Array<{ value: string; expression: boolean }>`, and it is `export`ed:

```ts
export function stringLeaves(step: Step): Array<{ value: string; expression: boolean }> {
  const values: Array<{ value: string; expression: boolean }> = [];
  const collect = (value: unknown, expression = false): void => {
    if (typeof value === "string") values.push({ value, expression });
    else if (Array.isArray(value)) value.forEach((entry) => collect(entry, expression));
    else if (typeof value === "object" && value !== null) Object.values(value).forEach((entry) => collect(entry, expression));
  };
  if (step.do !== undefined) collect(step.do);
  if (step.when !== undefined) collect(step.when, true);
  if (step.set !== undefined) collect(step.set, true);
  if (step.iterate?.until !== undefined) collect(step.iterate.until, true);
  for (const predicate of step.ensure ?? []) if ("expr" in predicate) collect(predicate.expr, true);
  // The engine's dependency edges must mirror the validator's: subflow `with`
  // templates and fanout over/stage templates reference steps too — a fanout
  // over "${prep.output.items}" must wait for prep, not fail at resolve time.
  if (step.with !== undefined) collect(step.with);
  if (step.evaluate?.in !== undefined) collect(step.evaluate.in);
  if (step.fanout !== undefined) {
    collect(step.fanout.over);
    for (const stage of step.fanout.steps) {
      collect(stage.do);
      if (stage.when !== undefined) collect(stage.when, true);
      for (const predicate of stage.ensure ?? []) if ("expr" in predicate) collect(predicate.expr, true);
    }
  }
  return values;
}
```

Its single caller is
`dependencies` (`ts/src/engine/engine.ts:2296-2302`), whose loop head changes from:

```ts
    for (const value of stringLeaves(step)) {
```

to

```ts
    for (const { value } of stringLeaves(step)) {
```

`dependencies` deliberately ignores the tag: a `kind === "step"` reference is an edge on every
field, expression or not. The tag exists so the two collectors can be compared field-for-field by
the mirror test (T-S01-13), which is the only defence against C5 drifting back.

### S01-9 `ts/src/ir/validate.ts` (edit) — `FANOUT_OVER_SINGLE_REF` (D4)

Add to the per-step loop, in the same `for (const [index, step] of flow.steps.entries())` block
that starts at `validate.ts:369`. Place it immediately after the `on_fail` edge block
(`validate.ts:375-378`) and before the reference loop (`:380`), so a malformed `over` is reported
against `over` rather than as a downstream reference error:

```ts
      if (step.fanout !== undefined) {
        const overRefs = extractReferences(step.fanout.over);
        if (!overRefs || overRefs.length !== 1 || !overRefs[0]!.fullValue) {
          return { ok: false, errors: [{ code: "FANOUT_OVER_SINGLE_REF", path: formatPath([...base, "fanout", "over"]), message: "fanout over must be one full reference" }] };
        }
      }
```

`base` is already in scope (`validate.ts:370`). `formatPath` is at `validate.ts:40`. The runtime
guard at `ts/src/engine/engine.ts:2396` stays exactly as it is — it is now unreachable for a
validated spec, which is the point.

### S01-10 Tests for S01

Two existing files edited; the mirror test needs the two collectors exported (S01-8), which is the
test seam named for R1-10.

| Test | File | Asserts | Copies |
|---|---|---|---|
| T-S01-1 `parses a bare carry reference and gives it no edge` | `ts/tests/ir/refs.test.ts` (edit) | `extractReferences("${wave}")` is `[{ raw: "${wave}", fullValue: true, reference: { kind: "carry", name: "wave", path: [] } }]`; `extractReferences("${wave.tasks[0].id}")` yields path `["tasks", 0, "id"]`; `referenceEdges("fan", …)` is `[]` for both | the shape of `ts/tests/ir/refs.test.ts:5-12` verbatim |
| T-S01-2 `reserves only the exact output segment` (R1-8, R2-6) | `ts/tests/ir/refs.test.ts` (edit) | all three spellings in one test: `${wave.output}` and `${wave.output.tasks}` parse as kind `step` with `stepId: "wave"` (reserved), while `${wave.outputValue}` and `${wave.outputs}` parse as kind `carry` with paths `["outputValue"]` and `["outputs"]`. Plus the regressions: `${build.output.items[0].name}` unchanged, `${input.bad-name}` still `undefined` | `ts/tests/ir/refs.test.ts:14-17` |
| T-S01-3 valid fixture `a carry flow` | `ts/tests/ir/fixtures.ts` (edit, appended to `validFixtures`, array at `:84-124`) | the §2.8 shape validates: `carry.wave.initial` on `plan`, `over: "${wave}"`, `after: [plan]`, an `assess_gate` whose `on_revise` target resets `execute` | `clone(designExample)` at `fixtures.ts:3`; `designExample` (`:5-60`) already carries a fanout, a revise gate and `max_rounds` |
| T-S01-13 collector mirror, through the production collectors | `ts/tests/ir/collectors.test.ts` (new) | for the carry fixture's every step, `referencesInStep(step, [])` (imported from `ts/src/ir/validate.ts`) and `stringLeaves(step)` (imported from `ts/src/engine/engine.ts`) yield the **same multiset of `value` strings** and the **same `expression` tag per value**; and neither produces a `kind === "step"` reference for `${wave}`. No hand-built leaf sets — R1-10 | new file, ~30 lines; import shape of `ts/tests/ir/refs.test.ts:1-2` |
| T-S01-14 reset-closure parity, over a fixture matrix (R2-7) | `ts/tests/ir/collectors.test.ts` (new) | `resetClosure(flow, target)` is imported from `ts/src/ir/validate.ts` (exported for this seam) and compared against the engine's actual `step_reset` detail for **each** of: a plain `after` chain, a chain with an `on_fail` branch, a chain with a gate `on_approve` branch, a chain with a gate `on_kill` branch (R3-4 — `on_kill` is the third routing edge in both closures, `engine.ts:2237-2238` and its validator twin, and is the one most easily dropped in a rewrite), and the golden flow. For every (flow, target) pair the statically computed name set equals the `detail.reset` step ids the engine emits. Pins R1-1(b) against `engine.ts:2226-2244` drifting away from its validator twin | none |
| T-S01-5..12, T-S01-15..21 invalid fixtures | `ts/tests/ir/fixtures.ts` (edit, appended to `invalidFixtures`, array at `:126-277`) | one entry per code, exact `{code, path}` (the suite compares the whole list in order, `ts/tests/ir/validate.test.ts:19-24`) | the `err(code, path)` helper at `fixtures.ts:75` |

The invalid fixtures, each built with `clone()` from the T-S01-3 valid carry spec:

| name | mutation | expected |
|---|---|---|
| `carry on a non-entry flow` | move the `carry` block onto `summarize` | `CARRY_ROOT_ONLY` @ `flows.summarize.carry` |
| `carry name collides with a step` | rename `wave` to `plan` | `CARRY_NAME_CONFLICT` @ `flows.main.carry.plan` |
| `carry name shadows item` | rename `wave` to `item` | `CARRY_NAME_CONFLICT` @ `flows.main.carry.item` |
| `carry name is not lowercase` (R3-2) | rename `wave` to `Wave` | `SCHEMA_INVALID` @ `flows.main.carry.Wave` — the strict record's key regex fails before any carry pass runs, so `schemaErrors` (`ts/src/ir/validate.ts:47-60`) maps it through its default arm. Confirm the emitted code against the runner rather than assuming it |
| `carry name starts with an underscore` (R3-2) | rename `wave` to `_wave` | `SCHEMA_INVALID` @ `flows.main.carry._wave` — same path |
| `carry initial is not a full reference` | `initial: "wave is ${plan.output.tasks}"` | `CARRY_REF_INVALID` @ `flows.main.carry.wave.initial` |
| `carry initial names an unknown step` | `initial: "${nope.output.tasks}"` | `REF_UNKNOWN_STEP` @ `flows.main.carry.wave.initial` |
| `carry initial source has no out contract` (R1-3) | insert a contractless `seed` do-step and point `initial` at `${seed.output}` | `REF_OUTPUT_CONTRACT_REQUIRED` @ `flows.main.carry.wave.initial` |
| `carry initial names an unknown output path` (R1-3) | `initial: "${plan.output.missing}"` | `REF_UNKNOWN_PATH` @ `flows.main.carry.wave.initial` |
| `carry initial names an unknown input path` (R1-3) | `initial: "${input.missing}"` | `REF_UNKNOWN_PATH` @ `flows.main.carry.wave.initial` |
| `carry initial source is when-guarded` (R1-4) | add `when: "true"` to `plan` | `CARRY_INITIAL_SOURCE_CONDITIONAL` @ `flows.main.carry.wave.initial` |
| `carry initial source is a gate` (R1-4) | point `initial` at a gate step | `CARRY_INITIAL_SOURCE_CONDITIONAL` @ `flows.main.carry.wave.initial` |
| `carry initial source is an on_fail target` (R2-2) | make `plan` the `on_fail` target of another step | `CARRY_INITIAL_SOURCE_CONDITIONAL` @ `flows.main.carry.wave.initial` |
| `carry initial source is a gate route target` (R2-2) | make `plan` the `on_approve` target of a gate | `CARRY_INITIAL_SOURCE_CONDITIONAL` @ `flows.main.carry.wave.initial` |
| `carry initial source is an on_kill target` (R3-4) | make `plan` the `on_kill` target of a gate | `CARRY_INITIAL_SOURCE_CONDITIONAL` @ `flows.main.carry.wave.initial` — `on_kill` is in the routed set at `validate.ts:456-462` and in `isActivated` (`engine.ts:2218-2219`), so it must be covered by a fixture and not merely by the code path |
| `carry on_revise key is not a gate` | key the map on `plan` | `CARRY_UNKNOWN_GATE` @ `flows.main.carry.wave.on_revise.plan` |
| `carry revise gate has no target` (R1-1a) | set `assess_gate.gate.on_revise` to `null` | `CARRY_REVISE_TARGET_NULL` @ `flows.main.carry.wave.on_revise.assess_gate` |
| `carry revise target does not reset the consumer` (R1-1b) | retarget `assess_gate.gate.on_revise` at a step downstream of `execute` | `CARRY_REVISE_MISSES_CONSUMER` @ `flows.main.carry.wave.on_revise.assess_gate` |
| `carry revise gate is a sibling of the consumer` (R1-1c) | move `assess_gate` onto a branch with no dependency path from `execute` (a ready fanout plus a sibling revise gate) | `CARRY_REVISE_GATE_NOT_AFTER_CONSUMER` @ `flows.main.carry.wave.on_revise.assess_gate` |
| `undeclared carry reference` | `over: "${surge}"` | `REF_UNKNOWN_CARRY` @ `flows.main.steps[1].fanout.over` |
| `inherited property is not a carry name` (R1-11) | `over: "${toString}"` | `REF_UNKNOWN_CARRY` @ `flows.main.steps[1].fanout.over` |
| `carry referenced before its initial source` | drop `after: [plan]` from `execute` | `CARRY_REF_BEFORE_INITIAL` @ `flows.main.steps[1].fanout.over` |
| `carry source reachable only by on_fail` (R1-4) | order `execute` after `plan` only through an `on_fail` route | `CARRY_REF_BEFORE_INITIAL` @ `flows.main.steps[1].fanout.over` |
| `carry in a step when` (R1-5) | `when: "${wave}"` on a do step | `CARRY_REF_IN_EXPRESSION` @ `flows.main.steps[…].when` |
| `carry in a set expression` (R1-5) | `set: { n: "${wave}" }` | `CARRY_REF_IN_EXPRESSION` @ `flows.main.steps[…].set.n` |
| `carry in a fanout stage when` (R1-5) | stage `when: "${wave}"` | `CARRY_REF_IN_EXPRESSION` @ `flows.main.steps[1].fanout.steps[0].when` |
| `carry in iterate.until` (R2-4) | `iterate: { max: 2, until: "${wave}" }` on a do step | `CARRY_REF_IN_EXPRESSION` @ `flows.main.steps[…].iterate.until` |
| `carry in a step ensure expr` (R2-4) | `ensure: [{ expr: "${wave}" }]` | `CARRY_REF_IN_EXPRESSION` @ `flows.main.steps[…].ensure[0].expr` |
| `carry in a fanout stage ensure expr` (R2-4) | stage `ensure: [{ expr: "${wave}" }]` | `CARRY_REF_IN_EXPRESSION` @ `flows.main.steps[1].fanout.steps[0].ensure[0].expr` |
| `carry path may not start with output` (R1-8) | `over: "${wave.output}"` | `CARRY_PATH_RESERVED` @ `flows.main.steps[1].fanout.over` |
| `fanout over is not a single reference` | `over: "${wave} and ${wave}"` | `FANOUT_OVER_SINGLE_REF` @ `flows.main.steps[1].fanout.over` |

---

## 4. Slice S02 — Engine state: persistence, checkpoints, event vocabulary

S02 adds only types and declarations. No behaviour changes; the suite must stay green after it.

### S02-1 `ts/src/engine/state.ts` (edit) — types

1. Add `CarryProvenance` and `CarryEntry` (§2.1) after `SubflowState` (`state.ts:142-147`).
2. Add `carry?: Record<string, CarryEntry>;` to `PersistedRun` after `checkpoints?`
   (`state.ts:229-231`), whose existing lines read:

```ts
  /** Named state-only snapshots in insertion order; optional so runs created before
   *  checkpoints remain loadable. */
  checkpoints?: CheckpointEntry[];
```

3. Add `"carry"` to the `CheckpointSnapshot` `Pick` (`state.ts:182-185`) — C11.
4. Append `"carry_updated"` to the `AuditEvent["type"]` union (`state.ts:174-177`), whose last
   line is:

```ts
    | "usage_debit" | "step_reset" | "checkpoint_reverted";
```

becoming

```ts
    | "usage_debit" | "step_reset" | "checkpoint_reverted" | "carry_updated";
```

### S02-2 `ts/src/engine/checkpoint.ts` (edit) — classification

`CHECKPOINT_FIELDS` (`ts/src/engine/checkpoint.ts:12-14`), existing:

```ts
export const CHECKPOINT_FIELDS = [
  "status", "output", "failure", "flowSpent", "rounds", "steps", "events", "policy_verdicts", "cancelRequested", "parallel",
] as const satisfies readonly (keyof PersistedRun)[];
```

gains `"carry"` at the end of the array. Nothing is added to `CHECKPOINT_EXCLUDED`
(`checkpoint.ts:19-34`) — the `satisfies Record<Exclude<keyof PersistedRun, CheckpointField>, string>`
at `:34` is what proves the classification is total, and it will fail to compile if this is
skipped (C10).

Why snapshotted rather than excluded (D6): `steps` is a checkpoint field (`checkpoint.ts:13`) and
carry is derived from step outputs. Excluding it would let `revertCheckpoint`
(`checkpoint.ts:47-58`) restore old outputs beside a new carried list, desyncing the fanout from
the tree it re-fans over. `revertCheckpoint` deletes any checkpoint field absent from the
snapshot (`:55`), so reverting to a checkpoint taken before the first carry write correctly
removes `run.carry` entirely.

### S02-3 `ts/contracts/events.json` (edit)

`"events": 2` → `3` at `events.json:2`, and the `carry_updated` kind of §2.5 appended inside
`kinds` after `checkpoint_reverted` (`events.json:90-96`).

### S02-4 Tests for S02

| Test | File | Asserts |
|---|---|---|
| T-S02-1 | `ts/tests/engine/flowctl.test.ts` (edit) — the list at `:52-55` | `"carry"` inserted between `"cancelRequested"` and `"checkpoints"` in the sorted 25-name array. The surrounding assertion at `:50-57` is otherwise untouched |
| T-S02-2 | `ts/tests/engine/flowctl.test.ts` (edit) — the round-trip test at `:59` | extend the `run()` fixture (`:29-47`) with `carry: { wave: { value: ["a"], provenance: { kind: "initial", sourceStep: "build", sourceEpoch: 0, at: "before" } } }`, then assert commit/mutate/revert restores the original entry and does not alias it (same shape the existing test uses for `output` and `steps`) |

---

## 5. Slice S03 — Engine runtime: scope, resolve, materialise, revise transaction

S03 is where the feature becomes real. It is also where every ordering hazard lives, so each
edit below names the exact anchor line.

### S03-1 `ts/src/engine/engine.ts` (edit) — `ExecutionScope` and `rootScope`

`ExecutionScope` at `engine.ts:117-124`, existing:

```ts
interface ExecutionScope {
  input: unknown;
  steps: Record<string, StepState>;
  flow: Flow;
  flowName: string;
  prefix?: string;
  parent?: { step: Step; state: StepState };
}
```

gains, after `steps`:

```ts
  /** Root-flow loop-carried values (D5). Populated by rootScope only; childScope
   *  deliberately leaves it undefined so a subflow can never read carry even if a
   *  future validation change let it try. */
  carry?: Record<string, CarryEntry>;
```

`rootScope` at `engine.ts:2449-2451`, existing:

```ts
  private rootScope(run: PersistedRun, spec: Specification): ExecutionScope {
    return { input: run.input, steps: run.steps, flow: this.flowFor(run, spec), flowName: run.flowName };
  }
```

becomes

```ts
  private rootScope(run: PersistedRun, spec: Specification): ExecutionScope {
    return { input: run.input, steps: run.steps, carry: run.carry, flow: this.flowFor(run, spec), flowName: run.flowName };
  }
```

**`carry: run.carry` captures an object reference, and that is a trap (R2-1).** `advance`
evaluates its default `scope` parameter (`engine.ts:1099`) *before* the body runs, and hands that
same object to `advanceScopeLoop` and thence to fanout resolution at `engine.ts:1232`. If
`run.carry` was `undefined` when the scope was built and the materialisation hook then created it,
the live scope would still see `undefined` and the fanout would fail with "not materialised" in
the very pass the value became available. Building a fresh root scope inside the hook does not
help — the *active* scope is the one the fanout reads.

The fix is one helper, placed beside `rootScope` (`engine.ts:2449`), which guarantees the run and
the active scope share **one** carry object:

```ts
  /** The root scope carry is written through, sharing ONE object with the run so a write
   *  made during this pass is visible to every later read through the LIVE scope (R2-1).
   *  Null-prototype so an inherited name like `toString` can never masquerade as a
   *  declared variable (R2-3); a reloaded run's plain object is guarded by Object.hasOwn. */
  private carryScope(run: PersistedRun, spec: Specification, scope: ExecutionScope): ExecutionScope {
    const root = scope.parent === undefined ? scope : this.rootScope(run, spec);
    if (root.flow.carry === undefined) return root;      // never persist an empty carry map
    run.carry ??= Object.create(null) as Record<string, CarryEntry>;
    root.carry = run.carry;
    return root;
  }
```

Every materialisation call site (S03-5) passes `this.carryScope(run, spec, scope)`, so:

- for a root-scope advancement the *active* scope object itself is patched, and the fanout at
  `engine.ts:1232` reads the value written moments earlier in the same pass;
- for a child-scope advancement the root scope is obtained explicitly, which is correct because
  carry is root-only (D5);
- `run.carry` and `scope.carry` are the same object, so there is exactly one place to write.

`childScope` (`engine.ts:2453-2465`) is **not** changed: it never populates `carry`, which is a
second guarantee that a subflow cannot read one.

### S03-2 `ts/src/engine/engine.ts` (edit) — `resolve`

Existing, `engine.ts:2641-2645`:

```ts
  private resolve(reference: Reference, scope: ExecutionScope): unknown {
    if (reference.kind === "input") return access(scope.input, reference.path);
    if (reference.kind === "step") return access(scope.steps[reference.stepId]?.output, reference.path);
    throw new Error("fanout references are outside P1 engine scope");
  }
```

becomes

```ts
  private resolve(reference: Reference, scope: ExecutionScope): unknown {
    if (reference.kind === "input") return access(scope.input, reference.path);
    if (reference.kind === "step") return access(scope.steps[reference.stepId]?.output, reference.path);
    if (reference.kind === "carry") {
      // Object.hasOwn, never `?.[name]`: a persisted run reloads as a PLAIN object
      // (state.ts:252-256 is a bare JSON.parse), so a variable legitimately named
      // `toString` or `constructor` would otherwise resolve to an inherited function
      // instead of a carry entry (R2-3).
      const store = scope.carry;
      if (store === undefined || !Object.hasOwn(store, reference.name)) {
        // A named, actionable failure replaces the generic "must resolve to an array"
        // that `over` would otherwise produce two frames up (D1).
        throw new Error(`carry variable ${JSON.stringify(reference.name)} is not materialised`);
      }
      return access(store[reference.name]!.value, reference.path);
    }
    throw new Error("fanout references are outside P1 engine scope");
  }
```

This one arm covers all six `resolveFanoutOver` call sites (`engine.ts:1232`, `:1457`, `:1546`,
`:1594`, `:1632`, `:2321`) with no call-site change, because each of them already re-resolves
`over` from live state and each defaults to `rootScope` (`engine.ts:2394`).

### S03-3 `ts/src/engine/engine.ts` (new private) — `carryReference`

A tiny helper so validation and runtime agree on "one full reference". Place it directly above
`resolve` (`engine.ts:2641`):

```ts
  /** The single reference in a carry `initial` / `on_revise` value. Validation has
   *  already proved the shape (CARRY_REF_INVALID), so a failure here is a bug. */
  private carryReference(value: string): Reference {
    const extracted = extractReferences(value);
    const reference = extracted?.length === 1 && extracted[0]!.fullValue ? extracted[0]!.reference : undefined;
    if (!reference) throw new Error("invalid carry reference after validation");
    return reference;
  }
```

### S03-4 `ts/src/engine/engine.ts` (new private) — `materialiseCarry` (D7, R1-3, R2-1, R2-3, R2-5)

Place it directly above `advance` (`engine.ts:1095`).

**Staged, then applied (R2-5).** Every candidate is resolved into a local array first; only when
all of them resolve does anything mutate. This matters because `advanceScopeLoop`
(`engine.ts:1159`) has **no** try/catch, and because at the `set:` and `evaluate:` call sites the
source step is already marked `succeeded` (`engine.ts:1213`, `:1347`) before the hook runs — a
throw halfway through a two-variable carry block would leave one entry written, one event in the
spine, and an unrecoverable run. So the function never throws: it returns a discriminated result
and each call site performs the failure transition.

```ts
  type CarryMaterialisation =
    | { kind: "unchanged" }
    | { kind: "written" }
    | { kind: "failed"; reason: string };

  /** Idempotent `initial` materialisation. Re-writes only when the source step's epoch
   *  differs from the recorded one, so:
   *   - a source that re-runs (which can only happen after a reset bumped its epoch)
   *     replaces its now-stale derived value;
   *   - a revise write, stamped with the initial source's CURRENT epoch, survives every
   *     later advance until that source is itself reset.
   *  `scope` MUST come from `carryScope` so `scope.carry === run.carry` (R2-1). */
  private materialiseCarry(run: PersistedRun, scope: ExecutionScope): CarryMaterialisation {
    const declarations = scope.flow.carry;
    if (declarations === undefined) return { kind: "unchanged" };
    const store = scope.carry;
    if (store === undefined) return { kind: "unchanged" };
    const staged: Array<{ name: string; value: unknown; provenance: CarryProvenance }> = [];
    for (const [name, declaration] of Object.entries(declarations)) {
      const reference = this.carryReference(declaration.initial);
      // Object.hasOwn: a declared variable named `toString` must not read as materialised
      // just because Object.prototype has one (R2-3).
      const existing = Object.hasOwn(store, name) ? store[name] : undefined;
      let provenance: CarryProvenance;
      if (reference.kind === "step") {
        const source = scope.steps[reference.stepId];
        if (source?.status !== "succeeded") continue;
        const sourceEpoch = source.epoch ?? 0;
        if (existing !== undefined && existing.provenance.sourceEpoch === sourceEpoch) continue;
        provenance = { kind: "initial", sourceStep: reference.stepId, sourceEpoch, at: now() };
      } else {
        if (existing !== undefined) continue;                 // input-sourced: write once
        provenance = { kind: "initial", at: now() };
      }
      const value = this.resolve(reference, scope);
      // NEVER create an entry from an absent value (R1-3): a materialised-but-undefined
      // carry would fail later at a confusing site, or hand `undefined` to a fanout.
      if (value === undefined) {
        return { kind: "failed", reason: `carry_initial_unresolved: carry ${JSON.stringify(name)} resolved to no value from ${declaration.initial}` };
      }
      staged.push({ name, value, provenance });
    }
    if (staged.length === 0) return { kind: "unchanged" };
    for (const write of staged) {
      store[write.name] = { value: write.value, provenance: write.provenance };
      this.event(run, "carry_updated", write.provenance.sourceStep, { name: write.name, reason: "initial", provenance: write.provenance });
    }
    return { kind: "written" };
  }
```

Notes:

- `now()` is the existing module helper used throughout (`engine.ts:632`, `:1215`, `:2848`).
- `store` is `run.carry` — the same object, guaranteed by `carryScope` — so writing through it is
  writing the run (R2-1).
- `this.event(..., write.provenance.sourceStep, ...)` passes `undefined` for an input-sourced
  initial, and `event` (`engine.ts:2847-2849`) spreads `stepId` only when defined, so the emitted
  event legitimately has no `stepId` (R1-7).
- `CarryMaterialisation` is declared beside `ExecutionScope` (`engine.ts:117`), not inside the
  class body.

**The failure transition (R2-5 RULING).** The source step has already succeeded, so its attempt
cannot be failed retroactively. `carry_initial_unresolved` is therefore a **run-level** failure,
raised through the same path a flow-output contract failure takes: `failScope`
(`ts/src/engine/engine.ts:2593-2602`), which routes a child scope to `failParentRunStep`
(`:2604-2615`) and a root scope to `terminalFailure` (`:2780-2787` — `run.status = "failed"`,
`run.failure = { attempt: 0, reason }`, a `failed` event, one persist, `emitFlowTerminal`). Because
the staging loop returns before any write, the failed run carries **no** partial carry entry and
**no** `carry_updated` event, in the pinned in-memory run and on disk alike.

### S03-5 `ts/src/engine/engine.ts` (edit) — the materialisation call sites (D7, R1-2, R2-1, R2-5)

**`advance`'s top of function is necessary but not sufficient.** `advance` is the common
re-entry after the settle sites that dispatch work — the `do:` settle
(`engine.ts:632-646`, persist `:645`, advance `:646`), the fanout aggregate settle
(`:1651-1656`, advance `:1656`), subflow completion (`:2634-2638`, advance `:2638`) and gate
approve/kill (`:970-971`). But two **engine-owned** constructs settle *inside*
`advanceScopeLoop` and then `continue` the same pass over `flow.steps`:

- `set:` — `engine.ts:1196-1219`, `state.status = "succeeded"` at `:1213`, persist `:1218`,
  `continue` `:1219`;
- `evaluate:` — `engine.ts:1347-1353`, `state.status = "succeeded"` at `:1347`, persist `:1351`,
  `continue` `:1353`.

Fanout activation is at `engine.ts:1229` in that **same** loop over `flow.steps`. A `set` step at
index *i* and a `${carry}` fanout at index *i+1* therefore settle and activate in one pass, before
control ever returns to `advance`. A top-of-`advance` hook alone would let that fanout resolve an
unmaterialised variable.

**Ruling: hook both places.** Three call sites, all passing `carryScope` so the write lands in the
object the live scope holds (R2-1).

1. **Top of `advance`** (`engine.ts:1095-1101`), covering every settle that dispatches work and
   every gate route. Existing code:

```ts
    scope: ExecutionScope = this.rootScope(run, spec),
  ): Promise<EngineResponse> {
    await this.advanceScopeLoop(run, spec, contracts, scope);
```

becomes

```ts
    scope: ExecutionScope = this.rootScope(run, spec),
  ): Promise<EngineResponse> {
    // STRAT-LOOP-CARRY D7: the re-entry after every dispatching settle, and BEFORE the
    // scope loop, so a ${carry} fanout sees the value in the same pass it activates.
    // carryScope patches THIS scope object when it is the root one (R2-1) — building a
    // detached root scope here would leave the live scope's carry undefined.
    // `advance` does not persist on every path (it can return `ready` at :1125 or
    // `running` at :1129), so a write persists itself.
    const materialised = this.materialiseCarry(run, this.carryScope(run, spec, scope));
    if (materialised.kind === "failed") return this.failScope(run, spec, contracts, scope, materialised.reason);
    if (materialised.kind === "written") await this.persist(run);
    await this.advanceScopeLoop(run, spec, contracts, scope);
```

2. **After the `set:` settle**, between the `result` event (`engine.ts:1216`) and
   `changed = true` (`:1217`), so a write rides the existing persist at `:1218`. The failure arm
   copies the shape already used for a `set` evaluation failure at `engine.ts:1204-1205`:

```ts
          this.event(run, "result", this.scopedId(scope, step.id), { attempt: 1, result: output });
          // R1-2: a later step in THIS pass may read the value. R2-5: never a partial write.
          const setCarry = this.materialiseCarry(run, this.carryScope(run, spec, scope));
          if (setCarry.kind === "failed") { await this.failScope(run, spec, contracts, scope, setCarry.reason); break; }
          changed = true;
          await this.persist(run);
          continue;
```

3. **After the `evaluate:` settle**, between the `result` event (`engine.ts:1350`) and the
   persist (`:1351`), identically:

```ts
          this.event(run, "result", this.scopedId(scope, step.id), { attempt, result: parsed.data });
          const evalCarry = this.materialiseCarry(run, this.carryScope(run, spec, scope));
          if (evalCarry.kind === "failed") { await this.failScope(run, spec, contracts, scope, evalCarry.reason); break; }
          await this.persist(run);
          changed = true;
          continue;
```

`spec` and `contracts` are parameters of `advanceScopeLoop` (`engine.ts:1159-1164`), so both are
available at the in-loop sites; `break` matches how every other failure in that loop exits
(`engine.ts:1191`, `:1205`, `:1212`).

The `do:`, fanout-aggregate and subflow settle sites need **no** in-loop hook: each returns
`this.advance(...)` immediately after its persist, and `advance` runs the hook before
`advanceScopeLoop` can activate anything. The flow-output rollback at `engine.ts:636-642` needs no
handling either — it returns through `failAttempt` with `state.status` left at `"ready"`, so the
`status !== "succeeded"` guard declines. This is why the hook lives after each settle rather than
inside it.

The hook is idempotent, so the overlap between site 1 and sites 2/3 costs nothing: the second call
finds a matching `sourceEpoch` and returns `{ kind: "unchanged" }`.

### S03-6 `ts/src/engine/engine.ts` (new private) — `resolveCarryOnRevise` (D8)

Place directly above `gateResolveLocked` (`engine.ts:906`).

```ts
  /** Every on_revise write this gate declares, resolved against the UN-RESET scope.
   *  All expressions are resolved before any of them is applied, so a missing source
   *  output fails the decision with no partial mutation. */
  private resolveCarryOnRevise(scope: ExecutionScope, gateId: string, gateToken: string): Array<{ name: string; value: unknown; provenance: CarryProvenance }> {
    const declarations = scope.flow.carry;
    if (declarations === undefined) return [];
    const writes: Array<{ name: string; value: unknown; provenance: CarryProvenance }> = [];
    for (const [name, declaration] of Object.entries(declarations)) {
      // Object.hasOwn on the on_revise map too: a gate step legitimately named
      // `constructor` must not pick up an inherited member as a declaration (R2-3).
      const onRevise = declaration.on_revise;
      if (onRevise === undefined || !Object.hasOwn(onRevise, gateId)) continue;   // gates that declare nothing leave the entry untouched
      const expression = onRevise[gateId]!;
      const value = this.resolve(this.carryReference(expression), scope);
      if (value === undefined) {
        throw new Error(`carry_revise_unresolved: carry ${JSON.stringify(name)} at gate ${JSON.stringify(gateId)} resolved to no value`);
      }
      // sourceStep/sourceEpoch name the INITIAL declaration's source (D6), so the write
      // survives every later advance until that source is itself reset (D7).
      const initial = this.carryReference(declaration.initial);
      const source = initial.kind === "step" ? { sourceStep: initial.stepId, sourceEpoch: scope.steps[initial.stepId]?.epoch ?? 0 } : {};
      writes.push({ name, value, provenance: { kind: "revise", ...source, gate: gateId, gateToken, at: now() } });
    }
    return writes;
  }
```

Subflow gates need no guard: `scope.flow` for a subflow gate is the child flow, whose `carry` is
`undefined` by D5's validation rule, so this returns `[]`.

### S03-7 `ts/src/engine/engine.ts` (edit) — the revise transaction, reordered (D8, R1-6)

**Why the order matters.** `loadRun` (`engine.ts:337-341`) returns the *live in-process run
object* whenever a fanout is active (`activeRuns`, declared with its rationale at
`engine.ts:311-314`, retained around `scheduleFanout` at `:1393`). So a throw partway through
`gateResolveLocked` does not roll back to a clean disk copy — it leaves the pinned object exactly
as the throw found it. Today `delete state.gateToken` (`engine.ts:927`) and the `gate_resolved`
event (`:929`) both run **before** the revise branch. If a carry `on_revise` expression fails to
resolve after that point, the token is gone, the event claims a decision that never happened, and
the gate can never be resolved again: the run is wedged.

The fix is to make the whole preflight — target, round limits, and every carry resolution — run
before the first mutation. The reordered function, from the entry guard through the revise branch
(`engine.ts:906-954`), with the changed region marked:

```ts
  private async gateResolveLocked(runId: string, stepId: string, decision: "approve" | "revise" | "kill", gateToken?: string): Promise<EngineResponse> {
    if (decision !== "approve" && decision !== "revise" && decision !== "kill") throw new Error(`invalid gate decision ${JSON.stringify(decision)}`);
    const run = await this.loadRun(runId);
    if (run.cancelRequested === true) throw new Error(`run ${runId} is cancelled; gate ${stepId} cannot be resolved`);
    const validated = this.validationFor(run);
    const located = this.locateStep(run, validated.value, stepId);
    const scope = located?.scope;
    const step = located?.step;
    const state = located?.state;
    if (!scope || !step?.gate || !state || state.status !== "waiting_gate" || run.status !== "running") throw new Error("gate is not awaiting a decision");
    if (gateToken === undefined) {
      throw new Error("gate decision is stale: missing gate token");
    }
    if (state.gateToken !== gateToken) {
      throw new Error("gate decision is stale: issued for a superseded gate round");
    }
    const target = decision === "approve" ? step.gate.on_approve : decision === "revise" ? step.gate.on_revise : step.gate.on_kill;

    // ---- STRAT-LOOP-CARRY R1-6: MUTATION-FREE PREFLIGHT ---------------------
    // Everything that can throw runs here, while the gate token is still valid and no
    // event has been appended. loadRun returns the LIVE run object while a fanout is
    // active (engine.ts:311-314, :337-341), so a throw after this point would strand the
    // gate: the token would be consumed and the decision unrepeatable.
    let carryWrites: Array<{ name: string; value: unknown; provenance: CarryProvenance }> = [];
    let reviseTotal = 0;
    let reviseGateRounds = 0;
    if (decision === "revise") {
      reviseGateRounds = state.iterations ?? 0;
      reviseTotal = (scope.parent ? scope.parent.state.sub?.rounds ?? 0 : run.rounds ?? 0) + 1;
      const flowLimit = scope.flow.max_rounds;
      const gateLimit = step.gate.max_rounds;
      if (target === null || flowLimit === undefined || reviseTotal > flowLimit || (gateLimit !== undefined && reviseGateRounds + 1 > gateLimit)) {
        // Rounds exhaustion terminalises the run deliberately; it is the one preflight
        // outcome that mutates, and nothing runs after it.
        delete state.gateToken;
        this.event(run, "gate_resolved", stepId, { decision, target });
        return scope.parent
          ? this.failScope(run, validated.value, validated.contracts, scope, "gate revision rounds exhausted")
          : this.terminalFailure(run, { attempt: 0, reason: "gate revision rounds exhausted" });
      }
      // Resolves every declared expression against the UN-RESET scope. Throws
      // `carry_revise_unresolved` before any mutation if one has no value.
      carryWrites = this.resolveCarryOnRevise(scope, step.id, gateToken);
    }
    // ---- END PREFLIGHT; EVERYTHING BELOW MUTATES ----------------------------

    delete state.gateToken;
    this.event(run, "gate_resolved", stepId, { decision, target });
    if (decision === "kill") {
      state.status = "succeeded";
      if (target === null) {
        const reason = `gate ${stepId} killed flow`;
        return scope.parent
          ? this.failScope(run, validated.value, validated.contracts, scope, reason)
          : this.terminalFailure(run, { attempt: 0, reason });
      }
    } else if (decision === "revise") {
      if (scope.parent) scope.parent.state.sub!.rounds = reviseTotal;
      else run.rounds = reviseTotal;
      const carryStore = this.carryScope(run, validated.value, scope).carry;
      for (const write of carryWrites) {
        const provenance: CarryProvenance = { ...write.provenance, round: reviseTotal };
        carryStore![write.name] = { value: write.value, provenance };
        this.event(run, "carry_updated", step.id, { name: write.name, reason: "revise", provenance });
      }
      this.resetFrom(run, scope, target!);
      // The target's descendants include this gate; retain its local revision counter.
      scope.steps[step.id]!.iterations = reviseGateRounds + 1;
      await this.persist(run);
      return this.advance(run, validated.value, validated.contracts, scope);
    } else {
      state.status = "succeeded";
    }
    // ... lines 958-971 unchanged ...
  }
```

Two behavioural notes for a reviewer:

- **Rounds exhaustion keeps its current semantics.** It consumes the token and emits
  `gate_resolved` exactly as before, then terminalises. It is the one preflight branch that
  mutates, and nothing runs after it, so it cannot strand anything.
- **`target!` is safe in the revise arm** because the preflight already returned when
  `target === null`. Prefer a local `const reviseTarget = target;` narrowed inside the preflight
  if the non-null assertion is unwelcome in review.
- **`carryStore!` is safe** because `carryWrites` is non-empty only when `scope.flow.carry` is
  defined, which is exactly the condition under which `carryScope` populates it (R2-1). Guard with
  `if (carryWrites.length > 0)` around the block if the assertion is unwelcome.

Three properties this ordering buys:

1. **One persistence boundary.** The rounds bump, the carry writes, the reset and the gate
   iteration restore all land in the single `persist` at the end of the arm. There is no window
   in which a persisted run has a new carry value and an unreset fanout, or the reverse.
2. **`resetFrom` never touches carry.** It is per-step (`engine.ts:2261-2284`) and reads `run`
   only to append an event (`:2252`) and a receipt (`:2253-2259`). `run.rounds`,
   `run.generationCounter` and now `run.carry` all survive it with no code change.
3. **A revise that resets the initial's source self-heals.** The write stamps that source's
   pre-reset epoch; `resetFrom` then bumps it; the next `advance` sees the mismatch and
   re-materialises when the source succeeds again. Intended (D7).

### S03-8 Tests for S03

New file `ts/tests/engine/carry.test.ts`. Harness copied from `ts/tests/engine/p4.test.ts:20-27`
(`mkdtemp` → `new StratumEngine({ stateRoot, evaluator: createEvaluator(), connector })` →
`tokenEchoingEngine`) with the `afterEach` cleanup of `p4.test.ts:18`. Gate-token reads use the
store-load pattern of `ts/tests/engine/fencing.test.ts:259-260`; `waitFor(engine, runId, predicate)`
is used at `fencing.test.ts:258` and `:264`.

| Test | Asserts |
|---|---|
| T-S03-1 `materialises the initial value when its source succeeds` | after `stepDone("plan", …)`, `(await store.load(runId)).carry?.wave` has `value` equal to the planned list and `provenance` `{ kind: "initial", sourceStep: "plan", sourceEpoch: 0 }`; a `carry_updated` event with `detail.reason === "initial"` is in the spine |
| T-S03-2 `re-fans over the same list when a gate declares nothing` | the merge-gate revise leaves `run.carry.wave.value` deep-equal and `provenance.kind` still `"initial"`; the fanout re-enumerates the same number of items |
| T-S03-3 `rewrites the list at a gate that declares on_revise` | after the assess-gate revise, `provenance` is `{ kind: "revise", sourceStep: "plan", sourceEpoch: 0, gate: "assess_gate", gateToken: <the consumed token>, round: 1 }` and `value` equals `assess.output.tasks` |
| T-S03-4 `does not re-materialise over a revise write` | drive a further `advance` (another `stepDone`) and assert the revise-written value is still present — the epoch guard held |
| T-S03-5a `a dispatched do-sourced initial is visible in the same advance` (R2-1) | the FABLE-ASTRA shape itself: `stepDone("plan", …)` returns `ready` with the `execute` descriptors and the fanout step has **no** recorded attempt. Fails whenever the hook writes to a carry object the live scope does not share |
| T-S03-5b `an input-sourced initial is visible on the first advance` (R2-1) | a flow whose `initial` is `${input.tasks}` and whose first step is the `${wave}` fanout with no `after`: `plan(spec, { tasks: [...] })` returns `ready` with the descriptors. The strictest scope-aliasing case — the scope is built by the default parameter before `run.carry` exists |
| T-S03-5 `a set-sourced initial is visible to the very next step in the same pass` (R1-2) | a flow whose `initial` is `${seed.output.tasks}` with `seed` a `set:` step immediately followed by a `${wave}` fanout: `plan` returns `ready` with the fanout descriptors and **no** failed attempt on the fanout step. Fails without call site 2 of S03-5 |
| T-S03-6 `an evaluate-sourced initial is visible to the very next step in the same pass` (R1-2) | same shape with an `evaluate:` source and a stub `evaluateRunner` |
| T-S03-7 `refuses a revise whose declared expression has no value, without consuming the gate` (R1-6, R2-8) | `engine.audit` reads **disk**, deliberately bypassing the in-memory pin (`engine.ts:814-818`), so it cannot prove the live object is intact. The black-box proof is the retry: with a slow engine fanout holding the run pinned in `activeRuns`, `gateResolve(revise)` rejects with `/carry_revise_unresolved/`; then the **same** `gateToken` is replayed once the source output exists and **succeeds**. What the retry detects is **token consumption**: `delete state.gateToken` (`engine.ts:927`) is what makes a replayed token stale, so a successful retry proves the failed attempt never reached line 927. Set `max_rounds: 1` so a silently double-counted round would exhaust the budget and fail the retry. An **appended event** is invisible to the retry, so it needs its own check: assert afterwards that `run.rounds === 1` and that the spine holds exactly one `gate_resolved` and one `carry_updated`. The three assertions cover the three mutations the preflight must not have made |
| T-S03-8 `fails the run when an initial resolves to nothing, with no partial write` (R1-3, R2-5) | **two** declarations on one source, the second unresolvable. Assert: `run.status === "failed"`, `run.failure.reason` matches `/carry_initial_unresolved/`, and **neither** variable has an entry and **no** `carry_updated` event exists — checked on the live pinned run *and* on the durable record, because staging is the only thing preventing the first write |
| T-S03-8c `an inherited name is not a gate declaration` (R2-3, R3-3) | a flow whose revise gate step id is `toString`, and a carry declared with `on_revise: {}` (empty). Resolving that gate with `revise` must leave `run.carry` byte-identical and emit **no** `carry_updated`: `Object.hasOwn(onRevise, "toString")` is `false`, whereas `onRevise["toString"]` would return `Object.prototype.toString` and `carryReference` would then throw on a function. Complements T-S03-8b, which covers the carry-name side of the same hazard |
| T-S03-8b `a carry variable named toString works end to end` (R2-3) | declare `carry: { toString: { initial: "${plan.output.tasks}" } }` and fan out over `${toString}`: materialisation writes it, `resolve` returns the list (not `Object.prototype.toString`), the run completes, and a reload from disk still resolves it — the reloaded map is a plain object, so `Object.hasOwn` is what carries this |
| T-S03-9 `names the missing variable when a carry is unmaterialised at resolve time` | a hand-built run with `carry` deleted from the record: the next fanout activation surfaces `/carry variable "wave" is not materialised/` rather than the generic array message |
| T-S03-10 `carry survives a fresh engine over the same state root` | rehydrate pattern of `ts/tests/engine/flow_bg_rehydrate.test.ts:14-22`: a second `StratumEngine` on the same `stateRoot` resolves the next gate and the re-fan uses the carried list |
| T-S03-11 `checkpoint revert restores the older carry beside the older outputs` | `commit(runId, "wave1")`, revise to rewrite `wave`, `revert(runId, "wave1")`; `run.carry.wave.value` is the wave-1 list and `run.steps` are the wave-1 states |
| T-S03-12 `a carry reference adds no reset edge` | after a revise targeting `execute`, the `step_reset` detail (`engine.ts:2245-2251`) lists `execute…assess` and **not** `plan`. Its step-id set is the value T-S01-14 compares the validator's `resetClosure` against |

---

## 6. Slice S04 — Surfaces: descriptor, audit, contracts, counters

### S04-1 `ts/src/engine/engine.ts` (edit) — descriptor `item` (D11)

Type change per §2.6 at `engine.ts:161`. The value change is one line in
`consumerDescriptor` (`engine.ts:2315-2349`). Existing code at `:2336-2339`:

```ts
      stage: item.stage,
      isFinalStage: item.stage === step.fanout.steps.length - 1,
      itemIndex: item.index,
      generation: item.generation,
```

becomes

```ts
      stage: item.stage,
      isFinalStage: item.stage === step.fanout.steps.length - 1,
      itemIndex: item.index,
      item: values[item.index],
      generation: item.generation,
```

`values` is already in hand from `this.resolveFanoutOver(step.fanout.over, run)` at
`engine.ts:2321`, with the `Array.isArray` guard at `:2322`.

**The invariant that makes computing safe, and which T-S04-1 pins:** the carried list changes at
exactly two moments — an `initial` materialisation, which happens when the source step succeeds
and therefore before any step that references the variable can activate (D1's static ancestor
rule guarantees this), and an `on_revise` write, which happens inside `gateResolveLocked` at a
gate that by construction runs after the fanout settled, and whose very next act is `resetFrom`
on the fanout. So no in-flight item ever observes a rewritten list, and re-resolving `over` at
descriptor time always yields the same element for the same `(fanoutEpoch, index)` pair. The
value is durable through `run.carry` (or the source step's output) either way, so nothing is lost
by not persisting it.

### S04-2 `ts/contracts/mcp-surface.json` (edit) — five descriptor blocks

Per §2.6: insert `"item": "any",` after `"itemIndex": "number",` at lines **135**, **257**,
**428**, **543**, **692** (later line numbers shift by one per prior insert — edit bottom-up, or
match on the three-line context in §2.6, which is identical in all five). Bump `"surface"` at
`mcp-surface.json:2` from `17` to `18`.

### S04-3 `ts/src/engine/engine.ts` (edit) — `AuditTrail` and `audit()` (D10)

Type change per §2.7 at `engine.ts:236-237`. The return at `engine.ts:818-819`, existing:

```ts
    const run = await this.store.load(runId);
    return { runId, status: run.status, events: structuredClone(run.events), steps: structuredClone(run.steps), flowSpent: structuredClone(run.flowSpent), ...(run.output !== undefined ? { output: structuredClone(run.output) } : {}) };
```

gains one spread, mirroring how `output` is handled:

```ts
    const run = await this.store.load(runId);
    return { runId, status: run.status, events: structuredClone(run.events), steps: structuredClone(run.steps), flowSpent: structuredClone(run.flowSpent), ...(run.output !== undefined ? { output: structuredClone(run.output) } : {}), ...(run.carry !== undefined ? { carry: structuredClone(run.carry) } : {}) };
```

The durable read is deliberate and unchanged — `audit` bypasses the in-memory pin
(`engine.ts:815-818`), so it reports only committed carry, which is what a consumer polling for a
merge gate needs.

### S04-4 `ts/src/mcp/server.ts` (edit) — `auditResponse` whitelist

Existing, `ts/src/mcp/server.ts:424-426`:

```ts
function auditResponse(audit: AuditTrail): Record<string, unknown> {
  return { status: audit.status, runId: audit.runId, events: audit.events, steps: audit.steps, flowSpent: audit.flowSpent, ...(audit.output !== undefined ? { output: audit.output } : {}) };
}
```

gains `...(audit.carry !== undefined ? { carry: audit.carry } : {})` in the same position as the
`output` spread. Without this the field is dropped silently at the MCP boundary — the whitelist
is a second gate after `AuditTrail`, which is C12's whole point.

### S04-5 `ts/contracts/mcp-surface.json` (edit) — four audit variants

Per §2.7: `"carry?": "object"` added to `running` (`:621-627`), `completed` (`:628-634`),
`failed` (`:635-641`) and `budget_exhausted` (`:642-648`).

### S04-6 Counter and pin updates

| File:line | From | To |
|---|---|---|
| `ts/contracts/mcp-surface.json:2` | `"surface": 17` | `18` |
| `ts/contracts/events.json:2` | `"events": 2` | `3` (done in S02-3) |
| `ts/tests/mcp/schema-grammar.test.ts:88` | `expect(surface.surface).toBe(17)` | `18` |
| `ts/tests/mcp/contracts-grammar.test.ts:83` | `expect(surface.surface).toBe(17)` | `18` — C8, missed by both explorers |
| `ts/tests/mcp/contracts-grammar.test.ts:105` | `expect((await eventContract()).events).toBe(2)` | `3` — R1-9, a second events pin neither explorer nor the verifier's first pass caught |
| `ts/tests/mcp/contracts-grammar.test.ts:104` | test title `"freezes events 2 and validates every newly declared event shape strictly"` | `"freezes events 3 …"` — the title states the frozen value and must move with it |
| `ts/tests/engine/p4.test.ts:981` | `expect(eventsContract.events).toBe(2)` | `3` |
| `ts/tests/engine/p4.test.ts:982` | `expect(surface.surface).toBe(17)` | `18` |
| `ts/tests/engine/p4.test.ts:983` | `expect(Object.keys(surface.tools)).toHaveLength(24)` | unchanged — no new tool |

### S04-7 `ts/tests/engine/p4.test.ts` (edit) — event vocabulary

The vocabulary assertion is bidirectional (`p4.test.ts:1163`):

```ts
    expect([...observedKinds].sort()).toEqual(Object.keys(eventsContract.kinds).sort());
```

so a declared-but-unemitted kind fails the suite. Use the existing escape hatch:
`declaredAheadOfEmission` at `p4.test.ts:1135-1144`, whose current contents are two literal
events. Append a third:

```ts
      {
        at: "2026-09-09T00:00:00.000Z", type: "carry_updated", stepId: "assess_gate",
        detail: {
          name: "wave", reason: "revise",
          provenance: { kind: "revise", sourceStep: "plan", sourceEpoch: 0, gate: "assess_gate", gateToken: "t-1", round: 1, at: "2026-09-09T00:00:00.000Z" },
        },
      },
```

and update the comment above it (`p4.test.ts:1133-1134`) to name the third kind. `carry_updated`
is genuinely emitted by `ts/tests/engine/carry.test.ts`, but that suite does not feed
`allEvents` here, so the literal keeps `p4.test.ts` self-contained the way the existing two do.

### S04-8 Tests for S04

| Test | File | Asserts |
|---|---|---|
| T-S04-1 `consumer descriptor carries the resolved item` | `ts/tests/mcp/p5.test.ts` (edit, the consumer test at `:296-320`) | extend the `toMatchObject` at `:312` with `item: "a"` for `over: "${input.items}"` with `items: ["a"]`. `toMatchObject` tolerates extra keys, so the JSON contract is the load-bearing half |
| T-S04-2 `a descriptor without item matches zero variants` | `ts/tests/mcp/p5.test.ts` (edit) | the negative already exists at `:313-315` (`ready: [{ id: "bare" }]` rejects with `/oneOf variants matched/`); add the mirror — a full consumer descriptor with `item` deleted also rejects, proving the field is required, not merely tolerated |
| T-S04-3 `audit exposes carry through the real MCP surface` (R1-10) | `ts/tests/mcp/p5.test.ts` (edit) | `auditResponse` is **private** to `ts/src/mcp/server.ts:424` and cannot be called from a test. Drive the assertion through an in-memory server instead: `connected({ engine })` (`ts/tests/mcp/p5.test.ts:40`), then `client.callTool({ name: "stratum_audit", arguments: { runId } })`. The transport already runs `assertToolResponse` (`server.ts:294`), so a missing contract edit fails here rather than silently passing. Assert the returned `carry.wave.provenance.gate === "assess_gate"` |
| T-S04-4 `every stratum_audit variant declares carry` (R1-10) | `ts/tests/mcp/contracts-grammar.test.ts` (edit) | `it.each(["running", "completed", "failed", "budget_exhausted"])` over the four variants: `assertShape({ runId: "r", events: [], steps: {}, flowSpent: {}, carry: { wave: { value: [], provenance: { kind: "initial", at: "t" } } } }, surface.tools.stratum_audit.responses[variant], …)` resolves. A table test, so a variant missed in the JSON cannot hide behind the three that were edited |
| T-S04-5 `an input-sourced carry_updated carries no stepId` (R1-7, R2-8) | `ts/tests/mcp/p5.test.ts` (edit) | a separate flow whose `initial` is `${input.tasks}`, driven through `connected({ engine })` and `stratum_audit`. The transport runs `assertEvent` on every returned event (`ts/src/mcp/server.ts:294`), so the `"stepId?"` optionality is proved by the real validator: assert the `carry_updated` event has `reason: "initial"` and **no** `stepId` key at all |
| T-S04-6 `item reaches the consumer through every ready-bearing tool` | `ts/tests/mcp/p5.test.ts` (edit) | one `assertToolResponse` per tool that can return a consumer `ready` — `stratum_plan`, `stratum_resume`, `stratum_gate_resolve` are already exercised in this file; add `stratum_step_done` and `stratum_revert` as literal shape assertions if a live path is not available |

---

## 7. Golden-flow test design

One scenario, in `ts/tests/engine/carry.test.ts`, run against the **real** engine with a temp
state root. It is the COMP-FABLE-ASTRA loop in miniature and is the single test that would catch
a regression in any of the four slices.

### 7.1 The spec under test

```ts
const astraFlow = {
  version: 1,
  contracts: {
    TaskGraph: { tasks: "Task[]" },
    Task: { id: "string", tier: "critical|standard|fast" },
    TaskResult: { value: "string" },
    VerifyResult: { tests_pass: "boolean" },
    WaveDecision: { action: "repair|complete", tasks: "Task[]" },
  },
  flows: { entry: "main", main: {
    input: { goal: "string" },
    output: { from: "${assess.output}", contract: "WaveDecision" },
    max_rounds: 4,
    carry: {
      wave: {
        initial: "${plan.output.tasks}",
        on_revise: { assess_gate: "${assess.output.tasks}" },
      },
    },
    steps: [
      { id: "plan", do: "Plan ${input.goal}", out: "TaskGraph" },
      { id: "execute", after: ["plan"], fanout: {
        over: "${wave}", dispatch: "consumer", concurrency: 1, isolation: "none",
        require: "all", merge: "sequential", steps: [{ do: "do ${item}", out: "TaskResult" }],
      } },
      { id: "execute_merge", after: ["execute"], gate: { on_approve: "verify", on_revise: "execute", on_kill: null } },
      { id: "verify", do: "verify", out: "VerifyResult" },
      { id: "assess", after: ["verify"], do: "assess", out: "WaveDecision" },
      { id: "assess_gate", after: ["assess"], gate: { on_approve: null, on_revise: "execute", on_kill: null } },
    ],
  } },
};
```

Notes an implementer must not "simplify" away:

- `after: ["plan"]` on `execute` is **required** by D1's static rule (C2). Removing it is
  T-S01's `carry referenced before its initial source` fixture, not a valid flow.
- `after: ["execute"]` on `execute_merge` is required by `CONSUMER_WORKTREE_GATE_REQUIRED`
  whenever `isolation: "worktree"` (C4). The golden flow uses `isolation: "none"` to keep the
  test off real git worktrees — the same rule is exercised by the S01 fixtures instead.
- `assess_gate.on_revise` targets `execute`, and `execute` is the only step that reads `${wave}`,
  so the R1-1 rules hold: the target is non-null, `execute` is inside its reset closure, and
  `execute → execute_merge → verify → assess → assess_gate` orders the gate after the consumer by
  dependency edges alone.
- `verify` and `assess` route from `execute_merge.on_approve` and an `after` edge respectively,
  so `adjacency` contains `plan → execute → execute_merge → verify → assess → assess_gate`, which
  is what makes both `on_revise: "execute"` targets legal ancestors (`GATE_REVISE_NOT_ANCESTOR`,
  `ts/src/ir/validate.ts:490`).

### 7.2 The scenario, step by step

Helpers: `engine()` from `p4.test.ts:20-27`; `waitFor(engine, runId, predicate)` as used in
`fencing.test.ts:258` and `:264`; `waitForTerminal` from `p4.test.ts:41-50` for the final leg;
`tokenEchoingEngine` (`ts/tests/helpers/token_echoing_engine.ts:40-73`) for gate resolution, with
raw store-read tokens (`fencing.test.ts:259-262`) wherever the assertion is about the token
itself. `StateStore` is imported directly so every persistence claim reads the file, not the
in-memory object.

1. **Plan, and first materialisation.** `plan(astraFlow, { goal: "g" })`, then
   `stepDone("plan", { output: { tasks: [{ id: "t1", tier: "standard" }, { id: "t2", tier: "fast" }] } })`.
   Assert on a fresh `store.load(runId)`: `carry.wave.value` is that two-element array;
   `carry.wave.provenance` is `{ kind: "initial", sourceStep: "plan", sourceEpoch: 0, at: <iso> }`.
2. **First fan-out materialises from carry.** Assert the response is `ready` with two consumer
   descriptors, `id` `execute/0` and `execute/1`, and `item` equal to the two task objects in
   order. This is the D11 assertion and the D7 ordering assertion in one: if `materialiseCarry`
   ran after `advanceScopeLoop`, this step fails with a burned attempt instead.
3. **Merge-gate revise re-fans over the SAME list.** Settle both items, wait for
   `execute_merge` to reach `waiting_gate`, read its token from the store, `gateResolve(revise)`.
   Assert: `carry.wave.value` is **deep-equal** to the step-1 array and
   `carry.wave.provenance.kind` is still `"initial"` (the gate declared nothing);
   the new descriptors' `item` values are deep-equal to the step-2 ones; `run.rounds === 1`.
4. **Approve through to assess.** Settle the two items again, approve `execute_merge`, settle
   `verify` and `assess` with
   `{ output: { action: "repair", tasks: [{ id: "t3", tier: "critical" }] } }`.
5. **Assess-gate revise rewrites the wave.** Read `assess_gate`'s token from the store,
   `gateResolve(revise)`. Assert, on a fresh `store.load`:
   - `carry.wave.value` is the one-element `t3` array;
   - `carry.wave.provenance` is
     `{ kind: "revise", sourceStep: "plan", sourceEpoch: 0, gate: "assess_gate", gateToken: <the token just consumed>, round: 2, at: <iso> }`;
   - the `step_reset` event's `detail.reset` names `execute`, `execute_merge`, `verify` and
     `assess` and **not** `plan` (T-S03-9: the `${wave}` reference created no dependency edge);
   - a `carry_updated` event with `stepId: "assess_gate"` and `detail.reason: "revise"` sits
     between `gate_resolved` and `step_reset` in the spine.
6. **Re-fan over the NEW list.** Assert exactly one ready descriptor, `id` `execute/0`, with
   `item` deep-equal to `{ id: "t3", tier: "critical" }`. This is the compose D6 requirement
   (per-item tier) reaching a consumer.
7. **Fresh engine over the same state root still sees carry.** Build a second `StratumEngine`
   on the same `stateRoot` (pattern: `flow_bg_rehydrate.test.ts:14-22`), settle the `t3` item on
   it, approve `execute_merge`, and assert the run advances rather than failing to resolve
   `${wave}`. No `parse` or migration step exists to teach (C18).
8. **Checkpoint commit and revert restore the older carry alongside the older outputs.**
   Between steps 4 and 5, `commit(runId, "wave1")`. After step 6, `revert(runId, "wave1")` and
   assert both halves move together: `carry.wave.value` is the two-element wave-1 array with
   `provenance.kind === "initial"`, **and** `steps.assess.output` is the wave-1 assess output.
   A revert that restored one without the other is the exact desync D6 exists to prevent.
9. **Audit exposes carry with provenance.** `await engine.audit(runId)` returns `carry` with the
   same entry. The wire half of this claim is **not** asserted here — `auditResponse` is private
   (`ts/src/mcp/server.ts:424`) — it is T-S04-3, which drives the same run through an in-memory
   MCP server, and T-S04-4, which table-tests all four `stratum_audit` variants (R1-10).

### 7.3 What the golden flow does not cover

Failure paths get their own targeted tests (T-S03-5, T-S03-6) rather than branches inside this
scenario. Worktree isolation, real merges and background flows are untouched by this feature and
are already covered by `p4.test.ts` and `flow_bg.test.ts`.

---

## 8. Invariants a reviewer should check

1. **No new edge.** `referenceEdges` (`ts/src/ir/refs.ts:82-86`), `dependencyIds`
   (`ts/src/ir/validate.ts:247-255`) and `dependencies` (`ts/src/engine/engine.ts:2296-2302`) all
   still filter `kind === "step"` and are unmodified. If any grows a carry arm, the
   `ROUTING_CYCLE` this feature exists to avoid comes straight back (C5).
2. **One persistence boundary per transaction.** The revise arm still has exactly one
   `persist` (`engine.ts:953` before the edit); `materialiseCarry`'s persist is a separate,
   conditional, at-most-once-per-epoch write in `advance`.
3. **Carry is never written from a subflow.** `childScope` has no `carry`; `CARRY_ROOT_ONLY`
   rejects the declaration; `resolveCarryOnRevise` returns `[]` for a child flow.
4. **The gate token in provenance is a consumed token.** `engine.ts:927` deletes it before the
   revise branch; the parameter is only a record of which round authorised the write.
5. **`revisionDigest` is untouched.** It digests the effective spec only (`engine.ts:421`,
   `:798-802`); neither `run.carry` nor the descriptor's `item` enters it, so fencing and resume
   comparisons are unchanged.
6. **The revise decision is unrepeatable only after it has succeeded.** Nothing in
   `gateResolveLocked` mutates before every carry expression has resolved (R1-6). Check that no
   later edit reintroduces a throw after `delete state.gateToken`.
7. **Carry never reaches the `expr` language.** `ts/src/eval/expr.ts` is unmodified; the
   `CARRY_REF_IN_EXPRESSION` rule and the `expression` leaf tag are the only things keeping it
   that way (R1-5).
8. **Three collector pairs must stay in step, not two.** `referencesInStep`/`stringLeaves` (C5),
   and now the validator's `resetClosure` against `engine.resetFrom`'s descendant walk
   (`engine.ts:2226-2244`, R1-1b). T-S01-13 and T-S01-14 are the pins.
9. **One carry object, not two.** `carryScope` is the only place `run.carry` is created, and it
   assigns the same reference onto the active root scope. A `rootScope(...)` built independently
   inside a hook is the R2-1 bug; check that no edit reintroduces one.
10. **Every carry lookup is an own-property check.** `Object.hasOwn` in `resolve`,
   `materialiseCarry` and `resolveCarryOnRevise`, and `Object.create(null)` for the runtime map. A
   persisted run reloads as a plain object (`state.ts:252-256`), so the own-property check, not the
   prototype, is what holds (R2-3).
11. **`materialiseCarry` never throws and never writes partially.** It stages, then applies, and
   returns a result its callers turn into a `failScope` transition. `advanceScopeLoop`
   (`engine.ts:1159`) has no catch (R2-5).
12. **Old runs still load.** `carry?` is optional and `StateStore.load`
   (`ts/src/engine/state.ts:252-256`) does no schema check. The one-way break is a *spec* with a
   `carry` block loaded by a pre-0.5.0 engine (C18).

---

## 9. File Plan

| File | Action | Purpose |
|---|---|---|
| `ts/src/ir/refs.ts` | edit | `Reference` union member; carry parse branch in `parseReference` |
| `ts/src/ir/schema.ts` | edit | `CarryVariableSchema`, `CarrySchema`, `FlowSchema.carry` |
| `ts/src/ir/validate.ts` | edit | `type Reference` on the `refs.js` import (R1-9); the shared `referenceTypeError` helper; dependency-only reachability; the exported `resetClosure(flow, target)` mirror of `engine.resetFrom`'s descendant walk (R2-7); the routed-target set (R2-2); the carry-block pass; the carry arm in the reference loop; `FANOUT_OVER_SINGLE_REF`; `referencesInStep` gains an `expression` tag plus `iterate.until` and both `ensure[].expr` fields (R2-4), and is exported as a test seam |
| `ts/src/engine/state.ts` | edit | `CarryProvenance`, `CarryEntry`, `PersistedRun.carry`, `CheckpointSnapshot`, `carry_updated` in the event union |
| `ts/src/engine/checkpoint.ts` | edit | `"carry"` in `CHECKPOINT_FIELDS` |
| `ts/src/engine/engine.ts` | edit | `CarryEntry`/`CarryProvenance` on the `state.js` import (R1-9); `ExecutionScope.carry`; `rootScope`; `resolve` arm; `carryReference`; `carryScope` (R2-1); `materialiseCarry`, staged and non-throwing (R2-5), plus its three call sites (advance, set settle, evaluate settle); `resolveCarryOnRevise`; the reordered `gateResolveLocked`; `stringLeaves` gains an `expression` tag and the same three fields (R2-4) and is exported; `dependencies` destructures the new leaf shape; descriptor `item`; `AuditTrail.carry`; `audit()` |
| `ts/src/mcp/server.ts` | edit | `auditResponse` carries `carry` |
| `ts/contracts/events.json` | edit | `carry_updated` kind; counter 2 → 3 |
| `ts/contracts/mcp-surface.json` | edit | `"item": "any"` ×5; `"carry?": "object"` ×4; `surface` 17 → 18 |
| `ts/package.json` | edit | `0.4.6` → `0.5.0` (`:3`) |
| `ts/server.json` | edit | `0.4.6` → `0.5.0` at **both** `:10` (server version) and `:15` (npm package version) — R1-9 |
| `CHANGELOG.md` | edit | same commit as the code |
| `README.md` | edit | `carry` in the flow field table, the reference table and a new subsection |
| `ts/tests/ir/refs.test.ts` | edit | carry parse, no-edge, mirror invariant |
| `ts/tests/ir/fixtures.ts` | edit | one valid carry fixture, twenty-two invalid ones |
| `ts/tests/ir/collectors.test.ts` | new | collector mirror through the production `referencesInStep`/`stringLeaves`; reset-closure mirror (R1-10) |
| `ts/tests/engine/carry.test.ts` | new | the golden flow plus the nine S03 behaviours |
| `ts/tests/engine/flowctl.test.ts` | edit | 25-name classification list; carry in the round-trip fixture |
| `ts/tests/engine/p4.test.ts` | edit | counters at `:981`/`:982`; `declaredAheadOfEmission` sample |
| `ts/tests/mcp/p5.test.ts` | edit | descriptor `item` over MCP; the required-field negative |
| `ts/tests/mcp/schema-grammar.test.ts` | edit | surface pin 17 → 18 |
| `ts/tests/mcp/contracts-grammar.test.ts` | edit | surface pin 17 → 18 (C8); events pin 2 → 3 and its test title at `:104-105` (R1-9); the four-variant `stratum_audit` carry table test |

Not touched, and deliberately so: `ts/src/speckit/compiler.ts`, `ts/src/migrate/check.ts`,
`ts/src/eval/expr.ts`, `ts/src/cli/query_gate.ts`, `ts/parity/*.v1.yaml` (C20, D13).

---

## 10. Boundary Map

Slice ids map to the sections above: S01 = §3, S02 = §4, S03 = §5, S04 = §6.

### S01: IR grammar, reference kind and validation
Produces:
  ts/src/ir/refs.ts → Reference (type)
  ts/src/ir/refs.ts → parseReference (function)
  ts/src/ir/schema.ts → CarryVariableSchema, CarrySchema, FlowSchema (const)
  ts/src/ir/validate.ts → validateSpec, referencesInStep, resetClosure (function)

Consumes: nothing (leaf node)

### S02: persisted state, checkpoint classification and event vocabulary
Produces:
  ts/src/engine/state.ts → CarryProvenance, CarryEntry, PersistedRun, AuditEvent (interface)
  ts/src/engine/state.ts → CheckpointSnapshot (type)
  ts/src/engine/checkpoint.ts → CHECKPOINT_FIELDS (const)

Consumes: nothing (leaf node)

### S03: runtime scope, resolution, materialisation and the revise transaction
Produces:
  ts/src/engine/engine.ts → materialiseCarry, resolveCarryOnRevise, carryReference, carryScope, stringLeaves (function)

Consumes:
  from S01: ts/src/ir/refs.ts → Reference, parseReference
  from S01: ts/src/ir/schema.ts → FlowSchema
  from S01: ts/src/ir/validate.ts → referencesInStep, resetClosure
  from S02: ts/src/engine/state.ts → CarryProvenance, CarryEntry, PersistedRun

### S04: consumer descriptor, audit and the frozen contracts
Produces:
  ts/src/engine/engine.ts → ConsumerDispatchDescriptor, AuditTrail (interface)
  ts/src/mcp/server.ts → auditResponse (function)

Consumes:
  from S02: ts/src/engine/state.ts → CarryEntry
  from S03: ts/src/engine/engine.ts → materialiseCarry

`ConsumerDispatchDescriptor` and `AuditTrail` are declared in `ts/src/engine/engine.ts` and are
therefore produced by S04 from the same file S03 produces functions in; the slices touch disjoint
regions of it (S03: `advance` at `:1095` and `gateResolveLocked` at `:906`; S04: the interfaces at
`:156-171` / `:230-237`, `audit()` at `:814` and `consumerDescriptor` at `:2315`). Wire formats
(`ts/contracts/*.json`), event payload shapes, the eight validation error codes and the six
invariants of §8 are prose in this blueprint, not Boundary Map entries — they are not
grep-checkable identifiers.

---

## 11. Versioning and docs

**`ts/package.json:3`: `"version": "0.4.6"` → `"0.5.0"`, and `ts/server.json` at both `:10`
(the server version) and `:15` (the npm package version inside `packages[0]`)** (D12, R1-9). The
MCP registry rejects a listing whose declared version disagrees with the published tarball, so the
two `server.json` fields move together with `package.json`. A minor, not a patch: the MCP
surface counter moves 17 → 18, the events contract moves 2 → 3, and a spec carrying a `carry`
block cannot be loaded by an older engine (C18). **Do not publish.** Per the standing version
rule, compose takes its own minor bump when it adopts the surface; that is a compose-side change
and is not part of this ticket.

**`CHANGELOG.md`** — the `## Unreleased` section currently opens with "Two tickets filed as
prerequisites for compose COMP-FABLE-ASTRA" and lists STRAT-LOOP-CARRY as PLANNED. Replace that
bullet with a shipped entry and add a version heading:

```markdown
## [0.5.0] — <date>

### STRAT-LOOP-CARRY: loop-carried flow values

A flow may declare a `carry:` block. Each variable has an `initial` reference, materialised when
its source step succeeds, and optional per-gate `on_revise` references. `${name}` is a flow-value
reference: legal wherever a step-output reference is, and it creates no dependency edge, so a
fanout can re-fan over a re-planned list without a routing cycle. On a revise the engine resolves
the declared reference against the un-reset scope, writes the new value with its provenance
(gate, consumed gate token, source epoch, round) into the run record, then resets and persists
once. A gate that declares nothing leaves the value unchanged, so a merge retry re-fans over the
same list. Carry is root-flow only, is snapshotted with checkpoints, and is exposed by
`stratum_audit`.

Consumer fanout descriptors now carry `item`, the resolved fanout element, beside `itemIndex`.

Carry references are legal only on rendered template fields (`do`, `with`, `evaluate.in`,
`fanout.over`, a fanout stage's `do`), never in the expression language of `when`, `set` or a
stage `when`, `iterate.until` or an `ensure` expression. A carry path may not begin with the exact
segment `output` (`${wave.outputs}` is still a carry reference). A gate that rewrites a carry
variable must have a revise target whose reset closure covers every step that reads it, and must
itself be ordered after those steps.

New validation codes: `CARRY_ROOT_ONLY`, `CARRY_NAME_CONFLICT`, `CARRY_REF_INVALID`,
`CARRY_UNKNOWN_GATE`, `REF_UNKNOWN_CARRY`, `CARRY_REF_BEFORE_INITIAL`,
`CARRY_INITIAL_SOURCE_CONDITIONAL` (the `initial` source may not carry a `when`, be a gate, or be a
routing target), `CARRY_REF_IN_EXPRESSION`, `CARRY_PATH_RESERVED`,
`CARRY_REVISE_TARGET_NULL`, `CARRY_REVISE_MISSES_CONSUMER`,
`CARRY_REVISE_GATE_NOT_AFTER_CONSUMER`, `FANOUT_OVER_SINGLE_REF` (the last lifts the previously
runtime-only `fanout.over` single-reference rule into validation).

New event kind `carry_updated`. MCP surface 17 → 18; events contract 2 → 3. A spec containing a
`carry` block cannot be loaded by an engine older than 0.5.0. Compose must take its own minor
bump when it adopts the surface.
```

**Where the spec grammar is documented.** `grep -rn "max_rounds" docs/ README.md` returns design
docs and one live reference: **`README.md`**. `grep -rln fanout docs/*.md README.md` returns
`README.md` only. There is no separate grammar reference under `docs/`. `SPEC.md` at the repo root
is a 2026-02-23 `1.0.0-draft` language spec that predates the TS v1 grammar entirely — it mentions
neither `fanout` nor `max_rounds` — so it is **not** a live grammar reference and takes no `carry`
edit. The authoritative, user-facing grammar is `README.md`. Three edits there:

| README location | Edit |
|---|---|
| the per-flow field table at `README.md:262-268` (rows `input`, `output`, `steps`, `budget`, `max_rounds`) | add a row: `` | `carry` | no | Named loop-carried flow values; entry flow only | `` |
| the reference table at `README.md:294-301` (rows `${input.field}` … `${prev}`) | add rows `` | `${name}` | A declared carry variable | `` and `` | `${name.field}` | Field inside a carry variable | `` |
| a new subsection after §"References" (`README.md:290-305`), before §"Migrating v0.x Specs" (`:306`) | the `carry` block: shape; the one-full-reference rule for `initial` / `on_revise`; that `on_revise` keys are gate step ids; that a carry reference creates no dependency edge and therefore needs an explicit `after` on any step that uses it; that the `initial` source must be an unconditional, non-gate, non-routed step (R2-2); that carry is legal only on rendered fields and never in the six expression fields (R2-4); that **a carry path may not begin with the exact segment `output`**, while `${wave.outputs}` is fine (R1-8, R2-6); that a gate rewriting a variable must reset every step that reads it and run after them; and that `carry` is entry-flow only |

The §"Gates" constraint list at `README.md:711-718` also gains one bullet: a revise at a gate that
declares `on_revise` for a carry variable rewrites that variable before the reset; a gate that
declares nothing leaves it unchanged.

---

## 12. Out of scope (D13)

- Persisting `item` on `FanoutItemState` (`ts/src/engine/state.ts:51-69`). Computing it at the
  descriptor is safe under the §6.1 invariant; persisting introduces a second source of truth
  that can disagree with `over`. A separate ticket if drift is ever observed.
- Carry in the `expr` grammar. `ts/src/eval/expr.ts:5,22` stay closed at
  `result|input|item|prev`; carry is not readable from `when`, `set`, `ensure` or
  `iterate.until` in v1.
- Per-subflow carry. `SubflowState.rounds` (`ts/src/engine/state.ts:146`) is the precedent if it
  is ever wanted; v1 rejects a subflow `carry` block outright (D5).
- A `carry` column on `stratum query` (`ts/src/cli/query_gate.ts:164-188`).
- Speckit emitting `carry` (`ts/src/speckit/compiler.ts:156-160`).
- A migrate guidance row (`ts/src/migrate/check.ts:30-58`).
- A dedicated carry receipt. Carry writes ride the existing event spine; `buildReceipt`
  (`ts/src/engine/receipts.ts`, called from `resetFrom` at `engine.ts:2254`) and the SmartMemory
  egress prefix match at `ts/src/learn/smartmemory_egress.ts:348` are untouched.
- Cross-provider per-item routing. `agent` remains `z.enum(["claude","codex"])`
  (`ts/src/ir/schema.ts:41,65`); that is STRAT-AGENT-INTERP-TS.

---

## 13. Open questions

1. **Provenance optionality (C16).** D6 specifies `sourceStep: string` / `sourceEpoch: number`,
   which cannot describe an `input.`-sourced `initial` that D2 legalises. This blueprint makes
   both optional. If the controller prefers to keep them required, the alternative is to forbid
   `input` refs in `initial` and narrow D2 to step references only — a one-line change to the
   `carryReference` helper in §3.4 and one fewer legal shape. The first consumer uses only step
   references either way.

   **RULING (controller, 2026-09-09):** keep both optional. An `input.`-sourced `initial` stays
   legal; provenance for it carries `kind: "initial"` with no `sourceStep`/`sourceEpoch`, and the
   re-materialisation rule treats an input-sourced entry as written once (input never re-runs).

---


## Verification Table (Phase 5, 2026-09-09)

Every `path:line` reference in the blueprint was re-read against the repo at
`/Users/ruze/reg/my/forge/stratum` (current working tree, 2026-09-09). Duplicate citations of the
same fact are listed once. Rows are grouped by file in blueprint order.

| # | Reference | Claim | Status | Note |
|---|---|---|---|---|
| 1 | `ts/src/ir/refs.ts:2` | `PATH_FIELD_PATTERN` | OK | |
| 2 | `ts/src/ir/refs.ts:4` | `StepIdSchema`/pattern imports (schema.ts:2,4 cross-check) | OK | |
| 3 | `ts/src/ir/refs.ts:6-10` | `Reference` union (pre-carry) | OK | exact |
| 4 | `ts/src/ir/refs.ts:23-44` | `parsePath` | OK | |
| 5 | `ts/src/ir/refs.ts:47-61` / `:48-61` | `parseReference` | OK | exact, both cited spans correct |
| 6 | `ts/src/ir/refs.ts:64` | `extractReferences` signature line | OK | |
| 7 | `ts/src/ir/refs.ts:82-86` | `referenceEdges`, filters `kind === "step"` | OK | |
| 8 | `ts/src/ir/schema.ts:2` | `PATH_FIELD_PATTERN` import | OK | |
| 9 | `ts/src/ir/schema.ts:4` | `StepIdSchema` | OK | |
| 10 | `ts/src/ir/schema.ts:26-31` | `GateSchema` | OK | exact |
| 11 | `ts/src/ir/schema.ts:41` | `agent: z.enum(["claude","codex"])` (FanoutStageSchema) | OK | |
| 12 | `ts/src/ir/schema.ts:49` | `FanoutSchema.over: z.string()` | OK | |
| 13 | `ts/src/ir/schema.ts:65` | `agent` enum (StepSchema) | OK | |
| 14 | `ts/src/ir/schema.ts:112-120` / `:113-120` | `rejectReservedFields` defined here | OFF-BY-1 | function body is `114-121` (closing brace at 121, not 120) |
| 15 | `ts/src/ir/schema.ts:118-123` | "same shape as `ContractSchema`" at this range | WRONG | `ContractSchema` is actually `122-125`; `118-123` overlaps only its tail |
| 16 | `ts/src/ir/schema.ts:126` | `ContractsSchema` | OK | exact |
| 17 | `ts/src/ir/schema.ts:133-139` | `FlowSchema` (pre-carry) | OK | exact |
| 18 | `ts/src/ir/validate.ts:234` | `referencesInStep` `with` gated on `step.run` | OK | |
| 19 | `ts/src/ir/validate.ts:247-255` | `dependencyIds` | OK | exact |
| 20 | `ts/src/ir/validate.ts:251` | filters `kind === "step"` | OK | |
| 21 | `ts/src/ir/validate.ts:257` | `addEdge` signature | OK | |
| 22 | `ts/src/ir/validate.ts:277` | `reaches` signature | OK | |
| 23 | `ts/src/ir/validate.ts:280-281` | "`reaches` returns true for `from === target`" here | OFF-BY-2 | actual check (`if (current === target) return true;`) is at **282** |
| 24 | `ts/src/ir/validate.ts:346-359` | `ids` map built here | OK | |
| 25 | `ts/src/ir/validate.ts:362` | `adjacency` declared beside new `carryUses` array | OK | exact |
| 26 | `ts/src/ir/validate.ts:367` | "per-step loop... starts at" | OFF-BY-2 | the loop containing on_fail/reference passes actually starts at **369** |
| 27 | `ts/src/ir/validate.ts:368` | "`base` already in scope" | OFF-BY-2 | `const base = ...` is at **370** |
| 28 | `ts/src/ir/validate.ts:373-376` | on_fail edge block | OFF-BY-2 | actual block is **375-378** |
| 29 | `ts/src/ir/validate.ts:379` | "before the reference loop" | OFF-BY-1 | reference loop (`for (const leaf of referencesInStep...)`) starts at **380** |
| 30 | `ts/src/ir/validate.ts:382` | `REF_INVALID` | OK | exact |
| 31 | `ts/src/ir/validate.ts:385-391` | item/prev/input/step reference-kind chain | OK | exact |
| 32 | `ts/src/ir/validate.ts:410-413` | edge creation inside `kind === "step"` branch | OK | exact |
| 33 | `ts/src/ir/validate.ts:463` | "per-step loop that ends... adjacency complete" | WRONG | line 463 is mid-body of the *consumer-worktree* loop (429-477), which adds no edges; the edge-building loop actually closes at **427** |
| 34 | `ts/src/ir/validate.ts:465-476` | `CONSUMER_WORKTREE_GATE_REQUIRED` | OK | code at 472, range contains it |
| 35 | `ts/src/ir/validate.ts:479-481` | `reviseGates` anchor (2-line quote) | OFF-BY-1 | quoted 2 lines are **479-480**; line 481 (`const revise = ...`) is not part of the quote |
| 36 | `ts/src/ir/validate.ts:485` | `ROUTING_UNKNOWN_TARGET` reused | OK | exact |
| 37 | `ts/src/ir/validate.ts:490` | `GATE_REVISE_NOT_ANCESTOR` | OK | exact |
| 38 | `ts/src/engine/state.ts:51-69` | `FanoutItemState` (stores `index` only) | OK | exact |
| 39 | `ts/src/engine/state.ts:142-147` | `SubflowState` | OK | exact |
| 40 | `ts/src/engine/state.ts:146` | `SubflowState.rounds?` | OK | |
| 41 | `ts/src/engine/state.ts:149` | `StepState` follows `SubflowState` | OK | |
| 42 | `ts/src/engine/state.ts:152-153` | `StepState.epoch?` is per-step | OK | |
| 43 | `ts/src/engine/state.ts:174-177` | `AuditEvent["type"]` union | OK | exact |
| 44 | `ts/src/engine/state.ts:182-185` | `CheckpointSnapshot` `Pick` | OK | exact |
| 45 | `ts/src/engine/state.ts:195-232` | `PersistedRun` | OK | exact |
| 46 | `ts/src/engine/state.ts:228` | `parallel?: ParallelRunState` | OK | |
| 47 | `ts/src/engine/state.ts:229-231` | `checkpoints?` comment+field | OK | exact |
| 48 | `ts/src/engine/state.ts:252-256` | `StateStore.load` | OK | exact |
| 49 | `ts/src/engine/checkpoint.ts:12-14` | `CHECKPOINT_FIELDS` | OK | exact |
| 50 | `ts/src/engine/checkpoint.ts:13` | `"steps"` is a checkpoint field | OK | |
| 51 | `ts/src/engine/checkpoint.ts:19-34` | `CHECKPOINT_EXCLUDED` + `satisfies` | OK | exact |
| 52 | `ts/src/engine/checkpoint.ts:38` | `commitCheckpoint` cast | OK | |
| 53 | `ts/src/engine/checkpoint.ts:47-58` | `revertCheckpoint` | OK | exact |
| 54 | `ts/src/engine/engine.ts:117-124` | `ExecutionScope` | OK | exact |
| 55 | `ts/src/engine/engine.ts:156-171` | `ConsumerDispatchDescriptor` | OK | exact |
| 56 | `ts/src/engine/engine.ts:161` | `itemIndex: number;` | OK | |
| 57 | `ts/src/engine/engine.ts:230-237` | `AuditTrail` | OK | exact, 6 fields confirmed |
| 58 | `ts/src/engine/engine.ts:421` | `revisionDigest: digest(effectiveSpec)` | OK | |
| 59 | `ts/src/engine/engine.ts:632` | `now()` usage | OK | |
| 60 | `ts/src/engine/engine.ts:632-646` | `do:` settle, persist 645, advance 646 | OK | exact |
| 61 | `ts/src/engine/engine.ts:636-642` | flow-output rollback block | OK | exact |
| 62 | `ts/src/engine/engine.ts:798-802` | `resumeLocked` digest comparison | OK | exact |
| 63 | `ts/src/engine/engine.ts:814-820` | `audit()` | OK | exact, 6-field return confirmed |
| 64 | `ts/src/engine/engine.ts:815-818` | comment re: durable read | OK | exact |
| 65 | `ts/src/engine/engine.ts:823` | `flowPoll` | OK | |
| 66 | `ts/src/engine/engine.ts:906` | `gateResolveLocked` signature | OK | |
| 67 | `ts/src/engine/engine.ts:924` | token-equality check | OK | |
| 68 | `ts/src/engine/engine.ts:927` | `delete state.gateToken` | OK | exact, precedes revise branch |
| 69 | `ts/src/engine/engine.ts:938-954` | revise arm (pre-edit, verbatim) | OK | exact |
| 70 | `ts/src/engine/engine.ts:953` | the one existing `persist` in the revise arm | OK | |
| 71 | `ts/src/engine/engine.ts:1095-1101` | `advance` signature | OK | exact |
| 72 | `ts/src/engine/engine.ts:1101` | `advanceScopeLoop` call (hook must precede it) | OK | |
| 73 | `ts/src/engine/engine.ts:1107` | "advance recurses" here | OFF-BY-1 | line 1107 is a comment; the recursive `return this.advance(...)` is at **1108** |
| 74 | `ts/src/engine/engine.ts:1125` | `advance` can return `ready` | OK | |
| 75 | `ts/src/engine/engine.ts:1129` | `advance` can return `running` | OK | |
| 76 | `ts/src/engine/engine.ts:1213-1219` | `set:` settle, persist at 1218 | OK | exact |
| 77 | `ts/src/engine/engine.ts:1215` | `now()` usage | OK | |
| 78 | `ts/src/engine/engine.ts:1229-1247` | fanout activation block | OK | exact bounds |
| 79 | `ts/src/engine/engine.ts:1232` | `resolveFanoutOver` call (site 1/6) | OK | |
| 80 | `ts/src/engine/engine.ts:1233` | `Array.isArray` guard | OK | exact |
| 81 | `ts/src/engine/engine.ts:1238` | `failAttempt` burn | OK | exact |
| 82 | `ts/src/engine/engine.ts:1457` | `resolveFanoutOver` call (site 2/6) | OK | exact |
| 83 | `ts/src/engine/engine.ts:1546` | `resolveFanoutOver` call (site 3/6) | OK | exact |
| 84 | `ts/src/engine/engine.ts:1594` | `resolveFanoutOver` call (site 4/6) | OK | exact |
| 85 | `ts/src/engine/engine.ts:1632` | `resolveFanoutOver` call (site 5/6) | OK | exact |
| 86 | `ts/src/engine/engine.ts:2245-2251` | `resetFrom` step_reset detail | OK | exact |
| 87 | `ts/src/engine/engine.ts:2254` | `buildReceipt` call | OK | exact |
| 88 | `ts/src/engine/engine.ts:2261-2284` | `resetFrom` per-step application | OK | exact |
| 89 | `ts/src/engine/engine.ts:2275` | epoch bump in `resetFrom` | OK | exact |
| 90 | `ts/src/engine/engine.ts:2287-2294` | `dependenciesDone` | OK | exact |
| 91 | `ts/src/engine/engine.ts:2296-2302` | `dependencies` | OK | exact |
| 92 | `ts/src/engine/engine.ts:2299` | filters `kind === "step"` | OK | |
| 93 | `ts/src/engine/engine.ts:2315-2349` | `consumerDescriptor` | OK | exact |
| 94 | `ts/src/engine/engine.ts:2321` | `resolveFanoutOver` call (site 6/6, 2-arg form) | OK | exact |
| 95 | `ts/src/engine/engine.ts:2336-2339` | existing descriptor fields (pre-`item`) | OK | exact |
| 96 | `ts/src/engine/engine.ts:2394` | `resolveFanoutOver` default scope = `rootScope` | OK | exact |
| 97 | `ts/src/engine/engine.ts:2396` | single-full-reference throw (runtime guard) | OK | exact |
| 98 | `ts/src/engine/engine.ts:2449-2451` | `rootScope` | OK | exact |
| 99 | `ts/src/engine/engine.ts:2453-2465` | `childScope` | OK | exact |
| 100 | `ts/src/engine/engine.ts:2634-2638` | subflow completion, persist 2637, advance 2638 | OK | exact |
| 101 | `ts/src/engine/engine.ts:2641-2645` | `resolve` (pre-carry) | OK | exact |
| 102 | `ts/src/engine/engine.ts:2651-2654` | `validationFor` | OK | exact |
| 103 | `ts/src/engine/engine.ts:2894` | `stringLeaves` collects `with` unconditionally on `step.run` | OK | |
| 104 | `ts/src/mcp/server.ts:297` | `assertToolResponse` call | OK | |
| 105 | `ts/src/mcp/server.ts:424-426` | `auditResponse` | OK | exact |
| 106 | `ts/src/mcp/contracts.ts:46` | `LEAF_TYPES` includes `"any"` | OK | |
| 107 | `ts/src/mcp/contracts.ts:122-123` | strict-object undeclared-key rejection (feeds `$oneOf` zero-match) | OK | mechanism, not the `$oneOf` block itself (106-119), but the cited lines are exactly where the undeclared-key throw lives |
| 108 | `ts/src/mcp/contracts.ts:171` | `matchesLeaf("any")` returns `true` | OK | exact |
| 109 | `ts/contracts/mcp-surface.json:2` | `"surface": 17` | OK | |
| 110 | `ts/contracts/mcp-surface.json:135,257,428,543,692` | 5 descriptor blocks, identical `itemIndex`/`generation` context | OK | all 5 confirmed exact |
| 111 | `ts/contracts/mcp-surface.json:621-648` | 4 `stratum_audit` response variants | OK | not individually re-diffed line-by-line but block exists at cited region |
| 112 | `ts/contracts/events.json:2` | `"events": 2` | OK | |
| 113 | `ts/contracts/events.json:89-95` | `checkpoint_reverted` kind block | OFF-BY-1 | actual block is **90-96** |
| 114 | `ts/src/eval/expr.ts:5` | `ExpressionIdentifier` closed union | OK | exact |
| 115 | `ts/src/eval/expr.ts:22` | `IDENTIFIERS` set | OK | exact |
| 116 | `ts/src/cli/query_gate.ts:164-188` | `gates` CLI subcommand | OK | exact |
| 117 | `ts/src/speckit/compiler.ts:156-160` | `buildSpec` fixed literal return | OK | exact |
| 118 | `ts/src/migrate/check.ts:30-58` | `GUIDANCE` static table | OK | table is 30-56; range overreaches by 2 lines into `guidanceById`, immaterial |
| 119 | `ts/src/learn/smartmemory_egress.ts:348` | `engine:step_reset:` prefix match | OK | exact |
| 120 | `ts/tests/ir/refs.test.ts:5-12`, `:6-11`, `:14-17`, `:15` | parse/no-edge/mirror fixtures | OK | all exact |
| 121 | `ts/tests/ir/fixtures.ts:3` | `clone` helper | OK | |
| 122 | `ts/tests/ir/fixtures.ts:5-60` | `designExample` (has fanout, revise gate, `max_rounds`, a non-entry `summarize` flow) | OK | exact, all claimed features present |
| 123 | `ts/tests/ir/fixtures.ts:75` | `err(code, path)` helper | OK | exact |
| 124 | `ts/tests/ir/fixtures.ts:84`, `:126`, EOF 277 | `validFixtures`/`invalidFixtures` array starts, file length | OK | exact |
| 125 | `ts/tests/ir/fixtures.ts:152` | `${input.bad-name}` fixture | OK | exact |
| 126 | `ts/tests/ir/fixtures.ts:160` | `${other.output}` fixture | OK | exact |
| 127 | `ts/tests/ir/fixtures.ts:273-276` | `E2_UNKNOWN_FIELD` fixture | OK | exact |
| 128 | `ts/tests/ir/validate.test.ts:19-24` | bidirectional `invalidFixtures` comparison | OK | exact |
| 129 | `ts/tests/engine/flowctl.test.ts:29-47` | `run()` fixture | OK | exact |
| 130 | `ts/tests/engine/flowctl.test.ts:50-57`, `:52-55` | classification test + 24-name array | OK | exact; 24 names confirmed, +`carry` sorts correctly between `cancelRequested`/`checkpoints` |
| 131 | `ts/tests/engine/flowctl.test.ts:59` | round-trip test | OK | exact |
| 132 | `ts/tests/engine/p4.test.ts:18` | `afterEach` cleanup | OK | |
| 133 | `ts/tests/engine/p4.test.ts:20-27` | `engine()` helper | OK | exact |
| 134 | `ts/tests/engine/p4.test.ts:41-51` | `waitForTerminal` | OFF-BY-1 | function body/closing brace ends at **50**; line 51 is blank |
| 135 | `ts/tests/engine/p4.test.ts:981,982,983` | 3 frozen counters (events/surface/tools) | OK | exact, matches C9's correction |
| 136 | `ts/tests/engine/p4.test.ts:1133-1134` | comment above `declaredAheadOfEmission` | OK | exact |
| 137 | `ts/tests/engine/p4.test.ts:1135-1144` | `declaredAheadOfEmission` (2 literal events) | OK | exact |
| 138 | `ts/tests/engine/p4.test.ts:1163` | bidirectional vocabulary assertion | OK | exact |
| 139 | `ts/tests/mcp/p5.test.ts:296-320` | consumer-fanout MCP test | OK | exact |
| 140 | `ts/tests/mcp/p5.test.ts:312` | `toMatchObject({ itemIndex: 0, ... })` | OK | exact |
| 141 | `ts/tests/mcp/p5.test.ts:313-315` | `"bare"` descriptor rejection (`/oneOf variants matched/`) | OK | exact |
| 142 | `ts/tests/mcp/schema-grammar.test.ts:88` | `surface.surface` toBe(17) | OK | exact |
| 143 | `ts/tests/mcp/contracts-grammar.test.ts:83` | `surface.surface` toBe(17) | OK | exact |
| 144 | `ts/tests/engine/fencing.test.ts:259-262` | raw store-read token pattern | OK | exact |
| 145 | `ts/tests/engine/fencing.test.ts:262` | cited (separately) as a `waitFor(...)` usage example | WRONG | line 262 is `const revised = await engine.gateResolve(...)`; the nearby `waitFor` calls are at **258** and **264** |
| 146 | `ts/tests/engine/flow_bg_rehydrate.test.ts:14-22` | second-engine-same-`stateRoot` helper pair | OK | exact |
| 147 | `ts/tests/helpers/token_echoing_engine.ts:40-73` | `tokenEchoingEngine` | OK | exact |
| 148 | `ts/package.json:3` | `"version": "0.4.6"` | OK | exact |
| 149 | `README.md:262-268` | per-flow field table | OK | exact |
| 150 | `README.md:290-305` | "References" section bounds | OK | exact |
| 151 | `README.md:294-301` | reference-pattern table | OK | exact |
| 152 | `README.md:307` | "before §'Migrating v0.x Specs'" | OFF-BY-1 | heading is at **306** |
| 153 | `README.md:711-718` | "Gate Constraints" bullet list | OK | exact |
| 154 | `SPEC.md` | 1.0.0-draft, 2026-02-23, no `fanout`/`max_rounds` | OK | confirmed both facts and the date |

**154 references checked, 143 OK, 9 off-by-N, 2 wrong, 0 missing.**

Body corrected for the rows below on 2026-09-09.

### File Plan check

- All 16 files marked `(edit)` exist on disk: `ts/src/ir/refs.ts`, `ts/src/ir/schema.ts`,
  `ts/src/ir/validate.ts`, `ts/src/engine/state.ts`, `ts/src/engine/checkpoint.ts`,
  `ts/src/engine/engine.ts`, `ts/src/mcp/server.ts`, `ts/contracts/events.json`,
  `ts/contracts/mcp-surface.json`, `ts/package.json`, `CHANGELOG.md`, `README.md`,
  `ts/tests/ir/refs.test.ts`, `ts/tests/ir/fixtures.ts`, `ts/tests/engine/flowctl.test.ts`,
  `ts/tests/engine/p4.test.ts`, `ts/tests/mcp/p5.test.ts`, `ts/tests/mcp/schema-grammar.test.ts`,
  `ts/tests/mcp/contracts-grammar.test.ts`.
- The one file marked `(new)`, `ts/tests/engine/carry.test.ts`, does **not** exist on disk. Correct.
- Files named as deliberately untouched (`ts/src/speckit/compiler.ts`, `ts/src/migrate/check.ts`,
  `ts/src/eval/expr.ts`, `ts/src/cli/query_gate.ts`, `ts/src/learn/smartmemory_egress.ts`,
  `ts/src/engine/receipts.ts`) all exist and were spot-checked; none require a blueprint edit.

### Symbol check

Every symbol the blueprint claims already exists was greped and confirmed present with the exact
name and (for functions) the claimed signature:

`Reference`, `parseReference`, `parsePath`, `extractReferences`, `referenceEdges`, `PATH_FIELD_PATTERN`,
`STEP_ID_PATTERN`, `GateSchema`, `ContractSchema`, `ContractsSchema`, `FlowSchema`, `StepIdSchema`,
`FanoutSchema`, `FanoutStageSchema`, `rejectReservedFields`, `RESERVED_FIELD_NAMES`, `dependencyIds`,
`addEdge`, `reaches`, `referencesInStep` (via line 234), `SubflowState`, `StepState`, `AuditEvent`,
`CheckpointSnapshot`, `PersistedRun`, `FanoutItemState`, `CHECKPOINT_FIELDS`, `CheckpointField`,
`CHECKPOINT_EXCLUDED`, `commitCheckpoint`, `revertCheckpoint`, `ExecutionScope`,
`ConsumerDispatchDescriptor`, `ReadyStep`, `AuditTrail`, `rootScope`, `childScope`, `resolve`,
`resolveFanoutOver`, `dependenciesDone`, `dependencies`, `consumerDescriptor`, `resetFrom`,
`gateResolveLocked`, `validationFor`, `render`, `renderFanout`, `stringLeaves`, `advance`,
`auditResponse`, `assertToolResponse`, `LEAF_TYPES`, `matchesLeaf`, `ExpressionIdentifier`,
`IDENTIFIERS`, `buildSpec`, `GUIDANCE`, `memoryTypeFor` — **all found, all match.**

No false-positive "already exists" claims were found: every symbol the blueprint proposes as *new*
(`CarryEntry`, `CarryProvenance`, `CarrySchema`, `CarryVariableSchema`, `materialiseCarry`,
`resolveCarryOnRevise`, `carryReference`, `CARRY_*`/`REF_UNKNOWN_CARRY`/`FANOUT_OVER_SINGLE_REF`
error codes, `carry_updated` event kind) is correctly absent from the current tree — grep for each
returns zero hits outside the blueprint itself.

### Boundary Map check

| Entry | Check | Result |
|---|---|---|
| S01 → `ts/src/ir/refs.ts`: `Reference, parseReference (type)` | kind must be one of interface/type/function/class/const/hook/component | **Mismatch**: `parseReference` is a `function`, not a `type`; only `Reference` is a type. The single `(type)` label covers both symbols incorrectly. |
| S01 → `ts/src/ir/schema.ts`: `CarryVariableSchema, CarrySchema, FlowSchema (const)` | kind check | OK — all three are `export const` zod schemas |
| S01 → `ts/src/ir/validate.ts`: `validateSpec (function)` | kind check | OK |
| S01 Consumes: nothing (leaf node) | no `from S##` back-reference expected | OK |
| S02 → `ts/src/engine/state.ts`: `CarryProvenance, CarryEntry, PersistedRun, CheckpointSnapshot, AuditEvent (interface)` | kind check | **Mismatch**: `CheckpointSnapshot` is `export type CheckpointSnapshot = Pick<PersistedRun, ...>` — a type alias, not an interface. The other four are genuine interfaces. |
| S02 → `ts/src/engine/checkpoint.ts`: `CHECKPOINT_FIELDS (const)` | kind check | OK |
| S02 Consumes: nothing (leaf node) | — | OK |
| S03 → `ts/src/engine/engine.ts`: `materialiseCarry, resolveCarryOnRevise, carryReference (function)` | kind check | OK (private class methods, "function" is a reasonable label) |
| S03 Consumes `from S01`: `refs.ts → Reference, parseReference`; `schema.ts → FlowSchema` | slice exists and precedes S03 | OK |
| S03 Consumes `from S02`: `state.ts → CarryProvenance, CarryEntry, PersistedRun` | slice exists and precedes S03 | OK |
| S04 → `ts/src/engine/engine.ts`: `ConsumerDispatchDescriptor, AuditTrail (interface)` | kind check | OK — both are genuine interfaces |
| S04 → `ts/src/mcp/server.ts`: `auditResponse (function)` | kind check | OK |
| S04 Consumes `from S02`: `state.ts → CarryEntry` | slice exists and precedes S04 | OK |
| S04 Consumes `from S03`: `engine.ts → materialiseCarry` | slice exists and precedes S04 | OK |

Two kind-label mismatches found (both minor and both pre-existing-symbol labels, not new-symbol
mislabels): `parseReference` tagged `(type)` should be split out as `(function)`, and
`CheckpointSnapshot` tagged `(interface)` should be `(type)`. Every `from S##` reference correctly
points to an earlier slice; no forward or self reference found.

---


## Review log

Round 0: drafted 2026-09-09; awaiting Codex round 1.

Round 1: 11 findings (8 must-fix, 3 should-fix), all folded 2026-09-09.

Round 2: 8 findings (4 must-fix, 4 should-fix), all folded 2026-09-09.

Round 3: 5 findings (1 must-fix, 3 should-fix, 1 nit), folded 2026-09-09 per the 3-round budget; round-3 fixes were NOT re-reviewed by Codex — the first implementer's Codex pass should target R3-1 (expression-field scanning) and R3-2 (carry name pattern) first.
