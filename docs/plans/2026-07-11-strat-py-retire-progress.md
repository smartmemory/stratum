# STRAT-PY-RETIRE — execution ledger

Companion to `2026-07-11-strat-py-retire-roadmap.md`. Records what has actually been
done as the epic is driven, so a fresh session resumes losslessly. Newest at top of
each phase. Absolute SHAs / versions only.

## Owner directive (2026-07-12, session 70422c49)

- **Soak collapsed.** No other users besides the owner → the calendar soak (Phase 0's
  "7 PASS days ~07-18") is dropped. Cutover proceeds as soon as the work is done.
- **Deletion sequencing: cut over now, delete after a SHORT real-usage window.** Drive
  Phases 0–4 to make TS the sole engine (forge + compose), operate TS-only for real,
  THEN Phase 5 deletes Python. Deletion gated on "TS actually ran as the only engine and
  held," not a calendar. Keep the Python fallback until then (we found engine races in the
  flow-bg work on 2026-07-12, so do not discard the fallback the same stretch we cut over).

### REVISED cutover strategy (owner, 2026-07-12 later — SUPERSEDES the fallback/incremental model above)

- **Python does NOT survive. No runtime fallback, no translation adapter, no dual-producer
  scaffolding.** Port the PRODUCER (compose) to speak the TS interface NATIVELY — do not build
  a Python↔TS translation shim (that would carry a dead dialect forever = pointless indirection).
- **Migration-branch workflow, atomic merge:** FREEZE the current known-good state (compose +
  stratum-python working together) on `main` in BOTH repos. Do the ENTIRE migration on a
  coordinated migration branch (`ts-cutover`) in each repo: port compose execution to TS-native,
  delete the Python execution path, v0→v1 specs, shared state root, de-hardcode Python-store
  reads. Dogfood LOCALLY until thoroughly tested. Then **merge both branches at once** = one clean
  replacement/upgrade. `main` staying on working-python IS the fallback until merge day.
- So there is NO incremental flip on main and NO permanent fallback flag. The "short real-usage
  window" happens as local dogfooding IN the branch, before the atomic merge. Baseline freeze:
  compose main @ 869a55b, stratum main @ (this commit).

## Status snapshot (2026-07-12)

- stratum @ origin/main; TS v0.2.106 (STRAT-TS-FLOW-BG epic COMPLETE this session).
- Critical path to TS-only: 0 → 1 → 4 → 5; Phase 2 (guard done) + Phase 3 feed Phase 4.

## Phase 2 — TS parity (stratum repo)

- **STRAT-PY-RETIRE ENDGAME (compose python deletion) — ✅ DONE 2026-07-17 (compose develop @ 62f115a). THE PYTHON EXECUTION PATH IS GONE. Epic build work COMPLETE — only merge day (owner-gated atomic develop→main, both repos) remains.**
  Safety first per owner directive: local `python-legacy` branches at the last python-bearing
  commits (compose cc390a7, stratum 642dda3) BEFORE any deletion. Deleted: python dispatch
  branches, executeParallelDispatch* + server/routing/worktree machinery, python parallel MCP
  methods + tool discovery, connector-factory shim (test capability → test/helpers/
  ts-agent-harness.js), python init (pip/stratum-mcp), python-era tests — 9,968 lines net.
  Python selection now FAILS LOUDLY naming python-legacy (incl. the design-routes cached-client
  path); no silent TS fallback anywhere. **Two-lens review (Codex + Opus) proved its worth: the
  deletion took LIVE behavior with it** — dirty-review recovery, GSD timing/diff instrumentation,
  bug-mode recovery checkpoints, diagnose rejected-hypotheses context, cockpit parallel-task
  events — and Opus caught the untracked load-bearing test harness that staging would have
  missed. THREE restoration rounds (H1–H8, I1–I4, J1–J2), with the middle round itself caught
  validating against proxies (helpers/injected flags/fabricated history) — controller mandate
  thereafter: real-path proof only (real runBuild/runGsd over the live TS bin, engine-audit
  assertions), which surfaced two further masked defects (normalization resets lenses_run;
  instrumentation keyed item-index vs task-id). **Design landed: dirty-review recovery is
  engine-native** — review_gate after the reducer (on_revise → review_triage, max_rounds 10),
  compose resolves by policy (clean→approve; dirty→pre-normalization dirty-lens capture →
  corrective fixer → revise), sidecar cleared at fresh start, result re-derived from engine
  audit on resume. Deleted-test specs recovered from cc390a7 drove every re-expression.
  Follow-ups filed: TS runGsd/runBuild harness + 3 python-era survivor suite ports (fidelity
  debt, still green); stratum issues (bg workspace-write agents + claude allowlists;
  deterministic test-judge backend) BLOCKED on gh reauth. Gates: **full suite 4608/4608 —
  0 fail 0 cancelled, the first fully green suite of the migration**; ts-cutover 117/117;
  every round independently verified. NOTE: the stratum-repo python tree (src/stratum,
  stratum-mcp) is NOT deleted this slice — compose no longer references it; its removal is
  merge-day housekeeping (owner call, alongside the atomic merges).

- **STRAT-TS-FLAG-DAY (both repos) — ✅ DONE 2026-07-17 (stratum develop @ 9c78b73 SURFACE 9; compose develop @ cc390a7). Epic status: only endgame (#11) remains.**
  Stratum: stepDone REQUIRES dispatchToken (ordinary+subflow), gateResolve REQUIRES gateToken,
  epoch retired (strict-schema rejected), enforcement at three boundaries (runtime guards for
  raw JS callers, required public TS types, MCP schema); human gate CLI moved to
  observation-time echo (`query gates` exposes tokens, `gate resolve --token` required — the
  resolve-time audit fetch silently rebinding stale human decisions is gone); three Slice-C/D
  compat assertions reversed; legacy suites migrated via a token-echoing test adapter
  (documented never-for-fencing; runtime-guard negatives through one documented untyped-caller
  helper). Two review passes, 5 findings fixed. Gates: vitest 644/1 skip, tsc clean.
  Compose: epoch removed end-to-end (epoch golden → rejection proof), goldens echo tokens,
  TEN python-coupled test files re-expressed on the live TS bin as v1 fixtures
  (build-integration/build-policy/JSONL+leaves/proof-run/gsd-pipeline + three stale-v1 the
  default flip surfaced), engine default flipped to TS via shared lib/stratum-engine.js
  (env → capability → TS; python pinnable until endgame). **Ship's judged ensure KILLED as
  E3 over-authoring** — unevaluable from {result,input}, judge fails closed even on evidenced
  results (F5-class); ship stays gated by ship_gate; stratum follow-up = deterministic
  test-judge backend. Whole-slice review + 5 scoped fix rounds (18 accepted, 1 partial):
  server adapter TS default now spawns the live checkout CLI behind a contract-verifying
  probe (sentinel NOT_FOUND, exact projection, timeout=failure) — bare `stratum` resolved to
  miniconda's CLI and half-enabled; abortBuild engine resolved from its project root;
  pipeline editor made v1-correct (version-derived intent→do at every serialization site,
  renameStep rewrites v1 refs incl. _extra/templates); pipeline saves simplified to an
  ALWAYS-require-baseHash contract (400/409, force===true only bypass) after a spoofable
  spec-wide classification survived two hardening rounds — controller ruling: remove the
  optionality rather than harden the classifier. **Editor-endpoint hardening beyond this is
  follow-up material, not migration scope (owner pushback on loop length — justified).**
  Gates verified: ts-cutover 105/105, parallel 18/18, full suite 4770/4778 (remaining = 7
  A-class python-era + known load flakes, all endgame-scoped; triage doc E3-delta section).

- **STRAT-TS-FANOUT-CONSUMER Slice E3 (full v0.3→v1 production pipeline conversion + consumer parity) — ✅ DONE 2026-07-17 (compose develop @ 9221548).**
  Both production pipelines re-authored as TS v1 (subflows for cross-model review/coverage,
  consumer fanouts for implement + lens review, gate revise loops; profile sidecar
  `pipelines/build.profiles.json` carries the stripped tool/model profiles + reducer markers).
  NEW `lib/local-claude-connector.js` (isolation:none reviewers: SDK `tools` allowlist binds,
  tool-event streaming for stuck detection, timeout/stuck abort) + NEW
  `lib/vocabulary-compliance.js` (deterministic python `vocabulary_compliance` port).
  **Loop: codex sol/high build → FIVE fix rounds (rounds 1–2 pre-clear: D1–D7+1b, V1–V6;
  rounds 3–5 this session: F1–F8, G1–G5, H1–H2) against codex sol/high review passes 3–6;
  pass 6 REVIEW CLEAN. 16 findings accepted this session's rounds**, highlights: scoped
  subflow ready ids (`<parentStepId>/<childId>`) resolved contracts/review-identity through
  the local spec (BLOCKER — builds died at codex_review/coverage); SDK `allowedTools` is
  no-prompt-only, availability restriction needs `tools` (BLOCKER — reviewer read-only
  boundary didn't bind); usage billed exactly once on success/failure/timeout-reject/
  timeout-late-resolve/abort (engine debits from step_done envelopes; GSD terminal fold
  made DELTA-only against incremental recording — double-debit killed); review scaffold
  parity on both ordinary + fanout paths, reducers normalize-but-never-scaffold
  (`_reduceSteps` sidecar key = python's stripped reduce_mode, restored compose-side);
  unevaluable v1 judged vocabulary guard (judge sees only {result,input}, fails closed
  forever) → deterministic consumer-side check failing steps through the engine lifecycle;
  GSD ownership conflicts → typed failure envelopes (attempts govern). **2 findings
  REJECTED with reasoning:** YAML 1.2-vs-1.1 vocabulary scalar divergence (python's
  yes/no→bool is a 1.1 wart; python dies at endgame — documented, not preserved);
  python-path gsd decompose throw (dies at endgame). **Triage delta:**
  `test/gsd-pipeline.test.js` ×11 joined class B (v1 conversion invalidated its
  python-validator contract test; re-express on TS validation at flag-day) — triage doc
  E3 section. Gates independently verified every round: ts-cutover goldens 105/105
  (78 pre-round-3 + 27 new), client parallel 18/18. Adjudications pinned pre-clear
  (rounds 1–2, do NOT re-litigate): E3 scope = FULL conversion; backward `on_fail` =
  ROUTING_CYCLE (empirical); merge-gate revise reruns full generation (design-permitted);
  local claude connector SCOPED to isolation:none reviewers — write-item mid-flight
  interrupt = stratum follow-up issue (ts: workspace-write bg agent mode + claude
  allowlists on the agent surface; bg mode is codex-only+read-only-only per
  ts/src/mcp/background.ts:65/:68, sync agent_run returns no runId, server.ts:104 —
  FILING BLOCKED on gh keyring reauth as of this entry). Next: flag-day (task #6).

- **STRAT-TS-FANOUT-CONSUMER Slice E2b (bounded concurrent consumer execution) — ✅ DONE 2026-07-16 (compose develop @ 287ae75).**
  Resolves the E2-deferred serialization P3 (task #8, owner go-ahead on controller recommendation:
  concurrency BEFORE E3 ships real traffic). dispatchToken-keyed working-set pump (all ready
  consumer descriptors launch concurrently, cap default 3 / `COMPOSE_FANOUT_CONCURRENCY`,
  ready[] of each response merged, seen/superseded tokens never re-dispatch; ordinary entries
  stay serial). Loop: codex sol/high build → 4 RED-first fix rounds (standing Opus fixer,
  codex sol/high reviewer) → 5th pass REVIEW CLEAN; **6 findings accepted**: (C1) stale per-item
  audit snapshots globally superseded newer issuances → reconciliation SCOPED per item, global
  reconcile only at ordered points with fresh audit; (C2) ordinary-path fatal bypassed the drain
  → pump-level fatal boundary (drain in-flight before propagate); (C3) journal one-writer not
  enforced → (C4) round-1's reconciling fold was last-writer-wins toward the STALE side (no
  monotonic fold exists — rollback legitimately goes merged→accepted) → **adjudicated
  architecture: mutate-against-fresh primitive** — every journal mutation applies to the freshly
  loaded on-disk journal under a module-level path-keyed guard, in-memory model = read cache,
  never a write base (12 sites converted, fold deleted); (C5) applyMerge's four saves still wrote
  the stale cache → converted, + DECIDED-round stop (gateOutcome/rolled_back ⇒ typed
  ConsumerMergeDecisionError, gate flow downgrades approve→repair); (C6) DECIDED check moved to
  immediately before each `git apply` (throw before touching the tree). **Documented residual:**
  cross-process TOCTOU window at pre-apply check (no journal lockfile; single-owner-per-run
  assumption) — in-process fully sealed. Gate: ts-cutover goldens 52/52 (10 new concurrency
  scenarios). Intermittent single 90s cancellation under parallel load persists (~1 in 5 full-gate
  runs; individual tests ≤3.7s) — environmental, watch not chase. Next: E3.

- **STRAT-TS-FANOUT-CONSUMER Slice E2 (compose consumer loop + journal + witness-chain merge) — ✅ DONE 2026-07-16 (compose develop @ c325db7).**
  Native consumer-dispatch execution in compose: descriptor routing off the TS ready[] pump
  (structural detection), generation-keyed worktrees OUTSIDE the merge target (tmpdir root,
  canonical-path + symlink rejection), durable fsync+rename journal (pre-stage witnesses,
  `prepared` envelope before EVERY step_done, `accepted` only via `acceptedDispatchToken`
  reconciliation, run-revision pins written in the journal's FIRST durable write and verified
  fail-closed at resume), ONE cumulative diff per item at final stage, merge gate = journaled
  transaction with precomputed UNIQUE tree-witness chain (temporary-index snapshot pattern;
  unmatched tree → baseline restore + replay-from-zero; partial applies never completed in
  place), `isolation:none` = python-parity in-cwd (no worktree/diff/merge; isolation-aware
  artifacts-complete check), full contract closures to agent schemas + normalizer,
  `previousFailure` in retry prompts, item-local connector-error envelopes, NODE_ENV-gated
  crash hooks. **Loop: codex sol/high build → FOUR RED-first fix rounds (Opus subagent fixer,
  codex sol/high reviewer) → 5th pass REVIEW CLEAN. 16 findings accepted total**, highlights:
  blanket revise-supersession (P1), revisionDigest never checked at resume (P1), crash window
  between journal creation and pin bind (P1), historical rollback erasing a later APPROVED
  merge (Critical — recovery now acts ONLY on the unresolved transaction, resolved rounds are
  durable history), rollback resurrecting engine-superseded evidence (audit reconciliation on
  restore), isolation:none silently losing writes (P1). **Unifying principle (rounds 3–4):
  recovery/rollback scoped to the CURRENT transaction round, engine audit as ground truth —
  never replay history from journal state alone.** REJECTED as E2 scope: production pipeline
  re-authoring (→ Slice E3, harness task #7); DEFERRED: serialized ready[] item execution
  (task #8 — owner decision before E3 ships real traffic). Engine facts confirmed read-only:
  descriptor `policy.isolation` = `z.enum(["worktree","none"])`, `merge:"sequential"` required
  on every fanout, step ids `/^[a-z][a-z0-9_-]*$/` (E3 brief inputs). Descriptor final-stage
  marker gap (compose derives finality from local spec, safe via revisionDigest pinning) →
  stratum follow-up issue (task #10). Gate: ts-cutover goldens 42/42 (17 pre-E2 + 25 new
  consumer scenarios: crash windows A–D, multi-round revise/merge recovery, re-enumeration
  supersession, empty-input/empty-contract edges, isolation:none + mixed fanouts). One
  timeout flake observed once under parallel load (individual tests ≤3.4s vs 90s ceiling;
  two clean reruns). Next: E3 (pipelines re-author) after the task-#8 concurrency decision;
  then flag-day (task #6).

- **STRAT-TS-FANOUT-CONSUMER Slice E1 (compose token echoes) — ✅ DONE 2026-07-16 (compose develop @ bda27ef).**
  Compose half of Phase-2 universal fencing: every TS-path `stepDone` echoes its ready
  entry's `dispatchToken` (live seams build.js 1590 + 1789; 7 other stepDone sites audited
  not-echoable = python-only/legacy-child paths, reasoning in the E1 run log), every TS-path
  `gateResolve` echoes the round's audit-discovered `gateToken` (skip/flag/human paths; the
  bare-`running` gate seam now carries `{id, gateToken}`). Python-era parallel lifecycle
  (`parallelStart/Poll/Advance/Done`) fails explicitly on the TS surface via advertised-tool
  discovery at connect; python servers advertising the tools are untouched. New golden
  `test/ts-cutover-token-echo-golden.test.js` (real TS bin): full gated build echo audit,
  stale-vs-current dispatchToken, stale-vs-current gate round, 4 parallel guards, discovery
  fail-closed. Loop: codex sol/high build (RED 0/4 → wired) → codex sol/high review → 2 P2s:
  (1) token-less direct TS callers in existing goldens will break at flag-day — **REJECTED
  as flag-day scope by design** (same adjudication as Slice D P1; the migration window is
  designed) — **ADDED to flag-day checklist: update direct `stepDone`/`gateResolve` calls in
  `ts-cutover-golden.test.js` + epoch golden to echo tokens when rejection flips**; (2) parallel
  guard failed OPEN when `tools/list` errors at connect (opaque unknown-tool error returns) —
  **ACCEPTED, controller fixed RED-first**: guard now fails closed with an explicit
  discovery-failure error (+1 golden case, prototype-patched `listTools`). Gate: ts-cutover
  goldens 17/17 (was 12 pre-E1). Next: Slice E2 (consumer loop + artifact journal + witness-chain
  merge transaction, brief drafted).

- **STRAT-TS-FANOUT-CONSUMER Slice D (consumer fanout + descriptors + SURFACE 8) — ✅ DONE 2026-07-16 (stratum develop @ 5efc30a).**
  Consumer scheduling (slot-per-item across stages, debit once per stage first-ready),
  self-contained descriptors in `ready[]` (contract CLOSURE+digest incl. `?`/`[]` ref
  resolution, policy, generation, revisionDigest, token — descriptor REQUIRES its token, no
  compat), shared settlement kernel `settleFanoutAttempt` (owners can't drift), merge guarded
  `dispatch==="engine"`, locateStep numeric discrimination (engine items externally
  unreachable). Surface 7→8: `ready` = `{"$array":{"$oneOf":[ordinary, descriptor]}}` both
  shapes frozen; optional `dispatchToken`/`gateToken` request echoes forwarded; plan/resume
  expose `revisionDigest` (every variant, no other tool — `RevisionedEngineResponse` wrapper);
  `errors` registry + typed MCP protocol error for `consumer_dispatch_bg_unsupported`
  (closes Slice B's deferred finding — probe-confirmed -32603/data-undefined gap now mapped
  with shape-validated `data`). events.json byte-identical. Loop: codex sol/high build
  (6 dense tests, contract-first RED) → codex sol/high review → **1 P1 finding REJECTED as
  flag-day scope** (missing-token acceptance for ordinary/gate ids is the DESIGNED migration
  window: design gates missing-echo rejection on compose echoing tokens first).
  **FLAG-DAY CHECKLIST (from the finding, task #6):** make `dispatchToken`+`gateToken`
  REQUIRED in requests; engine rejects MISSING tokens for ordinary/subflow/gate ids; REVERSE
  the three compat assertions (fencing.test.ts ~64 + ~126 missing-token acceptance,
  p5.test.ts ~350 ordinary-id acceptance); retire Phase-1 `epoch` request field; surface bump.
  Full suite 640 pass / 1 skip (live-codex flake recurs intermittently on full runs — network,
  not deterministic); tsc clean. Next: Slice E (compose consumer loop, compose-develop repo).

- **STRAT-TS-FANOUT-CONSUMER Slice C (tokens/generations/fencing) — ✅ DONE 2026-07-16 (stratum develop @ dca1235).**
  Engine-level universal fencing: persisted `dispatchToken`/`gateToken`/`acceptedDispatchToken`,
  run-level generation counter OUTSIDE checkpoint snapshots (CHECKPOINT_EXCLUDED + classification
  test), full mint/persist/rotate lifecycle (revert re-mint, monotonic generations, durable
  cancellation fence — p5 cancelled-run expectation updated to design semantics), engine
  stepDone/gateResolve optional token echoes (missing accepted / mismatch rejected),
  revisionDigest (SHA-256 canonical JSON) persisted+verified, commit/revert guard through the
  consumer-worktree successor gate. Surface STAYS 7 (server.ts/mcp-surface.json/events.json
  byte-identical — C/D boundary held; wire exposure = Slice D). Loop: codex sol/high build
  (10 RED-first tests) → codex sol/high review → **3 findings, ALL ACCEPT, all fixed RED-first
  by controller (+3 tests)**: (1) High — audit read the fanout-PINNED in-memory run without the
  lock; a minted token was observable before its save landed (probe-reproduced) → audit now
  reads DURABLE state (store.load, not loadRun); (2) High — guard resolved the successor gate
  by ARRAY adjacency (flow.steps[index+1]) not the validated dependency notion — reproduced
  both permanent-commit-refusal and false-release → guard now mirrors validation's
  qualifying-gate selection (unconditional, non-routed, dependencies ∋ fanout; release = all
  qualifying gates succeeded); TWO independent reviewers (controller read + codex probe)
  converged on this one; (3) Medium — pre-Slice-C persisted ready runs threw on resume
  (readyStep missing-token invariant) → resumeLocked backfills tokens for ready/waiting_gate
  before its persist. Full suite 634 pass / 1 skip (one live-codex network flake observed,
  clean on re-run); tsc clean. Next: Slice D (consumer scheduling + descriptors + surface 8;
  carry Slice B's deferred MCP error-mapping finding into the D brief).

- **STRAT-TS-FANOUT-CONSUMER Slice B (IR + validation) — ✅ DONE 2026-07-16 (stratum develop @ 06d8fcf).**
  `fanout.dispatch` enum w/ default injected into the VALIDATED value (persisted-spec
  proof via StateStore — plan already stores the Zod-parsed spec); consumer+worktree
  filesystem `ensure`/`when` rejected via real expression-AST inspection
  (`expressionUsesFilePredicate`, eval/expr.ts); direct-successor gate REQUIRED;
  subflow fanout pinned to existing root-only diagnostic; `flow_run_bg` rejects
  consumer specs w/ frozen code `consumer_dispatch_bg_unsupported`, same spec legal
  foreground. Loop: codex sol/high build (17 RED-first tests) → codex sol/high review →
  2 P1 findings: (1) **ACCEPT, fixed RED-first** — gate-bypass: a `when`-guarded gate the
  engine can skip (engine.ts:866) or a routing-target gate that only activates when
  routed (engine.isActivated:1471) satisfied the rule without ever entering
  `waiting_gate`; rule now requires an UNCONDITIONAL, NORMALLY-ACTIVATED direct-successor
  gate (+3 tests, mirrors engine semantics — also protects the Slice C commit/revert
  guard anchor); (2) **REJECT as Slice D scope** — MCP protocol-error mapping +
  `errors` registry absent: deliberately excluded from B (brief + slice plan put the
  registry/server mapping in D); probe (-32603, data undefined) usefully confirms the
  gap D closes — carry it into the D brief. Full suite 621 pass / 1 skip; tsc clean.
  Next: Slice C (token/generation lifecycle + universal fencing).

- **STRAT-TS-FANOUT-CONSUMER Slice A (grammar machinery) — ✅ DONE 2026-07-16 (stratum develop @ e43e799).**
  Tagged shape grammar `{"$array": <shape>}` + `{"$oneOf": [...]}` per design r4/r5/r6:
  complete-strict exactly-one `$oneOf` matching (zero AND ambiguous rejected), `$`-prefix
  reserved as grammar tags (illegal as record field names), new `validateShape` separates
  declaration errors from value mismatches, JSON-schema translator (`schemaFor`) shares the
  validator and implements the identical grammar. Loop: codex sol/high build (21 RED-first
  tests) → codex sol/high review → **3 P2 findings, ALL adjudicated ACCEPT** (empty `$oneOf`
  → invalid JSON Schema; leaf vocabulary unvalidated — `{"$array":"bogus"}` translated to
  invalid `{type:"bogus"}`; dual `x`+`x?` declaration made runtime and schema disagree) →
  controller fixed all three RED-first (+8 tests; leaf set `any|array|boolean|null|number|
  object|string` verified empirically against BOTH frozen contracts before tightening).
  NO mcp-surface.json changes, NO surface bump (rides Phase-2 flag-day). Full suite
  601 pass / 1 skip; tsc clean. Next: Slice B (IR `dispatch` field + consumer-mode
  semantic validation).

- **STRAT-TS-FANOUT-CONSUMER design gate round 2 — 🔄 IN FLIGHT 2026-07-15 (late session).**
  Grounded codex sol/high re-review of the revised+amended design (per owner practice)
  returned NOT implementation-ready: 4 High + 2 Medium, ALL adjudicated ACCEPT (zero
  category errors; premises code-verified — `gate_resolve` request is bare
  `{runId,stepId,decision}`, `gateResolveLocked` checks no issuance identity):
  1. gate_resolve unfenced (delayed prior-round approve can resolve a later round's
     `waiting_gate`) → design now fences gates: per-round **`gateToken`**, echoed on
     `gate_resolve`, same lifecycle + flag-day as dispatchToken; surfaces via response
     step state, NOT events (events.json stays frozen).
  2. descriptor carried only contract id+hash (stateless consumer can't produce the
     shape; no fetch-by-digest API exists) → descriptor now carries the canonical
     contract shape INLINE (+ `contractDigest`); explicitly NO fetch-by-digest in v1.
  3. dispatchToken lifecycle unspecified; checkpoint revert would resurrect old tokens
     (checkpoints snapshot `steps`, state.ts:148; revert restores, engine.ts:473) →
     explicit lifecycle contract added: mint-per-issuance, persist-before-expose,
     stable-within-issuance, rotate-on-any-reissue, **revert re-mints restored
     non-terminal tokens**, cancel invalidates.
  4. compose merge artifacts not restart-safe; scoped-id keying unsafe (reused across
     runs/stages/retries/revisions) → durable `.compose/` artifact journal keyed
     `(runId, scopedId, dispatchToken)`, journal-before-report, recovery on restart,
     crash tests (post-capture / post-step_done / mid-merge).
  5. bg support simultaneously required and optional → RESOLVED foreground-only v1;
     `flow_run_bg` rejects consumer-dispatch specs at submission w/ typed diagnostic +
     frozen contract test; bg semantics bind the follow-up feature.
  6. doc contradictions (stale "currently is not", ordinary-entries-unchanged vs
     gains-token, item-epoch-rejects-duplicates, byte-for-byte, ts-cutover header) →
     all corrected 2026-07-15b.
  **Round 2 (2026-07-16):** 3 High + 3 Medium, all within round-1 amendment blast
  radius (disposition: everything partially/mostly closed — converging), ALL ACCEPT:
  (1) no-`out` stages → descriptor `contract: null`, report unvalidated (source compat
  holds); (2) filesystem-dependent stage `when` rejected like filesystem ensures
  (engine evaluates `when` against the item worktree, engine.ts:1116); (3) artifact
  identity split — worktree keyed by ITEM (stable across stages/retries, engine
  parity), diffs keyed by issuance token; merge = journaled transaction w/ per-diff
  applied witness (mid-merge crash replay), `revise` RETAINS artifacts; (4) gateToken
  discovery MANDATED as audit-fetch (compose's real path, build.js:1929 running→audit→
  scan waiting_gate); ordinary StepState also gains persisted dispatchToken; (5) bg
  rejection = existing validation-failure channel (MCP protocol error, stable message;
  no new response variant), stale `flow_bg_poll.ready` dropped from v1 test row;
  (6) revision DEFINED = persisted effective spec; `revisionDigest` on every
  plan/resume variant + descriptor echoes; origin map marked future scope.
  **Round 3 (2026-07-16):** 3 High + 2 Medium; gateToken-discovery + null-contract
  CLOSED; remaining findings all precision gaps in the r2 amendments, ALL ACCEPT:
  (1) per-token diffs wrong — engine captures ONE cumulative patch per item after all
  stages (engine.ts:1210) → one cumulative diff per item @ final issuance token; item
  identity gains GENERATION (revise re-enumerates the fanout, engine.ts:1464 — same
  index ≠ same item) → key `(runId, scopedId, item epoch)`, old generations
  `superseded`; journal states `prepared→accepted→merged/superseded` w/ engine-audit
  reconciliation for the prepared→accepted crash window; (2) `git apply --check` is
  NOT a recovery primitive (already-applied vs conflict indistinguishable) and commit
  SHAs aren't witnesses in a no-commit merge path (build.js:4354) → tree-id witnesses
  (git write-tree) + journaled base tree + rollback-to-base on revise/kill
  (build.js:4389/5042 parity); (3) descriptor must carry the contract CLOSURE (named
  refs resolve recursively, validate.ts:62/145; root-only shape not self-contained);
  (4) typed rejection = stable error CODE `consumer_dispatch_bg_unsupported` in the
  MCP error data envelope + frozen code registry (message regex ≠ type);
  (5) `ready: "array"` validates nothing → frozen shape language gains element
  variants (contracts.ts:36/89). Convergence check: closures accumulating, Highs now
  concentrated in the compose artifact journal — if round 4 opens a NEW front,
  split the compose consumption design into its own gated doc per
  review-convergence rule.
  **Round 4 (2026-07-16):** 3 High + 1 Medium — NO new front (all in the r3
  journal/merge amendments + one revert interaction), tripwire not hit, ALL ACCEPT:
  (1) `accepted` conflated acknowledgment with success (engine evaluates
  contracts/ensures AFTER receipt, engine.ts:1174 — an acked report can retry) →
  `accepted` = "issuance terminalized the item as succeeded"; engine persists
  **`acceptedDispatchToken`** on terminal items, audit exposes it; prepared entries
  store the exact result envelope for idempotent re-report; (2) apply-before-witness
  window remained → full expected witness chain precomputed in a TEMPORARY INDEX
  (build.js:4562 pattern; plain write-tree hashes the index and compose applies
  --index-less over dirty state) and journaled BEFORE first mutation; rollback
  restores the full baseline; (3) epoch-keyed generations collide after checkpoint
  revert (revert restores steps incl. epochs) → run-level monotonic **generation
  counter persisted OUTSIDE checkpoint snapshots**, advanced on every
  (re-)enumeration, exposed in descriptors, keys compose artifacts; (4) shape
  grammar specified: `arrayOf` + `oneOf` w/ strict variant matching, checker +
  JSON-schema translator share it.
  **Round 5 (2026-07-16):** 4 must-fix + 2 should-fix, ALL ACCEPT — depth iterations,
  no new front: (1) checkpoint revert can restore an already-TERMINAL fanout + its
  waiting merge gate whose artifacts were superseded/deleted (generation counter
  can't help — nothing re-enumerates; checkpoints at waiting gates + terminal-run
  reverts are legal, engine.ts:451/1804, p5:128/149) → v1 PROHIBITS commit/revert
  from first consumer issuance until the merge gate resolves (ship-narrow: kill the
  class, bg follow-up may design retention); (2) intermediate stages crash-unsafe →
  `prepared` entry (token + exact envelope) journaled per EVERY issuance, diff only
  at final stage; (3) in-tree journal invalidates its own witnesses (`.compose/` not
  guaranteed ignored, build.js:4509; snapshot = git add -A @4562, apply --cached
  @4544 — citation fixed) → journal OUTSIDE the target tree + witness-chain ids must
  be unique or abort pre-mutation; (4) grammar got a concrete tagged encoding —
  `{"$array":…}`/`{"$oneOf":[…]}`, $-keys reserved, matching = exactly one COMPLETE
  strict shape (undeclared fields rejected — else descriptor ⊃ ReadyStep matches
  both); (5) frozen `errors` registry: top-level mcp-surface section
  `{code:{data:<shape>}}`, p5 asserts the actual JSON-RPC error data (bypasses
  assertToolResponse, server.ts:152); (6) stale test row still said item-epoch key →
  fixed to generation. Round-6 re-review dispatched; gate until CLEAN. If round 6 is
  not clean-or-trivial, STOP and restructure per review-convergence rule (engine side
  is converged; the compose journal protocol is the recurring well).
  **Round 6 (2026-07-16): 2 High + 3 Medium → TRIPWIRE FIRED, GATE CLOSED WITH
  RESTRUCTURE.** Bounded findings fixed at design altitude (all ACCEPT): pre-stage
  worktree witness + restore-before-reexecute (crash after agent mutation, before
  `prepared` write); mid-diff kill leaves a tree matching NO witness (git apply of a
  multi-file diff isn't atomic) → normative unmatched-tree rule: restore journaled
  baseline, replay-from-zero or revise/kill, NEVER complete a partial diff in place;
  lifecycle-guard release anchored to a VALIDATED direct-successor gate required for
  consumer+worktree fanouts (D5 authoring invariant promoted to validation via the
  worktree proxy; no-gate behavior specified); ordinary variant gains
  `previousFailure?` w/ defined `?` optionality (else every ordinary retry fails the
  frozen contract). Finding 5 (exact descriptor wire encoding) resolved STRUCTURALLY:
  new "Specification boundary (r6)" section — 4 consecutive rounds of High findings
  in the prose crash-protocol = spec-too-broad signal; encodings move to frozen
  contract FILES authored as implementation step 1 (per planning-standards: shapes
  live in contracts, not prose), and the kill-based crash-test suite — not prose
  iteration — arbitrates the recovery protocol. DESIGN GATE COMPLETE: 6 rounds,
  ~25 findings, all adjudicated ACCEPT + amended or structurally resolved; zero
  category errors across the run. Next: implement (step 1 = author frozen
  contracts).
  `.claude/rules/` (both branches: develop 1bf928d, main 78634e4 — breadcrumbs/
  compose-loop/incremental-builds retired, journaling demoted to milestones).

- **FENCING PHASE 1 (step_done epoch echo) — ✅ DONE 2026-07-15 (stratum + compose develop).**
  Closes review finding 4's live exposure ahead of the fanout feature. Design AMENDED first:
  STRAT-TS-FANOUT-CONSUMER's original "dispatchToken optional/ignored for ordinary ids" cut
  would have CEMENTED the unfenced-step_done defect — fencing is now UNIVERSAL, two phases
  (P1 epoch echo now; P2 per-issuance dispatchToken required-for-all at the fanout flag-day,
  which also closes same-epoch late-retry duplicates that per-revision epochs cannot).
  - stratum: `step_done.request` declares optional `epoch` (surface 6→7, p4 pin), server
    forwards to the engine's existing `expectedEpoch` check; p5 golden: stale echo rejected
    ("superseded epoch"), current echo accepted. Suite 572 pass / 1 skip.
  - compose (develop): `StratumMcpClient.stepDone` transmits an integer 4th-arg `epoch`;
    build.js echoes `readyStep?.epoch` at BOTH live TS-path call sites (generic ~1787 +
    ship-interception ~1590). New golden `test/ts-cutover-epoch-echo-golden.test.js`:
    (a) full runBuild revise round records echoes work@0, work@1, finish@1; (b) compose's
    own client against the real TS bin — stale epoch rejected, current accepted.
  - **Engine semantics learned (don't re-guess):** revise bumps the epoch of EVERY
    descendant of the revision target (engine.ts ~1497), not just the re-issued step —
    post-revise `finish` is legitimately issued at epoch 1.
  - Unported paths (subflow/parallel/gsd/new.js stepDone call sites) intentionally NOT
    threaded — they are Python-era paths; they get tokens when ported (P2).
  - Codex review (sol/high): CLEAN; one Low residual — the epoch golden covers only the
    generic dispatch site, not ship-interception (same 1-line expression). Accepted: the
    "ship interception stepDone → TS-shaped" work-list item owns that site and its golden.
  - **Known-broken on compose develop (PRE-EXISTING, verified via lib-reverted baseline —
    identical failures with and without this change):** the full suite shows ~17 fails, all
    Python-envelope-era tests broken by the TS-native port of build.js's loop, pending
    port-or-delete with their paths: `test/stratum-mcp-client.test.js` (5 + timeout),
    `test/build-integration.test.js` (4: integration/sub-flow/resume + policy),
    JSONL integration (2), parallel_dispatch branch tests (2 — die with the fanout port),
    proof-run (2 — known full-suite flake on main too). Cutover slices gate on the
    ts-cutover goldens (all 12+2 green), not this legacy set.

- **CONTROL-PLANE HARDENING (post-review) — ✅ DONE 2026-07-15 (this commit).** Whole-port
  adversarial review (codex sol/high, 2 runs: main...develop diff + full ts/src vs Python)
  surfaced 4 control-plane defects; the 3 independent of consumer-fanout are fixed here,
  RED-first (5 new tests; full suite 571 pass / 1 skip; tsc clean):
  1. `resume()` bypassed the bg sole-mutator guard (Python `bg_owned` parity, server.py:1057) —
     now guarded like stepDone/commit/revert, and made `async` so the guard REJECTS instead of
     throwing synchronously (the non-async method leaked the throw past `.rejects` semantics).
  2. A cancelled run could still be advanced/completed through its waiting gate — gates are the
     one ownership-guard exception, so `gateResolveLocked` now refuses on the durable
     `cancelRequested` flag; restart-covered by a rehydrate golden.
  3. Legal terminal reverts violated the frozen surface AFTER persisting (checkpoints snapshot
     `status`, so reverting to a post-failure checkpoint returns failed/budget_exhausted; the
     adapter then threw "undeclared status") — `stratum_revert` now declares both shapes,
     surface 5→6 (p4 pin updated; p5 exhaustive-coverage exercises both).
  Finding 4 — `step_done` unfenced on the wire (stale/duplicate reports accepted; epoch never
  sent over MCP) — rides with STRAT-TS-FANOUT-CONSUMER's dispatchToken design; extend the
  fencing to ORDINARY client-executed steps there, not just fanout descriptors.
  **Review residuals (real, not fixed here; file/track):** SDK transport ignores
  `STRATUM_CODEX_STREAM_LIMIT_BYTES` (memory bound only guards runExec); restart of an
  in-flight worktree fanout leaks the superseded worktree (engine.ts ~1094 overwrites
  `item.worktree` without pruning); bg agent `meta.json` persisted after spawn+unref (a persist
  failure orphans a live detached process); TS requires explicit `workspaceRoot` where Python
  captured cwd at plan time (migration footgun); single-owner state root documented-unsupported
  but unenforced (two live MCP servers can double-drive bg runs). Also: all three transports
  (Python, exec, SDK) CONCATENATE agent messages (deliberate parity; SDK's own run() takes
  last-message-as-final — revisit post-cutover); codex.live test gates on global `codex` in
  PATH though the SDK bundles its own binary.
  **Env sidebar (don't relearn):** two mid-work suite failures were NOT code — CodeIsland wrote
  orphaned `[mcp_servers.stratum.tools.*]` blocks (no parent server table) into
  `~/.codex/config.toml` @ 22:44, making the codex binary reject the whole config ("invalid
  transport in mcp_servers.stratum") = every SDK/exec dispatch fails. Removed the 3 orphaned
  blocks (backup: `~/.codex/config.toml.bak-20260715-2252`).

- **stratum#6 (node ≥26 bin fix) — ✅ DONE + VERIFIED (2026-07-12).** Code fix already
  landed @ 494fa60 (`extraNodeFlags()` in `ts/src/cli/node-flags.mjs` gates
  `--experimental-transform-types` via `process.allowedNodeEnvironmentFlags`; erasable-only
  syntax means type *stripping*, default-on in node ≥24, suffices). Verified on homebrew
  **node 26.0.0**: CLI bin `--help` exits 0; MCP bin answers `initialize` with a valid
  JSON-RPC reply (serverInfo stratum-mcp). D5 Phase-2 entry gate CLEARED.
  - **Residual (non-blocking follow-up):** both bins emit `DEP0205` — `module.register()`
    is deprecated for `module.registerHooks()` (in `ts/src/cli/bootstrap.mjs`). Warning
    only today; a future node major may remove it. Track + fix before it becomes the next
    "#6". Node-22 pin wrapper (`~/bin/stratum-ts`) can be dropped once callers move.
- **STRAT-TS-GUARD — ✅ COMPLETE + PUSHED** (origin/main @ 25fb104, v0.2.97). 5 guard
  tools, cross-engine byte-parity + Python↔TS mutual-exclusion proven. Residual: compose
  `guardBin()` unpin → STRAT-PY-SWEEP row 4 (Phase 4).
- STRAT-TS-PARALLEL — ⏸️ PAUSED (dead-on-arrival; real path = STRAT-TS-PARALLEL-FANOUT post TS-2).
- STRAT-TS-ITER — NEEDS-WIRING (no live caller; engine auto-drives iterate). Confirm a
  consumer before porting the 3 tools.
- STRAT-TS-FLOWCTL — commit/revert KEEP, skip_step thin-KEEP, check_timeouts PARK.
- STRAT-TS-JUDGE-TOOL — ABSORB (judged: ensures over TS judge backend) + 2 deltas
  (budget-ledger wiring, evidence-bounding tests).

## Phase 2/3 usage audit — DONE 2026-07-12 (codex terra/high + Opus verification)

Evidence-backed dispositions (verified: KILL candidates have 0 non-doc/non-test refs;
"adapter-only" = a method on compose `lib/stratum-mcp-client.js` with NO caller of that
method anywhere — the wrapper existing ≠ the surface being live).

| tool(s) | live consumer | disposition | evidence |
|---|---|---|---|
| flow_run_bg / flow_bg_poll / flow_cancel_bg | already on TS | **KEEP (done)** | server.ts:24,76-78; mcp-surface v3 |
| compile_speckit | agent skill | **PORT or retire-with-skill** | stratum-speckit/SKILL.md:213,235 |
| distill | agent skill | **PORT or retire-with-skill** | distill/SKILL.md:20-23 |
| commit / revert | speckit skill (recovery) | **PORT or retire-with-skill** | stratum-speckit/SKILL.md:280 (adapter methods themselves uncalled) |
| skip_step | adapter-only, no caller | **thin KEEP or PARK** | client.js:307 only |
| iteration_start/report/abort | adapter-only, no caller | **NEEDS-WIRING / PARK** | client.js:330,344,359 only; engine auto-drives iterate |
| check_timeouts | none | **PARK** | 0 refs; no field precedent (roadmap) |
| goal / goal_decide / goal_status / goal_archive | none | **PARK** | 0 refs; dormant kernel |
| decompose | none | **KILL** | 0 non-doc/non-test refs |
| draft_pipeline | none | **KILL** | only a doc audit table |
| list_workflows | none | **KILL** | 0 refs |
| read_centered / read_transcript_centered / blame_session | none | **PARK (maybe separate small server)** | 0 refs; session-ergonomics, not engine |

**Owner directive OVERRIDE (2026-07-12): DON'T LOSE ANYTHING — no kills.** These tools were
deliberately designed and built in Python; every capability is preserved. This SUPERSEDES the
KILL/PARK table above:
- **KILL is removed from this retirement.** decompose / draft_pipeline / list_workflows are NOT
  killed. (decompose is anyway part of the STRAT-GOAL subsystem, not a stray tool.)
- **"Park" no longer means "maybe delete."** It means "port LATER, lower priority." The Python
  code for anything not yet ported STAYS LIVE until its TS port exists.
- **Port-before-delete is the hard rule.** Phase 5 deletes a Python tool ONLY once its TS
  equivalent is verified. Nothing breaks in the interim because Python remains the fallback.
- So every tool is **PORT** (now or queued) or **KEEP (already on TS)**. Full surface → TS.

### PORT-NOW vs PARK split (owner: "figure out what to park; do it in phases; UIs are planned")

Rule: **PORT-NOW** = has a live consumer today (blocks the active-surface cutover). **PARK** =
no live consumer yet / gated on a not-yet-built UI → DEFER the port, keep the Python tool LIVE
(never deleted until ported), port it in the phase where its consumer/UI lands. Nothing killed.

**PORT-NOW (active surface — the near-term retirement):**
- [x] commit / revert (shipped), flow_run_bg / flow_bg_poll / flow_cancel_bg (KEEP, done).
- [ ] compile_speckit — live consumer: stratum-speckit skill.
- [ ] distill — live consumer: distill skill.

**PARK (defer; Python stays live; port when the trigger arrives):**
- STRAT-GOAL subsystem (decompose, goal, goal_decide, goal_status, goal_archive) — big worker→
  judge capability, 0 live consumers today. Trigger: a real goal-loop consumer, or a dedicated
  GOAL-on-TS phase. Preserved + live meanwhile.
- iteration kernel (start/report/abort) — no live caller; TS auto-drives `iterate`. Trigger: a
  manual-loop consumer.
- skip_step — no live caller. Trigger: a consumer appears (thin, quick port).
- check_timeouts — no consumer + needs IR gate `timeout` + `dispatchedAt` (STRAT-TS-FLOWCTL
  remainder). Trigger: a gate-timeout consumer.
- transcript tools (read_centered, read_transcript_centered, blame_session) — session ergonomics,
  no consumer. Trigger: decide engine-vs-small-sibling-server, then port.
- **draft_pipeline — PARK until the PipelineEditor UI phase.** The UI is PLANNED (owner confirmed),
  built in a later phase; port draft_pipeline alongside it. Python stays live till then.
- STRAT-TS-JUDGE-TOOL (standalone judge tool) — the `judged:` backend ALREADY works on TS; the
  standalone tool has no consumer. Trigger: a caller needs the tool form; close the 2 deltas then.

**Consequence for Phase 5:** deletion is INCREMENTAL and phased — delete each Python tool only
once its TS port is verified. Near-term Python shrinks to the PARKED set (a demoted, dormant-but-
live legacy surface); full Python deletion is a long horizon tied to the UI/consumer phases.
"TS-only for the active surface" is the near-term goal; "zero Python" is the eventual one.

### Near-term execution queue (ordered)
1. [x] PORT commit/revert → TS (STRAT-TS-FLOWCTL checkpoint slice) — **SHIPPED 2026-07-12** (v0.2.109).
2. [x] PORT compile_speckit → TS — **SHIPPED 2026-07-12** (session 70422c49). Brief:
   `docs/features/STRAT-TS-SPECKIT/build-brief.md`. RE-PORT to TS v1 IR (Python emits old IR the
   TS engine can't run). `ts/src/speckit/compiler.ts` (pure: parser/dep-graph/criterion/step-id/
   collision ported byte-for-byte from `task_compiler.py`; emits `do:` steps, structured ensures,
   shared strict `TaskResult{done, tests_pass?, lint_clean?}`, flow output = last sorted task).
   Tool `stratum_compile_speckit` (server.ts dispatch + surface 4→5, ok/error), 38 compiler tests
   incl. validateSpec round-trip. Codex WROTE (sol/high), 2 review rounds → REVIEW CLEAN.
   - **R1 findings (both CONFIRMED, Opus-fixed):** (High) `${...}` in task text → un-plannable IR
     returned as ok (TS reads `${}` in `do` as a reference; NO literal escape). (Med) flow_name
     "entry" overwrote the entry sentinel. FIX: `compileSpeckit` now `validateSpec`s the built
     spec before returning (same gate `stratum_plan` uses → guarantees plannability) → throws
     `compile_error`; `buildSpec` guards reserved `flow_name "entry"`. R2 CLEAN.
   - **Follow-up filed — stratum#8:** engine-level escape for literal `${}` in interpolated fields
     (restores Python pass-through of shell/template task text). Own feature, lower priority.
   - Gates: tsc + erasableSyntaxOnly clean; full suite 561 pass / 1 skip / 0 fail.
3. [→PARKED] PORT distill → TS — **RE-CLASSIFIED to the deferred transcript-substrate unit
   (owner decision, 2026-07-12, session 70422c49).** Scoping found distill is NOT engine/flow
   code — it's transcript mining (~620 LOC distill core: detector/synthesize/runner/candidate)
   that drags in `postmortem.loader` (CC-transcript reader iter_sessions/Session/Event) + a
   sidecar writer, ~1000 LOC closure, none engine-related; the live path is deterministic (the
   synthesize LLM override is unused). It sits on the SAME transcript substrate as the parked
   transcript tools (read_centered/read_transcript_centered/blame_session) whose engine-module-vs-
   small-sibling-server home is UNDECIDED. Owner: group distill + those transcript tools as ONE
   deferred unit, decide their home together, port together in that phase. Python distill stays
   LIVE (no loss, port-before-delete). Was queue item 3; now in the PARKED transcript-substrate
   group below. NEXT = Phase 0/1 compose cutover (the higher-leverage retirement step).
4. [ ] **Phase 0/1 (compose): compose→TS cutover ← NEXT.** GATED (owner, 2026-07-12): dogfood
   internally before ANY flip; **compose must remain compatible** — that's the flip precondition.
   **SEAM TOPOLOGY MAPPED (codex 9bdf47b186e5, sol/high, evidence-backed; Opus adjudicated —
   split-brain CONFIRMED). The monitor-seam flip is NOT a coherent standalone step:**
   - compose has TWO seams: (a) `server/stratum-client.js` = CLI query/gate/guard (monitor reads +
     human gate), engine-selectable via `stratumEngine`; (b) `lib/stratum-mcp-client.js` = MCP-
     stdio client for build EXECUTION (plan/step_done/gate_resolve/audit), directly spawns
     `stratum-mcp` (Python), **NOT engine-aware** (build.js:1117 connect({cwd}) only).
   - `stratumEngine="ts"` switches ONLY seam (a) + a startup bin probe. Execution stays Python.
     Stores are SEPARATE (Python `~/.stratum/flows/`, TS `~/.stratum/ts/flows/`), so flipping the
     monitor alone makes TS query an EMPTY store → **blinds the monitor.** The existing soak
     (`scripts/stratum-ts-soak.mjs`) already knew this: it keeps the workspace on Python and seeds
     a SYNTHETIC TS flow — so the soak NEVER tested compose-on-TS execution.
   - Pointing the exec client at the TS MCP bin is necessary but **NOT sufficient — the TS MCP
     contract is WIRE-INCOMPATIBLE** with what compose sends: compose sends {spec, flow, inputs},
     flow_id/step_id/outcome, expects Python dispatch statuses (execute_step/await_gate); TS wants
     {spec, input, workspaceRoot}, runId/stepId/decision, returns ready/running/completed. TS MCP
     also LACKS tools compose uses (parallel/iteration).
   - **Minimum coherent cutover (5 items):** (1) execution on TS MCP; (2) shared STRATUM_STATE_ROOT
     for MCP+CLI; (3) an engine-aware **contract adapter** (request-field + response-status +
     ready-step translation); (4) convert compose v0 pipeline specs → TS v1 (= the TS-2 agent-
     authoring cutover); (5) remove hard-coded Python-store reads (`lib/flow-state.js:27` gate-round,
     `lib/build.js:5219` abort cleanup). Guard stays Python-pinned = a runtime dep, NOT a flow-store
     split (guard root `~/.stratum/guards/` is separate; nothing joins guard+flow state).
   - **Two contract-decisions the harness must EXPOSE (not normalize):** (i) terminal divergence —
     Python DELETES completed-flow persistence (server.py:948/2610), TS PERSISTS completed runs
     (engine.ts:639); decide if the compat contract is "completed flow disappears" vs "stays
     queryable". (ii) pre-existing Python coherence risk — MCP caches live flows in `_flows` while
     the CLI gate command mutates a separate disk copy (server.py:942/2578/5020); test CLI-gate-
     mutation → MCP-resume/advance, a shared dir is NOT proof of live-process coherence.
   - **Harness (owner chose "I build it"):** per-engine ISOLATED state root, run the same golden
     fixture (plan→gate→approve AND →revise→complete→audit) natively on each engine, diff the
     projections compose consumes (query flows/flow/gates + gate approve/revise; through
     stratum-client.js → StratumSync.readFlows → StratumPanel fields). CANNOT drive compose's exec
     client against TS yet (contract gap = the adapter's job). So the harness proves MONITOR/
     PROJECTION parity + quantifies the adapter's gap list; it is a diagnostic, not a flip green-light.
5. [ ] Phase 4 sweep (active surface): .mcp.json → TS stdio; forge+compose default → ts; keep the
       Python server registered ONLY for the parked tools; D4 codex_models relocation;
       CLAUDE.md/skills → TS for ported tools; retire soak cron.
6. [ ] Short TS-only-active-surface real-usage window.
7. [ ] Phase 5 (incremental): delete the Python for each PORTED tool once verified; final PyPI
       handling deferred until the PARKED set is also ported in its later phases.

### Parked-ports backlog (later phases, nothing lost)
P1. GOAL subsystem → TS.  P2. iteration kernel + skip_step + check_timeouts (IR timeout work).
P3. **transcript-substrate unit** = transcript tools (read_centered/read_transcript_centered/
    blame_session) + **distill** (grouped 2026-07-12): first decide the family's home (TS engine
    module vs small sibling server), then port together. distill needs a CC-transcript loader +
    sidecar writer; deterministic live path.  P4. draft_pipeline (WITH PipelineEditor UI phase).
P5. STRAT-TS-JUDGE-TOOL standalone + deltas.

## MCP-surface design review — CLOSED 2026-07-12 (owner-interactive; details in memory `project_ts_cutover_branch`)

Decisions: engine surface stays lean/frozen. Parallel = **Option C**: consumer-dispatch as a
first-class TS fanout mode (`dispatch: engine|consumer`) — key insight: TS is ALREADY client-
executed per step (ready[]/stepDone), so fanout items surface in ready[], per-item stepDone,
retries via attempts/ensure, consumer-merge = gate-after-fanout, capture_diff leaves the engine.
iterate/judged stay engine-native (3 iteration_* + stratum_judge tools dropped). Goal = a SPEC
authored from primitives, not a tool. Transcript/distill: 4 Python tools + distill skill retire
at merge; successor = **stratum's OWN provenance verbs (3-5, capability-gated) delegating to
SmartMemory as invisible backend** (encapsulation; Temporal-Visibility model; engine kernel never
depends on it) — post-cutover surface bump w/ own design doc. SmartMemory MCP = direct memory
customers only; its ~93-tool surface needs a diet (SmartMemory roadmap). One-product adoption.

### Control-plane audit — CLOSED 2026-07-12 (nothing blocks cutover)

Coverage strong: start/bg-start/cancel-bg/gates/retry-redrive(attempts+on_fail+revise+commit/
revert)/pause-via-gates/resume all ✓; **budgets (usd/tokens/dispatches/ms) + guard policy ledger
are DISTINCTIVE control surface most engines lack** (positioning point). Three gaps, all
post-cutover follow-ups, none built now: (1) **terminate-any-run** — kill exists only at gates +
bg; a dead-client foreground run can't be explicitly abandoned (matters more since TS persists
runs); (2) **retention/GC** — TS keeps all runs forever, no cleanup policy (Python deleted
completed); (3) **durable timers/signals** — no "wait 2h"/"wait for external event" IR construct;
gates cover human decisions, client-executed steps cover foreground events by architecture; treat
like goal = declared future primitive, add when a consumer arrives (gate-timeout auto-kill stays
parked per field survey).

## STRAT-TS-FANOUT-CONSUMER design — LANDED 2026-07-12

`docs/features/STRAT-TS-FANOUT-CONSUMER/design.md` committed to ts-cutover. Codex-drafted
(run `3ec04d14a05b`, sol/high), owner-adjudicated faithful to the locked Option-C skeleton.
D1 `dispatch: engine|consumer` (engine=byte-for-byte default); D2 scoped item id
`<fanout>/<index>` + per-item epoch (engine-side, no wire field); D3 existing attempts/ensure
own retry; D4 `require` settles once all items terminal (no early-any); D5 merge = explicit
downstream gate (`gate_resolve` approve/revise/kill), diffs never enter the engine. MCP surface
delta = only `flow_bg_poll.ready` + `bg.status: awaiting_consumer` (surface bump → P4/P5 count
fixes). Grounding verified locally: fanout root-only (`engine.ts:1673/1678`), subflow scoped-id
precedent, `step_done.stepId`/`gate_resolve.decision` are `string`, compose parallel call sites.

Review round: codex sol/high pool hit usage-limit (reset 15:53) → ran spark/xhigh instead
(run `ae5f10e0851b`). All 7 findings were the design-gate category error (reviewed the design as
shipped code: "current code doesn't already do X" for each proposed change). One exposed a real
ambiguity (#6 epoch-not-on-wire) → added one sentence clarifying engine-side epoch enforcement
mirroring ordinary steps' `expectedEpoch`. No decision changed. Design is CLEAN.

## Wire port (client) — GREEN 2026-07-12 (compose ts-cutover @ e29e62b)

`compose/lib/stratum-mcp-client.js` ported to TS-native vocab; `test/ts-cutover-golden.test.js`
RED→GREEN (1 pass, real TS engine, full plan→step→gate→approve→finish→audit lifecycle). Built by
codex sol/high (run `7c58705777fc`), verified locally under Node 22, adjudicated, committed.
Narrow test-gated slice — only the 4 methods the test exercises:
- plan `{spec,flow,inputs}`→`{spec,input}`; stepDone `{flow_id,step_id,result}`→`{runId,stepId,result}`;
  gateResolve `{flow_id,step_id,outcome,rationale}`→`{runId,stepId,decision}`; audit `{flow_id}`→`{runId}`.
- `#callTool` prefers TS `structuredContent` (status/runId/ready direct), JSON-text fallback kept.
- Method signatures unchanged (compose API); undeclared keys dropped (TS rejects them). Vocab is
  PER-TOOL: audit=runId, commit/revert (untouched)=flow_id — follow mcp-surface.json, no blanket rename.
No codex review round (31-line rename proven by a real golden flow = verification theater to skip).
Note: compose ts-cutover has UNRELATED uncommitted COMP-AUDIT-1..18 work (memory `project_comp_audit_2607`) — left untouched.

## build.js SIMPLE path — GREEN 2026-07-12 (compose ts-cutover @ e193432)

`runBuild`'s simple (non-parallel, non-gate) dispatch loop consumes TS-native responses end-to-end
over the real TS engine. Gated by `test/ts-cutover-build-golden.test.js` (drives real runBuild, agent
stubbed at the connector-factory seam, engine real). 4 cases: happy single-step, no-out step completes,
failing flow terminalizes as failed, template≠entry-flow contract resolution. Both goldens: 5 passed.
Built + reviewed via codex sol/high (map `65c878442e2d`, porters `e4eb935d26b0`/`f4f86ca566cc`,
reviews `2d7c491f485b`/`2ca91c652a56`); 3 review-found simple-path defects fixed with regression
coverage (failed-terminalization, no-out `{}` vs `{failure}`, flows.entry pointer resolution).
Key architecture: PRODUCER owns contract metadata — `resolveStepOutputContract()` derives each step's
out-contract from compose's OWN locally-parsed spec (TS response carries none; lean surface). stepDone
result is TS-shaped (`{output}`/`{}`/`{failure}`, no legacy keys).

### Remaining cutover work-list (exhaustive site map = codex run `65c878442e2d`)
Simple-path deferred sub-cases (build.js): gate/await_gate → running + audit-based gate discovery
[DONE, gate slices]; ~~resume() `{flow_id}`→`{runId}` (+ build.js:1295 step_id)~~ [DONE 2026-07-15,
compose develop @ 2fa4840 — see slice below]; ship interception stepDone → TS-shaped;
default client server flip `stratum-mcp`(Python)→TS bin (do LAST, once consumption ported — flipping
early breaks still-Python paths); output-vs-contract robustness (coerce/validate agent output before
`{output}`; `outputFieldsToJsonSchema` is loose). Bigger units: subflow/execute_flow + scoped-id
(`parent/child`) contract resolution in resolveStepOutputContract; parallel/parallel_dispatch → fanout
consumer mode (design @ 449c961); GSD path (gsd.js); de-hardcode Python-store reads
(`flow-state.js:27`, `build.js:5230/5238`); v0→v1 spec authoring (compose pipelines are v0, TS runs v1).
Test hardening nits: assert exact `{}` payload, `flowId===runId`, budget_exhausted terminal case.
Then: dogfood locally, atomic merge (both repos).

## build.js GATE path (auto-approve) — GREEN 2026-07-12 (compose develop @ 6fc1e28)

`runBuild`'s gate branch ports off the retired Python `status==='await_gate'` envelope onto the TS
engine's foreground-gate shape: TS returns a bare `status:'running'` (no gate id) and marks the gate
step `waiting_gate` in the audit. New branch discovers the single non-scoped `waiting_gate` step that
the local spec declares a `gate` node (0 → break as non-dispatch running; >1 → throw, single-gate seam),
producer-synthesizes gate metadata (gate_type=approval, from/to phase from local spec, artifact/summary
from stepHistory), keys the policy by the GATE STEP ID (not the synth approval target — else
`evaluatePolicy`'s `toPhase ?? stepId` defaults to human-gate and hangs), resolves via `gateResolve`,
and continues the loop. Gated by `test/ts-cutover-build-gate-golden.test.js` (work → review flag
auto-approve → finish over the real TS engine); both goldens 5 passed. Self-implemented (codex crashed
3× on the pre-fix sweep bug — see agent-run hotfix below); independent codex review = run `b850d005296a`.

### FOLLOW-UP SLICE — human interactive gate over TS — DONE 2026-07-12 (compose develop @ 8709038)
The prior slice covered ONLY the auto-approve (flag/skip) path. This slice makes `policy.mode==='gate'`
(human) TS-correct, with a golden driving revise/kill/prompt over the real TS engine. Codex-written
(run `7fa30b4c720b`, gpt-5.6-sol/high), every change adjudicated vs code + verified locally (8 goldens +
4 unit green).
- [x] **(High) revise round read** — `readFlowRound` (`flow-state.js`) now reads the TS store first
  (`STRATUM_STATE_ROOT`-aware; flows stored FLAT at the root, not under `ts/flows`; fresh run → round 0,
  NOT 1), Python store as fallback. **Extra bug found beyond the checklist:** the old code hardcoded
  `homedir()/.stratum/flows` and ignored `STRATUM_STATE_ROOT`, so it silently failed under any custom
  state root (incl. the test harness). Closes the "de-hardcode Python-store reads" item for this reader.
- [x] **(High) kill → killed marker** — human `kill` (on_kill:null → TS `terminalFailure`/`failed`) is
  remapped to `killed` right after `gateResolve`, so the existing `killed` terminal branch (build.js
  ~2542) records an aborted build (item killed, feature→PLANNED). Guarded on `outcome==='kill'` + terminal
  status only, so an `on_kill`-routed kill (running/ready) is NOT remapped.
- [x] **(Med) synthesized routing to the prompt** — `makeAskAgent`/`promptGate` now receive a
  `gateDispatch` synthesized from the local spec node (`step_id`,`on_approve`,`on_revise`,`on_kill`);
  no more `Gate: undefined`.
- [x] **(Low) predecessor artifact/summary** — uses the gate's declared `after` predecessor from
  `stepHistory`, falls back to last.
- **Coverage boundary (honest):** the golden drives the CLI prompt path (dead `COMPOSE_PORT` → no server),
  which re-prompts regardless of round — so it does NOT observe the round read (empirically: forcing
  `readFlowRound`→const still passes the golden). The round-collision only manifests on the
  server-delegated path (`pollGateResolution` replaying a stale resolved gate). Locked instead by a
  direct unit test `test/flow-state-round.test.js` (TS-first, 0-based, env-aware, Python fallback).
- **Documented v1 limitation (NOT a bug):** >1 concurrent root gate throws by design (single-gate seam).
  Revisit only if a real compose pipeline needs concurrent gates.

### SIMPLE-PATH SLICE — resume() over TS — DONE 2026-07-15 (compose develop @ 2fa4840)
Ports the build.js resume path off the retired Python envelope. Codex-written (run `f3c5cc2d32c8`,
gpt-5.6-sol/high, write=true), every change adjudicated vs code + verified locally (13/13 goldens).
- [x] **(High, load-bearing) client `runId` rename** — `StratumMcpClient.resume(flowId)` sent
  `{ flow_id }`, but the TS MCP `stratum_resume` tool (`ts/src/mcp/server.ts:97`) reads
  `string(request,"runId")`, which THROWS `"runId must be a string"` when absent → `stratum.resume()`
  threw before the engine ran. Now sends `{ runId }`, matching the stepDone/audit/gateResolve siblings.
  Resume was fully DEAD over the TS engine until this; the client was the real defect.
- [x] **(Med) build.js resume-branch field normalization** — the branch (~1289–1332) read
  `response.step_id`/`response.flow_id` (Python names, `undefined` on TS). Now reads TS-first
  (`response.ready?.[0]?.id ?? response.step_id`, `response.runId ?? response.flow_id ?? resumeFlowId`),
  fixing the "Resuming from step: undefined" log + the active-build `currentStepId`/`flowId` write.
  (The `flow_id` reads worked only by the `flowId` fallback and were immediately re-derived by the
  main loop's `updateActiveBuildStep` — so this field is cosmetic; the client rename is the fix.)
- **Golden** `test/ts-cutover-build-resume-golden.test.js`: drives a real interrupt (throwing agent
  leaves the TS run non-terminal), audits over a 2nd client that the run is still `running` with its
  step `ready`, wraps `resume` to assert the real TS resume path fires once, resumes over the real TS
  bin, asserts the resumed step re-executes and the build completes retaining the runId. RED until the
  `{ flow_id }`→`{ runId }` rename (resume throws otherwise). No rubber-stamp.
- **Sandbox note:** codex's workspace-write jail EPERM'd `flow-state-round.test.js`
  (`~/.stratum/flows/` write); outside the sandbox all 13 pass. A codex "# fail 1" on that file is a
  jail artifact, not a real failure.

## Phase 0/1 (compose repo) — not started this session
## Phase 4 (sweep) / Phase 5 (remove) — not started
