# Changelog

## [Unreleased]

- **Codex background runs register as Claude Code peer sessions.** The tentative `peerName`
  lets callers subscribe with `notify_when_idle`; polling reports registration status. Set
  `STRATUM_PEER_REGISTER=0` to disable registration. Terminal peers linger for 15 seconds
  by default (`STRATUM_PEER_LINGER_MS`). The integration is coupled to Claude Code 2.1.272's
  peer protocol and skips registration when a live peer advertises a newer protocol.

- **chore(connectors): drop the dead `budgeted` guard on background agent runs
  (STRAT-AGENT-BG-BUDGET superseded).** Nothing in `ts/src` set the flag. Background run usage is
  debited by reporting a `stratum_usage_report` receipt: poll returns `usage`/`split`/`usdSource`,
  and the caller reports it with the run id as `dispatchId`.

- **Claude defaults updated to Sonnet 5.** Foreground, background, and app connector defaults now
  use `claude-sonnet-5`; living specifications and connector docs match. The workflow-budget design
  also seeds current Claude model pricing while retaining older model rows for historical cost lookup.

- **Optional contract fields now accept explicit `null`.** `T?` now means `T | null | undefined`
  rather than only `T | undefined`, widening both declared-contract and flow-input validation while
  leaving required fields and type checks unchanged. The canonical case is an agent reporting that
  it made no commit as `commit_hash: null`: this failed both a retried `ship` step whose first attempt
  had already committed and the 2026-09-15 `explore_design` step in flow
  `00540397-0bec-4aa5-b6d5-2eb5634f7201`, where the design already existed. This closes the previously
  filed open question about a retry being unable to satisfy its contract after the failed attempt
  already committed.

- **`step_usage` events now state the amount AND its provenance (`usd_source`).** The consumer used
  to infer provenance from whether `cost_usd` was present, so a producer sending an honest estimate
  had it silently relabelled as provider-reported spend. Its only safe alternative was to omit the
  cost entirely, which compose's stream validator then rejected outright — 6 dropped events per run,
  measured. Both connectors now say how they know: `claude.ts` emits `usd_source: "reported"`
  (Claude reports a real cost), and `codex.ts` emits its OWN estimate with `usd_source: "estimated"`,
  computed by the same `usdFromTokens` the final result uses. Codex reports no cost structurally, so
  in practice it is always an estimate — and it is labelled as one, never promoted.

  This also makes the OpenAI/Anthropic cached-token dialect moot on the happy path: because the
  connector states the amount, the consumer no longer prices tokens at all, so it never has to know
  that OpenAI's `input_tokens` includes `cached_input_tokens` while Anthropic's excludes them. That
  mismatch had been worth 2.76x on a real call ($0.49173775 against the correct $0.17813775).

  **Token counts stay RAW** — `input_tokens` still includes the cached portion for Codex. compose's
  routing evidence guard (`lib/routing-runtime.js:187-196`) enforces identity between this event and
  the connector's own evidence; translating here was tried (d006278) and reverted (1c2646c) after
  failing 15 compose tests with `Forwarded tokens differs from original connector evidence`. Because
  `usdFromTokens` is linear in tokens, summing per-turn event amounts reproduces the result's single
  total, so the guard's `usd` comparison holds too. An unpriced model yields 0 and BOTH keys are
  omitted, so unknown cost stays unknown rather than becoming a false $0.

  Full suite 1287 passed, 3 skipped, 0 failed.

## [0.5.2] — 2026-09-10

- **Codex connector: `step_usage` events carry the real cost, or omit it.** The streamed event
  hardcoded `cost_usd: 0`, which a consumer summing events read as "reported: free" and which
  beat the real `usd` on the final result. Now the event carries the turn's reported cost when
  present and omits the key otherwise.
- **Codex connector: successful runs now carry the reported cost.** Both success returns rebuilt
  `usage`/`split` by hand and dropped the `usd`, `usdSource: "reported"` and `cacheRead` the stream
  loop had accumulated from `turn.completed` (the failure path attached them), so every successful
  codex dispatch reached the ledger and usage receipts as cost-unknown. One shared
  `codexUsageFields` now feeds both paths. Found by compose's real-engine wave golden, whose
  cost gate held every run at `WAVE_COST_UNVERIFIED`.
- **MCP surface 20 — `stratum_usage_report` accepts `receipt.detail`**: the engine's `ReceiptInput.detail`
  (a plain object, `engine/receipts.ts`) was never declared in `contracts/mcp-surface.json`, so the
  default-deny request validator rejected every receipt that carried one with
  `receipt.detail is undeclared`. Declared as optional; no engine change. First consumer: compose
  COMP-FABLE-ASTRA slice 3 writes zero-usage metadata receipts (planned per-item model, gate decision,
  wave checkpoint, ownership finding) through it so the run record carries that evidence.
  Found by compose's real-engine wave golden (dispatch 3).

## [0.5.1] — 2026-09-10

- **STRAT-FLOW-CANCEL-FG fast-exit fix**: a flow-tagged foreground agent whose child exited before
  process-identity registration (the darwin libproc probe takes ~40ms; a child gone by then has no
  start time) was failed with `REGISTRY_WRITE_FAILED` "agent would be uncancellable" even though it
  had already finished. `recordForegroundGroup` now retries the probe once after a short yield (macOS
  zombies answer signal 0), omits a positively gone child (ESRCH) from the registry, and stays
  fail-closed for a live or opaque pid without a start time. The flow admission check still runs
  for an omitted child, so a fast agent on a flow cancelled meanwhile is still refused.
  Found by compose's `build-abort-golden` (COMP-BUILD-CANCEL S07).
- `tests/guard/store.test.ts`: the cache-busting dynamic import is typed so `npm run typecheck` is
  clean again (pre-existing TS2307).

## [0.5.0] — 2026-09-10

- **STRAT-FLOW-CANCEL-FG S03 (surfaces)**: `stratum_flow_cancel` MCP tool and `stratum flow cancel <runId>`
  CLI over one shared orchestrator (`engine/flow_cancel.ts`): settle first, then signal, local abort,
  reap under one absolute teardown deadline; lease/lock refusals return `CANCELLATION_UNCONFIRMED`
  with `reason` and `holderPid` and sweep nothing; already-terminal runs return `acknowledged:false`.
  `cancelled` status on audit/flow_poll/flow_bg_poll; MCP surface 18→19 (25 tools). README documents it.
- **STRAT-FLOW-CANCEL-FG S02 (foreground agent registry)**: durable `~/.stratum/ts/agent_fg/<12hex>/meta.json`
  records for cancellable foreground agent runs, a sibling of the background registry so a
  foreground entry can never be loaded and killed as a detached background run. `stratum_agent_run`
  accepts `flow: {runId, stepId?, itemIndex?}` (legal only with `cancellationId`); the record is
  written `starting` before the spawn, stamped `running` with each child's pid and start time
  through a new `onSpawn` connector callback, and stamped `settled` in the dispatcher's finally.
  `engine.admitFlowAgent` gates the spawn before it happens and again after each pid lands, failing
  closed (`flow_not_running`, `flow_admission_failed`); a failed registry write aborts the run, kills
  and reaps the child, and fails the call. `signalFlowAgents`/`reapFlowAgents` sweep a flow's agents
  from any process under one absolute deadline, rescanning so a mid-spawn agent cannot escape, with
  per-id and per-pid accounting (`signalled`/`reaped`/`unreachable`/`alreadySettled`/`unresolved`/`unsettled`).
- **STRAT-FLOW-CANCEL-FG S01 (engine)**: cross-process run lock (`engine/run_lock.ts`: hard-link
  publication, tri-state process identity, dead-only stale takeover), driver lease on pinned runs,
  every persist under the lock, `cancelled` RunStatus, `flowCancel` settle transaction, resume /
  commit / revert refuse a cancelled run, `flow_cancelled` event (events contract 3→4).
- **STRAT-FLOW-CANCEL-FG blueprint** written and verified (`docs/features/STRAT-FLOW-CANCEL-FG/blueprint.md`):
  three slices, 134 refs verified, four Codex sol/high rounds (39 findings) folded. Design pivoted in
  review from a lockless sidecar to a cross-process run lock plus a driver lease; v1 boundary is
  stated in §2.1b. Round-4 fixes not re-reviewed; see its Review log.

- **STRAT-LOOP-CARRY S04 (surfaces)**: consumer descriptor gains `item` (the resolved fanout
  element), `stratum_audit` returns `carry` with provenance, MCP surface 17→18, version 0.5.0
  (compose must take a minor when it adopts the surface). README documents `carry:`.
- **STRAT-LOOP-CARRY S03 (runtime)**: carry scope shared with the run, `${name}` resolution,
  staged atomic `materialiseCarry` (top of advance + after in-loop set/evaluate settles),
  mutation-free revise preflight then carry write + reset + single persist.
- **STRAT-LOOP-CARRY S02 (state)**: `CarryEntry`/`CarryProvenance`, `PersistedRun.carry` as a
  checkpoint field, `carry_updated` event kind (events contract 2→3).
- **STRAT-LOOP-CARRY S01 (IR)**: `carry:` flow block, `${name}` carry reference kind, and the
  validation passes (13 new error codes incl. `FANOUT_OVER_SINGLE_REF`); collectors tagged by
  field language and mirrored (`referencesInStep` / `stringLeaves`), `resetClosure` exported.

- **STRAT-LOOP-CARRY blueprint** written and verified (`docs/features/STRAT-LOOP-CARRY/blueprint.md`):
  four slices, 154 refs verified, three Codex sol/high rounds folded (24 findings). Round-3 fixes
  not re-reviewed; see its Review log.

### Two tickets filed as prerequisites for compose COMP-FABLE-ASTRA

- **STRAT-LOOP-CARRY** (PLANNED, M): a declared `carry:` flow variable with an `initial`
  expression and per-gate `on_revise` updates, evaluated under the gate token before the
  reset and persisted with provenance, so a fanout can re-fan over a re-planned list without
  a routing cycle. Also exposes the resolved item on the consumer descriptor, which two
  compose seams depend on (ownership enforcement at merge, per-item tier routing).
- **STRAT-FLOW-CANCEL-FG** (PLANNED, M): a foreground flow cancel keyed by flow id, since
  consumer fanout is foreground-only and the per-call cancellation id lives in the starting
  MCP server process, which leaves a second process unable to cancel a running build.
- **STRAT-AGENT-INTERP-TS** (PLANNED, M): TS successor to the Python-only STRAT-AGENT-INTERP,
  whose interpolatable `agent` field was retired at the TS cutover (the TS IR is a literal
  enum). Adds per-step and per-fanout-item executor resolution from recorded state.

## [0.4.6] — 2026-09-06

### chore: `mcpName` for MCP registry listing

The MCP registry refuses to list a package whose published artifact does not name the server it
claims to be, so `package.json` now carries `"mcpName": "ai.smartmemory/stratum-mcp"`. No code
change; this release exists to put that marker in a published tarball.

The listing uses the DNS-authenticated `ai.smartmemory/*` namespace (a TXT proof on
`smartmemory.ai`) rather than `io.github.smartmemory/*`, so the org's public directory presence
does not depend on a GitHub identity. The pre-existing `io.github.smartmemory/stratum-mcp` entry
still points at the retired PyPI package `stratum-mcp` 0.2.42 and is superseded by this one.

## [0.4.5] — 2026-09-06

### feat(guard): `guard list` — read-only resource discovery

`guard list {prefix}` returns every registered resource under a prefix as
`{status:'ok', resources:[{resource_id, checksum, current_state, terminal, graph_version}], skipped}`.
A consumer that needs to know which resources are registered no longer has to walk the
filesystem: Compose's guard status went from 76 s of per-feature-directory probing to 7 s,
and the store listing finds registrations whose feature directory is gone — the probe never
could.

### fix(guard): honour `STRATUM_GUARDS_DIR`

The guard store location is now overridable, so a consumer's test suite writes fixtures to a
temp dir instead of the operator's real store. Compose's suite had leaked 32 fixture
registrations into `~/.stratum/guards`.

### fix(guard): trust-root header must be printable ASCII

The `allowed_signers` parser refuses non-ASCII inside comments too, so the em dash shipped in
the trust-root header made the file unloadable with any key. Signed authorization was
unavailable in 0.4.4 for that reason alone.

### docs(guard): ssh-agent confirm mode has no askpass on macOS

`ssh-add -c` fails closed with no dialog on the launchd agent (its compiled-in askpass path
does not exist), so confirm mode is not a viable prompt. Recorded alongside the Compose
one-tap approach (a root-owned key behind `sudo` + `pam_tid`).

### build: the published trust root is always empty

`contracts/guard-signers.allowed` is local install state — a checkout is its own install
site, so an operator enrolled here has their public key committed. `npm run release` sets
`STRATUM_TRUST_ROOT_EMPTY=1`, which strips every signer entry from the copy placed in
`dist/`, keeping the published package's "empty by default, no default trust" guarantee
while a plain `npm run build` preserves the local enrolment. The release script rebuilds
afterwards, so the stripped dist never outlives the publish — a checkout left stripped
would fail its own signature verification on the next one-tap.

## [0.4.4] — 2026-09-05

### feat(guard): STRAT-GUARD-EXPECTED-CHECKSUM — atomic policy-checksum precondition on transition

`guard transition` now accepts an optional `expected_policy_checksum`. When supplied, it must be a lowercase SHA-256 checksum matching the verified policy under the resource lock; a mismatch returns `policy_checksum_mismatch` before evaluation or ledger writes.

This remains CLI-only because the frozen MCP surface 17 contract cannot accept an additional request field without a contract-version change. Existing transition payload digests continue to bind the policy checksum.

## [0.4.3] — 2026-09-05

### feat(guard): STRAT-GUARD-DIGEST — `guard digest` on the CLI

`guard digest` now returns the version-2 payload digest for a supplied transition
envelope and policy checksum, using the guard's canonical digest implementation.

This lets a recovering Compose consumer compare its persisted envelope against
the ledger entry under an idempotency key without reimplementing canonical JSON
or SHA-256. The policy checksum remains bound into the result.

## [0.4.2] — 2026-09-05

### feat(guard): STRAT-GUARD-CLI-APPLY — `guard apply-upgrade` and `guard policy` on the CLI

`guard apply-upgrade` now applies a named, sshsig-authorized upgrade descriptor
through the CLI, and `guard policy` returns a registered resource's verified
stored policy, checksum, graph version, and current state. Both are CLI-only;
the MCP surface and its contract version are unchanged.

The old CLI restriction defended an environment digest pin: a caller could set
both the descriptor path and its digest. Descriptors are now signed against the
in-source trust root, so selecting a file is not authorization; the remaining
attacks are equivalent on the CLI and MCP surfaces. This unblocks compose's
CLI-only COMP-LIFECYCLE-BACKFILL flow.

## [0.4.1] — 2026-09-05

Patch republish of 0.4.0. The 0.4.0 publish was left in a staged state on the
npm registry and never became installable, so the identical build ships as 0.4.1.
No code changes.

## [0.4.0]

Breaking release. The MCP surface moves 16 -> 17 and entry input is validated
strictly, so requests and specs that previously slipped through now fail.

- **MCP surface 17.** `stratum_agent_run` gains the foreground cancellation
  contract (`cancellationId` plus `stratum_cancel_agent_run`), and the error
  registry gains two envelopes: `input_validation_failed` for a rejected
  request field, and `agent_run_failed` for a provider failure. The latter
  declares the optional `usage`, `split`, `usdSource`, `stderr`, and
  `telemetry` keys the server attaches, and its `code` carries the connector's
  own failure code when it has one.
- **Strict entry-input validation.** Flow entry input is validated against the
  spec's declared inputs and rejected with `input_validation_failed` rather
  than flowing into a step as an undeclared key.
- **Provider settings are rejected, not dropped.** `thinking`,
  `allowedTools`, and `disallowedTools` are Claude-only: passing them to a
  Codex run fails before execution on both the foreground and background
  paths, instead of silently disappearing at the provider boundary.
- **Cancellation contract.** A supplied `cancellationId` is the only thing
  that claims POSIX process-group ownership, for Claude and Codex alike; the
  acknowledgement waits for the whole group to be reaped. Cancellation on
  Windows fails before spawn with `CANCELLATION_UNSUPPORTED_PLATFORM`; runs
  that do not ask for cancellation are unaffected on every platform.
- **`revisionDigest` covers the normalized spec.** The same spec now digests
  differently than it did on 0.3.4. Persisted runs stay self-consistent, so
  this affects cross-version digest comparison only.
- **Cancellation teardown is graceful and bounded.** SIGTERM to the owned
  process group, `STRATUM_CANCEL_GRACE_MS` (default 5000) grace, then SIGKILL
  and a bounded reap of every group member; a stdout overrun escalates
  immediately even mid-grace. `stratum_cancel_agent_run` waits at most
  `STRATUM_CANCEL_TIMEOUT_MS` (default 15000) and returns
  `CANCELLATION_TEARDOWN_TIMEOUT` rather than acknowledging a live group.
- **Provider failures carry usage.** A failed Claude or Codex result attaches
  its usage, split, and USD provenance to the `agent_run_failed` envelope so
  consumers can debit the attempt.
- **Codex exec transport.** Foreground Codex runs that own a process group
  use `codex exec` with the PATH binary, falling back to the SDK's bundled
  CLI only when PATH has none; `STRATUM_CODEX_TRANSPORT` still selects the
  transport for every other run. A nonzero exit with complete agent text is
  a success, as before.
- **stdout hygiene.** Engine and guard diagnostics go to stderr; the stdio
  MCP channel carries JSON-RPC only.
- **Durable polling.** `stratum_flow_poll` reads committed state, never the
  in-memory run pinned by an active fanout, and background poll captures the
  driver status before the disk read so the two cannot disagree.

### feat(judge): gpt-6-astra takes the paranoid tier

OpenAI's new flagship `gpt-6-astra` ($10/$50 per MTok, 272K context in the
Codex CLI) replaces `gpt-5.6-sol` as the `paranoid` stakes model in
`STAKES_MODEL` and joins `MODEL_PRICING`. `default` stays `gpt-5.6-terra/high`
(astra is 4x its price) and `cheap` stays `gpt-5.3-codex-spark/low`. The
`CODEX_MODEL` default for the CodexConnector is unchanged; pass
`gpt-6-astra/high` explicitly to route a dispatch there.

### feat(STRAT-USAGE-SPLIT): input/output token split survives to receipts (surface 16)

Every record ever written had `input_tokens = 0`: connectors read the true
split from the SDK, then collapsed it into `Budget.tokens` at the return
boundary, and compose filed the aggregate as output. The split now rides
BESIDE the Budget-shaped usage — the `usdSource` seam — end to end:

- `ConnectorResult.split?` (`{input, output, cacheRead?, cacheCreation?}`);
  populated by the Claude connector (with cache detail), both Codex paths,
  and the background scanner. The bg Claude worker forwards cache fields on
  `turn.completed`.
- Engine threads `split` wherever `usdSource` already flowed: `StepResult`,
  the fanout dispatch wrap, `settleLegacyReceipt` → `buildReceipt`. The
  never-populated `ReceiptRecord.split` now actually receives data.
- `stratum_agent_run` / `stratum_agent_poll` `complete` responses declare
  `split?`; **surface 15 → 16**.

Consumers note: `output_tokens` in downstream records will DROP to true
output — it previously contained the whole aggregate (prompt volume
mislabeled as generation). That is the fix, not a regression.

### fix(connectors, engine, mcp): Codex review of 0a497ce (3 rounds, CLEAN)

- `usdSource` moved from `ConnectorUsage` to `ConnectorResult`: the ledger
  admits only budget keys inside `usage`, so every positively priced Claude
  result was being rejected as an invalid usage entry (high). Declared as
  `usdSource?` on the `stratum_agent_run` / `stratum_agent_poll` `complete`
  responses. The Claude connector omits `usd` entirely for a zero/absent price
  (receipts require provenance whenever `usd` is present).
- Engine-owned Claude calls keep `"reported"`: `StepResult.usdSource` is
  carried by the default adapter and by legacy settlement instead of being
  downgraded to `"legacy"`.
- Background Claude runs carry the SDK's cumulative `total_cost_usd` on
  `turn.completed`; `agent_poll` reconstructs `usd` + `usdSource`.
- Agent-run progress envelopes are `schema_version` **0.2.8**: identical to
  0.2.7 except `flow_id` is optional on `_agent_run` events (call-local; the
  consumer stamps its correlation id). There is no producer-side JSON schema
  for the envelope in `ts/contracts` (events.json is the audit-event
  contract); this entry is the declaration.


### fix(mcp, connectors): census follow-ups — agent stream flow_id, usd provenance

- `stratum_agent_run` progress envelopes no longer carry a server-invented
  `flow_id`. Compose's stream consumer accepts only an absent or matching id,
  so every agent event was being dropped as "misrouted" (seen on every step of
  the 2026-08-30 census build). Progress is already scoped per call by
  `progressToken`; the consumer stamps its own correlation id.
- The Claude connector labels `total_cost_usd` with `usdSource: "reported"`
  (`ConnectorUsage.usdSource`). Surface 15 fails closed on an unlabelled usd,
  so local-Claude receipts had tokens but no dollars.


### feat(engine, learn): STRAT-LEARN-COST — a receipt per model call, mirrored to SmartMemory

Cost never reached the learn loop because the data did not exist: 0 of 1,541
ordinary step attempts in the local corpus carried usage, compose billed model
calls the engine never saw, a gate revise wiped step ledgers, and a checkpoint
revert rewrote the event stream. This adds the data half; the classifier is
parked (`docs/features/STRAT-LEARN-COST/design.md` §7).

- **`stratum_usage_report`** (surface 15): one idempotent receipt per model
  call, keyed by `(runId, dispatchId)`, any run status, gate/no-step receipts
  debit flow-only, never `terminalBudget` on a terminal run. Receipts live on
  an append-only spine `run.receipts` (+ `receiptCounter`), both excluded from
  checkpoints. Every existing cost debit (stepDone, fanout settle, judged
  ensure) is routed through the same path with `legacy:<seq>` ids and
  `usdSource: "legacy"`; `legacy:` and `engine:` prefixes are reserved.
- **Events** (events 2): `usage_debit` per accepted receipt; `step_reset` from
  `resetFrom` (reset steps with from/to epochs, dropped subflows);
  `checkpoint_reverted`. `flowSpent` is monotonic across reverts — the live
  pre-revert total is kept (spine as floor), correct for receipt-era runs,
  pre-receipt runs, and runs upgraded mid-run.
- **SmartMemory egress** (`learn/smartmemory_egress.ts`): the receipt spine
  *is* the queue (`egress: pending|sent|dead` per row), drained under the
  engine's authoritative run lock with network I/O outside it, per-run
  backoff, coalesced triggers, dead-letter on 4xx, at-least-once with
  `metadata.receipt_id` for consumer dedupe. **Explicit opt-in:**
  `STRATUM_LEARN_EGRESS=1` plus `SMARTMEMORY_API_URL/API_KEY/WORKSPACE_ID`;
  register `stratum_usage_debit`, `stratum_step_reset`,
  `stratum_checkpoint_reverted` via `SMARTMEMORY_EXTRA_MEMORY_TYPES` (README).
  `stratum learn egress drain|verify|retry-dead`. The policy channel and
  `~/.stratum/policy-outbox` are untouched.
- Compose side ships separately (compose `44e54cf`): every dispatch reports a
  receipt from its accounting funnels; envelopes omit `usage` in receipts mode.

Design gate: 4 Codex sol/xhigh rounds (carrier pivoted at r3 to receipt-per-call).
Implementation: Codex sol/high per slice, 3 review rounds each.

### fix(connectors): never hand a SmartMemory credential to a spawned agent

GOV-COMPOSE-SEAM-1 step 0. Compose now injects `SMARTMEMORY_API_KEY` and
`SMARTMEMORY_WORKSPACE_ID` into the MCP server's env so the policy client can
deliver enforcement events. The server reads them once at construction, long
before any agent spawn, so both are added to the scrub lists in `claude.ts` and
`codex.ts` via a shared `SMARTMEMORY_SCRUB_VARS` in `connectors/base.ts`.

An implementer or reviewer agent has no use for a live memory-write credential,
and handing one over widens a prompt injection from "edits code" to "rewrites
the audit trail it is being judged against". Shared rather than duplicated
because the failure mode of this control is a third connector that forgets it.
`SMARTMEMORY_API_URL` is not scrubbed — it is not a credential and grants
nothing on its own.

First tests for the scrub path in either connector (`tests/connectors/
credential-scrub.test.ts`); the control existed but nothing held it in place.
Codex's deliberate retention of `OPENAI_API_KEY` is now asserted too, so a
future tidy-up that "unifies" the two lists cannot silently break Codex auth.


### feat(policy): GOV-STRATUM-SEAM-1 P1 — SmartMemory policy source (local runner)

Stratum can now consume a SmartMemory **policy bundle** at plan time and report
every enforcement decision back. Contract:
`smart-memory-docs/docs/features/GOV-STRATUM-SEAM-1/predicate-exchange-contract.json`;
decision record `docs/decisions/2026-08-21-enforcement-seam.md` (D2, D3).

- `stratum_plan` accepts `policy_bundle` and an optional `policy_step_selector`
  (narrows, never widens). Ensure rules are merged into matching `do` steps; the
  rule ↔ predicate mapping lives in a persisted `policy_rules` side-channel keyed
  by `flow/step` (`policy_rules_version: 2`; versionless maps migrate when the
  step id is unambiguous, otherwise resume/revert refuse and ask for a re-plan).
- `stratum_guard_register` accepts `policy_bundle`; guard-edge rules carry their
  SmartMemory `source` (record id, version, `content_hash`, `chain_hash`) inside
  the registered predicate, so it is covered by `guardChecksum`. Rule-level
  `judged.stakes` raise the effective edge stake; paranoid edges still require a
  deterministic predicate. Guard-edge `expr` and `on_fail: "gate"` are refused in
  P1 (not evaluable / routing deferred to P3).
- Ledger entries gain `payload_digest_version` (absent/1 legacy, 2 checksum-bound):
  new transitions bind the registry checksum into `payload_digest`, replay and
  learn/apply recovery recompute legacy entries with legacy material, mixed
  chains verify.
- `stratum_guard_transition` / `stratum_guard_override` return `entry_digest`,
  `prev_digest`, `payload_digest`; both accept `run_id`; override and
  `stratum_gate_resolve` accept `user_id` for human attribution.
- `ts/src/policy/smartmemory_client.ts`: posts `enforcement_event`s for
  `guard_transition`, `gate_resolution`, `flow_terminal` to
  `POST /memory/policy/events` (`SMARTMEMORY_API_URL`, `SMARTMEMORY_API_KEY`,
  `SMARTMEMORY_WORKSPACE_ID`; disabled mode warns once). Fire-and-forget;
  failures queue in `~/.stratum/policy-outbox/` (0700/0600, sha256 filenames,
  1000 files / 50 MB cap, jittered backoff, fenced single-flight drain via a
  token-bound lock with atomic tombstone takeover/release).
- `server_file_contains` trusted evaluator added so `file_contains` guard rules
  are enforceable.
- MCP surface contract (`ts/contracts/mcp-surface.json`) updated for the new args
  and response fields.

### feat(guard)!: STRAT-GUARD-AUTHZ — signed authorization, retiring the override token

**Breaking:** `guardOverride` and `guardMigrate` take an `authorization` (a
detached sshsig) instead of an `override_token`, and
`STRATUM_GUARD_OVERRIDE_TOKEN` is gone. MCP surface 13 -> 14. No in-tree consumer
called either operation, so nothing needed migrating.

The token was a shared secret compared against `process.env` of *whatever process
is running*. Over the MCP server that environment is the operator's; over the CLI
it is the caller's, so the caller set both sides of the comparison. Verified
before removal against a guard whose only predicate could never be satisfied: an
honest transition was `refused`, and the same walk with a self-invented token
returned `deviation` and moved the state. `STRAT-TS-GUARD` invariant 8 called the
token "not agent-mintable"; it was mintable by anything with a shell, and the CLI
is the only surface compose uses.

Authorization is now a signature over a payload the **server reconstructs**, so
nothing travels except the signature itself:

- override: `{action, resource_id, from_state, to_state, rationale, ledger_head}`
- migrate: `{action, resource_id, policy_checksum, rationale, ledger_head}`

Three properties fall out rather than being separately enforced. It cannot be
**redirected** (a signature naming one resource/edge/rationale/resulting policy
will not verify against another). It cannot be **replayed**: `ledger_head` is the
resource's last ledger digest, so an authorization is valid at exactly one point
in that resource's history — spending it moves the head and kills the signature,
with no clock, nonce store, or expiry to tune. And it cannot **cross purposes**:
one sshsig namespace per operation, checked before the cryptographic verify. The
head is read inside the resource lock, so a concurrent mutation invalidates the
authorization rather than letting it apply to a history nobody signed for.

`stratum guard authorize` prints the exact canonical payload, namespace and
`ssh-keygen` invocation, since a ledger head cannot be guessed by hand. It is
read-only and grants nothing. Rejections echo the expected payload back, because
the common honest failure is a stale head.

The ledger now records **who** authorized: every deviation and policy change
carries the signer's principal and key fingerprint, and the responses add
`authorized_by`. A `resolved_by: "human"` stamp any process could mint was worse
than no stamp, because it made the audit trail lie.

Verified end to end through the real CLI with a real `ssh-keygen` signature:
authorize -> sign -> apply (`deviation`, ledger naming the signer) -> replay
refused. And the recorded attack now fails twice over — `override_token` is
rejected as an unknown argument, and a self-signed authorization is refused
because the key is not enrolled.

Adversarial review named two boundaries, both now documented in full rather than
summarised away. `setGuardTrustRootForTests` is fixed: it refuses outside
`NODE_ENV=test`, matching the fixture judge backend, so the production API no
longer advertises "replace the trust root" as a supported call. The other is not
fixable in-process and is not claimed to be — both entrypoints honour
`NODE_OPTIONS`, so anything that controls a process's environment can patch the
verifier inside it. That is exactly why the guarantee is scoped to the MCP
server, whose environment belongs to the operator who launched it, and why the
privileged descriptor apply is MCP-only. What signing changed is the cost of the
cheapest bypass: from "set an environment variable" — silent and available
everywhere — to "edit a committed file", "inject code into a process you already
own", or "tamper with guard state and be caught by the hash chain".

`docs/features/STRAT-GUARD-AUTHZ/design.md`.

### feat(guard): signed authorization for upgrade descriptors

Replaces the env digest pin that `STRAT-GUARD-DESCRIPTOR` shipped hours earlier.
The pin was aimed at the wrong adversary: its premise was "an agent cannot alter
the environment of an already-running server", which is true and irrelevant,
because the guard is also reachable from processes the agent launches itself —
and there the agent supplies the environment. Proven by the same defect that made
the override token forgeable.

Authorization is now a **signature**. A descriptor file must carry a detached
sshsig (`ssh-keygen -Y sign`) at `<path>.sig` under the namespace
`stratum-guard-descriptors`, from a key enrolled in the new in-source trust root
`contracts/guard-signers.allowed`. `STRATUM_GUARD_UPGRADE_DESCRIPTORS_SHA256` is
gone. The path env var stays: locating an artifact is not authorizing it.

The adversary's cheapest move is no longer "set two variables" but "forge
Ed25519" or "edit a committed file" — the latter possible with a shell, but
`git status`-visible instead of invisible, and it defeats every check in the
codebase equally rather than this one specifically. That is the honest ceiling of
any local mechanism.

**Verification is native** (`ts/src/guard/sshsig.ts`, `node:crypto`), not a
shell-out to `ssh-keygen -Y verify`. Shelling out would have re-opened the same
hole from a new angle: `ssh-keygen` resolves through `PATH`, which the adversary
controls. Ed25519 only; other key types and `allowed_signers` option lists are
refused rather than ignored. The verifier is tested against a signature produced
by real `ssh-keygen`, committed under `ts/tests/fixtures/sshsig/`, so a misreading
of PROTOCOL.sshsig cannot hide behind a round-trip with our own test signer.

No default trust: the trust root ships empty, and an empty or missing one makes
the signed paths report themselves unavailable rather than degrade. The dist
packaging step now asserts and rewrites the contract path for every compiled
module that reads a shipped contract, so a contract reader added without being
listed fails the build instead of shipping a package that cannot find its trust
root at runtime.

### feat(guard): STRAT-GUARD-DESCRIPTOR — server-owned upgrade descriptors

`STRAT-GUARD-UPGRADE` shipped the provably-safe subset of policy evolution and,
in doing so, proved that the interesting case cannot be made safe by inspecting
the policy: granting a guard a new terminal state is granting a new way to be
complete, and a caller that can do that token-free simply declares its own
success state. So it froze `terminal`, and the requesting use case
(`COMP-LIFECYCLE-BACKFILL`'s `complete_backfilled` node) was left on the
break-glass token.

This is the general form of the answer. A **descriptor** is a policy change the
*server* holds: `{id, rationale, from_checksum, to_policy}`, carrying the full
target policy rather than a transformation, bound to the exact policy checksum it
was authorized against. A caller may only ask for one **by name**, via the new
`stratum_guard_apply_upgrade` / `stratum guard apply-upgrade` /
`guardApplyUpgrade`. No additive-only classifier runs — this path can grant a
terminal state, remove an edge, retighten a predicate — because a human read that
exact resulting policy before installing it.

Authorization is anchored in two required server-environment variables:
`STRATUM_GUARD_UPGRADE_DESCRIPTORS` (absolute path) and
`STRATUM_GUARD_UPGRADE_DESCRIPTORS_SHA256` (a pin of the file's bytes). **The pin
is required, not optional**, and that is the load-bearing decision: the
descriptor file usually sits where the agent under guard can write, so an
unpinned file authorizes nothing — an optional pin would convert "no capability"
into "a capability everyone believes is safe". The file must also not be group-
or world-writable. `stratum guard descriptors` (CLI-only, operator-facing) prints
the parsed set and the digest to pin, and reports it even when no pin is
installed yet, because otherwise the pin could never be set the first time.

Idempotent like its sibling: a resource already at the target policy answers
`unchanged` and writes nothing, and the destination check deliberately precedes
the `from_checksum` check so a partially-failed fleet batch is safe to re-run. A
resource whose current policy is not the one the descriptor was authorized
against is refused with the new `upgrade_descriptor_mismatch`, naming both
checksums. `guardMigrate` is deliberately not retired: a mechanism that requires
a reviewed artifact cannot be what you reach for when the reviewed artifact is
what is broken.

Also hardened, found while adversarially reviewing this: `__proto__`,
`constructor` and `prototype` are now rejected as state names. They pass the
`[A-Za-z0-9_.-]` character class but are not ordinary object keys, so a policy
carrying one would not mean exactly one thing — the same reservation the IR
schema already applies to contract field names.

**Ships MCP-only, and its consumer cannot use it yet.** Adversarial review
showed that a CLI apply action would destroy the whole property: a CLI process
inherits the caller's environment, so a caller writes its own descriptor file,
computes its digest, points both variables at them, and mints its own
authorization — with the ledger stamping `resolved_by: "human"` over it. There is
therefore no CLI apply action. Compose reaches stratum's guard by spawning the
CLI, so compose cannot call this until either it talks to stratum over MCP or
descriptors are signed against a key checked into stratum's source. The design
recommends signing.

**Related defect found while proving that, in the EXISTING system:**
`_checkOverrideToken` compares the caller-supplied token against
`process.env.STRATUM_GUARD_OVERRIDE_TOKEN` in whatever process is running — so
over the CLI a caller sets both sides. Verified against a guard whose only
predicate could never be satisfied: an honest transition was `refused`, and the
same walk with a self-invented token returned `deviation` and moved the state.
`STRAT-TS-GUARD` invariant 8 ("not agent-mintable") holds on MCP and does not
hold on the CLI, which is the only surface compose uses. Not fixed here.

MCP surface 12 → 13 (22 → 23 tools).
`docs/features/STRAT-GUARD-DESCRIPTOR/design.md`.

### feat(guard): STRAT-GUARD-UPGRADE — idempotent, non-emergency guard upgrade

`guardMigrate` was the only way to evolve a registered policy, and it required
the break-glass `STRATUM_GUARD_OVERRIDE_TOKEN` and bumped `graph_version`
unconditionally. That made routine policy evolution depend on the emergency
mechanism it should replace, and it blocked compose's `COMP-LIFECYCLE-BACKFILL`,
which needs to graft one node onto ~350 already-registered guards lazily.

New `stratum_guard_upgrade` / `stratum guard upgrade` / `guardUpgrade`: no
token, idempotent, additive-only. An identical policy returns `unchanged` and
writes nothing at all — no ledger entry, no version bump — so the lazy migration
is free in the steady state and safe to re-run after a partial failure. Real
changes must be additive: nothing removed, existing edges byte-identical in
predicates and stakes, **new edges may only terminate at states that did not
exist before** (an edge into an existing state is a new route that bypasses the
predicates on the old one), and **`terminal` is frozen in both directions** — no
membership change, and no new edge entering or leaving a terminal state. Everything
else is refused with the new `incompatible_policy_upgrade` slug and still
belongs on the token-gated `guardMigrate`, which is unchanged.

The frozen `terminal` is a scope cut adversarial review forced, and it costs the
requesting use case. Letting `terminal` grow would let a token-free caller
declare its own success state, reach it over a new edge whose predicates it also
chose (an empty predicate list evaluates as met), and be *complete* without
passing any gate that existed at registration — a completion bypass that never
touches an existing edge, so the additive classifier waves it through. Granting
completability is an authorization decision and stays on the token. Terminal
*egress* is the mirror of that hole and closed the same way: `shipped →
reopened` with a brand-new `reopened` would walk an already-complete resource
back out of its terminal state, so a new edge may not leave a terminal state
either. So
`COMP-LIFECYCLE-BACKFILL`'s terminal `complete_backfilled` node still needs one
token-gated migrate per resource; what it gains here is the free, token-free,
idempotent steady state and a batch that is safe to re-run.

Adversarial review of the classifier surfaced a **pre-existing, unrelated
hole** that this ships a fix for: `_validatePolicy` never checked that a graph
adjacency is an array. `{"draft": "shipped"}` passed every check (a string
iterates as characters, and characters are valid state names) and, once stored,
turned the edge-legality test into `String.prototype.includes` — a substring
match, so a `"bxyz"` adjacency legalized a transition to the undeclared,
unguarded state `"xyz"`. `guardRegister` needs no token, so this was reachable
with no credential at all. `_validatePolicy` now validates the shape of graph,
terminal, edge_predicates and stakes, which covers register, migrate and
upgrade at one chokepoint — and because a registry written before that check
still loads through an unchecked cast, edge legality itself now requires a real
array before testing membership.

MCP surface 11 → 12 (21 → 22 tools).
`docs/features/STRAT-GUARD-UPGRADE/design.md`.

### feat(learn): STRAT-TS-LEARN — across-run learning, closed end to end

S4 lands the write half: four admission critics, a journalled apply whose single
commit point is the guard ledger, compare-and-swap revert, and reconciliation
that refuses to guess when the evidence is ambiguous. Default OFF. CLI:
`stratum learn harvest|list|apply|revert|reconcile`.

Two adversarial implementation rounds produced 18 findings, **all of them in the
S4 crash-recovery protocol** — S1-S3 drew zero across both. Among them: recovery
could undo a ledger-committed apply (the journal's `ledgerRef` is written after
the commit, so a crash in that window made a committed apply look uncommitted,
and a test of mine asserted that buggy behavior); every revert was an illegal
guard transition that threw and was swallowed, leaving the ledger claiming
`applied` over reverted bytes; the path allowlist was symlink-bypassable; and
ledger corruption failed open into destructive rollback, made worse by
`readLedger` truncating at a malformed trailing line rather than throwing.

All are fixed and regression-tested. The honest caveat: the apply path is
default-OFF and has never run outside tests. Treat the read-only three quarters
as solid and the apply path as unproven until exercised.
`docs/features/STRAT-TS-LEARN/report.md`.

### feat(learn): STRAT-TS-LEARN S1-S3 — harvest, classify, and stage lessons from persisted runs

Stratum had no working across-run learning: the Python `STRAT-LEARN-INLINE`
harvester retired with the Python engine in July and was never ported, and its
apply half was never built in any engine. This lands the read-only three
quarters of the replacement — `ts/src/learn/{harvest,classify,candidate}.ts`,
31 tests, all fixtures extracted from the real persisted corpus rather than
hand-written.

The design was driven by a census of the 492 local persisted runs, and two of
its findings inverted the obvious implementation:

- **The expected trigger has never fired.** Zero `judged` events exist across
  the whole corpus, so a harvester hung off judge verdicts (the Python design)
  would have been live and permanently silent. The signal that does exist is
  `result` events carrying `detail.failure`, plus flow-level `budget_exhausted`
  — 332 records. Harvest reads persisted state offline, so there is no engine
  change, no judge-contract change, and a harvest crash cannot fail a flow.
- **The largest cluster in the corpus is test noise.** 155 of 174 step failures
  land on one step, which reads as a spectacular recurring defect and is in fact
  one golden test rerun in 155 ephemeral temp workspaces. Grouping is therefore
  attributed by `workspaceRoot` first: without that, the harvester's most
  confident output is its worst. A regression test asserts those 155 records
  produce **zero** durable candidates.

Grouping keys on the violated contract (issue code + path + declared options),
never on the rejected value and never on the spec revision — both were measured
to shatter the one real lesson in the corpus (five ways and two ways
respectively). Clustering explodes each failure into one unit per violated
constraint, because two records violate an enum and a type in the same response.
`durable` requires breadth rather than volume: ≥2 distinct runs and ≥3 distinct
run/step pairs.

Against the live corpus this yields exactly one lesson: four steps in one flow
return `success`/`done`/`pass`/`revised`/`approved` where the contract declares
`complete|skipped|failed`, 14 times across 2 runs, every one recovered on retry
and therefore never visible. Candidates carry rendered note text (not just an
intent), an evidence-backed breadth count, and dual identity — a stable
`clusterId` plus a content-addressed `revisionId`.

Staging only: nothing is applied. S4 (admission critics, journalled apply,
compare-and-swap revert) is not in this commit, and the apply path stays
default-OFF when it lands. Design and the three-round review trail:
`docs/features/STRAT-TS-LEARN/design.md`.

### docs(STRAT-ADMIT): design the pre-commit admission gate for skill-class assets

Specifies the gate that guardrail 5 of the apply path has always named but never
defined: three critics that intercept disjoint classes of harm (structural
validity, behavioral harmlessness, semantic consistency with claimed evidence),
subset-level marginal-gain admission over the existing pool, and lineage capture
at authoring time with a revert that walks descendants instead of reporting only
the asset it removed. Design only — no implementation.

The review falsified the original claim that memory-class notes could skip this
gate for being "declarative": this repository's own memory format carries
`**How to apply:**` sections, so notes are instructions a future agent acts on.
Memory-class applies now run the critics and subset admission; only lineage is
exempt, and only because candidate authoring does not read the memory pool — a
falsifier recorded as a test, not a note. `docs/features/STRAT-ADMIT/design.md`.

### docs(readme): state where Stratum sits relative to Compose

The README explained what Stratum does but never said which layer it is, so a
reader arriving from Compose could not tell whether the two compete. Adds a
"where it sits" paragraph (Stratum is the execution kernel; Compose drives the
product lifecycle on top of it and calls Stratum per step) plus a one-line
tagline, "your agent proposes the step, Stratum decides whether it actually
finished". The npm `description` in `ts/package.json` now carries the same line
instead of the trailing "(TypeScript port)", which stopped being meaningful
once the TS engine became the only engine.

### chore(license): add the Apache-2.0 LICENSE file the README already claimed

The README has carried an Apache 2.0 badge since early on, but the repo shipped
without a `LICENSE` file — so the actual legal status was all-rights-reserved,
and neither GitHub nor npm could detect a license. Adds the canonical
Apache-2.0 text (`Copyright 2026 regression-io`) and sets
`"license": "Apache-2.0"` in `ts/package.json` so the published
`@smartmemory/stratum` package declares it too. No code or behaviour change.

`app/package.json` is `"private": true` and stays unlicensed by design.

## [0.3.4] — 2026-07-25

Reaches compose users automatically: compose 0.3.7 moved its stratum dependency
from an exact pin to `^0.3.3`, so 0.3.x patches now arrive on a plain reinstall.
Every change below is additive — the surface bump (10 → 11) only adds a
`spec_validation_failed` entry to the `errors` map, and no existing tool's
request or response shape changed.

### feat(STRAT-SEARCH): S1 — the evaluate step (engine-owned external verdict)

First slice of STRAT-SEARCH. A new `evaluate:` step kind delegates to an
external program, invoked BY THE ENGINE (never by an agent), and receives a
structured verdict `{ status: closed|open|failed, children[], reason, score?,
route? }`. This is the trust anchor: a proof system that takes an agent's word
for whether it proved something is not a proof system.

- `EvaluateSchema` in `ts/src/ir/schema.ts` (`command`, optional `in`,
  `timeout_ms`), registered as a sixth step kind across the kind list, the
  field allowlist, and the mix check.
- `contractForStep` and `referencesInStep` in `ts/src/ir/validate.ts` now know
  `evaluate`, so `${step.output.field}` references type against the step's `out`
  contract exactly as `do`/`set` do (R1-8).
- `evaluatorResultSchema` in `ts/src/engine/engine.ts` is the engine-owned, strict
  trust schema — it enforces the cross-field invariants (`closed` ⇒ no children,
  `open` ⇒ ≥1 child, R1-3). The evaluate branch in `advanceScopeLoop` runs the
  injected `EvaluateRunner` inline and settles atomically (no intermediate
  `running` persisted, so a crash re-runs cleanly on resume).
- Five distinct typed failures — no runner, non-zero exit, timeout, unparseable
  stdout, contract-invalid output — none of which can be laundered into a
  `closed` verdict.
- Default `createEvaluateRunner` in `ts/src/engine/evaluate.ts` spawns the
  command via `/bin/sh -c`, feeds the bound input as JSON on stdin, reads a JSON
  verdict from stdout, and classifies only the transport outcome. Wired into the
  MCP server and both CLI engine constructions.
- `ts/contracts/evaluator-result.json` documents the canonical shape.
- S2-S5 (recursion, backtrack, scored judge, inconclusive) remain unbuilt; S2
  was re-scoped to real engine work by design-gate R1 and needs its own pass.

### fix(mcp): surface structured SpecValidationError entries from every spec-accepting tool (#26, surface 11)

An invalid spec sent to `stratum_plan` (or any spec-accepting tool other than
the one special-cased `stratum_flow_run_bg` bg-dispatch rejection) returned a
bare `-32603 "spec validation failed"` — the structured `errors[]`
(code/path/message per violation) existed on the thrown `SpecValidationError`
but never reached the caller, forcing a manual `dist/ir/validate.js` repro to
learn what was wrong. The catch block in `ts/src/mcp/server.ts` now handles
ANY `SpecValidationError`: the existing `consumer_dispatch_bg_unsupported`
case keeps its error code, and everything else maps to a new registry-declared
`spec_validation_failed` error thrown as
`McpError(InvalidParams, message, { code, errors })`. The error registry gains
`spec_validation_failed` (same `{code, errors[]}` data shape), bumping the
frozen surface version 10 → 11. Pinned by a new p5 boundary test.

### fix(connectors): brief codex agents on the OS sandbox; point Puppeteer at chrome-headless-shell

Codex agents dispatched into the seatbelt/landlock sandbox had no way to know
GUI apps cannot start there: full Chrome aborts (SIGABRT) during macOS
WindowServer registration even with `--headless`, so agents that hit a browser
step crash-looped Chrome launch retries (observed 2026-07-22: five Chrome
crash reports in four minutes from one SmartMemory S3 run). Every codex
dispatch — `CodexConnector.run` (both sdk and exec transports) and the codex
background path in `startBackgroundRun` — now prepends a short
`[sandbox constraints]` preamble stating the constraint and the escape hatch
(use `chrome-headless-shell`, never retry an aborted GUI launch). When the
dispatch falls back to ambient `process.env` (a caller-supplied env stays
authoritative), the connector also sets `PUPPETEER_EXECUTABLE_PATH` to the
newest `chrome-headless-shell` in the Puppeteer cache when one exists, so
Puppeteer scripts that honor the env work without agent intervention. New
exports: `CODEX_SANDBOX_PREAMBLE`, `withSandboxPreamble`,
`resolveHeadlessShellPath`, `applyHeadlessShellEnv`.

## [Shipped in 0.2.0 – 0.3.3, never sectioned]

Pre-existing bookkeeping debt, recorded here rather than silently absorbed into
0.3.4: every entry below had already been released by the time 0.3.4 was cut,
but no release rolled the `[Unreleased]` heading, so they accumulated under it.
Left in place — reconstructing the exact version boundaries after the fact would
be guesswork.

### fix: declare spec/input as "object" in the MCP tool contract (surface 10)

`stratum_validate`, `stratum_plan`, and `stratum_flow_run_bg` declared `spec`
and `input` as `"any"`, which `schemaForValidated` maps to the empty JSON
schema `{}`. MCP clients (Claude Code) deliver untyped arguments as raw
strings, so every spec — valid or not — reached the engine as a string and
died in the Zod object parse with `SCHEMA_INVALID "Expected object, received
string"` at path `""`. The tools were uncallable from Claude Code entirely.
Declaring the parameters `"object"` makes the advertised schema
`{"type":"object"}` (clients now parse the JSON into a real object) and gives
server-side shape assertion a clean named error
(`stratum_plan.request.spec must be object`) for any client that still sends
a string. Breaking for callers that passed scalar `input`, so the frozen
surface version bumps 9 → 10. Pinned by tests in
`tests/mcp/schema-grammar.test.ts` and the p5 boundary tests.

### fix: rescan the background stream before declaring child_died_without_sentinel (#24)

`pollBackgroundRun` captured the event stream once, then checked liveness (the
in-memory registry for claude, process-identity for codex) and, if the child was
gone, returned a terminal `error` with reason `child_died_without_sentinel` —
without re-reading the stream. This is a TOCTOU: the wrapper writes its exit-code
sentinel *before* exiting, so between the stale scan and the child going away the
sentinel can land, and the poll reports a terminal status with `exitCode` missing.
On slow CI this surfaced as an intermittent flake in `background.test.ts` (error
status recorded without `exitCode`). Both agent paths now rescan the stream before
declaring death; only a rescan that still lacks the sentinel returns the error, so
a terminal status always carries its `exitCode`. Producer was already correct
(atomic sentinel); the fix is entirely in the reader. 15×0 flakes locally.

### feat: stream BuildStreamEvents as progress notifications during agent runs (#21)

During a synchronous `stratum_agent_run` the connector's message stream
(assistant text, tool activity, usage) was invisible to the client until
completion — the server emitted only bare heartbeat `notifications/progress`.
Now foreground connectors forward their events, and the MCP boundary serializes
each as a `BuildStreamEvent` envelope (schema 0.2.7: schema_version, flow_id,
step_id, seq, ts, kind, metadata, reply_required; direct runs omit task_id) in
the progress-notification `message` field, matching the contract Compose already
demuxes for cockpit visibility. Event mapping matches the retired python server
(agent_started, agent_relay assistant/system, tool_use_summary, tool_result,
step_usage; tool payloads bounded to 2048 chars). The 15s heartbeat is preserved
independently (quiet runs still get periodic progress, notification failures
stay non-fatal, timer cleared in finally), and event forwarding is a no-op for
background runs and when no progressToken is present. New tests pin the envelope
fields and the codex/claude event mappings.

### feat: deterministic `fixture` judge backend for testing judged ensures (#19)

`judgeBackend()` supported only `openai | codex`, so any pipeline carrying a
`judged:` ensure could only be exercised via live, minute-long, non-deterministic
LLM calls, leaving judged-ensure code paths (budget debit, fanout per-item
judged events, failure routing) without deterministic coverage. Added
`STRATUM_JUDGE_BACKEND=fixture`, which resolves judged predicates from canned
verdicts supplied via `STRATUM_JUDGE_FIXTURE` (a statement-keyed JSON object or
an ordered verdict array), returning the real `JudgedResult` shape
(holds/reason/stakes/model/usage) so budget debits and `judged` audit events run
the real paths. Guarded to `NODE_ENV="test"` at both backend selection and in
the fixture constructor. Tests cover the production guard, keyed + scripted
verdicts, retry exhaustion, on_fail routing, and fanout per-item judged events
with `source: "judged"` ledger debits.

### docs: rewrite the README YAML reference to v1 (retire the v0.x dialect) (#20)

Merge day made the TS engine execute `version: 1` specs exclusively, but the
README's YAML Spec Reference still documented the retired v0.x dialect behind a
"pending v1 rewrite" banner. Rewrote the spec reference and concept sections to
real v1 syntax sourced from the zod IR schema (`ts/src/ir/`) and the
`stratum migrate --check` legacy classifications: top-level shape (`version: 1`,
`contracts`, `flows` with `entry`, step `do`/`out`, `${}` refs), per-construct
sections (step types, ensures, gates, routing, composition, iterations,
checkpoints), and both former `version: "0.2"` examples replaced. All seven
complete examples pass `stratum validate`. Constructs with no v1 equivalent are
documented as removals rather than invented syntax. Banner removed.

### feat: expose `isFinalStage` on consumer ready-descriptors (#16)

Consumer ready-descriptors omitted whether a stage was the item's LAST stage,
so Compose derived finality from its locally loaded pipeline — safe only because
it pins/verifies `revisionDigest`, but a quiet violation of the "reconstructable
with no local spec" guarantee that forced every consumer to keep a verified
spec copy. Added `isFinalStage: boolean` to the descriptor, computed engine-side
as `item.stage === step.fanout.steps.length - 1` — the exact predicate the
authoritative stage-completion/advance logic already uses, so the flag cannot
drift from real completion. Frozen MCP surface contract updated across all five
ready-response descriptors (`stratum_plan`, `stratum_step_done`,
`stratum_revert`, `stratum_resume`, `stratum_gate_resolve`). Additive and
backward-compatible. Tests cover single-stage (true), multi-stage
(false→true at the last stage), and the frozen contract-compliance check.

### fix: no orphaned detached process when background-run metadata fails to persist (#15)

`startBackgroundRun` spawned and `unref()`'d the detached codex wrapper before
writing `meta.json`; a persistence failure rejected without killing the child
and without returning a run id, leaving an undiscoverable orphan that poll/cancel
could never reach. The codex path now `unref()`s only after a successful persist,
and on persist failure kills the entire detached process group (`process.kill(-pid,
SIGKILL)`, with a `child.kill` fallback), awaits the wrapper's exit, then rethrows.
The claude Worker path already handled this (terminate + registry-cleanup on
persist failure) and is unchanged; exactly-once `claimFinalization`/sentinel
semantics are preserved. New regression test starts a real detached process,
forces `meta.json` to fail, and asserts the process group is gone.

### fix: prune the superseded worktree when a fanout item is redispatched (#14)

Restarting an in-flight worktree fanout leaked the superseded worktree: on
restart every nonterminal item is redispatched, `executeFanoutItem` created a
NEW worktree and overwrote `item.worktree` without removing the old directory
or its `git worktree` registration, and the `finally` cleanup only removed the
current/new path. The old directories accumulated indefinitely (this is the
bug behind a batch of 21 leaked worktrees found in housekeeping). Extracted a
best-effort `teardownWorktree()` helper (remove --force, then prune on failure,
never throws) and call it on the OLD path before overwriting `item.worktree`,
guarded for same-path / already-gone / unset-first-dispatch. Cleanup reuses the
same helper. Restart always creates a fresh worktree (never reuses), so the
prune is unconditionally safe. Regression test asserts the old dir + git
registration disappear while the replacement stays functional and merges.

### fix: enforce `STRATUM_CODEX_STREAM_LIMIT_BYTES` on the default SDK transport (#13)

The output-memory safety bound only guarded the `runExec` path; on the
production-default `@openai/codex-sdk` transport the connector retained
assembled event data with no cap, so the documented knob silently no-op'd
there. `runSdk` now applies the same `resolveStdoutLimit()` per-event byte
check (matching runExec's per-line policy), aborts the SDK turn via an
`AbortController` signal on overflow, and throws the identical overrun error.
Shared `exceedsStreamLimit`/`stdoutOverrunError` helpers are hoisted and reused
by both paths. Residual (documented in code): the SDK's private readline/stderr
buffers are not reachable from the connector, so the bound is enforced at the
first accessible event boundary, not inside the SDK. Regression test feeds a
>64 KiB SDK event and asserts abort + configured-limit error.

### fix: migrate CLI bootstrap loader to `module.registerHooks()` (DEP0205, #7)

The TS bins (`stratum`, `stratum-mcp`) registered the NodeNext `.js`->`.ts`
resolver via the deprecated loader-based `module.register()`, which emits
`DEP0205` on node >=26 and is slated for removal. Migrated
`ts/src/cli/bootstrap.mjs` to `module.registerHooks({ resolve })` and made the
`resolve` hook in `ts/src/cli/ts-resolver.mjs` synchronous (it only remaps the
specifier, so an in-thread synchronous hook is behaviorally equivalent). Both
bins verified to still resolve `.js`->`.ts` deep-import chains after the change
(CLI usage + `validate` subcommand load, MCP bin clean boot). No behavior
change today; removes the deprecation before it becomes a hard break.

### feat: workspace-write background agent runs + tool allowlists over MCP (STRAT-AGENT-BG-WRITE-1, #18)

Claude agents can now run in BACKGROUND with run/poll/cancel, and codex
background runs are no longer read-only-locked. Claude bg runs execute in a
Worker Thread (`claude-bg-worker.ts`, in-process SDK — no CLI binary exists)
writing Codex-compatible JSONL so `scanStream()` needs no per-agent branching;
`worker.terminate()` gives death-confirmed cancellation. Terminal records are
serialized through a per-run `claimFinalization` lock shared by the exit,
error, and cancel paths (exactly-once sentinel; cancel reports `cancelled`
only when it owns the rc=130 record, otherwise it rescans and reports the
committed outcome). `sandboxMode: "read-only"` is REJECTED for claude runs
(foreground and background) — the connector cannot enforce it, and a false
guarantee is worse than a refusal. `allowedTools`/`disallowedTools` now cross
the MCP wire (`{"$array":"string"}` contract shapes, element-validated at the
boundary) and map to the SDK `tools` param (availability restriction) — fixing
the mapping bug where they only controlled auto-approval. `bg_started.pid` is
optional (worker threads have no OS pid). Node floor raised to >=22.15
(`registerHooks` type-stripping loader for the worker). Built via the first
compose-in-stratum dogfood pipeline (5-round design gate, 8-round plan gate,
4-round codex merge gate; salvaged worktree fanout after compose #48/#49).

The TS MCP server never emitted `notifications/progress`, so clients relying
on `resetTimeoutOnProgress` (compose sets a 10-minute per-heartbeat timeout on
`stratum_agent_run`) timed out with MCP -32001 on any synchronous agent run
longer than one timeout window — hit on the first compose-in-stratum dogfood
build (`explore_design` died at exactly 600s). The python server streamed
`ctx.report_progress`; the TS port dropped it. The tool-call handler now emits
interval heartbeats (default 15s, injectable `heartbeatMs` dependency) for
requests carrying a progressToken, cleared on completion or failure. Streaming
real BuildStreamEvents (cockpit visibility parity) remains a follow-up.

### chore: compose workspace scaffolding (dogfood)

Stratum is now a Compose workspace: `compose init` artifacts committed
(`.compose/compose.json`, `pipelines/`, `contracts/vocabulary.yaml`,
`docs/context/`, `docs/product/`, generated `docs/plans/COMPOSE-ROADMAP.md`,
and the `STRAT-AGENT-BG-WRITE-1` feature spec for gh #18). `.mcp.json` points
at the compose MCP server plus the TS stratum MCP bin. Compose local run
state (`.compose/data/`, stream/breadcrumb logs) is gitignored, mirroring the
compose repo's convention.

### breaking: require report tokens and retire the Phase-1 epoch wire (STRAT-TS-FANOUT-CONSUMER flag-day, surface 9)

The coordinated migration window is closed. `stratum_step_done` now requires
the current issuance's `dispatchToken` for ordinary steps, scoped subflow
steps, and consumer-fanout items; `stratum_gate_resolve` likewise requires the
current round's `gateToken`. Missing echoes are rejected in the same stale
report family as mismatched or superseded tokens. The temporary Phase-1
`epoch` request field is retired from the engine and MCP wire, and strict MCP
request validation rejects clients that still send it. Surface 8 → 9;
`events.json` is unchanged.

**Review round 1 (S1–S3).**

- **S1** The human-gate CLI no longer defeats fencing by re-fetching the token at
  resolve time. `stratum query gates` now exposes each waiting gate's `gate_token`
  (its observation-time value), and `stratum gate <approve|reject|revise>` REQUIRES
  a `--token <t>` argument that is passed to `gateResolve` verbatim (a missing token
  is a CLI usage error). A stale decision — the human approves round 1's token after
  the gate has advanced to round 2 — is now rejected by the engine's gate fencing and
  surfaced as an error, instead of being silently rebound to the current round.
- **S2** The public engine signatures now REQUIRE the token at the type boundary:
  `StratumEngine.stepDone(..., dispatchToken: string)` and
  `gateResolve(..., gateToken: string)` (previously optional). A tokenless
  direct-engine call no longer compiles (it only failed at runtime before). The
  engine's internal owned/locked settle methods keep the optional parameter for the
  bg driver's own path; the runtime guards remain as defense-in-depth for untyped
  (JS) callers.
- **S3** The two explicit token-fencing tests (bg gate-revise dispatch-token
  supersession; the P4 checkpoint stale-token assertion) now drive the RAW engine
  directly instead of the token-echoing test adapter, which would forward an omitted
  token and mask a regression. The adapter helper documents that it must never be
  used for fencing assertions.

### feat: consumer-dispatched native fanout + dispatch descriptors (STRAT-TS-FANOUT-CONSUMER Slice D, surface 8)

`fanout.dispatch: "consumer"` now executes end to end on the stratum side.
The engine keeps enumeration, concurrency, attempts, budgets, ensures,
persistence, `require`, output ordering, and advancement; only execution
ownership moves to the client. Consumer-ready items surface in `ready[]` as
self-contained fenced dispatch descriptors: scoped id (`<fanout>/<index>`),
rendered `do`, effective agent, `attempt`/`previousFailure`, `dispatchToken`,
authored origin (`flow`/`step`/`stage`/`itemIndex`), `generation`, the output
contract carried as its CLOSURE (root id + every reachable named contract;
`contract: null`/`contractDigest: null` for no-`out` stages), effective policy
(`isolation`/`merge`/`pre_merge` as consumer instructions), and the run
`revisionDigest`. Consumer reports REQUIRE the descriptor's token; settlement
is factored into one kernel shared with engine dispatch (usage, contract,
ensure, audit, budget semantics cannot drift) and the merge branch is guarded
`dispatch === "engine"`. Surface 7 → 8: `ready` is redeclared as
`{"$array": {"$oneOf": [ordinary, descriptor]}}` with both element shapes
frozen in full (ordinary entries gain `dispatchToken`), `step_done`/
`gate_resolve` requests gain optional token echoes (required at the flag-day),
`plan`/`resume` expose `revisionDigest` on every variant (no other tool), and
a new top-level `errors` registry freezes `consumer_dispatch_bg_unsupported`
— the server now maps that `SpecValidationError` to a typed MCP protocol
error whose `data` carries the structured validation errors and stable code.
`events.json` unchanged. v1 stays foreground-only.

### feat: per-issuance token/generation lifecycle + engine-level fencing (STRAT-TS-FANOUT-CONSUMER Slice C)

Every client-executed issuance is now fenced at the engine level. `StepState`
persists `dispatchToken` (minted per issuance: first dispatch, retry, stage
advance, post-revise re-issue), gate-bearing steps persist a per-round
`gateToken`, and terminal-succeeded state persists `acceptedDispatchToken` —
the consumer's reconciliation target. Fanout items persist `stage`, `epoch`,
`dispatchToken`, and a `generation` stamped from a run-level monotonic counter
that lives OUTSIDE checkpoint snapshots (revert provably cannot roll it back;
post-revert/post-revise re-enumeration advances it). Token lifecycle per the
design: persist-before-expose, stable within an issuance (plan/resume/restart
return the same token, no budget re-debit), rotate on any reissue, checkpoint
revert re-mints restored non-terminal issuances, cancellation permanently
fences outstanding issuances (a cancelled bg run no longer completes from a
late connector result). `engine.stepDone` accepts an optional `dispatchToken`
and `engine.gateResolve` an optional `gateToken` — missing accepted (migration
compat), mismatched or prior-round rejected. Runs persisted before this change
backfill tokens on resume. `plan` computes and persists `revisionDigest`
(SHA-256 over canonical JSON: sorted keys, no whitespace, UTF-8), verified on
resume. `audit` now reads DURABLE state (bypassing the in-memory pin an active
fanout holds) and exposes all three token fields. The commit/revert guard
extends through a consumer-worktree fanout's validated successor gate —
resolved by the same dependency notion validation uses, not array adjacency.
Wire exposure (MCP request echo fields, `revisionDigest` on responses) rides
the surface-8 slice; `mcp-surface.json`, `events.json`, and the MCP server are
untouched at surface 7.

### feat: IR `fanout.dispatch` + consumer-mode semantic validation (STRAT-TS-FANOUT-CONSUMER Slice B)

`fanout.dispatch: "engine" | "consumer"` lands in the IR with the default
injected into the VALIDATED value: the persisted effective spec always
observes `dispatch: "engine"` when the field is omitted (verified against
`StateStore` — `plan` already persists the Zod-parsed spec). Semantic
validation gains the consumer-mode rules (design r6): consumer + worktree
stages reject engine filesystem predicates in `ensure` AND in stage `when`
(detection walks the parsed expression AST, catching predicates nested in
boolean expressions and `{expr}` forms); consumer + worktree REQUIRES an
unconditional, normally-activated gate as the fanout's direct successor —
a `when`-guarded gate the engine could skip, or a gate reachable only via
`on_fail`/`on_approve`/`on_kill` routing (never normally activated), is
rejected, since either would bypass the mandatory merge handshake;
consumer fanout in subflows stays pinned to the existing root-only
diagnostic. `stratum_flow_run_bg` rejects consumer-dispatch specs at
submission with the frozen error code `consumer_dispatch_bg_unsupported`
(v1 is foreground-only) while foreground `plan` accepts the same spec.
Engine scheduling, MCP surface, and server error mapping are untouched —
consumer execution and the `errors` registry land in later slices.

### feat: tagged shape grammar for frozen contracts — `$array` / `$oneOf` (STRAT-TS-FANOUT-CONSUMER Slice A)

The frozen-contract shape language gains exactly two tagged constructs
(design r4/r5): `{"$array": <shape>}` (every element must match) and
`{"$oneOf": [<shape>, ...]}` with complete-strict exactly-one matching —
zero matches fail, ambiguous (≥2) matches fail, and variant matching is
whole-object strict (required present AND undeclared rejected; `field?`
stays optional). `$`-prefixed keys are reserved grammar tags, illegal as
record field names anywhere in the surface. Shape declarations are now
validated independently of value matching (`validateShape`): malformed
shapes — unknown `$` tags, a tag plus extra keys, empty or non-array
`$oneOf` payloads, leaf types outside the frozen vocabulary
(`any|array|boolean|null|number|object|string`), and a field declared in
both required and optional form — throw declaration errors distinct from
value mismatches. The JSON-schema translator implements the SAME grammar
(`$array` → `{type:"array", items}`, `$oneOf` → `{oneOf:[...]}`) and
rejects the same malformed shapes. Grammar machinery only: no
`mcp-surface.json` declaration changes, no surface bump — the `ready`
redeclaration rides the Phase-2 flag-day.

### feat: Phase-1 step_done epoch fencing over the wire (surface 7)

First half of universal dispatch fencing (STRAT-TS-FANOUT-CONSUMER design,
fencing scope amendment 2026-07-15): `stratum_step_done.request` declares an
optional `epoch`, and the server forwards it to the engine's existing
`expectedEpoch` staleness check — a report echoing a superseded epoch is now
rejected over MCP instead of silently satisfying post-revision readiness.
Compose echoes every engine-issued ready-entry epoch (compose develop). A
missing echo is still accepted (migration compat); per-issuance
`dispatchToken` fencing for ALL client-executed steps lands with the
consumer-fanout feature and then becomes required. The design amendment also
reverses the original "token optional/ignored for ordinary ids" cut, which
would have cemented the unfenced-step_done defect the 2026-07-15 whole-port
review confirmed.

### fix: TS engine control-plane hardening — resume ownership, cancelled gates, terminal revert shapes

Three control-plane defects surfaced by a whole-port adversarial review (codex
sol/high, TS engine vs Python reference), each fixed with a RED-first
regression test:

- **`resume` now honors bg-run ownership.** `engine.resume()` goes through the
  same sole-mutator guard as `stepDone`/`commit`/`revert`: an external resume on
  a bg-driven run would hand the driver's in-flight `ready` step to a second
  executor (Python parity: `bg_owned`). Cancelled runs stay durably abandoned;
  terminal bg runs still resume normally.
- **A cancelled run's gate can no longer advance it.** Gates are the one
  exception to the ownership guard, so `gateResolve` now honors the durable
  `cancelRequested` flag: after `flow_cancel_bg`, a decision on the
  still-waiting gate is refused instead of completing the run or issuing new
  ready work behind the cancellation — including after a server restart
  (rehydrate golden).
- **Terminal revert responses are declared, not adapter errors.** Reverting to a
  checkpoint of a retained terminal run legitimately returns `failed` or
  `budget_exhausted` (checkpoints snapshot `status`), but the frozen MCP surface
  declared neither — a legal revert persisted its state change and then threw at
  the adapter boundary. `stratum_revert` now declares both shapes
  (surface 5 → 6); the P5 exhaustive-coverage test exercises them.

### feat: STRAT-TS-FLOW-BG-REHYDRATE — detached flows survive a server restart

Detached background flows now re-attach a driver on startup instead of stalling
after a restart. Runs carry a durable `bgDriven` marker; `StateStore.list()`
enumerates persisted runs; `engine.rehydrateBgFlows()` (called from `serveStdio`
before serving) scans them and, for each non-terminal bg run, re-registers it and
launches a driver — a paused-gate run re-pauses itself, a cancelled or terminal
run re-registers its status without a driver. Rehydration is non-blocking and
per-run isolated: it launches each driver without awaiting per-run advancement, so
a slow or malformed persisted run fails in its own background driver rather than
blocking or crashing server startup.

Semantics (documented bounds): at-least-once across restart — a step whose
connector was in flight at crash is re-dispatched (writes must be idempotent), and
that re-dispatch is not re-ledgered. Single-process ownership is assumed (two live
engines on one state root are unsupported in v1). Also fixed a driver test flake:
the error path flips the registry to `failed` after the durable terminalization
persists.

### feat: STRAT-TS-FLOW-BG driver — fail-fast retries, parallel dispatch, epoch binding

Three follow-ups on the TS detached driver:
- **No-pointless-re-judge:** when a retry (ensure or `iterate`) produces output
  byte-identical to the prior attempt, the engine fails fast instead of spinning
  to the retry/iterate cap — re-judging unchanged evidence is wasted, and a
  deterministic `iterate.until` can never flip on identical output.
- **Parallel top-level dispatch:** the driver now fires all ready-step connectors
  concurrently, then settles each under the run lock. A settlement error is
  re-raised only when it is a genuine driver failure (step still ready at the
  same epoch, resolved scope-aware for subflow children); true supersession is
  reconciled by re-advance, so a malformed connector result terminalizes the run
  instead of re-dispatching forever.
- **STRAT-TS-FLOW-BG-OWNERSHIP slice 2 (epoch-bound dispatch):** ordinary steps
  now carry an `epoch` bumped on every revise reset; the driver binds each
  dispatch to its epoch, so a result dispatched before a revise is rejected as
  stale rather than committed into the reset epoch. The session/MCP path is
  unchanged (the epoch check is opt-in). OWNERSHIP is now COMPLETE.

### feat: STRAT-TS-FLOW-BG-OWNERSHIP (slice 1) — sole-mutator lockout

Closes the reachable stale-result vector from the STRAT-TS-FLOW-BG review: the
public `stepDone` now refuses an actively bg-driven run (running / paused_gate /
cancelled), so an external pump can't race a stale connector result into a reset
step. The driver uses an internal `stepDoneOwned` that bypasses the guard;
`gateResolve` still resolves gates; a cleanly-terminal bg run falls through to
the normal "not awaiting" error. `stepDone` is now async so the refusal surfaces
as a rejection. Attempt/epoch-bound dispatch for the multi-branch revise vector
(out of v1 linear+fanout scope) remains as slice 2.

### feat: STRAT-TS-FLOW-BG — TS whole-flow detached driver + bg MCP tools

The TypeScript engine can now run a whole pipeline **detached**: the server-side
driver pumps every `ready` step through the engine's connector and `stepDone`
without the session pumping each step, pausing (never auto-approving) at
top-level gates and resuming after `gateResolve`. Judged ensures run through the
existing judge path unchanged; async fanout is reused as-is. New MCP tools:
`stratum_flow_run_bg` / `stratum_flow_bg_poll` / `stratum_flow_cancel_bg`
(MCP surface bumped to v2). Scope is v1 linear + fanout; child-flow gate
propagation and restart-rehydration of detached loops are follow-ups.

Cancellation is cooperative and durable: `flowCancelBg` sets a persisted
`cancelRequested` flag that both the driver and in-flight fanout workers observe,
so no further items dispatch after cancel; a gate-paused flow cancels
immediately instead of wedging. The driver tolerates a benign concurrent advance
of a driven step (re-derives instead of failing a healthy run). A stale-result
race under out-of-contract concurrent mutation (unreachable in v1's
linear+fanout scope) is documented and filed as `STRAT-TS-FLOW-BG-OWNERSHIP`.

### feat: STRAT-CODEX-WRITE-DURABLE slices 3+4 — codex write + background

`stratum_agent_run(type="codex", write=True, background=True)` is now allowed
through a fail-closed launch gate (NARROW v1, kill-on-controller-loss). A
writable durable child blocks on an inherited pipe until the controller writes
`GO` — only after its verified `(pid, proc_start_time, pgid)` identity is
persisted; EOF before release makes the wrapper exit before codex ever runs.
Interrupted writable runs are terminated (never resumed) by a startup +
shutdown sweep. Codex review (2026-07-11) fixed two sweep defects: terminal
`failed` is now recorded only on confirmed death, and a run completing in the
scan race is re-scanned and wins. Two bounded residual windows (hard-killed
controller with no restart; `setsid()`-escaping payload) are documented and
deferred to STRAT-CODEX-WRITE-DURABLE-LIVENESS. Suite 1538 passed / 2 skipped.

### docs: STRAT-PY-RETIRE roadmap — full Python engine retirement

`docs/plans/2026-07-11-strat-py-retire-roadmap.md`: 5-phase epic from the
current COMP-STRATUM-TS soak (Phase 0) through Python deletion + PyPI
deprecation (Phase 5). Grounded in a measured inventory: 38 Python MCP
tools vs 10 TS, used-but-unported set (guard, parallel, iteration,
flow-control, judge-tool), disposition list for the unused surface, and a
consumer sweep (compose files, .mcp.json registrations, model-pricing
cron). Decisions: drain-and-cutover (no state migration), usage-driven
parity, bin-name claim at Phase 5, codex-allowlist relocation, stratum#6
as Phase 2 entry gate.

### ts — feat(cli): `stratum query` + `stratum gate` — the compose monitor seam (P7 prerequisite)

`ts/src/cli/query_gate.ts`: `stratum query flows|flow <id>|gates` and
`stratum gate approve|reject|revise <flow> <step> [--note] [--resolved-by]`,
emitting the Python stratum-mcp CLI's JSON projections and exit-code
contract (0 = result, 2 = idempotency conflict, 1 = error) so compose's
stratum-client can drive either engine unchanged. Status vocabulary mapped
to what compose branches on (complete/running/awaiting_gate/failed/
budget_exhausted/killed); killed derives only from the canonical attempt-0
gate-kill failure on a validator-accepted spec (no spoofing); listings skip
unreadable AND semantically-corrupt run documents; gate misuse classified
in Python resolve_gate order (terminal flow → conflict, wrong step →
conflict, current-non-gate → not_a_gate_step) with a TS-DAG exception: an
actually-waiting gate is always resolvable (multiple simultaneous gates are
legal here, unlike Python's linear current_idx); gate results are
route-derived (execute_step/killed/complete/max_rounds_exceeded — never
inferred from downstream advancement, which can complete synchronously);
revise on a null on_revise pre-checks to missing_on_revise WITHOUT
terminalizing the run. Both bins now carry exec bits (direct-path
invocation hit EACCES; npm sets bits only on install). STRATUM_STATE_ROOT
honored. terra/high build + sol/high review, 5 rounds (12 findings fixed,
1 rejected — compose-bin routing is compose-side by design) → REVIEW
CLEAN. Suite: 380 passing. Consumed by compose COMP-STRATUM-TS (flag-gated
engine cutover).

### ts — feat(judge): codex-OAuth judge backend + STRAT-TS-PORT live acceptance PASSED

Feature-level acceptance closed: the live golden flow (spec → codex task →
judged ensure → gate → engine-owned fanout → audit) PASSED on the real
binaries — `ts/acceptance/{golden-flow.v1.yaml,run_golden_flow.mjs,
golden-flow-result.json}` drive the shipped stdio MCP server over a real SDK
client with real codex dispatches and enforce the outcomes (judged
holds=true on gather, gate approve→fan, exactly-once fanout success per
item, keyless server env). The run surfaced an environment-parity gap: the
default judged-ensure runner (@ai-sdk/openai) requires OPENAI_API_KEY, but
this host (like the Python judge kernel, which routes judged predicates
through stratum_agent_run) runs codex on ChatGPT OAuth. New
`src/judge/codex_judged.ts`: judged predicates via the P3 codex connector
(read-only, same stakes routing spark/terra/sol, schema-validated verdict,
fail-closed everywhere, paid dispatch charged even on unparseable verdicts,
conservative output-rate pricing when the connector reports no usd,
policy/data prompt fencing with \u003c escaping making the fence markers
unrepresentable in payload data). `judgeBackend()` in src/mcp/server.ts:
explicit STRATUM_JUDGE_BACKEND=openai|codex (unknown values throw), default
keyed to OPENAI_API_KEY presence. 6 sol/high review rounds (5 findings
fixed; 1 rejected — nonzero-exit-with-text tolerance is an exact Python
parity port, codex.py:532/:684) → REVIEW CLEAN. Suite: 368 passing.

### ts — feat(cli,migrate): STRAT-TS-PORT Phase P6 — compat linter + reference parity flows

`ts/src/migrate/check.ts` + `stratum migrate --check <old.yaml>`: report-only
compat linter — parses v0.1–0.3 YAML, classifies every construct the spec
uses against the design guidance table (supported/unsupported/diagnostic,
with spec paths), always exits 0, emits no YAML and performs no semantic
translation (clean-break decision). `stratum validate` now parses YAML
instead of JSON. The fixture-sweep gate classifies every checked-in
.stratum.yaml document (docs/) plus every embedded v0 fixture across BOTH
Python suites (repo-root tests/ and stratum-mcp/tests) without crashing —
216 triple-quoted snippets + 2 concatenated-literal fixtures. `ts/parity/`:
3 reference flows hand-authored in both IRs (linear+gate, fanout, subflow)
run on both engines with fake connectors; the Python runner drives the real
public test seam (stratum_plan/step_done/gate_resolve/parallel_done) and
enforces expected terminal + ensure/gate outcomes, exiting non-zero on
mismatch; P6-PARITY-REPORT.md committed. Authoring-cost specimen
linear-gate.v1.yaml: exactly 5 task steps, 250 cl100k_base tokens, both
CI-enforced from file bytes (limit 400). Deps: yaml@2.9.0,
js-tiktoken@1.0.21. terra/high build; pre-gate self-adversary pass (3
test-honesty fixes: dead sweep arm, missing 5-step assertion, hardcoded
ensure literals) + sol/high review, 2 rounds (3 MUST-FIX + 1 SHOULD-FIX
confirmed and fixed: both-suite + concatenated-literal sweep, enforced
parity comparison, pipeline-nested unsupported classification,
reasoning_template certificates) → REVIEW CLEAN. Suite: 356 passing.

### ts — feat(mcp,cli): STRAT-TS-PORT Phase P5 — stdio MCP server + stratum CLI + watch

`ts/src/mcp/`: stdio server (@modelcontextprotocol/sdk) exposing EXACTLY the
frozen 10-tool surface from ts/contracts/mcp-surface.json — engine tools
delegate to StratumEngine, agent tools to the P3 connectors; requests AND
responses are runtime-validated against the frozen payload shapes
(default-deny), and the contract test drives EVERY status variant of every
tool through real execution paths over a real SDK client (no fabricated
samples). `ts/src/cli/stratum.ts`: `stratum validate` (exit 0/1/2) and
`stratum watch <run_id> [--json|--events [--kinds=...]]` porting the Python
_cmd_watch matrix 1:1 (text + sentinel-rc exit, missing run exits 2, pure
JSONL, curated/filtered events, 2000-char caps, died-without-sentinel), plus
flow-run watch over the persisted event spine via flowPoll cursors. Agent
watch reads incrementally by byte offset (positional fd reads; split
multibyte characters stay whole) and skips JSONL primitive noise. Both bins
run source-only under Node >=22.7 (engines raised to match the
transform-types loader) and are smoke-tested as real child processes; MCP
robustness covered (malformed args → MCP errors, connection survives;
internal throws never crash the transport). terra/high build + sol/high
review, 4 rounds → REVIEW CLEAN. Suite: 345 passing.

### ts — feat(engine): STRAT-TS-PORT Phase P4 — gates, engine-owned fanout, subflow execution, frozen observability contracts

Gates: resolve approve/revise/kill with runtime decision validation; revise
targets a validated ancestor, resets its descendants over the SAME forward
edges the validator walks (after/data refs + on_fail + gate routes), flow
`max_rounds` + per-gate `max_rounds` enforced — gate revision counters
survive upstream resets. Engine-owned fanout: concurrency-capped workers
dispatch items through the P3 connectors WITHOUT holding the run lock
(pinned-run registry; an independent stepDone proceeds during a slow batch),
`require` all/any/N judged BEFORE any worktree patch merges, per-item
lifecycle + ledger events on the one persisted spine (dispatch persisted
pre-connector — restart-proof), worktree isolation with staged-changes-
inclusive patches (git diff HEAD, 64MiB buffer) merged sequentially with
per-item durable progress, restart skips terminal items, revise invalidates
a live fanout via epoch + staleness checks. `run:` subflow execution
(pinned to P4 — third phase-orphan after ensure/iterate): namespaced
`<step>/<child>` ready steps, scoped rendering/eval, subflow output contract
→ parent output, on_fail inside the child scope, resume mid-subflow; v1
body restriction (non-entry flows are task-steps-only) enforced
path-precisely for ALL non-entry flows. `iterate {max, until}` through the
ensure evaluator seam with on_fail exhaustion. Frozen contracts:
`ts/contracts/events.json` (events: 1) + `mcp-surface.json` (surface: 1)
are PAYLOAD contracts (typed shapes, default-deny) validated by a contract
test that exercises every event kind and engine status against real runs.
Validator: fanout outputs are array-typed (`${fan.output[0].field}`, bare
field paths rejected). Fixed latent P1 bugs surfaced along the way: engine
dependency edges now include fanout over/stage and subflow `with` templates;
fanout over-resolution failures no longer retry forever. Production default
connector: contract-instructed JSON dispatch, previous-failure feedback,
workspace-write for worktree codex stages. terra/high build + sol/high
review, 11 rounds (23 findings fixed, 1 rejected with rationale) →
REVIEW CLEAN. Suite: 334 passing.

### ts — feat(connectors): STRAT-TS-PORT Phase P3 — connectors + durable background runs

`ts/src/connectors/`: claude connector over `@anthropic-ai/claude-agent-sdk`
query() (narrow SDK boundary, zod stays v3); codex connector shelling
`codex exec --json` with argv byte-identical to Python `_exec_args`, streamed
per-line parsing under `STRATUM_CODEX_STREAM_LIMIT_BYTES` (default 4MiB,
floor 64KiB, counted in UTF-8 bytes, loud overrun + SIGKILL — same regime as
Python's LimitOverrunError path). Durable background mode ports T2F5 exactly:
detached shell wrapper with `{"__t2f5_done__":rc}` sentinel, 12-hex run
registry under `~/.stratum/ts/agent_runs/` (0700 dirs / 0600 files),
restart-proof poll with 20k text caps and paths derived from the validated
run directory (serialized meta paths never trusted), cancel = killpg only
after a twice-checked pid + microsecond start-time identity match; Darwin
identity via libproc (fail-closed — no second-precision `ps` fallback,
matching Python). Terminal polls and sync runs report telemetry
`{durationMs, model, effort}`, threaded into engine attempt records per the
observability contract; connectors never report `usage.dispatches`
(engine-accounted). Python `test_agent_run_bg.py` scenarios ported 1:1; live
spark echo smoke auto-skips when codex is absent or sandbox-denied.
Codex sol/high build + 5 review rounds (4 hardening fixes, 2 stream-limit
fixes, 1 telemetry-accuracy fix) → REVIEW CLEAN. Suite: 285 passing.

### ts — feat(eval,judge,engine): STRAT-TS-PORT Phase P2 — ensure evaluator + judged tier, wired into the engine

`ts/src/eval/`: recursive-descent evaluator over JSON values implementing the
locked grammar exactly (result/input/item/prev, member/index own-property
access, whitelisted functions), prototype access impossible by construction,
bounded parse depth/nodes, and a group-transparent regex shape filter
rejecting nested AND adjacent quantified atoms (a*a*, (x)*(y)*, (a*)(a*)).
File helpers jailed to the workspace root: lexical + realpath containment,
O_NOFOLLOW fd reads, bounded read loop (16MB default), ancestor-TOCTOU
documented as accepted residual. `ts/src/judge/`: judged predicates via AI
SDK generateObject with stakes routing (cheap=spark/low, default=terra/high,
paranoid=sol/high), fail-closed on malformed stakes, conservative pricing
(unattributed tokens at the output rate — never $0). Engine now ENFORCES
`ensure` (the round-2 review catch): expr/file predicates through a
validated evaluator seam with structured retry reasons, judged predicates
through an injected JudgeRunner seam (fail closed when absent) with usage
settled into both ledgers and a fixed-payload "judged" audit event on every
path; plan() gains a canonicalized workspaceRoot; all injected-seam outputs
snapshot-validated against hostile getters/throws. IR `file_contains`
shorthand fixed to `{path, text}`. deps: ai + @ai-sdk/openai/anthropic.
Codex sol/high build + 7 review rounds (5 build must-fixes, 4 wiring, 3
hardening) → REVIEW CLEAN. Tests 67 → 258 (+1 env-gated live judged test).

### ts — fix(engine): STRAT-TS-PORT ledger audit — no spend escapes, ledger on every response

Owner-requested audit of the token/usage accounting: (1) a usage report
rejected for containing `dispatches` now settles its valid keys first — the
failed attempt's real tokens/usd/ms no longer vanish from the ledgers;
(2) render happens BEFORE the dispatch reserve, so a render failure no
longer ledgers a phantom dispatch, and non-dispatched failure attempts no
longer stamp `{dispatches: 1}` usage; (3) a run terminalized mid-advance
stops processing further steps (no stray "ready" persists on a failed run);
(4) every EngineResponse now carries a `ledger: { spent, budget? }` flow
snapshot so controllers get spend without a second audit call. +2 tests (67).

### docs — STRAT-TS-PORT design amendment: observability contract

"The engine may own execution, but it never owns information": one event
spine, frozen event vocabulary (`ts/contracts/events.json`, lands P4),
per-item fanout lifecycle events, non-blocking `status: "running"` +
`stratum_flow_poll` (surface grows to 10 tools), connector telemetry hints
(`durationMs` + model identity, P3). P1/P2 scope unchanged.

### ts — feat(engine): STRAT-TS-PORT Phase P1 — engine core (fake connectors)

`ts/src/engine/`: StratumEngine client-driven core loop (plan → stepDone →
resume → audit) with durable per-transition JSON persistence (injectable
state root, atomic unique-temp writes), `attempts` retries with structured
failure context, `on_fail` routing (unreachable targets skip on success
paths), local `when` skips that don't block `after:` successors, an injected
Evaluator seam for `set:` steps (grammar lands in P2), reserve/settle budget
ledgers (usd/tokens/ms client-settled even over limit; `dispatches`
engine-accounted, client reports rejected loudly), and E1 zod enforcement of
task `out` + flow `output`. Per-run promise lock serializes concurrent
stepDone; reference interpolation rebuilds from original-template positions
(immune to `$&` patterns and `${ref}` text in resolved values); all terminal
paths persist before responding. 24 engine tests (65 total) incl. golden
resume flow, table-driven error harness, and one regression per review
finding — 2 codex adversarial rounds, 8 must-fixes applied, final verdict
REVIEW CLEAN.

### ts — feat(ir): STRAT-TS-PORT Phase P0 — v1 IR schema + strict validator

New `ts/` pnpm workspace (`@smartmemory/stratum`, private until publish):
zod schemas for the consolidated v1 IR (5 constructs, normative field
matrix), the `${ref}` grammar parser with routing-edge extraction, and
whole-spec validation (contract resolution, DAG acyclicity, gate-revise
ancestry, fanout/subflow rules) with path-precise `E2_*` error codes.
41 table-driven tests incl. an adversarial-review regression block
(reserved `__proto__` contract fields rejected loudly; nested typed
arrays; one error per unknown field). Design: docs/features/STRAT-TS-PORT/.

### stratum-mcp — feat(agent): curated background-run Monitor stream (STRAT-AGENT-BG-MONITOR)

`stratum-mcp watch <run_id> --events [--kinds=...]` now emits compact curated
JSONL for meaningful Codex run events (assistant, tool, and error by default),
with opt-in started/reasoning/usage events and unconditional terminal done/died
events. This is the live inline companion to the existing Bash watcher bridge:
`Monitor(command: "stratum-mcp watch <run_id> --events")` receives one safe,
line-buffered event per update while default and `--json` watch output remain
unchanged.

### stratum-mcp — feat(agent): background agent runs + watch CLI (STRAT-AGENT-BG)

`stratum_agent_run(background=True)` (codex-only in v1) spawns the agent as a
detached T2-F5 durable child and returns immediately with
`{status: "bg_started", run_id, stream_path, pid, watch_cmd}` instead of
blocking the MCP call for the whole run. The run registry lives at
`~/.stratum/agent_runs/<run_id>/` (JSONL stream + completion sentinel +
meta.json), so everything below survives an MCP server restart.

New surfaces: `stratum_agent_poll(run_id)` (read-only status/text/usage,
tail-capped at 20k chars, restart-proof) and the `stratum-mcp watch <run_id>
[--json]` CLI — a line-buffered tailer that exits with the agent's rc, built
to bridge background runs into harness-native task tracking (launch the watch
via Claude Code's Bash `run_in_background`; `--json` stdout is pure JSONL for
Monitor consumers). `stratum_cancel_agent_run` now also cancels background
runs: pid/start-time identity check + group-leader check, then SIGTERM to the
process group.

Fail-loud guards: `background=True` rejects non-codex types
(STRAT-AGENT-BG-CLAUDE) and budgeted flows (STRAT-AGENT-BG-BUDGET). run_ids
are validated 12-hex at the single registry chokepoint (no path traversal,
no killpg on foreign metadata). Sync path (`background=False`) is unchanged.

Also: `proc_identity.proc_start_time` on macOS now uses native
`libproc.proc_pidinfo` instead of spawning `ps` (works under sandboxes that
deny exec). The identity token format changed on macOS — durable reparent
handles persisted BEFORE this upgrade will classify as `failed` (safe
degrade: consumer re-runs) across the upgrade boundary, never mis-reparent.

Adversarial review (codex, read-only): 3 findings (registry path traversal →
killpg exposure; unbounded stream scan; `watch --json` purity) — all fixed,
each with a regression test. 48 targeted tests; full suite 1508 passed.

### stratum — chore(codex): GPT-5.6 Sol/Terra models; default gpt-5.6-sol/high

Adds OpenAI's GPT-5.6 family (released 2026-07-09) to the codex model
allowlist: `gpt-5.6-sol` and `gpt-5.6-terra`, each with `/low|medium|high|xhigh`
effort variants (all verified live against codex-cli 0.144.0). The code-level
default (`_FALLBACK_DEFAULT`) moves from `gpt-5.5` to `gpt-5.6-terra/high`
(balanced tier, ~gpt-5.5 quality at half the price; effort pinned explicitly
to high). Sol stays available for hard passes. `CODEX_MODEL` still overrides.

Also corrects stale rows in `stratum_mcp/pricing.py` against current published
API pricing: gpt-5.5 $1.25/$10 → $5/$30, gpt-5.4 $1.25/$10 → $2.50/$15,
gpt-5.3-codex-spark $1.25/$10 → $1.75/$14; adds gpt-5.6-sol ($5/$30) and
gpt-5.6-terra ($2.50/$15). A monthly cron (forge root
`scripts/model-pricing-refresh.sh`) now re-verifies models + pricing.

### stratum — feat(codex): codex write mode (STRAT-CODEX-WRITE)

`stratum_agent_run(type="codex", write=True)` now runs codex with
`--sandbox workspace-write` so it can create and edit files in `cwd` — codex is
no longer read-only-only. Read-only stays the default (`write` defaults to
False), so the existing adversarial-review path is byte-for-byte unchanged.

Write is guarded, fail-loud: it is codex-only (rejected for `type="claude"`),
requires an explicit `cwd` (otherwise codex would write into the server's own
cwd), and honors the `STRATUM_CODEX_ALLOW_WRITE` kill-switch (absent = enabled;
`0`/`false`/`no`/`off` hard-disables and raises rather than silently downgrading).
Combining `write` with the read-only `read_jail` Docker path or the durable
stream is rejected at the connector (follow-ups `STRAT-CODEX-WRITE-JAIL` /
`STRAT-CODEX-WRITE-DURABLE`); a dedicated `stratum_codegen` tool and an
allowed-workspace-root policy are also filed as follow-ups. Verified end-to-end
against codex-cli 0.143.0: an empty dir + a write prompt produced a working
source file.

### stratum — fix(agent_run): accept tiered/profile agent suffixes in the connector factory

`stratum_agent_run` rejected `claude::critical` / `claude::fast` (and would have
rejected `claude:reviewer`) with `unknown type 'claude::critical'`, because
`connectors/factory.make_agent_connector` validated the **full** agent string
against `{claude, codex}` — while `executor.resolve_agent` already treats a
`:profile` / `::tier` suffix as first-class and validates only the base prefix.
The two dispatch paths disagreed, so a Compose build that uses tiered agents
(`build.stratum.yaml`) died at the first `stratum_agent_run` step even though the
flow-executor path accepts the same strings.

Fix: a single shared parser `connectors.factory.connector_base()` extracts the
connector prefix (the part before the first `:`). `make_agent_connector`,
`executor.resolve_agent`, and `parallel_exec._connector_type_from_agent` all
normalize through it, so connector selection is suffix-tolerant everywhere and
the three paths can't drift again. The suffix stays metadata for the caller
(Compose resolves it to model/effort/tools, passed via separate kwargs); it never
gates connector selection. An unknown base (`bogus::x`) and `opencode` still
raise as before. Tests: `tests/test_connector_factory.py`.

### stratum — fix(agent_run): surface the agent's last message on connector failure

When a connector streams the real error as an assistant turn and then its
subprocess exits non-zero, the propagating `ProcessError` discarded the
accumulated output, so callers (compose builds, anyone invoking
`stratum_agent_run`) saw only "Command failed with exit code 1 / Check stderr
output for details". The streaming loop now catches the exception and re-raises
with the agent's last spoken text (e.g. a `403 forbidden / "Request not allowed"`
auth error) plus the underlying error for debugging. This surfaced a real miss:
a compose env-strip bug made every agent step fail an auth check, but the 403 was
hidden behind the opaque subprocess error. Test:
`test_streaming_failure_surfaces_last_agent_message`.

### distill — feat(CORE-CODE-PROVENANCE-1 P1): code↔conversation provenance (`blame_session`)

Given a git **commit** or **`file:line`**, find which captured agent session (Claude Code + Codex) **authored** that code — a git-anchored evidence pipeline, NOT clock proximity. `git show` / `git blame -L` resolves the target, candidates are narrowed by repo + touched path, and authorship is proven strong→fuzzy: exact / normalized / block-hash / longest-common-substring, with an **IDF-weighted character-tri-gram fallback** (the denominator spans the whole target so a tiny shared fragment can't score 1.0; a fuzzy match must clear score + raw-coverage floors). Honest status (`ok | no_clear_author | no_overlap | no_indexable_content | merge_no_direct_changes`) with per-span resolution (strong ties → `no_clear_author`; multi-author commits → `ok`), span-scoped `survival`, and a source-aware `(source, source_path, line_no)` handle that chains into the new `read_transcript_centered` for both CC and Codex. New: `judge/postmortem/{provenance,codex_loader,transcript_reader}.py` (pure matcher + extractors + reader), `stratum_mcp/provenance_crawl.py` (git/FS orchestration), and the `blame_session` + `read_transcript_centered` MCP tools. `loader.py` refactored to share `center_over_rendered`. Codex-gate-clean design + blueprint + implementation; only successful (non-errored) edits count. SmartMemory feature CORE-CODE-PROVENANCE-1 / IDEA-445; product Phase 2 (graph index) deferred.

### stratum — feat(STRAT-AGENT-INTERP): interpolatable per-step `agent`

A flow can now select a step's executor at runtime by interpolating the `agent:` field through the **same** JSONPath resolver that already handles `inputs` — e.g. a router step emits `{agent: "codex"}` and a later step uses `agent: "$.steps.route.output.agent"`. Stays entirely in the data plane (the resolved value comes only from recorded flow state, so audit/resume/result-cache replay identically); literal agents are byte-identical to before. The data-plane enabler for COMP-CODEX-IMPL (Codex-implements / Claude-reviews).

- **Resolution (`executor.py`):** new `resolve_agent(agent, flow_inputs, step_outputs)` — `None`→`None`, literal→identity (no new validation), `$`-ref→resolved + **connector-prefix** validated against `VALID_AGENT_TYPES` (profile agents like `claude:reviewer` are first-class; only the part before `:` must be known). `effective_agent(state, step)` is the single accessor every runtime consumer routes through; it **recomputes** from persisted flow state rather than storing new state, so replay is identical.
- **Consumers rerouted:** all `get_current_step_info` dispatch envelopes (gate/function/inline/judge/decompose/parallel_dispatch), the cache-hit + completion `StepRecord`, cert injection (inline/decompose) and validation (now gated on the *resolved* agent, not the literal `$`-ref), the server-side `ParallelExecutor` construction (so an interpolated agent drives the **real** parallel dispatch, not just the advertised envelope), the pipeline/non-pipeline cert template, and every retries-exhausted error envelope. `_step_fingerprint` intentionally stays literal (it is the spec-tamper fingerprint).
- **Cache-key correctness:** `result_cache_key` folds the resolved agent **only when the agent is interpolated**, so claude- vs codex-resolved dispatches of the same step+inputs get distinct keys (no cross-executor cache collision) while literal-agent keys stay byte-identical (no existing on-disk cache invalidated).
- **`spec.py`:** `has_cert` treats a `$`-ref agent as conservatively cert-capable so a `reasoning_template` step is not spuriously flagged as having no validation; runtime still skips cert when it resolves to codex. (Static ordering validation deliberately omitted — consistent with how `inputs` `$`-refs rely on the runtime resolver, `spec.py:1355`.)
- **Import note:** `VALID_AGENT_TYPES` is lazy-imported inside `resolve_agent` — `_scan_guardrails` runs regexes in a multiprocessing-spawned worker that re-imports `executor`, and pulling the `connectors` package into executor's module-load graph broke that worker (every pattern fail-closed to a false match). Caught by the full suite.
- **Tests (18 new, `tests/test_agent_interp.py`):** `resolve_agent` branches incl. profile prefix + error cases; dispatch + parallel_dispatch envelopes carry the resolved agent; cache-key distinct-for-interpolated / unchanged-for-literal; cert injection gated on the resolved agent. Design + impl Codex reviews CLEAN. Full `stratum-mcp/tests/` **1436 passed, 2 skipped, 3 failed** — the 3 are pre-existing codex-model-validation failures from an unrelated working-tree change to `connectors/codex.py`, not this feature. `docs/features/STRAT-AGENT-INTERP/`.

### stratum — feat(STRAT-DISTILL): repeated-workflow → staged reusable-asset distiller (v1, manual)

The success-pattern complement to STRAT-LEARN-INLINE (failure-triggered, patches existing scaffold): DISTILL is recurrence-triggered and synthesizes *new* assets. Mines Claude Code session transcripts for repeated tool-call workflows and **stages** asset candidates (skill / subagent / command) for review — never auto-applied (STRAT-IMMUTABLE). Lifted from a Xiaomi MiMoCode `/distill` teardown (2026-06-13).

- **Detector** (`src/stratum/judge/distill/detector.py`, net-new): cross-session recurrence counting over tool-call sequences — `(tool, canonical_input)` singletons + tool-name n-grams (n=2..4). `canonicalize_input` reuses the `signals.py` meaningful-key priority (`command`/`file_path`/`path`/`pattern`/`url`/`notebook_path`). Reads the postmortem loader's `Session`/`Event` model directly (does NOT depend on judge verdicts). Pure + deterministic; an empty result ("nothing recurred → create nothing") is a valid success. Bar: recurred ≥ `min_count` (default 2).
- **Staging** (`src/stratum/judge/distill/candidate.py` + `postmortem/corpus.py`): `AssetCandidate` (mirrors `PatchCandidate`; `asset_kind` skill|subagent|command, `patch_type="create"` locked) → `append_distill_candidates` writes `.stratum/postmortem/distill_candidates.jsonl` — own `distill-1.0` schema (`origin:"distill"`), `fcntl.flock`-guarded, idempotent on a stable `cluster_id`. Never touches the inline or canonical corpora.
- **Synthesis** (`src/stratum/judge/distill/synthesize.py`): smallest-form heuristic (single recurring invocation → `command`; multi-step → `skill`; read-only investigation → `subagent`) with an opt-in, fail-open LLM override (`llm_form`). Produces *described* content only — never writes a file. Below-bar / formless → `None`.
- **Surfaces:** stateless `stratum_distill` MCP tool (mirrors `stratum_decompose`; no FlowState, returns `{candidates, evaluated, written, reason, out_path, applied}`); `distill extract|top|stats` CLI (`src/stratum/judge/distill/cli.py`, mirrors postmortem CLI); shared `runner.py` (`run_distill`); thin bundled skill `stratum-mcp/src/stratum_mcp/skills/distill/SKILL.md` (ships in the wheel; installed/upgraded to `~/.claude/skills/` by `stratum-mcp install`, manifest-tracked alongside the other bundled skills). `apply` is reserved (v1 always stages).
- **Scope (ship-narrow-first):** v1 is the manual distiller — a stateless tool is inherently opt-in, so there is no off-path / dead config. Auto-run + `[learn.distill]` config deferred to `STRAT-DISTILL-AUTO`; real asset scaffolding deferred to `STRAT-DISTILL-APPLY`.
- **Tests (32 new, all green):** `tests/test_distill_{detector,corpus,synthesize,cli}.py`, `stratum-mcp/tests/test_server_distill.py`. Full suites: `tests/` **743 passed** (14 pre-existing `test_e2e.py` real-LLM timeouts, untouched); `stratum-mcp/tests/` **1421 passed, 2 skipped**. Stratum flow `7022b74f` — all 6 slices passed `ensure` on attempt 1. `docs/features/STRAT-DISTILL/`.

### stratum — feat(STRAT-LEARN-INLINE): inline judge self-patch harvester edge (default-OFF)

Closes the gap between within-step self-correction (regenerate-until-met) and across-run learning (offline postmortem `--all`): when a judge turn produces a `must-fix` finding, classify the fix target and — for the ones that generalize — emit a **staged, described** skill/MEMORY patch *candidate* for review. Nothing is ever applied; the running spec is never touched (STRAT-IMMUTABLE).

- **Trigger (v1):** the `stratum_judge` MCP judge-step path only. `run_judge` also runs from the goal orchestrator (deferred → `STRAT-LEARN-INLINE-GOAL`) and guard transitions (deliberately excluded — a lifecycle gate, not a dev-work diagnosis).
- **Classifier** (`src/stratum/judge/inline_learn.py`): each `not_met` predicate → `transient` / `step-local` / `durable`. Heuristic by default (`judged`→durable, `deterministic`+flaky-marker→transient, else step-local); opt-in fail-open LLM classifier (`classifier="llm"`) reuses `stratum_agent_run`. Only `durable` emits a `PatchCandidate` (described intent: target + op + rationale + suggested-change prose — never a literal diff).
- **Inline sidecar** (`src/stratum/judge/postmortem/corpus.py`): candidates append to `.stratum/postmortem/inline_candidates.jsonl` — a **separate** file with its own `inline-1.0` schema (`origin:"inline"`, **no `label`**), never the transcript corpus `candidates.jsonl` (whose readers + replay `label` ground-truth can't absorb a synthetic row). `fcntl.flock`-guarded, idempotent on a turn-scoped `candidate_id`.
- **Surfacing:** `stratum_audit` gains `learn_inline:{evaluated,durable}` (distinguishes "ran, none durable" from "never ran") + `staged_patch_candidates`. New additive `FlowState.learn_candidates` / `learn_inline_evaluated`.
- **Config (opt-in, default OFF):** `[learn.inline_patch] enabled/classifier` in `stratum.toml`, env override `STRATUM_LEARN_INLINE_PATCH_ENABLED`. When off, the harvest is skipped entirely; the judge return dict, persisted flow JSON, and audit snapshot are **byte-identical** (new keys omitted-when-empty, no kernel/`JudgeResult`/judge-contract change). The harvest helper is **wholly fail-open** — a config/classifier/IO error is warned and swallowed, never turning a valid judge result into a tool failure.
- **Tests:** `tests/test_inline_learn.py`, `tests/test_inline_corpus.py`, `tests/test_project_config.py` (+10), `stratum-mcp/tests/test_server_inline_learn.py`. Full suites green: `tests/` **711**, `stratum-mcp/tests/` **1418** (2 Docker-gate skips). Codex design gate CLEAN (3 rounds 8→2→0); blueprint gate CLEAN (2 rounds 6→1→0); impl review (Codex rate-limited → independent-reviewer fallback) caught a dead LLM-classifier path (`ctx` not threaded, masked by `**kwargs` stubs) → fixed + regression-tested → CLEAN. `docs/features/STRAT-LEARN-INLINE/`.

### stratum — feat(COMP-PAR-MERGE-QUEUE-CONSUMER): surface the resolved pre-merge gate + structured parallel_done

Substrate for the Compose consumer-dispatch gate (agents run in Compose, not Stratum's `_run_one`).

- **Shared resolver** (`executor.py` `resolve_pre_merge_verify`): the `pre_merge_verify` resolution (list / `$.input.*` ref → list, dangling ref → `[]`) is now one function used by both the server-start site (`server.py`, via alias) and the dispatch-surface builder.
- **Dispatch surface** (`executor.py` `get_current_step_info`): the parallel_dispatch envelope now carries the **resolved `pre_merge_verify`** so the Compose consumer path can enforce it — added **only when non-empty**, so a step without a gate produces a byte-identical envelope.
- **`stratum_parallel_done`** (`server.py`): accepts `merge_status` as a bare string (back-compat) **or** a structured `{status, bounced_tasks}` (the consumer assembles gate-failed + merge-conflict bounces Compose-side). `_evaluate_parallel_results` derives human-readable `violations` strings from the structured bounces (appended to `per_task_cert_strs`).
- Full `stratum-mcp/tests/` **1413 passing**; Codex review → CLEAN.

### stratum — feat(COMP-PAR-MERGE-QUEUE): per-task pre-merge verify gate + bounce-into-reprompt for parallel_dispatch

- **What:** an optional **`pre_merge_verify`** gate on `parallel_dispatch` (isolation=worktree, server-dispatch). A list of shell commands (or a `$.input.*` JSONPath ref resolved from a flow input) runs in each task's worktree, via `worktree.run_pre_merge_gate`, **before** its diff is captured — first non-zero exit (or not-found / timeout) marks the task `failed`, records a structured `gate_failed` bounce on its state, and **skips diff capture** so the bad work never merges. `node_modules` is best-effort symlinked from base (bare worktrees lack it). Absent ⇒ byte-identical (no gate).
- **Bounce channel** (`server.py`): gate bounces are collected into a unified `ensure_failed.bounced_tasks[]`; `stratum_parallel_advance` accepts `merge_status` as a bare string (back-compat) **or** a structured `{status, bounced_tasks}` carrying consumer-computed merge-conflict bounces, and persists those onto the conflicting task's state. `_advance_after_parallel` now reverts + surfaces `ensure_failed` when require/merge fails on a step with no `ensure` clause (previously such a deferred-path failure silently advanced).
- **Bounce-into-reprompt** (`parallel_exec.py`): a re-dispatched task's prompt carries its prior-attempt bounce — `ParallelExecutor` snapshots inbound bounces at construction (`_inbound_bounces`), `_run_one` clears a task's bounce for a fresh attempt, and `_render_prompt` appends `_format_bounce_for_prompt(...)`. This is the server-side delivery point (the server re-resolves tasks on each re-dispatch, so a consumer-side prompt edit can't reach the re-run task).
- **IR** (`spec.py`): `pre_merge_verify` accepted on `parallel_dispatch` (oneOf array-of-strings | string); included in `_step_fingerprint` (tamper-detected).
- First consumer: compose GSD `execute` (closes COMP-GSD-3). Full `stratum-mcp/tests/` **1409 passing** (new `tests/test_par_merge_queue.py` + server-dispatch cases); Codex review 3 rounds → CLEAN.

### stratum — feat(STRAT-PAR-STREAM-TOOLDETAIL): per-task tool-use detail in the parallel-dispatch stream

- **What:** the streaming **claude** connector now surfaces, per tool call, the raw (size-capped) tool **input** + a `tool_use_id` on `tool_use_summary`, and emits a new **`tool_result`** event (`{tool_use_id, ok, output}`) per `ToolResultBlock` in a `UserMessage` — so a stream consumer can recover `input.file_path` structurally and observe per-call success/error text. Previously `tool_use_summary` carried only `{tool, summary(80-char), ok:true (hardcoded), duration_ms}` on the call (no raw input, no result/error), making per-task observability impossible. First consumer: compose `COMP-GSD-5` (gsd stuck detection).
- **Schema:** `BuildStreamEvent.schema_version` 0.2.6 → **0.2.7** (new `contracts/build-stream-event.v0.2.7.schema.json`). `tool_use_summary` + `tool_result` ride the open catch-all (no closed-kind change; the 6 closed kinds are byte-identical). Compose consumer accepts 0.2.7 (`build-stream-schema.js` `KNOWN_VERSIONS`).
- **Caps/parity:** input/output each capped to ≤2048 chars *including* a `…[truncated N chars]` marker (`_cap_text`); the codex connector is brought to parity (raw `input.command` capped at the same tool-detail bound, **not** the ~4 MiB stdout cap); opencode has no parallel-dispatch stream path (noted, no change).
- **Tests:** `tests/test_stream_tooldetail.py` (14) + strengthened existing connector/version-pin assertions. Full `stratum-mcp/tests/` **1384 passed, 2 skipped**. Codex review 2 rounds (cap exceeded bound + reported bytes-not-chars; codex parity used the 4 MiB cap) → **REVIEW CLEAN**. `docs/features/STRAT-PAR-STREAM-TOOLDETAIL/design.md`.

### stratum — feat(STRAT-GUARD): `guard` CLI subcommand (COMP-MCP-ENFORCE seam)

- **What:** `stratum-mcp guard <register|transition|override|migrate|history>` exposes the STRAT-GUARD library over the CLI so clients that reach stratum via subprocess (compose's `server/stratum-client.js`) can drive guarded transitions without speaking the MCP stdio protocol. Wire format: each action reads ONE JSON kwargs object from stdin and prints the result; domain errors print the canonical `{status:"error",...}` dict and exit non-zero, while a verdict **refusal** is a normal exit-0 `{status:"refused"}`. Thin wrappers over the existing `guard/` library (no new guard logic); `transition` passes the module `stratum_agent_run` so LLM-tier edges still verify from the CLI.
- **Tests:** `stratum-mcp/tests/test_guard_cli.py` (7 — golden flow, idempotent register, override, error harness). Full `stratum-mcp/tests/` **1370 passed, 2 skipped**.

### stratum — feat(STRAT-GUARD): standalone guarded-transition primitive (tamper-evident state machine over run_judge)

- **What:** five new MCP tools (`stratum_guard_register`/`transition`/`override`/`migrate`/`history`) expose stratum's independent-verification engine (`run_judge`) as a **resource-agnostic, tamper-evident state machine** for clients that manage a resource lifecycle **outside** a stratum flow. A client registers a transition graph + per-edge evidence predicates; a transition is permitted only if the edge is legal **and** its predicates verify against **trusted, server-read evidence**. First consumer is compose (`COMP-MCP-ENFORCE`), which today hand-rolls a bypassable copy (self-approving gates, `force`, unverified completion). The driving insight: `stratum_judge`/`gate_resolve` enforce guarantees only *inside* a flow keyed by `flow_id`+current step; the engine underneath (`run_judge`, `kernel.py:56`) is FlowState-light and reusable as-is.
- **Trusted evidence — NOT the T1 jail (key architectural decision):** the design's "extend the deterministic predicate vocabulary" framing was corrected at the blueprint gate. T1 (`predicates.py`) evals over a **read-only staged snapshot** with `{"__builtins__": {}}` and no real fs/git/subprocess — the opposite of "the guard server reads the file / runs the command itself." So the four trusted builtins (`server_file_exists`/`git_commit_exists`/`command_exit_zero`/`verdict_receipt_clean`) are evaluated **server-side** in a guard-owned evaluator (`guard/evidence.py`, an explicit 4-builtin `ast`-parsed allowlist — never `eval`), at the registered `workspace_root`, with traversal guards. The judge T1 jail stays pure; `run_judge` is still used for LLM-tier (`verified`/`judged`) edge predicates.
- **Tamper-evidence + threat model (scoped, not overclaimed):** the policy `(graph, edge_predicates, terminal, stakes)` is checksummed (immutable — weaken-by-reregister is rejected, `guard_migrate` is the token-gated path); the ledger is **hash-chained** (`entry_digest = sha256(canonical(core) ‖ prev_digest)`) and **verified before every trust-bearing read** (idempotency, receipts), failing closed on interior tampering but recovering a torn trailing line (crash mid-append). Explicitly **in scope**: a rogue MCP/API caller bypassing the skill. Explicitly **out of scope for v1** (documented, not silently assumed): an attacker with arbitrary local-fs write to `~/.stratum/guards/` — no unsigned scheme defends against the actor who can also edit the source; cryptographic signing is the named later escalation.
- **Correctness:** the **ledger is the source of truth for `current_state`** (registry.json's copy is a best-effort cache) so the durable, fsync'd ledger append is the atomic commit point and a crash self-heals on next load. Per-resource serialization = an in-process `asyncio.Lock` **plus** a cross-process `fcntl.flock` (acquired via `asyncio.to_thread` so the event loop never blocks; net-new — stratum had no cross-process lock). `guard_transition` uses **optimistic concurrency**: structural checks under the lock → slow predicate/`run_judge` evaluation outside it → commit re-acquires the lock and re-validates `current_state == from_state` + re-checks idempotency. `register_guard` is locked (no first-registration race). Idempotency: same key + same payload → `replayed` (returns the **stored original** verdict); same key + different payload → `idempotency_conflict`. Resource dirs are content-hashed (collision-proof vs slugs) with raw-id verification. No `force`: deviations go through `guard_override` (out-of-band `STRATUM_GUARD_OVERRIDE_TOKEN`, human + rationale, `deviation` ledger entry). `command_exit_zero` is opt-in (`STRATUM_GUARD_ALLOW_COMMANDS=1`); the command is fixed in the checksummed policy, never per-transition caller input.
- **Reuse vs net-new:** consumes `run_judge`/`Predicate`/`JudgeResult` (uniform verdict shape — deterministic edges synthesize a `JudgeResult` honoring the `clean==met` invariant), `canonical_json`, the fsync-atomic-write idiom, and the `{status,error_type,message}` tool-error convention as-is. Net-new: the guard registry/store, hash-chained ledger, guard-specific checksum, the cross-process lock, and the server-side trusted-evidence layer.
- **Tests:** `stratum-mcp/tests/test_guard_{store,evidence,transition}.py` + `test_server_guard.py` (59 — golden flow, every error path, tamper/`ledger_corrupt`, torn-tail recovery, crash-recovery state-from-ledger, idempotent replay/conflict, **concurrency** [same-key applies-once, concurrent first-registration], override/migrate token gating + immutability, paranoid-needs-trusted, command opt-in, traversal guard, real-git commit existence, LLM-tier via mocked `run_judge`). Full `stratum-mcp/tests/` **1363 passed, 2 skipped**. Codex review: blueprint gate 2 rounds (9 then 4 findings → CLEAN: integrity anchor/threat-model scoping, crash consistency, async-safe locking, run_judge side-effects + uniform verdict, receipt/idempotency semantics, torn-tail, `initial` storage, staging charset); implementation gate 2 rounds (5 findings → CLEAN: phase-3 idempotency re-check, stored-verdict replay + true refused target, locked registration, fail-closed predicate-type validation, concurrency tests). `docs/features/STRAT-GUARD/{design,blueprint,report}.md`.

### stratum — feat(STRAT-WORKFLOW-BG): server-driven background flow execution (v1 linear driver)

- **What:** a `_background_flow_advance` loop drives a flow through `function`/`inline` steps **autonomously** — dispatching each step's agent itself via `stratum_agent_run` — instead of the consumer round-tripping every step via `stratum_step_done`. Start with `stratum_flow_run_bg(flow_id)` (the session is then free), poll with `stratum_flow_bg_poll`, cancel with `stratum_flow_cancel_bg`. Closes the STRAT-WORKFLOW epic (ticket 6 of 6). The "largest architectural item / lands with the TS port" framing was outdated: advancement was a turn-driven state machine, and BG just wraps the existing `get_current_step_info`→`process_step_result` spine — no new engine.
- **Scope (ship-narrow v1):** the loop drives `function`/`inline` steps, **pauses** at gates (`paused_gate`), and **hands off** (never mis-executes) at `judge`/`flow`/`parallel_dispatch`/`pipeline` steps (`handoff:<mode>`) and any unrecognized dispatch shape. Autonomous parallel/pipeline execution + mid-parallel restart-reattach (the design's riskiest surface) are deferred to `STRAT-WORKFLOW-BG-PARALLEL`; judge/flow to `STRAT-WORKFLOW-BG-NESTED`; driver auto-restart to `STRAT-WORKFLOW-BG-RESUME`. Default-off — a flow runs consumer-driven exactly as before unless BG is started. No IR/schema change.
- **Dispatch parity:** `_bg_dispatch_step` reuses `stratum_agent_run` wholesale (budget debit, streaming, structured-output schema), extracts the envelope's `result`, and feeds it to `process_step_result` — the same schema/guardrails/ensure/retries a consumer-reported result gets. A connector `parseError`/non-dict result is routed through `process_step_result` as `{}`, consuming a **real, persisted** `state.attempts` under the step's retry cap (durable across resume).
- **Exactly one driver per flow:** a live `_BG_FLOWS` task makes `stratum_step_done` and `stratum_resume` return `bg_owned`; a second `stratum_flow_run_bg` is refused. Closes the dual-driver race (the per-flow lock serializes persistence, not in-memory `FlowState` mutation).
- **Cancel vs shutdown are distinct:** explicit cancel marks the flow in `_BG_CANCEL_REQUESTED` before `task.cancel()` → terminal `cancelled`; a shutdown drain (`_BG_SHUTTING_DOWN` set before cancel, mirroring T2-F5's detach-don't-kill) persists a **resumable** in-progress snapshot — a restart must not look like a user cancel. The marker is cleared in both the loop's and the tool's `finally` so a cancel-vs-finish race leaves no stale bit. Any unexpected exception finalizes a durable resumable `error` snapshot — never an orphaned `running` flow.
- **State:** `FlowState.flow_mode`/`bg_status`/`bg_pause_reason` (persist/restore round-trip; old flows default `consumer_turn`); BG `finalize` persists a **terminal snapshot** (not delete) so `stratum_flow_bg_poll` stays accurate after completion.
- **Tests:** new `test_workflow_bg_e2e.py` (15 — autonomous advance to complete with 0 `step_done`, bad-dispatch durable retries → error, gate pause, parallel handoff, budget halt, `bg_owned` on step_done+resume, cancel-terminal, cancel-authoritative-under-shutdown-race, connector-exception → durable error, shutdown-drain resumable). Full `stratum-mcp/tests/` **1304 passed, 2 skipped**. Codex review 3 rounds → REVIEW CLEAN (R1: unfinalized-exception-exit + non-durable bad-dispatch retry + resume-race [2×High,1×Med]; R2: cancel-tool stale-marker race [Med]; R3: docs). `docs/features/STRAT-WORKFLOW-BG/{design,blueprint,plan,report}.md`.

### stratum — feat(STRAT-WORKFLOW-RESUME): content-addressed result cache — an unchanged prefix replays instead of re-dispatching

- **What:** opt-in `cache: true` on a side-effect-free `compute` **function step**. When you re-run or iterate a flow, an unchanged prefix step returns its prior **validated** output from a content-addressed store instead of re-dispatching the agent — "same workflow + same inputs → 100% cache hit," the governed, cross-model answer to dynamic-workflow result caching. A hit dispatches no agent and debits no budget, and is recorded as `cache_hit` so the audit never passes a replay off as a fresh run. Ticket 4 of 6 of the STRAT-WORKFLOW epic; **orthogonal sibling** to `T2-F5-RESUME` (live-process reparenting), not a dependency — the forge-top row's "depends on / extends `T2-F5-RESUME`" clause was stale (`T2-F5-RESUME` is merged `2101cc4`; they compose but neither needs the other).
- **Scope (ship-narrow):** opt-in, default-off, `compute` function steps only. The parser **rejects `cache: true` at parse time** (fail-closed) on a gate/judge/`parallel_dispatch`/`pipeline`/inline step, an iteration-loop step (`max_iterations`/`exit_criterion`/`score_expr`), an accumulator step (`accumulate`), or a routing step (`next`) — gating the **effective** enablement (`step.cache OR fn.cache`), so a function-level `cache: true` can't smuggle an ineligible step past the validator. The author asserts the step's `output` is its whole effect; the cache replays the *result*, not any file writes/commits (documented caveat). Caching side-effecting steps, `parallel`/`pipeline` results, `next:` routing, and a shared/remote cache are named follow-ups.
- **Content-addressed key (per-step, NOT whole-flow):** `sha256(CACHE_VERSION ‖ flow_name ‖ step_id ‖ _step_fingerprint(step) ‖ _fn_fingerprint(step.function) ‖ canonical_json(resolved_input))`. The key folds **only this step's own** fingerprint and **its function's** fingerprint — deliberately not the global `spec_checksum` — so editing a *later* step changes only that step's key; the unchanged prefix still hits, and the edited step's suffix misses via the resolved-input cascade. A changed flow input cascades the same way from step 1. Non-JSON-serializable resolved input → forced miss, never an exception.
- **Checksum-helper extraction (single source of truth):** `_step_fingerprint`/`_fn_fingerprint` promoted from nested closures of `compute_spec_checksum` to module level so the **cache key and whole-flow tamper detection share the exact same fingerprints**. The fingerprints now also cover load-bearing fields they previously omitted — `step_guardrails`, function `guardrails`, `cache`, `step.output_schema`, and the function `output_contract` + its resolved contract field shape — so a guardrail/schema/contract edit invalidates a cached result **and** is tamper-detected (closes a pre-existing checksum gap for those fields too).
- **Store:** `~/.stratum/cache/results/<key>.json`, content-addressed (shared across `flow_id`s and sessions). Atomic tmp + `os.replace`; corrupt/version-skew record → miss, never crash; age+count eviction sampled off the hot path. Kill switch `STRATUM_DISABLE_RESULT_CACHE=1` forces every step to miss. Only `ensure`-passing results are ever written; the hit path re-validates the cached output against the current schema/guardrails/ensure before trusting it (belt-and-suspenders behind the key). `StepRecord.cache_hit`/`cache_key` round-trip through persist/restore; `stratum_audit` adds a `cache_hits` count.
- **Tests:** 5 new files (47 tests) — `result_cache` store unit (round-trip/corrupt/skew/atomic/evict/disable), IR parse + checksum (guardrail-edit invalidation), validator eligibility (both gates incl. function-level-cache bypass), key composition (intent/contract/schema/input sensitivity + prefix property), and the e2e golden flow (identical re-run → 4 hits / 0 dispatches; edit a late step → prefix hits; flow-input change → full cascade; kill switch; only-successes-cached; persist/restore round-trip). Full `stratum-mcp/tests/` **1289 passed, 2 skipped**. Codex review 3 rounds → REVIEW CLEAN (R1: function-level-cache validator bypass [High]; R2: fingerprints omitted output_schema/output_contract → contract/schema staleness [Medium]; R3: clean). `docs/features/STRAT-WORKFLOW-RESUME/{design,blueprint,plan,report}.md`.

### stratum — feat(T2-F5-RESUME): live-process reparenting — server-dispatched codex survives a restart

- **What:** a server-dispatched **codex** task in a `parallel_dispatch`/`pipeline` step now **survives an MCP server restart mid-run**. Previously `resume_interrupted_parallel_tasks` flipped every in-flight `running` task to `failed` on boot — a 20-minute codex run 90% done at restart was thrown away. Now the codex child is spawned **detached** and writes to a **durable file it owns**, so it keeps running after the server dies; on restart the task is re-classified `reparenting` and a fresh reader tails the durable stream to completion and recovers the full result. **No engine rewrite** — a spawn-site change + a durable-stream reader, proven by a feasibility spike (darwin incl. `kill -9`).
- **Scope (settled, ship-narrow):** **codex + server-dispatch only.** claude is in-process (no child to reparent), opencode isn't server-dispatchable, `stratum_agent_run` has no durable record — all named follow-ups. Unblocks the forge-top `STRAT-WORKFLOW-RESUME` (content-addressed replay, a different mechanism that *extends* this).
- **Durable spawn (S1, `connectors/codex.py`):** when the executor passes a `stream_path`, codex is spawned under a `setsid`-less POSIX-shell wrapper — `'"$@" >"$T2F5_OUT" 2>"$T2F5_ERR" <"$T2F5_IN"; rc=$?; printf {"__t2f5_done__":%d} "$rc" >>"$T2F5_OUT"; exit "$rc"'` — `start_new_session=True`, std fds `DEVNULL`, prompt fed from `$T2F5_IN`. The wrapper wraps the **final** `_build_codex_cmd` argv, so it composes **outside** the read-jail wrapper. The wrapper-written **sentinel** (NOT the connector's in-memory result) is the durable completion signal. A stateless `_emit_for_codex_event` maps codex JSONL records to events for **both** the live PIPE loop and the durable file tailer (`_tail_stream`, partial-trailing-line safe). `stream_path=None` (every existing caller) → today's PIPE behavior byte-for-byte.
- **Detach-don't-kill (S3/S6):** on shutdown the server sets `executor._detaching=True` on every live `_PARALLEL_EXECUTORS` instance **before** cancelling, and the codex connector's durable `finally` no longer kills the child (only an explicit `interrupt()` does, via `killpg` of the wrapper's group). `_run_one`'s WHOLE finalizer (terminalize / done-event / budget debit / worktree-remove) is bypassed for a reparentable task being detached — it stays `running` with its handle persisted. A genuine require/budget cancel keeps the full destructive teardown.
- **Restart classify + reattach (S4):** `classify_interrupted_parallel_tasks` (the boot hook, retargeted from `resume_interrupted_parallel_tasks`) flips a `running` task to `reparenting` iff it's `reparentable` AND its persisted pid is alive AND `proc_start_time` matches (strict PID-reuse guard, `proc_identity.py`); else `failed`. A `ReattachReader` (single-flight per task via `_REATTACH_READERS`, lazily started by `stratum_parallel_poll`/`stratum_resume`) binds the canonical `_flows[flow_id]`, tails `stream_path` to the sentinel without being the child's parent (verdict from sentinel rc ∪ `{"type":"error"}` event ∪ `$T2F5_ERR`), and **reproduces the `_run_one` finalizer accounting** (`finished_at`, `elapsed_s`, `tokens`, `dollars_recorded`, the one-time dispatch debit guarded by `dispatch_debited`, `budget_exhausted`, worktree removal). It also reproduces the restart-time **sibling cascade** (require-unsatisfiable / budget-exhaust → killpg the sibling reparented children).
- **Handle (S2):** 7 Optional fields on `ParallelTaskState` (`child_pid` = the wrapper/session leader, `stream_path`, `stderr_path`, `proc_start_time`, `stream_offset`, `reparentable`, `dispatch_debited`) — JSON round-trip + back-compat (old persisted states load with the not-reparentable defaults).
- **`reparenting` surfaces (S5):** treated as non-terminal/in-flight everywhere a terminal set is special-cased — `_item_counts`, `_require_unsatisfiable`, poll summary + `all_terminal`, `stratum_parallel_advance` terminal gate, `stratum_parallel_start` re-start reject, `stratum_resume` poll-not-dispatch. Durable `streams/` dir removed on flow delete; per-task terminal removes its own files **after** the terminal snapshot is persisted (crash-safe recovery window).
- **Tests:** 5 new files (42 tests) incl. the **E2E survival golden flow** — a real detached child survives `shutdown_all` and a fresh `ReattachReader` recovers the result it wrote *after* the executor was torn down. Full suite **1242 passed, 2 skipped**. Codex: design 5 rounds + blueprint 3 rounds + plan review 1 round + impl review 2 rounds (stranded-terminal-task, persist-before-delete, restart sibling cascade) → REVIEW CLEAN. `docs/features/T2-F5-RESUME/`.

### stratum — feat(STRAT-WORKFLOW-PIPELINE-FANOUT): bounded data-driven map-reduce for pipelines (split → lanes → join)

- **What:** a pipeline can now **fan out** — a stage marked `fanout: {max: K, require: …}` emits a list, the next stage(s) run **once per element** in ≤K parallel lanes, and a stage marked `join: true` **reduces** the surviving lane outputs into one result. True `pipeline()`-style map-reduce over a list the pipeline discovers at runtime. The *split* half of the filed `-PIPELINE-FANOUT` row; fixed-count replicate (best-of-N) and unbounded fan-out are deferred follow-ups.
- **No engine change.** K lanes are pre-materialized on the existing static grid (`item{i}::stage{j}::lane{k}`); lanes past the runtime list length ride the `-PIPELINE-ROUTE` **`skipped`** primitive (an unfilled lane is just a skipped task — zero new task state). The one genuinely new primitive is the **multi-predecessor join**: the engine's first task with >1 dependency, binding `{prevs}`/`{prevs_raw}` = the list of surviving (complete, filled) lane outputs.
- **Split-output contract:** the split stage's result is a native `list` (used as-is) or a JSON-array string (parsed); a non-array string or any non-list result **fails the split stage** with a clear message. Enforced in a split-role validation branch in `_run_one` (after cert, before terminal commit), which also caps `len(L) ≤ K` (over-cap → split fails — the honest boundary of *bounded*) and memoizes the list so lanes read a resolved, validated `L` via a single `_effective_lane_input` resolver.
- **Lane bindings:** a per-lane stage's `{item}` is the lane element `L[k]`; `{source}`/`{source_raw}` is the original source item (so a lane can reference both, e.g. `summarize {item[title]} of {source[id]}`); the first per-lane stage's `{prev}` is the lane element.
- **Two require scopes (both reuse `all|any|N`):** **lane-require** (`fanout.require`) — how many *filled* lanes must complete for the join to run; a failed lane drops from `{prevs}` and the join runs over survivors (`require: any`/`N`) or the item fails (`require: all`). Evaluated in a **new join-specific dep-gate** that waits for all lanes terminal, then gates on survivors (uniform empty-list rule: 0 filled satisfies `all` → join runs with `{prevs}=[]`, fails `any`/`N`). **item-require** (step `require`) — unchanged. `_item_counts` learns that a failed *lane* is not itself an item failure (the join's complete-vs-cancelled state carries the lane verdict).
- **Server:** `_collapse_pipeline_items` emits one `items[].stages` entry per **per-item** stage (split/join/pre/post) and **none** for per-lane indices (lane detail lives in the trace); the full lane-id graph is enumerated so the require-bypass guard holds. Fill is read from lane **status** (`skipped` ⇒ unfilled — sound because route predicates are banned in-region), no list re-resolution. Fan-out is **server-dispatched only**: a fanned-out pipeline via `stratum_parallel_done` is rejected (the status-fill inference is trusted only on executor-produced traces).
- **Validation:** exactly one `fanout` + one `join`, `join` after `fanout`, ≥1 per-lane stage between, `max ≥ 1`, `require ∈ {all,any,int≥1}`; `when`/`exit_when` banned inside the region **and** pre-fanout `exit_when` banned (it would skip the whole region and the join would misread the early-exit skips as unfilled lanes). All parse-time.
- **Tests:** new `test_pipeline_fanout.py` (33 — spec shape/region validation, desugar lane grid + multi-dep join edge, executor fill/skip/survivors/require/`len>K`/non-list/empty-list, server collapse + `_done` rejection). Combined suite (`tests/ stratum-mcp/tests/`, e2e + docker-live excluded): 1879 passed, 2 skipped. Codex: design 5 rounds (split-output contract + `_run_one` hook, route-predicate ban in-region, uniform empty-list require, two-part lane helper, status-fill scope), impl 2 rounds (pre-fanout `exit_when` × fanout-region interaction) → REVIEW CLEAN. `docs/features/STRAT-WORKFLOW-PIPELINE-FANOUT/design.md`.

### stratum — feat(STRAT-WORKFLOW-PIPELINE-ROUTE): conditional stage routing for pipelines (`when` / `exit_when`)

- **What:** a pipeline `stage` may now carry two optional predicates: **`when`** (evaluated before the stage dispatches — if falsy the stage is *skipped* and the previous stage's output flows through unchanged) and **`exit_when`** (evaluated after the stage completes, over its own output — if truthy the item *early-exits* and its remaining stages skip). Per-item, server-evaluated, on the existing static N×S grid. The conditional-routing half of the filed `-PIPELINE-FANOUT` row (the actual 1→many split stays deferred — it needs a variable task graph the fixed-at-construction executor can't grow mid-run).
- **No new engine, no grid-shape change.** Routing is a new terminal task state `skipped` layered on the `-PIPELINE` desugar. The crux: a skipped task reports `skipped` but the downstream dependency gate (`parallel_exec.py`) treats a `skipped` predecessor as *proceed* (not cancel) and threads its passthrough result as `{prev}` — so the chain continues transparently. A skipped stage never acquires a concurrency slot and never counts as a budget dispatch.
- **Two binding contracts (they fire at different times):** `when` binds `{item, prev, prev_raw}` (the input; stage 0 → `{item}` only); `exit_when` binds `{item, result, result_raw}` (this stage's own output; all stages). Both compile through the existing ensure jail (`compile_predicate`) with an **AST free-name validation pass** at parse time — allowed = the predicate's bindings ∪ `_ENSURE_BUILTINS` (so `len(item['tags'])>0` validates; a stage-0 `when` referencing `prev`, or any unknown name, is a spec error). `any`/`all` added to the jail builtins. Comprehension/lambda-bound names are excluded from the free-name check.
- **Degrades safely:** a malformed `when` fails *open* (runs the stage), a malformed `exit_when` fails *closed* (no exit); both log a warning rather than writing the failure-semantic `ParallelTaskState.error`. `exit_when` is evaluated only on a terminal-`complete` task (after cert), so an invalid output that cert flips to `failed` can't trigger an early-exit.
- **`skipped` recognized everywhere a terminal state is special-cased** (the `-BUDGET` pattern): `_item_counts` (settled-non-failure → an early-exited/skipped tail reads complete; `require: all` satisfied), `_collapse_pipeline_items` (item complete iff every stage complete-or-skipped; `missing`≠complete bypass guard intact), restart-rejection, poll summary, `all_terminal`, `stratum_parallel_advance` terminal check, and both `ParallelTaskState→task_results` serializers (via `_serialized_task_status`). **Scoped regression fix:** the failed-partition treats `skipped` as non-failure *only* for pipelines — plain `parallel_dispatch` keeps `failed = status != complete`, so a client can't submit `status:"skipped"` to bypass `require: all`.
- **Scope:** predicate evaluation is **server-dispatched only** (the executor evaluates them); the client-dispatched `stratum_parallel_done` path doesn't, and that's a documented limitation. No IR/schema change beyond the two optional stage keys (checksum already fingerprints stages wholesale).
- **Tests:** new `test_pipeline_route.py` (27 — predicate compiler/AST validation, spec-level when/exit_when validation incl. stage-0 rejection, executor skip/early-exit/passthrough/isolation/degradation, server-side collapse+evaluate incl. the non-pipeline bypass guard). Combined suite (`tests/ stratum-mcp/tests/`, e2e + docker-live excluded): 1846 passed, 2 skipped. Codex: design 6 rounds (gate-clobber, server-surface enumeration, AST-vs-jail name validation, exit_when binding contract), impl 1 round (non-pipeline require bypass) → REVIEW CLEAN.

### stratum — feat(STRAT-WORKFLOW-BUDGET-DOLLARS): promote run-budget `usd` from recorded-only to enforced

- **What:** the flow run-budget `usd` axis is now an **enforced** cutoff on the MCP path, not just recorded. A `budget: {usd: 5.00}` flow halts (`terminal_status=budget_exhausted`) once accumulated dollar cost crosses the cap. Closes the deliberate deferral in the parent `STRAT-WORKFLOW-BUDGET` ("recorded-not-enforced; mechanism absent").
- **Why it was deferred:** connectors emit token counts but no dollars (codex hardcodes `cost_usd=0`, claude omits it), and `litellm.completion_cost` lives only in the library executor — `stratum-mcp` has no litellm dep. So there was no token→price mechanism on this path.
- **Mechanism:** a static, hand-maintained `MODEL_PRICING` table (`pricing.py`, USD per 1M tokens, seeded for the claude-4.x and gpt-5.x/codex families) with `cost_from_tokens(model, in, out)` pricing input/output separately and stripping the codex `/effort` suffix. Unknown model → `$0` (degrade, never block a flow) with a one-time warning when a `usd` cap is in effect. Patch/extend prices without a release via the `STRATUM_MODEL_PRICING_JSON` env override (merged over the built-in table; malformed JSON degrades silently).
- **Wiring:** `accumulate_usage` (`run_budget.py`) derives dollars from token counts when no positive `cost_usd` is reported (trusts a real `cost_usd` if present — future-proof), so **both** server-dispatched debit sites (`stratum_agent_run`, parallel `_run_one`) price dollars for free; `budget_exhausted` enforces the `usd` axis; `init_budget_state` (`executor.py`) now yields a ledger for a `usd`-only budget. All token/dollar inputs are sanitized (`nonneg_int`/`nonneg_float`): negative/NaN/inf/non-numeric → 0 so a bad value can neither credit the ledger nor poison `usd` enforcement (`nan >= cap` is always False); non-string model ids degrade to `$0` rather than raising.
- **Consumer-reported usage:** `stratum_step_done` gains an optional `usage` param (`{input_tokens, output_tokens, model}` or pre-priced `{tokens, dollars}`) so the common *sequential* consumer path debits too — charged **after `process_step_result` validation** (a stale/wrong-step call is rejected uncharged) but **across all outcomes** (ok + every retry status), so a retry storm can't evade the cap; on exhaustion it tears down any child flow then halts. No `dispatches` charge (a consumer step isn't a server-dispatched agent).
- **Scope:** client-dispatched parallel work (`stratum_parallel_done`) carries no usage field in v1 (server-dispatched parallel IS covered); deferred. No IR/schema change — `usd` already existed as a budget key.
- **Tests:** new `test_pricing.py` (12) + `test_workflow_budget_dollars.py` (13, incl. usd exhaustion via agent_run and via step_done, retry-storm halt, unpriced/negative/NaN/non-string-model/unhashable-model robustness); `test_run_budget.py` + `test_workflow_budget_state.py` updated for the inverted `usd`-enforced contract. Combined suite (`tests/ stratum-mcp/tests/`, e2e + docker-live excluded): 1819 passed, 2 skipped. Codex: design 3 rounds (retry-storm bypass, debit placement vs validation, child-flow orphan on hard-stop), impl 4 rounds (untyped/negative/NaN coercion, non-string model in pricing chokepoint, unhashable model in the unpriced set) → REVIEW CLEAN.

### stratum — feat(STRAT-WORKFLOW-PIPELINE-STAGEOPTS): per-stage cert + timeout for pipeline steps

- **What:** a pipeline `stage` may now declare its own `task_reasoning_template` (cert) and `task_timeout`, overriding the step-level defaults — so a fast `claude` clean stage and a slow `codex` verify stage can have different timeouts, and a stage that must emit structured output can carry its own cert while a free-text stage carries none. Follow-up to `-PIPELINE` (shipped same day, `bc8182d`), which only supported per-stage `agent`/`intent_template`.
- **Precedence (one rule, presence-based):** for any field, *stage value if `is not None`, else step value, else default*. A stage `task_reasoning_template: {}` inherits the default sections (`_apply_cert_defaults` now runs per stage in `_build_step`, same as step-level) rather than being treated as absent.
- **Cert *instructions* now injected, not just validated** (the non-obvious half): the parallel path historically only *validated* a cert post-hoc and never injected its instructions into the prompt — so an explicit per-stage cert would have failed (the agent was never told to produce it). `ParallelExecutor._render_prompt` now appends the effective cert's instructions via `inject_cert_instructions` (pipeline-only, graceful-degrade on a malformed template), so per-stage certs actually instruct the agent.
- **Agent-gate rule:** an *explicit per-stage* cert applies unconditionally (explicit beats heuristic — a codex stage with its own cert is validated + instructed); a *step-level fallback* cert keeps the claude-agent-gate (preserves `-PIPELINE` behavior). One shared `executor.effective_pipeline_task_cert(stage, step, agent)` helper drives all three pipeline cert sites (`_run_one` validate, `_render_prompt` inject, `server._evaluate_parallel_results` validate) so they can't drift.
- **Zero non-pipeline regression:** the helper is **pipeline-only**. The two *non-pipeline* `parallel_dispatch` cert paths are intentionally asymmetric (`_run_one` validates unconditionally, `_evaluate_parallel_results` is claude-gated) and a single helper can't represent both — so each call site keeps `if is_pipeline:` → helper, `else:` → its existing branch verbatim, and injection only fires for pipelines. `parallel_dispatch` prompt construction is byte-identical.
- **Wiring:** `spec.py` (stage schema gains `task_reasoning_template`/`task_timeout`; pipeline validation widens allowed stage keys; per-stage cert defaults/validation in `_build_step`); `executor.py` (`expand_pipeline_tasks` stamps `_task_timeout`/`_task_reasoning_template`; new `effective_pipeline_task_cert`); `parallel_exec.py` (per-task timeout in `_run_one`; effective cert in `_run_one` + `_render_prompt` injection); `server.py` (per-task effective cert in `_evaluate_parallel_results`). Checksum needs no change — the `stages` fingerprint already serializes each stage dict.
- **Tests:** 13 new in `stratum-mcp/tests/test_pipeline.py` (STAGEOPTS section). Combined suite (`tests/ stratum-mcp/tests/`, e2e + docker-live excluded): 1780 passed, 2 skipped. Codex: design 3 rounds (caught the prompt-injection gap + the non-pipeline cert asymmetry), impl 1 round → CLEAN.

### stratum — feat(STRAT-WORKFLOW-PIPELINE): `pipeline` step type — no-barrier stage staggering

- **What:** a new `pipeline` IR step type runs a `source` list through an ordered `stages` list with **no inter-stage barrier** — item A can be in stage 2 while item B is still in stage 0, so wall-clock is the slowest single-item chain, not the sum of per-stage maxima. The cross-client, governed, cross-model analogue of Claude Code's `pipeline()` dynamic-workflow primitive. Epic STRAT-WORKFLOW ticket 3 of 6 (after `-NAMING`/`-IMPERATIVE`/`-BUDGET`).
- **Approach (desugar, no new engine):** a `pipeline` step compiles (`source × stages`) into the existing `depends_on` task graph and reuses `ParallelExecutor` verbatim. Staggering is an emergent property of the existing `asyncio.Semaphore` + dependency waiters that *don't hold concurrency slots*. v1: linear stages, 1:1 per item.
- **Surface:** `stages: [{intent_template, agent?}, …]`; per-stage `agent` enables cross-model pipelines (a claude stage then a codex stage in one flow). Stage *j*'s prompt threads stage *j-1*'s output via `{prev}` (JSON-stringified) and `{prev_raw}` (raw object field access). Step-level `task_timeout`/`task_reasoning_template` apply uniformly across stages in v1 (per-stage variants deferred to `-PIPELINE-STAGEOPTS`).
- **Semantics:** `require` is **item-scoped** (an item is complete iff its full chain completes); a single item's failure drops only that item's downstream stages — siblings continue unless item-scoped `require` is already unsatisfiable (`require: all` → first item failure cascade-cancels; `any`/`N` → siblings run on). Consumer reads a per-item `items: [{item, status, result, stages}]` aggregate (canonical step result; `ensure` uses bracket access on the plain-dict elements, e.g. `result.items` then `i['status']`).
- **Wiring:** `spec.py` (stages field + JSON schema + pipeline validation branch + two-site stray-`stages` rejection on every non-pipeline step type); `executor.py` (`_step_mode` maps `pipeline → parallel_dispatch`; shared `expand_pipeline_tasks` consumed by both the dispatch resolver and `get_current_step_info` so advertised surface == dispatched graph; checksum `+stages`); `parallel_exec.py` (`is_pipeline` flag; per-task `_intent_template` + `{prev}`/`{prev_raw}`; per-stage `_agent`; pipeline-scoped per-task cert agent-gate; item-scoped `_require_unsatisfiable`); `server.py` (desugar in `_resolve_dispatch_tasks`; pipeline-aware `_evaluate_parallel_results` + `_collapse_pipeline_items`; `parallel_advance` raw gate widened to a mode check).
- **Safety / correctness:** `_collapse_pipeline_items` enumerates the **full desugared graph** (not the reported task subset) as source of truth, so the client-dispatched `stratum_parallel_done` path cannot satisfy `require: all` by omitting an item's tasks (missing stages count as `incomplete`); `require: all` means *every item complete*, not merely no-failures. Non-pipeline `parallel_dispatch` behavior is byte-identical (`is_pipeline` defaults off; regression-tested).
- **Tests:** `stratum-mcp/tests/test_pipeline.py` — 27 tests incl. a timing-overlap staggering proof, per-item isolation, the require-bypass guard, and `ensure`-over-items. Combined suite (`tests/ stratum-mcp/tests/`, e2e + docker-live excluded): 1767 passed, 2 skipped. Codex: design 6 rounds, blueprint 4 rounds (caught a 2nd live cert path + a 2-site validation gap), impl 2 rounds (caught the require-bypass + an empty-string hole) → all REVIEW CLEAN.

### stratum — fix(#1): CI green on a hermetic stratum-only checkout (judge + isolation + platform fixes)

The combined-suite CI (`test.yml`, added in 4d55522) ran the whole corpus against a bare checkout and failed; only the first failure was visible because of `-x`. Root-caused and fixed the whole cascade:

- **Judge production bug:** `_validate_judge_result` (server.py) loaded the judge-result contract schemas from a sibling `compose/contracts` checkout and a broad `except` turned a *missing schema file* into `schema_validation_failed`. Any `pip install stratum-mcp` (where `__file__` is in site-packages, no compose tree) or stratum-only CI checkout therefore failed **every** `stratum_judge` call. The runtime check is a best-effort result-shape regression catcher, not a correctness gate — it now degrades to a skip (one-time stderr warning) when the schemas can't be located, raising only on a genuine mismatch. Regression test `test_judge_succeeds_when_contract_schemas_absent`.
- **Judge log isolation leak:** `judge/logging.py` did `from .staging import JUDGE_ROOT`, freezing the root at import time — so `append_turn_log` wrote `turns.jsonl` to the real `~/.stratum/judge/` even after the root was reconfigured (e.g. in tests). Now resolves `staging.JUDGE_ROOT` at call time (staging is the single source of truth). Caught by `test_goal_e2e`'s no-home-writes assertion, which had been passing only on leftover local state.
- **Cross-repo contract tests** (`test_goal_state`, `test_judge_schema`, `test_judge_corpus`, `test_goal_tool`) read `compose/contracts/*.json` directly; they now `skipif` the contracts dir is absent (run locally where compose is a sibling, skip in stratum-only CI). Also fixed a hardcoded absolute `/Users/...` contracts path in `test_goal_tool`.
- **Platform:** `test_judge_sandbox::test_profile_realresolves_paths` exercised the macOS `/tmp`→`/private/tmp` symlink canonicalization (Seatbelt is macOS-only) — now `skipif sys.platform != "darwin"`.
- **CI (`test.yml`):** kept a single hermetic job (both packages in one process, preserving the cross-package contamination guard), dropped `-x` so the full failure set is visible. Contract tests skip without compose; live Docker/model judge gates skip without `OPENAI_API_KEY`. Hermetic CI sim (no compose, no keys): 1677 passed, 67 skipped.

### stratum — feat(#1): `stratum-mcp doctor` install/environment diagnostics

- **What:** new `stratum-mcp doctor` CLI subcommand that surfaces the common first-run failure modes behind `compose init` leaving Stratum disabled (smartmemory/stratum#1). Checks: Python version vs. the `>=3.11` floor (with the exact running version + interpreter path), whether `stratum-mcp` is installed (`importlib.metadata`, with version + location), whether a `stratum-mcp` console script resolves on PATH (`shutil.which`), and whether the active `python` differs from the interpreter that owns the package. Exit 0 = healthy, 1 = problems; every failure carries an actionable `fix:` line.
- **Shadow detection:** distinguishes "not installed" from "installed but no binary on PATH" (pyenv-shim / PATH mismatch) from "installed but declares no console script" — the last being the vendored-kernel-shadow footgun the issue calls out. Each maps to a different remediation (`pip install` / `ln -sf` / `pip uninstall && pip install`).
- **Wiring:** `src/stratum_mcp/doctor.py` (pure `evaluate(Probe) -> DoctorReport` + `gather_probe()` + `render()` so logic is testable without touching the environment); dispatched in `server.main()`, listed in `_cmd_help`. `tests/test_doctor.py` — 10 tests covering each branch + live `gather_probe`/`_cmd_doctor` smoke. Full `stratum-mcp/tests/` 1055 passed, 2 skipped.

### stratum — fix(#4): cover `score_expr` in `compute_spec_checksum`

- `_step_fingerprint` hashed `max_iterations`/`exit_criterion`/`accumulate`/`accumulate_key` but not `score_expr`, leaving a tamper-detection gap (a live flow's score expression could be altered mid-run undetected). Added `score_expr` to the fingerprint; regression test `test_spec_checksum_covers_score_expr`. Found during STRAT-WORKFLOW-IMPERATIVE.

### stratum — feat(STRAT-WORKFLOW-IMPERATIVE): governed accumulator + loop-until-dry for the iteration loop

- **What:** a per-step iteration loop can now declare `accumulate` (an expression extracting the iteration's item list from `result`) and optional `accumulate_key` (a per-item dedup-key expression binding `item`). Items are deduped across iterations into `FlowState.iteration_accumulator`, and `exit_criterion` additionally sees `accumulator` / `accumulated_count` / `new_count` / `dry_streak`. Loop-until-dry is expressed as a predicate — `exit_criterion: "dry_streak >= K"` (K consecutive zero-new rounds) — with no new construct, no new MCP tool, no new outcome verb. Epic STRAT-WORKFLOW ticket 3 of 6.
- **Scope reconciled (verify-first):** the ROADMAP framing ("the IR cannot express `while (count < N)`, loop-until-dry, or in-flow dedup") was substantially stale — **STRAT-ENG-4 already ships** the counted loop (`max_iterations`) + until-guard (`exit_criterion` with `iteration`/`best_score`/`prior_scores`) + K-window stagnation. The genuine residual was the accumulator + a dry-predicate distinct from identical-fingerprint stagnation. 6th confirmed stale-forge-top-row instance.
- **Wiring:** `accumulate`/`accumulate_key` IR fields (`spec.py`, schema v0.2+v0.3, `_build_step`); validation (require `max_iterations`/`accumulate`, dunder guards, rejected on gate + `decompose`/`parallel_dispatch` steps); included in `compute_spec_checksum` (STRAT-IMMUTABLE tamper-detection). New `compile_value_expr(expr, bind)` mirrors `compile_score_expr` (value-returning, dunder-guarded, parameterized binding). `report_iteration` dedups (canonical-JSON keys, non-hashable-safe) and folds accumulator kwargs into a single unified `exit_criterion` eval. `process_step_result` merges `accumulated`/`accumulated_count` into the authoritative step output **after** validation; accumulator cleared in every terminal/restart path (success, all 4 failure routes, `_clear_from`, server retry-reset).
- **Safety:** a malformed `accumulate`/`accumulate_key` is an `accumulate_error` that **freezes `dry_streak`** — a broken extractor can never manufacture a false dry exit. Fingerprint-stagnation is **suppressed for accumulator loops** so a `dry_streak >= K` predicate with `K > _STAGNATION_WINDOW` isn't preempted.
- **Review:** 2 Codex design-gate rounds (4 findings: authoritative-output path, false-dry-streak, retry-reset, key-hashability/checksum) + 1 blueprint round (3 findings: merge-after-validation, on_fail cleanup, compile-once key expr) + 3 implementation rounds (ensure-path cleanup miss, parallel-step validation hole, stagnation preemption) → REVIEW CLEAN. 20 new tests; full `stratum-mcp/tests/` 1044 passed, 2 skipped. `docs/features/STRAT-WORKFLOW-IMPERATIVE/{design,blueprint,report}.md`.

### stratum — feat(STRAT-WORKFLOW-BUDGET): flow-execution-wide run budget ceiling

- **What:** a flow may declare a run budget; every **server-dispatched** agent debits it; when an enforced axis is exhausted the flow is marked terminal (`budget_exhausted`) and in-flight parallel siblings are cascade-cancelled. Closes the gap where `parallel_exec` enforced only a per-task `timeout` and `BudgetCaps` was scoped to a single `stratum_judge` run. Promotes parked `idea_budget_ceilings`. Epic STRAT-WORKFLOW ticket 2 of 6.
- **Enforced axes:** `ms` (wall-clock, as cumulative active-dispatch compute-seconds — resume-safe, parallel-aware), `max_agent_dispatches`, `max_tokens`. Declared by extending the **existing** flow-level `budget:` block (`IRBudgetDef`/`BudgetDef` gain two optional integer fields — no collision, no new key). `usd` is **recorded-not-enforced** (dollars aren't computable on the MCP path: connectors emit tokens, codex hardcodes `cost_usd=0`; `litellm.completion_cost` exists only in the library executor). The ROADMAP's "dollars + wall-clock, gap is scope not mechanism" premise was **verified wrong for dollars** on this path — follow-up `STRAT-WORKFLOW-BUDGET-DOLLARS` filed for a token→USD pricing table.
- **Wiring:** usage captured in both connector shapes (claude `kind="step_usage"` / codex `metadata.type="usage"` / `run()` `type="usage"`); debited at the two server chokepoints — `ParallelExecutor._run_one` and `stratum_agent_run` (attributed via `correlation_id`). New `run_budget.py` (pure helpers: `accumulate_usage`/`debit_budget`/`budget_exhausted`). `FlowState.budget_state` threaded through **both** persistence paths (`executor.persist/restore_flow` + `goal/orchestrator.py`'s synthetic-flow serializer, which always carries `None`). Run budget added to `compute_spec_checksum` (STRAT-IMMUTABLE tamper-detection).
- **Hard cutoff is durable across restart:** `budget_exhausted` set **before** persist (parallel) / in the `finally` (agent_run, so error/cancel still charges and marks terminal). Recognized at every advancement + status surface: `stratum_step_done`, `_advance_after_parallel` (covers `parallel_poll`/`advance`), `stratum_parallel_done`, `stratum_gate_resolve`, `stratum_parallel_start` (pre-fanout gate), `stratum_check_timeouts`, `stratum_skip_step`, `stratum_resume`, `_flow_status`, `_build_audit_snapshot`.
- **Contract change (additive):** `status` enum in `flow-state.v1.schema.json` + `query-flows.v1.schema.json` gains `budget_exhausted` (same shape `killed` already had).
- **Known v1 limitation (documented):** judge-internal T2/T3 dispatches are governed by the judge's own `BudgetCaps`, not the run-wide budget (the verifier carries no `correlation_id`); deferred. No behavior change for flows without a `budget:` block.
- **Review:** 2 Codex design-gate rounds (5+2 findings) + 3 implementation-review rounds (4→1→0 — error-path debit, four missing advancement gates, non-durable terminal status, dropped partial usage — all wiring bugs the happy-path tests missed). Full `stratum-mcp/tests/` 1024 passed; 44 new tests. `docs/features/STRAT-WORKFLOW-BUDGET/{design,blueprint,report}.md`.

### stratum — docs(STRAT-WORKFLOW-NAMING): formalize the two-tier workflow/flow vocabulary

- **Wrote down a distinction the code already encoded.** Stratum splits *workflow* (authored definition — a `.stratum.yaml` spec with a `workflow:` block, discoverable via `stratum_list_workflows`) from *flow* (the executable DAG definition: `flows:`, `@flow`) and *flow execution* (a single run — a `FlowState` with a `flow_id`). The boundary existed structurally but was never documented, risking vocabulary drift. **No rename** — the definition/instance split is intentional (Temporal/Airflow model); a rename would be ~20 files of churn for zero behavior gain.
- **SPEC.md** gains a "Terminology: Workflow vs Flow" section (three-layer glossary table + `git diff`-vs-`flow_id` rule of thumb). **README.md** gains a matching "Workflow vs Flow" Core Concepts entry plus a positioning note framing Stratum as **governed, portable, cross-model workflows** — the cross-client answer to single-vendor in-context orchestrators.
- **Docstrings** (narrow scope, 3 load-bearing public symbols) now carry the distinction: `stratum_list_workflows` (lists *definitions*, not runs), `@flow` (*defines* a flow; invoking it *creates* a flow execution), `FlowState` (runtime state of *one* flow execution). No behavior, signature, or API change — purely documentary.
- Codex doc-review gate caught two real internal inconsistencies in the initial drafts (prose calling a flow "the execution unit and its running instance," contradicting the table that separates flow from flow execution; and "### Flows" implying only YAML defines flows, omitting the `@flow` library track) — both tightened, re-review **REVIEW CLEAN**. First of 6 tickets in the STRAT-WORKFLOW epic. `docs/features/STRAT-WORKFLOW-NAMING/design.md`.

### stratum — fix: test-hygiene follow-ups from STRAT-TEST-EVENTLOOP-HYGIENE

- **`.githooks/pre-push` self-perpetuating bump loop.** The pre-push hook auto-commits `chore: bump to 0.2.N` when pushing to `main`, but a commit created during pre-push can never be part of *that* push — it lands unpushed and the next push re-triggers the hook, forever (`0.2.47`→`0.2.48`→…). Added a loop guard: capture the main ref's local/remote oids and skip bumping when every commit in `remote..local` is already a `chore: bump` commit (nothing real changed since the last bump). Real-work pushes still bump exactly once; the bump path itself is unchanged. Verified live: bump-only push now prints `skipping bump (loop guard)`, exits 0, creates no commit.
- **`test_judge_corpus.py` mutated a tracked fixture every run.** `test_kernel_runs_on_10_corpus_candidates` unconditionally rewrote `tests/fixtures/judge_corpus_smoke.json` (whose `candidate_id`s vary with corpus regen — a human diff aid, not an assertion oracle). Guarded the write behind `STRATUM_UPDATE_CORPUS_FIXTURE=1`; a normal run no longer touches the tracked file. No equality assertion added (would be flaky); the per-candidate behavioural asserts are unchanged. Verified: test passes, fixture stays clean post-run.

### stratum — fix(STRAT-TEST-EVENTLOOP-HYGIENE): combined-suite event-loop pollution

- Running `tests/` + `stratum-mcp/tests/` in one pytest process produced ~64 order-dependent failures (`65 failed, 1024 passed` in the bounded repro) — 9 `stratum-mcp/tests/integration/` files each defined an identical `def _run(coro): return asyncio.get_event_loop().run_until_complete(coro)` bridge that drove the **process-global** loop, which a prior `tests/` test leaves closed under pytest-asyncio `asyncio_mode = "auto"`. Per-directory runs were green only by ordering luck; no production code implicated (library `run()` was already loop-hardened in `a875ba7`).
- **Fix:** all 9 `_run` helper bodies → `asyncio.run(coro)` (private per-call loop, immune to prior loop state). Signature unchanged → **zero call-site edits**; diff is 9 files × 1 line. The ticket's larger `@pytest.mark.asyncio` migration alternative was intentionally not done (unnecessary to close the defect).
- **Verified:** same bounded repro post-fix `1 failed, 1088 passed` — the sole residual is the unrelated, pre-existing, environment-dependent `test_judge_jail_docker.py::test_live_gate_A_real_model_turn_through_connector` (real Docker+model), explicitly out of scope. Regression guard: full `stratum-mcp/tests/` standalone `982 passed, 0 failed`. `docs/bugs/STRAT-TEST-EVENTLOOP-HYGIENE/{description,repro,diagnosis,report}.md`.
- Follow-ups filed in report (not fixed here, out of scope): a test mutating committed fixture `tests/fixtures/judge_corpus_smoke.json` as a side-effect; pre-existing `tests/test_e2e.py` hangs; optional combined-run CI guard.

### stratum — feat(STRAT-JUDGE-v2-slice2): decomposer modes (`auto` + two-phase `hybrid`; `ask` skill-only)

- **Closes the `user`-only decomposer cut** (design.md v1 cut #2). `run_judge` gains a trailing defaulted `decomposer_mode: str = "user"` param threaded into the single `JudgeKernelMeta` stamp site (was a hardcoded literal); every existing caller is byte-for-byte unaffected. `GoalState` gains an additive `decomposer_mode` field (old state files load as `"user"`) made immutable on resume via a third `restore_goal_state` check mirroring the `mode` check.
- **Two-phase, stateless surface (no kernel state machine).** `stratum_goal` gains `decomposer ∈ {user,auto,hybrid}` (validated at the MCP boundary *before* predicate parsing → deterministic `invalid_decomposer`; `ask` is a skill-layer concept, rejected). `auto` decomposes the prompt **once on a fresh goal** via the reused, fail-open `LiteLLMDecomposer` (litellm `claude-haiku-4-5`), `asyncio.to_thread`-wrapped; resumes reuse persisted predicates. New stateless `stratum_decompose` tool returns a draft `{predicates,applied,reason,model}` for the `hybrid` flow (caller presents → user edits → passes back).
- **Resume safety (Codex-review-hardened).** `_resolve_predicates` substitutes persisted predicates **only** when caller is `auto`+empty-list **and** the persisted goal was itself `auto`; every other resume falls through to the `predicates_hash`/`mode`/`decomposer_mode` immutability gate (raises `GoalImmutabilityError`) — no silent provenance/predicate coercion. `auto`+`cheap` with any non-deterministic resolved predicate is surfaced as structured `auto_cheap_mismatch` **before** the loop (not swallowed mid-run as budget burn) on both fresh and auto-resume paths.
- Typed `GoalError` subclasses (`DecomposeFailed`/`AutoPredicatesConflict`/`AutoCheapMismatch`/`InvalidDecomposerError`) carry `error_type` snake_case strings, mapped explicitly *before* the generic `except GoalError` (which would emit PascalCase). Output `JudgeKernelMeta.decomposer_mode` Literal **unchanged** (4-value; `ask` a permanently-unproduced reserved member — contract back-compat). Design gate 2 Codex rounds + blueprint 3 rounds + impl 2 rounds → REVIEW CLEAN. 686 (`tests/`) + 965 (`stratum-mcp/tests/`) green (e2e excluded — no model in env); 30+ new tests. `docs/features/STRAT-JUDGE/{design.md §v2 slice 2,blueprint-v2-decomposer.md,plan-v2-decomposer.md,report.md}`.

### stratum — feat(STRAT-JUDGE-T3-READJAIL-CODEXNEST): non-nesting Docker read-jail — `codex_jailed` is now real (live gate PASSED)

- **The non-nesting primitive.** The parent's live gate falsified `sandbox-exec`-wrapping `codex exec` (codex self-applies Seatbelt; Seatbelt can't nest). This ships a `JailDriver` seam in `sandbox.py` (`SandboxExecJailDriver` retained inert as the proven `/bin/cat` regression substrate; `DockerJailDriver` is v1) and runs the T3 adversary in an ephemeral container whose **only readable host path is the `:ro`-bound staged turn tree**. codex runs `--dangerously-bypass-approvals-and-sandbox` inside because the container *is* the externally-enforced sandbox (the officially-sanctioned pattern). Fresh container per call → zero cross-predicate state bleed.
- **Blocking live gate PASSED for real** (`test_judge_jail_docker.py`; Docker 29.4.3, codex-cli 0.130.0, Darwin 25.5): (A) a real `codex exec` gpt-5.4 turn through the **real connector path** read an unguessable planted token out of the jailed staged tree; (B) `/bin/cat`-grade proof that the container namespace denies the sibling `turns.jsonl` and the host repo. Verification is **host-scoped** (`_docker_readjail_verified()`: True on Darwin where the gate ran, or explicit `STRATUM_DOCKER_READJAIL_VERIFIED=1` opt-in) — NOT a global constant that would over-claim on an unverified Linux/CI host (distinct from the permanently-`False` Seatbelt `_CODEX_READJAIL_VERIFIED` — two flags so one never conflates two primitives). `read_jail_available()` now reflects driver selection; **`verifier.py`/`kernel.py` unchanged** — `codex_jailed` provenance is genuine end-to-end.
- **Seven defects only a real `codex exec` could surface** (the session thesis): duplicate `--skip-git-repo-check`; read-only rootfs/no writable HOME; `CODEX_HOME` refused under `/tmp`; no stdin into the container (`-i`); no CA bundle in `node:slim` (TLS fail); codex 0.130 dropped `--api-key` (in-container `codex login --with-api-key` then `exec codex`); `-C` must stay on the evidence dir. All fixed; each documented in the report.
- **Vendored pinned image** `judge/jail/Dockerfile` (node:22-slim + `ca-certificates` + `@openai/codex@0.130.0`, non-root), content-addressed tag, lazy `_ensure_image` (build-fail → `JailUnavailableError`, never a silent fallback or public-image pull); shipped as wheel package data.
- **Auth path locked + truth-corrected:** env-injected `OPENAI_API_KEY` (no `~/.codex` host mount — that would add a second readable host path). `RESIDUAL_CODEX_JAILED` rewritten for the env-key model; `compose/contracts/judge-result.json` ll.32/108 descriptions corrected `sandbox-exec`→container-namespace (enum/field **shape frozen** — no consumer moves).
- **Failure routing unchanged, verifier-owned:** static absence → `claude_cold_fallback`; operational failure of the *selected* jail (build/daemon/auth/turn error) → `codex_jailed_error`, never silently downgraded. Exactly 4 tests retargeted (invariants preserved verbatim on their new owners); all frozen anchors incl. the entire `test_judge_t3.py` honesty set green unmodified. Codex review CLEAN across design/blueprint/plan gates. Follow-up **STRAT-JUDGE-T3-READJAIL-LINUX** still open (run the same gate on Linux/CI before claiming it). `docs/features/STRAT-JUDGE-T3-READJAIL-CODEXNEST/{design,blueprint,plan,report}.md`.

### stratum — feat(STRAT-JUDGE-T3-READJAIL): read-jail machinery + honest-degrade (live gate falsified the premise)

- **Connector read-jail capability (shipped, verified for ordinary processes).** New `stratum/src/stratum/judge/sandbox.py`: `build_seatbelt_profile` (deny-default, real-path-resolved, single staged-tree read-allow + `~/.codex` for auth), `materialize_profile`, probe. `read_jail` threaded `stratum_agent_run → make_agent_connector → CodexConnector`; spawn wrapped in `sandbox-exec -f <profile>` at both `codex.py` callsites; `_cleanup_jail` terminates+awaits the child *before* unlinking the profile on every path; `--ephemeral` inserted after `exec`. OS enforcement **proven** (`test_judge_readjail.py`: confined `/bin/cat` reads the staged tree, is denied the sibling `turns.jsonl` and the repo).
- **Live gate run — and it falsified the core premise.** Real `codex exec` EPERMs at startup under a deny-default Seatbelt profile regardless of every file/non-file allowance and codex's own bypass flag (`codex --version` runs jailed; `codex exec` does not). Strong inference: codex exec self-applies Apple Seatbelt and Seatbelt cannot be nested — `sandbox-exec` is the wrong primitive for jailing codex, not a tunable profile gap.
- **Honest re-scope (not a false guarantee).** `read_jail_available()` is gated `False` (`_CODEX_READJAIL_VERIFIED=False` ∧ sandbox-exec present). `paranoid` T3 honestly degrades to the in-process Claude cold-read, per-predicate `PredicateResult.t3` = `claude_cold_fallback` with `RESIDUAL_CLAUDE_FALLBACK` stated verbatim (never rounded to "confined"). `codex_jailed`/`codex_jailed_error` lanes are dead-but-tested, one flag-flip from active when a non-nesting primitive lands.
- **`T3Provenance`** (`result.py`): `mode`/`guarantee`/`model_id`/`residual`, optional on `PredicateResult` (additive superset); `make_t3_provenance` pure map; `meta.model_id` documented as T1/T2-lane only (T3 model authoritative in `t3.model_id`); `meta.t3_summary` a per-predicate rollup, never a flattened label. `evaluate_t3` branches jailed-Codex vs Claude-fallback with a machine `[t3:<mode>]` reason tag; jailed-error vs fallback-error never conflated.
- **Honest-absence contract:** no adversary run ⇒ `t3=None`, `ran_t3=False`, no `T3` in summary, no fabricated `tier_disagreements`, `degraded_judged=True`, T2 stands — every surface agrees.
- `compose/contracts/judge-result.json`: additive optional per-predicate `t3`; `meta`/`stakes` descriptions reconciled. New `test_judge_sandbox.py` (10) + `test_judge_readjail.py` (8) + 11 `test_judge_t3.py`; 659 suite green (excl. standing live-inference `test_e2e`). 8 Codex rounds (3 design + 1 blueprint + 4 impl) → CLEAN; live gate caught the `--ephemeral`-after-`exec` bug `--version` never would. Follow-ups filed: **STRAT-JUDGE-T3-READJAIL-CODEXNEST**, **STRAT-JUDGE-T3-READJAIL-LINUX**.

### stratum — feat(STRAT-JUDGE-v2-slice1): T3 cold-read adversary (paranoid-only)

- **`paranoid` stakes is live.** Every interpretive `met` is cross-checked by a T3 adversary asked to falsify it. `default`/`cheap` unchanged (byte-for-byte v1). `spec.py` stakes Literal + both JSON-schema enums admit `paranoid`; the kernel no longer raises `StakesNotAvailableError`.
- **`evaluate_t3`** (`verifier.py`): cold by signature — does not accept the T2 `TierRecord`/`Evidence`; adversary/falsifier prompt; Claude, Read/Grep/Glob only, Bash disallowed, `cwd=staging_root`; reuses T2 citation/parse discipline; fail-safe `ambiguous`/`t3_no_staged_evidence` on empty staging (never fabricates `met`).
- **Disagreement:** T2 `met` + T3 `not_met`/`ambiguous` → final `ambiguous` + a `tier_disagreements` record (T4 quorum deferred — surfaced, never a silent pick). T2 `met` + T3 `met` → `met`.
- **`degraded_judged`** redefined: "a `judged` predicate did not receive adversarial (T3) verification" — `False` once T3 ran.
- **Cold-read isolation is best-effort, stated honestly** (three Codex rounds killed two isolation overclaims): the connector stack provides no filesystem read-jail. Real guarantee = T3 is not *handed* prior reasoning (structural) + per-predicate tier rows are buffered and flushed in a `finally` *after* T3 (closes the shared-`turns.jsonl` side channel for the same predicate; preserves audit completeness on mid-predicate exception). Accepted residual + hard read-jail tracked as STRAT-JUDGE-T3-READJAIL.
- 11 new `tests/test_judge_t3.py`; 3 stale-contract tests updated; contract docs (`compose/contracts/judge-result.json`, MCP tool descriptions) reconciled. 6 Codex rounds (3 design + 3 impl) → CLEAN.

### stratum — feat(STRAT-JUDGE-POSTMORTEM-v2.2): corpus-quality fixes + replay harness

> **RETIRED 2026-07-18.** STRAT-JUDGE-POSTMORTEM (v1.5 → v2.2, the whole
> 13-module `judge/postmortem/` subsystem) was retired with the Python engine by
> STRAT-PY-RETIRE. It was dropped, not ported: TS `learn` (`ts/src/learn/harvest.ts`)
> reads engine run records from `~/.stratum/ts/flows/*.json` and never reads
> conversation transcripts, so it targets a different corpus rather than replacing
> this one. The transcript-reading capability now lives in SmartMemory —
> `smartmemory/provenance/reader.py` (which superseded Stratum's
> `transcript_reader.py` on 2026-06-23) and `smartmemory/importers/agent_transcript.py`
> (Claude Code + Codex ingestion, shipped 2026-08-20).
>
> Final source is archived on the [`python-legacy`](../../tree/python-legacy) branch
> (tip `642dda3`); on `main` the engine tree `src/` tracks zero files and no
> `postmortem` module remains, so every command in the entries below is dead here.
> The orphaned corpus data under `.stratum/postmortem/` (`candidates.jsonl`,
> `candidates.v1.0.jsonl`, `replay-scorecard.json`, untouched since 2026-05-17)
> was deleted 2026-08-30.
>
> Kept for history — the calibration finding still stands: the corpus was
> high-precision but too sparse to calibrate a judge (n_scored=1), and growing
> usable volume needs more work-oriented transcripts, not more harness code.

- **#2 acceptance/topic-shift discrimination** (`signals.py`): `_is_genuine_acceptance` gates the acceptance signal behind `_FORWARD_PIVOT_PATTERNS` + a symmetric `_token_overlap` check — "thanks, now let's Y" is a pivot, not acknowledgement. Conservative: only softens `true_met→ambiguous`, never flips a label.
- **#3 predicate decomposition** (`decompose.py`, new): `LiteLLMDecomposer` back-decomposes `request_text` into `result.Predicate` lists in the kernel's real `deterministic|verified|judged` taxonomy. Mirrors the `llm_gate` seam — litellm-routed, pydantic-validated, fail-open = empty list (never fabricates predicates). CLI `--decompose`; schema **1.1 → 1.2** additive `predicates` key.
- **#4 replay harness** (`replay.py`, new + `replay` CLI subcommand): runs a faithful judge subset over the corpus at moment-of-claim, scoring per-tier false-met/false-not-met vs ground truth. Taxonomy-faithful routing (deterministic→T1 only if transcript-decidable & not a result/output claim; verified→T2 only with a post-claim `tool_result`; else `unreplayable`); moment-of-claim respected (T1 reads work-span tools only); empty/all-unreplayable → explicit unscorable (never `all([])→true_met`); abstention + coverage first-class; sha1 20% holdout with smoke-only caveat; schema-versioned scorecard JSON.
- **65 postmortem tests**; full core-lib suite 629 passed (14 pre-existing `test_e2e` live-inference timeouts only). 3 Codex implementation-review rounds → CLEAN.

### stratum — feat(STRAT-JUDGE-POSTMORTEM-v2.1): LLM-augmented segmenter gate

- **New `stratum.judge.postmortem.llm_gate`:** opt-in request↔claim same-task gate that runs after the regex segmenter (recall) as a precision pass. `SegmenterGate` Protocol, pure `build_gate_prompt`/`parse_gate_response`, concrete `LiteLLMGate`, `GateVerdict`, `SegmentStats`.
- **Routed through the declared `litellm` dependency** (not the undeclared `anthropic` SDK); default model `claude-haiku-4-5`.
- **Fail-open contract:** any gate error, malformed JSON, semantically-invalid output (pydantic `StrictBool` + `[0,1]` confidence), or non-string `message.content` keeps the candidate (`applied=False`) — a calibration corpus never silently shrinks.
- **`segment()`** gains keyword-only `gate`/`gate_threshold`/`stats`; `Candidate.gate_verdict`; `gate=None` preserves pre-v2.1 segmenter behavior. Removed dead `_last_assistant_text_before`.
- **CLI:** `extract --llm-gate`, `--gate-model`, `--gate-threshold` (range-validated to `[0,1]`); summary reports `checked`/`rejected`.
- **Schema 1.0 → 1.1:** additive `gate` key on each candidate record (null when off).
- **25 tests** in `tests/test_postmortem_gate.py`. 3 Codex review rounds → CLEAN.

### stratum-mcp — feat(STRAT-GOAL-V1): goal orchestrator with 4 MCP tools

- **4 new MCP tools:** `stratum_goal`, `stratum_goal_status`, `stratum_goal_decide`, `stratum_goal_archive`
- **New `stratum.goal` package:** orchestrator with mode matrix (shadow-driven, shadow-observed, advisory, autonomous), worker dispatch with M17 Codex driven-mode safety guard, autonomy resolution with SmartMemory DI
- **`FlowState.synthetic` field:** when `True`, `delete_persisted_flow` skips judge-tree cleanup (PRD M14) so the orchestrator can inspect judge audit artifacts after the synthetic flow completes; `stratum_goal_archive` handles teardown instead
- **`delete_persisted_flow(*, synthetic=False)` guard:** STRAT-GOAL-aware signature; synthetic flows skip deletion of flow JSON and judge tree in `stratum_gate_resolve`, instead persisting terminal state for `stratum_goal_status` reads
- **New schema fields:** `flow-state.v1.schema.json` and `query-flows.v1.schema.json` both add `synthetic: bool` so that Compose and external query consumers can distinguish goal-driven synthetic flows from real user flows
- **Adversarial corpus (7 cases):** `tests/fixtures/goal-adversarial.jsonl` + `tests/test_goal_adversarial.py` for shadow-mode regression detection
- **Tests:** `test_goal_kernel.py`, `test_goal_state.py`, `test_goal_prompts.py`, `test_goal_worker.py`, `test_goal_adversarial.py`, `test_goal_coverage_sweep.py`, `test_goal_e2e.py`, `test_goal_tool.py`
- See `docs/features/STRAT-GOAL/` for full design

### stratum-mcp — feat(STRAT-JUDGE-V1): tiered self-correction judge

- **New `stratum.judge` package:** kernel, predicates, staging, verifier, errors, result — T1 + T2 tier dispatch with confidence-gated verdict normalization
- **New MCP tool: `stratum_judge`** — STRAT-IMMUTABLE integrity checks enforce that predicate/stakes/budget payload matches the IR-declared `judge:` block; spec-level checksum verified before every invocation
- **T1/T2 tier dispatch:** T1 evaluates deterministic predicates against staged artifacts; T2 dispatches a Claude verifier with read-only tools and citation-format enforcement
- **Judge tree at `~/.stratum/judge/<flow_id>/`** — per-turn staging with `record_judge_turn` accumulating `judge_history` and `judge_outcome` on `FlowState`; cleared atomically with `delete_persisted_flow`
- **Checksum coverage:** `compute_spec_checksum` includes `judge:` block (predicates, stakes, budget) so live flows can't have gate config altered mid-run undetected
- **`get_current_step_info` judge mode:** returns caller-driven dispatch envelope so the executor never invokes MCP tools itself
- **Tests:** `test_judge_kernel.py`, `test_judge_predicates.py`, `test_judge_schema.py`, `test_judge_staging.py`, `test_judge_verifier.py`, `test_judge_corpus.py`, `test_executor_judge.py`, `test_server_judge.py`, `test_spec_judge.py`
- See `docs/features/STRAT-JUDGE/` for full design

### stratum-mcp — fix(setup): probe + reorder for atomic install (STRAT-SETUP-ATOMIC)

- **`_cmd_setup` reordered to fail-fast before any project mutation.** New order: root detection → `_probe_setup_preconditions()` → `_copy_hook_scripts` (raise on per-script failures) → `.claude/mcp.json` → `CLAUDE.md` → skills sync → `_register_hooks_in_settings`. Previously `.claude/mcp.json`, `CLAUDE.md`, and `~/.claude/skills/` were written first; if `_install_hooks` then raised (missing bundled hook source or unwritable `~/.stratum/hooks/`), the project was left in a partial state.
- **New `_probe_setup_preconditions()` helper** — checks every bundled hook source file in `_HOOK_SCRIPTS` exists; runs `_STRATUM_HOOKS_DIR.mkdir(parents=True, exist_ok=True)` as a writability test. Raises `OSError` with named missing paths on failure. Silent on success.
- **`_install_hooks` function definition unchanged.** Still composes copy + register and raises on copy failures; still exercised by the existing `TestInstallHooksFailFast` regression. Just no longer called from `_cmd_setup` (which now invokes `_copy_hook_scripts` and `_register_hooks_in_settings` directly).
- **New `_SKILLS_HOME` module-level constant** — extracted from a local resolution inside `_cmd_setup` so the new `isolated_skills_home` test fixture can monkeypatch it cleanly.
- **Surviving non-atomic registration paths documented** — `_register_hooks_in_settings` can still raise mid-call (legacy-copy cleanup at server.py:2023, settings.json write at :2072). Deferred to potential STRAT-SETUP-ATOMIC-V2 if it surfaces in practice.
- **Tests** — 9 new tests in `tests/integration/test_setup.py` covering probe behavior (silent on happy path, raises on missing source, error names paths, creates `~/.stratum/hooks/`) and atomic-ordering invariants (probe failure leaves mcp.json / CLAUDE.md / skills untouched; copy failure mid-stream leaves project untouched). **907 passing, 2 skipped.**

### stratum-mcp — fix(codex): raise stdout buffer ceiling (STRAT-MCP-CHUNK-SIZE)

- **`CodexConnector` now passes `limit=4 MiB` to `asyncio.create_subprocess_exec`** in both `run()` and `stream_events()`. The asyncio default 64 KiB `StreamReader` buffer was too small for codex's `--json` preamble (resolved model config, sandbox profile, cwd, full prompt echo), causing the first `proc.stdout.readline()` to raise `LimitOverrunError` ("Separator is not found, and chunk exceed the limit") before any agent event reached the caller. `mcp__stratum__stratum_agent_run(type="codex")` would deterministically fail before the agent ran.
- **Env knob `STRATUM_CODEX_STREAM_LIMIT_BYTES`** — overrides the 4 MiB default, clamped to a 64 KiB floor so a misconfigured value can't silently re-enable the bug.
- **Graceful failure path** — if a line still exceeds the configured limit, `run()` yields an `{"type":"error", message:...}` envelope and `stream_events()` raises `RuntimeError`. Both messages name the env knob so callers can self-recover. Python 3.12's `readline()` wraps `LimitOverrunError` as `ValueError` with the original message — both paths are matched via a small message-text helper.
- **Tests** — new `tests/test_codex_chunk_size.py` (9 cases): constant defined, env override honored, floor clamp, real-subprocess 200 KiB line read OK, asyncio default sanity-repro of original bug, graceful-failure messages on both code paths. **898 passing, 2 skipped.**

### stratum-mcp — feat(STRAT-PAR-STREAM): stream_events rolled out to all connectors

- **`AgentConnector.stream_events()`** added to base — default impl yields nothing so subclasses (opencode) don't raise `AttributeError`.
- **`ClaudeConnector.stream_events()`** added — yields `ConnectorEvent` per assistant block / tool call for parallel-dispatch consumers. Adds `thinking` and `effort` constructor params.
- **`CodexConnector.stream_events()`** added — parallel JSONL driver, marked for de-dup under `STRAT-DEDUP-AGENTRUN-V3`.
- **`make_agent_connector`** now accepts `allowed_tools` / `disallowed_tools` / `thinking` / `effort` for Claude.
- **Server + parallel-exec wiring** — `_emit` envelope path consumes per-connector streams without breaking the legacy envelope contract.
- **Drop `tests/test_codex_connector_sync.py`** — STRAT-DEDUP cross-repo drift guard retired now that codex's connector is being rewritten upstream.

### stratum-mcp — fix(codex): port JS codex-connector rewrite to Python (removes opencode dep)

- **`CodexConnector` no longer inherits from `OpencodeConnector`.** Spawns `codex exec --json` directly, parses the CLI's own JSONL event stream (`item.completed` → `agent_message` / `command_execution` / `file_change` / `reasoning`; `turn.completed` → usage). Ports `compose/server/connectors/codex-connector.js` (commit `f552c7f`, 2026-04-18) to Python — that rewrite was applied to the JS side only, leaving `stratum_agent_run type="codex"` shelling out to `opencode run` indefinitely since we stopped using opencode for codex. Every codex review through the MCP tool hung waiting for events that couldn't arrive.
- **Model-ID effort suffix** — `<model>/<effort>` (e.g. `gpt-5.4/high`) is split: base model goes to `-m`, effort becomes `-c model_reasoning_effort="<effort>"`. Matches JS.
- **Env scrubbing deviates from opencode** — `ANTHROPIC_API_KEY`, `CLAUDE_API_KEY`, `CLAUDECODE` are scrubbed; `OPENAI_API_KEY` is **kept** because codex uses it as fallback auth when OAuth credentials are absent. Opencode's connector still scrubs all four because opencode's OAuth path doesn't want the raw key.
- **Interrupt is SIGTERM-only** (no grace+SIGKILL dance) — matches JS `codex-connector.js:217-222`. Simpler process model; the CLI terminates cleanly.
- **Stall detection preserved** — warns via stderr every 30s after 120s silence. Does not kill; caller can `interrupt()` if needed.
- **Tests refactored** — dropped `test_codex_inherits_opencode_interrupt` and `test_codex_override_forwards_env_to_super` (both asserted the now-gone opencode inheritance). Added `_translate_codex_event` event-taxonomy tests, direct-subprocess env-forwarding test, `OPENAI_API_KEY`-kept / cross-provider-creds-scrubbed test, `codex` binary-missing friendly-error test. **872 passing, 2 skipped.** Live smoke confirmed against real `codex exec --json` on 2026-04-19 — round-trip ~5s, events stream correctly.

### stratum-mcp — test: cross-repo drift guard for codex connector (STRAT-DEDUP-AGENTRUN interim)

- **New test `tests/test_codex_connector_sync.py`** asserts Python and Compose's JS codex connectors stay aligned until STRAT-DEDUP-AGENTRUN v3 ships. Two checks: (1) JS side still uses direct `codex exec` (not opencode), (2) `CODEX_MODEL_IDS` sets are identical across languages.
- **Skipped when Compose isn't adjacent** so stratum-only clones and partial-repo CI don't fail. In normal dev trees (both repos as siblings under `forge/`) the guard runs every `pytest` invocation.
- **Why now:** the 2026-04-19 codex hang was caused by the JS connector migrating to direct `codex exec --json` while the Python connector stayed on opencode. That class of drift would have been caught in seconds by this guard. Band-aid until the final v3 refactor eliminates the two-trees invariant. Retire this file when v3 lands. **874 passing, 2 skipped.**

### stratum-mcp — T2-F5-DEPENDS-ON

- **`ParallelExecutor` now respects `task.depends_on`** at dispatch time. Previously ignored — all tasks fanned out immediately under `asyncio.gather`. Now: dependent tasks wait on per-task `asyncio.Event`s until their upstreams reach a terminal state. Dep-wait happens outside the semaphore (waiting tasks don't consume concurrency slots) but inside the outer `try` (early returns on unknown-dep or upstream-failure unwind through the existing finally, invoking `_require_unsatisfiable` / `_cancel_siblings` correctly).
- **Upstream failure → dependent cancels** with `state="cancelled"` and an error naming the upstream task and its terminal state. Under `require: "all"`, this cascades via the existing unsatisfiable check.
- **Cycle detection via DFS** (`_detect_dependency_cycle`, WHITE/GRAY/BLACK) runs before `asyncio.gather`. Direct or transitive cycles fail all tasks with `error="dependency cycle detected: A -> B -> A"`; no task handles are created. Unknown task_id references in `depends_on` (typos, stale decompose output) are NOT flagged as cycles — they're caught at wait-time with a clearer per-task error.
- **Event-set placement is load-bearing**: `_task_done[tid].set()` fires at the top of the outer `finally`, immediately after state normalization, BEFORE any await that might raise `CancelledError` (diff capture via `asyncio.to_thread`, persist under per-flow lock). Downstream waiters always unblock, even if we're cancelled mid-cleanup.
- **12 new tests** covering linear chains, diamonds, direct + transitive cycles, unknown-deps-aren't-cycles, cascade-on-dep-failure (require:all), and semaphore-starvation regression (max_concurrent=1 linear chain). **855 total passing.**
- **Out of scope (by design):** cross-worktree state propagation. A dependent task that needs an upstream's filesystem output still gets a fresh worktree from HEAD; it won't see the upstream's changes without explicit diff application by the consumer (Compose does this via T2-F5-DIFF-EXPORT + client-side topological merge).

### stratum-mcp — T2-F5-DEFER-ADVANCE

- **`defer_advance: bool` IR field on `parallel_dispatch` steps** — opt-in, default false. When true, `stratum_parallel_poll` returns a sentinel `{status: "awaiting_consumer_advance", aggregate: {...}}` on terminal instead of auto-advancing. Validator rejects non-bool at parse time via `IRValidationError`.
- **`stratum_parallel_advance(flow_id, step_id, merge_status)` MCP tool** — consumer-driven advance. Feeds `merge_status` ('clean' | 'conflict') into `_evaluate_parallel_results` before calling `_advance_after_parallel`, then pops `(flow_id, step_id)` from `_RUNNING_EXECUTORS`. STRAT-IMMUTABLE-gated (mirrors `stratum_parallel_done` / `stratum_step_done`). Idempotent — returns minimal `{status: "already_advanced", step_id}` if the flow moved past. Enumerated errors: `flow_not_found`, `unknown_step`, `wrong_step_type`, `advance_not_deferred`, `invalid_merge_status`, `step_not_dispatched`, `tasks_not_terminal`, plus the existing `spec_modified` integrity envelope on tampered specs.
- **`_step_fingerprint` fixed** — now covers `capture_diff` (pre-existing gap) and `defer_advance`. Both fields gate consumer input into `process_step_result`, so a spec tamper flipping either between plan and advance must invalidate the integrity check. No baseline-hash test updates needed (existing fixtures don't set either flag so their checksums are unchanged via `getattr(..., False)` defaults). **Migration note:** any flow that was *persisted with* `capture_diff: true` under the old schema will get a different checksum after this change; drain in-flight flows or re-plan before upgrading if production runs use the field. Fresh flows planned after the upgrade are unaffected.
- **Unblocks T2-F5-CONSUMER-MERGE-STATUS-COMPOSE** — Compose consumer extension that routes `isolation: "worktree"` + `capture_diff: true` through defer-advance, reporting merge_status back properly and fixing the `buildStatus='complete'` regression from T2-F5-COMPOSE-MIGRATE-WORKTREE W1.
- **14 new tests** (3 schema + 3 poll-sentinel + 2 fingerprint + 9 advance-tool including STRAT-IMMUTABLE tamper detection), **843 total passing**. 2 rounds of design review, 0 blockers at implementation.

### stratum-mcp — T2-F5-DIFF-EXPORT

- **`capture_diff: bool` field on `parallel_dispatch` steps** — opt-in per-task diff capture for server-dispatched parallel steps. Default `false`; silently ignored when `isolation: "none"` (gated in `stratum_parallel_start` with `cur_step.capture_diff and isolation == "worktree"`). Rejected at parse time if non-bool (JSON schema layer fires `IRValidationError` before `_build_step`'s defense-in-depth guard).
- **`ParallelTaskState.diff` / `.diff_error`** — new fields on the terminal state dataclass. `diff` is `None` when not requested or when the worktree was already gone; `""` when captured with no changes; non-empty unified-diff text otherwise. `diff_error` carries a short `{ExceptionType}: {message}` string when capture raised, kept separate from `error` so a successful task whose diff capture fails doesn't look "failed" to consumers. Both auto-serialize through `dataclasses.asdict()` in `persist_flow`.
- **`capture_worktree_diff(path)`** in `worktree.py` — runs `git -c core.hooksPath=/dev/null add -A` then `git -c core.hooksPath=/dev/null diff --cached HEAD` in the worktree, 30s timeout each, `errors="replace"` decode for binary-safe output. Hooks-path override prevents parent-repo pre-commit hooks from firing in the ephemeral worktree. `.gitignore` is respected (no `node_modules`, no `.env` leaks into flow state JSON).
- **Capture site in `_run_one` finally** — `await asyncio.to_thread(capture_worktree_diff, worktree_path_obj)` runs before `remove_worktree` when `self.capture_diff` is truthy. Exceptions are swallowed into `diff_error`. Sibling tasks aren't blocked because the subprocess runs in a thread.
- **Connector-setup failure path fix** — `worktree_path_obj = None` after the inline `remove_worktree` so the finally block skips its capture attempt on a deleted path (previously would have populated a spurious `diff_error` on every pre-execution failure when `capture_diff=True`).
- **Unblocks T2-F5-COMPOSE-MIGRATE for `isolation: "worktree"` paths.** Compose will read `tasks[task_id].diff` from the poll response and hand it to its existing topological-merge logic; the Compose consumer extension ships as a separate follow-up feature.
- 13 new tests (5 `test_worktree.py` unit tests including binary + gitignore behavior, 3 `test_parallel_schema.py` accept/default/reject tests, 5 `test_parallel_exec.py` integration tests including the connector-setup-failure-is-clean case). **825 total passing, 2 skipped.**

### stratum-mcp — T2-F5-ENFORCE

- **`stratum_parallel_start` / `stratum_parallel_poll` MCP tools** — server-side dispatch for `parallel_dispatch` steps. `_start` schedules a `ParallelExecutor` via `asyncio.create_task`, registers the handle in `_RUNNING_EXECUTORS`, and returns immediately with a task list. `_poll` returns per-task state, summary counts, `require_satisfied`, `can_advance`, and advances the flow idempotently when all tasks are terminal. The legacy `stratum_parallel_done` path is preserved byte-identically via the extracted `_evaluate_parallel_results(state, step, task_results)` helper shared by both paths.
- **`ParallelExecutor`** (`stratum_mcp/parallel_exec.py`) — drives N tasks concurrently bounded by `Semaphore(max_concurrent)`, per-task `asyncio.wait_for(task_timeout)`, optional git-worktree isolation, per-task cert validation, and a per-flow `asyncio.Lock` around `persist_flow`. Cascade cancel on unsatisfiable require (`all`/`any`/integer): failing tasks trigger `.cancel()` + `connector.interrupt()` on siblings. Uses `asyncio.gather(return_exceptions=True)` rather than `TaskGroup` so `_run_one` owns its own exception handling and always reaches a terminal state.
- **`connectors/factory.py`** — `make_agent_connector(agent_type, model_id, cwd)` extracted from `server.py` so `server.py` and `parallel_exec.py` share a single factory without a circular import. Server-dispatch v1 supports `claude` and `codex` only; `opencode` is explicitly rejected with a pointer to roadmap **T2-F5-OPENCODE-DISPATCH**. Opencode agent strings remain valid for legacy consumer-dispatch.
- **`SENSITIVE_ENV_VARS`** (`connectors/base.py`) — `("ANTHROPIC_API_KEY", "OPENAI_API_KEY", "CLAUDE_API_KEY", "CLAUDECODE")`. Previously only `CLAUDECODE` was stripped by claude and `OPENAI_API_KEY` by opencode; the rest leaked through. Claude/opencode/codex connectors now all scrub the full list at the connector layer (defense-in-depth), and `ParallelExecutor._task_env` scrubs again before dispatch while injecting `STRATUM_FLOW_ID`, `STRATUM_STEP_ID`, `STRATUM_TASK_ID`.
- **`AgentConnector.run(..., env=None)`** — trailing keyword-only parameter so the parallel path can hand each concurrent task its own env dict without mutating `os.environ`. `None` preserves legacy behavior.
- **`OpencodeConnector.interrupt()`** — sends `SIGTERM`, schedules `SIGKILL` after a 5-second grace period via a background asyncio task. Idempotent against missing/exited processes. `CodexConnector` inherits. `ClaudeConnector.interrupt()` stays no-op (tracked as **T2-F5-CLAUDE-CANCEL** — the claude-agent-sdk has no cancel API today).
- **`worktree.py`** — `create_worktree(flow_id, task_id, base_cwd) -> Path` runs `git worktree add --detach <target> HEAD` under `~/.stratum/worktrees/<flow_id>/<task_id>`, deliberately outside the source repo. `remove_worktree(path, force=True)` best-efforts via git then falls back to `shutil.rmtree(ignore_errors=True)`. `Path.home()` is resolved lazily so tests can monkeypatch it.
- **`task_timeout` field** on `parallel_dispatch` steps — v0.3 schema gains `{"type": ["integer","null"], "minimum": 1}`, additive with no IR version bump. `IRStepDef.task_timeout` reaches the executor via `_build_step`. `_parallel_dispatch_only` now also gates `task_timeout` AND `max_concurrent` — the latter was parallel-only in practice but never gated; blueprint review surfaced the gap.
- **`FlowState.parallel_tasks` / `FlowState.cwd`** — `ParallelTaskState` dataclass (`task_id`, `state`, `started_at`, `finished_at`, `result`, `error`, `cert_violations`, `worktree_path`; states `pending|running|complete|failed|cancelled`) persists and restores via `dataclasses.asdict` + targeted reconstruction. `stratum_plan` captures `os.getcwd()` so the parallel path can anchor worktrees to the caller's repo. Legacy flows deserialize with sane defaults (no migrate.py change).
- **Shutdown + resume lifecycle** — `shutdown_all(_RUNNING_EXECUTORS)` wired into a `try/finally` around `mcp.run()` cancels in-flight executor tasks cleanly. On startup, `resume_interrupted_parallel_tasks(flow_root)` flips any persisted `state='running'` entries to `state='failed'` with `error='server restart interrupted task'` so interrupted work is observable. Full subprocess reparenting is tracked as **T2-F5-RESUME**.
- **Documented deferrals** (all on roadmap): T2-F5-OPENCODE-DISPATCH, T2-F5-BRANCH (`isolation: branch` rejected at dispatch with a clear error), T2-F5-DEPENDS-ON (`depends_on` edges not respected — tasks run concurrently), T2-F5-STREAM (no event streaming — consumer polls), T2-F5-CLAUDE-CANCEL, T2-F5-RESUME, T2-F5-COMPOSE-MIGRATE, T2-F5-LEGACY-REMOVAL.
- **No `migrate.py` edits.** Legacy `stratum_parallel_done` integration behavior is byte-identical.
- 70 new tests (`test_connector_factory`, `test_connectors_env`, `test_connectors_interrupt`, `test_spec_task_timeout`, `test_worktree`, `test_flowstate_parallel`, `test_parallel_exec`, `test_parallel_server_dispatch`). **812 total passing, 2 skipped.**

### stratum-mcp — T2-PAR-5

- **`stratum-mcp migrate <file>` CLI** — upgrades a `.stratum.yaml` spec from its declared IR version to the latest registered version (or `--to VERSION` to pin). Preview-and-confirm by default; `--yes` to skip the prompt, `--dry-run` to preview only, `--interactive` to prompt per opportunistic upgrade.
- **Transform registry architecture** — versioned `Transform` + optional `Upgrade` dataclasses in `stratum_mcp/migrate.py`. Registry is a graph of `from_version → to_version`; `walk_registry` does BFS with `UnknownVersion` / `NoTransformPath` distinguishing "version outside SCHEMAS" from "valid version, no migration chain". Numeric tuple version ordering (`0.10 > 0.9`).
- **Today's only registered transform:** `0.2 → 0.3` as a pure version-string bump (v0.3 is a backward-compatible superset of v0.2). Framework is ready to accept structural transforms and opportunistic upgrades when v0.4+ lands — one registry entry + tests, no CLI changes.
- **Formatting preserved** — uses `ruamel.yaml` in round-trip mode with source-derived indent detection (`_detect_sequence_style`, `_detect_mapping_indent`) so comments, blank lines, quote style, and both mapping and sequence indentation survive the migration. Tested against 4/2-indented and 2/0-indented specs, 2-space and 4-space mapping indent.
- **`--output PATH`, `--backup`, `--force`** — divert the write to a new path, save a `.bak` next to the original, or allow overwriting an existing `--output` target. Atomic write (tempfile + `os.replace`) avoids partial writes on crash.
- **Exit-code contract:** `0` success/no-op, `1` validation or I/O failure or flag misuse, `2` user declined, `3` unknown version or no transform path. Manual `argv` parsing to keep exit codes under control (stdlib `argparse` would exit 2 on flag misuse).
- **Shape guard** handles non-mapping YAML roots (`[]`, scalars) and non-string `version` fields without leaking `AttributeError` from `parse_and_validate`.
- **Dependency added:** `ruamel.yaml>=0.18` (side-by-side with `pyyaml`, no conflict).
- 41 new tests (`tests/test_migrate.py`), 742 total passing.

### stratum-mcp — T2-F5

- **`stratum_agent_run` MCP tool** — dispatches prompts to claude or codex with a Node-compatible contract (`modelID`, `parseError`, errors raised as exceptions rather than wrapped in payloads). Schema mode injects JSON-Schema into the prompt and extracts the last ```json block from the response.
- **`stratum_mcp.connectors` package** — new Python connectors ported from the Node.js originals:
  - `AgentConnector` ABC with `inject_schema()` helper (byte-for-byte matches the Node `injectSchema()` output)
  - `ClaudeConnector` — wraps `claude-agent-sdk` `query()`. Uses `{type: "preset", preset: "claude_code"}` tools by default so default behavior matches the Node connector's `claude_code` preset. Strips `CLAUDECODE` env var for nested execution.
  - `OpencodeConnector` — spawns `opencode run --format json` asynchronously. Parses `text`, `tool_use`, and `step_finish` events into the shared envelope. Handles rate-limit/auth errors on stderr and stall detection on 120s silence. Yields a friendly error event when the `opencode` binary is missing.
  - `CodexConnector` — extends `OpencodeConnector`, validates against `CODEX_MODEL_IDS` at both construction and run time.
- **`claude-agent-sdk>=0.1.56,<0.2`** added to dependencies.
- 27 new tests (connector unit + MCP tool integration + opt-in live smoke behind `STRATUM_LIVE_AGENT_TESTS=1`). 676 total passing.

### stratum-mcp — STRAT-CERT-PAR

- **`task_reasoning_template` IR field** on `parallel_dispatch` steps — per-task certificate validation template. CERT-1 restriction on `reasoning_template` (step-result validator) preserved; use `task_reasoning_template` for per-task validation.
- **`_apply_cert_defaults()` refactor** — accepts `field_name` parameter so the same defaulting/validation logic handles both `reasoning_template` and `task_reasoning_template`.
- **`_parallel_dispatch_only` tuple** — `task_reasoning_template` added, automatically forbidden on decompose and legacy step types.
- **Claude-agent gate alignment** — 4 sites updated from exact-match `in ('claude', '')` to `startswith('claude')` so profile agents (e.g. `claude:read-only-reviewer`) are consistently validated, have certs injected, and pass on_fail viability checks:
  - `executor.py` inline cert injection
  - `executor.py` decompose cert injection
  - `executor.py` inline cert validation in `process_step_result`
  - `spec.py` `on_fail` viability check
- **`validate_certificate()` reasoning fallback** — reads from `result["artifact"]`, falls back to `result["reasoning"]` for consumer compatibility.
- **Per-task cert validation in `stratum_parallel_done`** — runs before require/merge evaluation, flips cert-failed tasks to `status="failed"` so they count against the require threshold naturally. Violations collected once and merged into every failure-response path (require-fail, merge-conflict, ensure-failed on aggregate, on_fail_routed, retries_exhausted).
- 18 new tests, 647 total passing.

### stratum-mcp — STRAT-SCORE

- **`score_expr` field on `IRStepDef`**: optional numeric scoring expression for iteration loops (requires `max_iterations`)
- Validation: rejected on gate steps, decompose/parallel_dispatch steps, and when missing `max_iterations`; dunder guard applied

### stratum-mcp — STRAT-PAR (T2-PAR-1 through T2-PAR-4)

- **IR v0.3 schema**: `decompose` and `parallel_dispatch` step types. Backward-compatible superset of v0.2.
- **`decompose` step**: agent-executed step emitting TaskGraph (`files_owned`, `files_read`, `depends_on`)
- **`parallel_dispatch` step**: concurrent execution with `max_concurrent`, `isolation`, `require`, `merge`, `intent_template`
- **`no_file_conflicts` ensure builtin**: validates no two independent tasks share `files_owned`; transitive dependency aware
- **`stratum_parallel_done` MCP tool**: batch result reporting with require semantics (all/any/N), merge conflict detection
- **Semantic validation**: decompose requires agent+intent+output_contract; parallel_dispatch requires source+intent_template
- 30 new tests (479 total passing)

### stratum-py

- `@pipeline` / `@phase` decorators — pipeline authoring model; metadata capture and IR compilation separate from MCP execution mode
- `Capability` and `Policy` enums — capability tiers for connector routing and policy overrides
- `stratum.toml` project config — policy overrides, capability mapping, connector routing
- Run workspace convention — `.stratum/runs/{run-id}/{phase-id}.json` output passing between phases
- File-based gate protocol — `.gate` / `.gate.approved` / `.gate.rejected` files for human approval checkpoints
- Pipeline runtime loop — `run_pipeline()` drives `@pipeline` classes through phases via `Connector`

**Bug fixes**

- `run()` now detects closed event loops and creates a fresh one instead of raising `RuntimeError: Event loop is closed` — resolves e2e test failures after first loop close
- `run()` closes the passed coroutine before raising on a running-loop path — eliminates "coroutine never awaited" warning
- `run()` drains pending async tasks (both on normal return and exception paths) before closing the loop — prevents dropped telemetry callbacks (e.g. litellm `async_success_handler`)
- Anthropic (claude-*) models now receive `cache_control: {type: ephemeral}` blocks on system message, user message, and tool definition — restores prompt caching behavior that reduces cost and latency
- `datetime.utcnow()` replaced with `datetime.now(timezone.utc)` throughout — clears Python 3.12 deprecation warnings

**Testing**

- T1-11: 17-test end-to-end suite (`tests/test_e2e.py`) runs against a real LLM (gpt-4o-mini via OpenAI) — validates `@infer`, `@compute`, `@flow`, `ensure` postconditions, `PostconditionFailed`, `TraceRecord` fields, trace accumulation, `clear_traces`, and `stratum.run()` sync shim

### stratum-mcp

**New MCP tools**

- `stratum_commit` — checkpoint the current flow state under a named label; label recorded in audit trace
- `stratum_revert` — roll back flow state to a named checkpoint; revert event recorded in trace

**MCP server improvements**

- FlowState persistence — flows survive MCP server restarts; state written to `~/.stratum/flows/{flow_id}.json` after each step
- `output_schema` validation in `stratum_step_done` — JSON Schema checked before `ensure` expressions; returns `schema_failed` with violations if invalid
- `ensure` file-aware builtins — `file_exists(path)` and `file_contains(path, substring)` available in postcondition expressions
- `stratum-mcp validate <file>` CLI — validates a `.stratum.yaml` file from the command line
- `stratum-mcp compile <tasks-dir>` CLI — compiles `tasks/*.md` acceptance criteria into `.stratum.yaml` IR (task compiler)

**Skills (ten total)**

- `/compose` — full feature lifecycle skill; emits `.stratum.yaml`, drives spec-kit phases through `stratum_plan` loop
- `/stratum-speckit` — bridge skill; drives spec-kit phases through Stratum, emits compiled flow
- `/stratum-build` — compiles `tasks/` → `.stratum.yaml` and drives execution via `stratum_plan` loop
- Memory sections added to all skills — read project `MEMORY.md` before writing spec; write new patterns after `stratum_audit`

**Memory & Hooks (Tier 1 — MEMORY.md)**

- `SessionStart` hook — auto-injects relevant `MEMORY.md` entries at session open
- `Stop` hook — auto-appends session summary to `MEMORY.md` at session close
- `PostToolUseFailure` hook — auto-records `ensure` failures and tool errors

**Memory (Tier 2 — SmartMemory lite, opt-in)**

- `SessionStart` hook — `memory.search()` for project-relevant context
- `Stop` hook — `memory.ingest()` session summary as episodic memory
- `PostToolUseFailure` hook — `memory.ingest()` failures as observation memory
- Skills use `memory.search()` instead of `MEMORY.md` when lite backend configured (`pip install smartmemory[lite]`)

**Track 3 — Compose + Stratum + spec-kit**

- Task→step compiler — `tasks/*.md` acceptance criteria → `.stratum.yaml` `ensure` expressions
- Compose skill adopts spec-kit artifact format — design phases produce `spec.md`, `plan.md`, `tasks/` under `.specify/`
- Compose web app (Vision Surface) integration:
  - Startup seed from `.specify/` — work items created from spec-kit directories on load, updated on file change
  - Live stratum flow sync — 15s poller maps bound flows to Vision items; detects `running`, `blocked` (retries exhausted = ensure violations), `paused`; clears stale violation evidence on recovery
  - Audit trace surfaced in item evidence panel — `stratum_audit` trace stored in `evidence.stratumTrace`; item transitions to `complete` on flow completion

**Testing:** 211 tests passing (up from 79 at 0.1.3)

**IR v0.2 — Gate / Round / Skip primitives**

- `mode: gate` on functions — gate steps return `await_gate` instead of `execute_step`; `stratum_step_done` rejects gate steps; `stratum_gate_resolve` required
- `stratum_gate_resolve` MCP tool — resolves gate steps with `approve | revise | kill`; `resolved_by: human | agent | system`; GateRecord written to trace
- `stratum_check_timeouts` MCP tool — auto-kills gate steps that exceed their `timeout` (seconds); fires with `resolved_by: system`
- Round archiving — `revise` archives the active round into `state.rounds`; resets active trace; increments `state.round`; `stratum_audit` returns `rounds: [{round, steps}]` unconditionally
- `max_rounds` on flow definitions — `resolve_gate` returns `max_rounds_exceeded` error when round limit reached; GateRecord written but not archived
- `skip_if` / `skip_reason` on steps — Boolean expression evaluated before dispatch; `$.steps.X.output.field` refs resolved inline; SkipRecord written, output set to None; downstream refs propagate None
- `on_approve` / `on_revise` / `on_kill` routing — null = default terminal behaviour; named = route to that step; kill routing sets `terminal_status = "killed"` regardless of named cleanup step
- `terminal_status` on FlowState — `stratum_audit` returns `status: killed` when set; `stratum_step_done` complete path uses `terminal_status or "complete"`

**IR v0.2 semantic validation (enforced at parse time)**

- Gate functions: `ensure`, `budget`, `retries` forbidden
- Gate steps: `skip_if` forbidden; `on_approve` and `on_kill` must be explicitly declared (even if null); `on_revise` must be non-null, must not self-reference, must target a topologically-earlier step
- Non-gate steps: `on_approve`, `on_revise`, `on_kill` forbidden
- `declared_routing: frozenset` tracks which routing fields were explicitly present in YAML (distinguishes absent from null)
- `retries_explicit: bool` tracks whether `retries` was explicitly declared
- `_topo_positions()` computes topological execution order for `on_revise` ordering invariant
- YAML `true` / `false` / `null` recognised in `skip_if` expressions in addition to Python-style literals
- All server tool paths call `get_current_step_info()` before `persist_flow()` — skip mutations durable across restarts

**Testing:** 305 tests passing (+94); new files: `test_gate_api.py` (9 contract tests), `test_gate_revise.py` (6 integration tests); `test_ir_schema.py` +12 v0.2 semantic invariant tests

**STRAT-ENG-1: IR v0.2 inline steps, workflow declarations, flow composition**

- `workflow:` block — self-registering workflow declaration with name, description, input schema
- `stratum_list_workflows` MCP tool — scans a directory for `*.stratum.yaml` files with `workflow:` blocks; returns name/description/input/path; detects duplicate names
- Inline steps — `intent:` + `agent:` on steps (mutually exclusive with `function:` and `flow:`); step-level `ensure`, `retries`, `output_contract`, `model`, `budget`
- `flow:` composition — `flow_ref` on steps for sub-workflow invocation (parsed and validated; execution deferred to STRAT-ENG-5)
- `on_fail` / `next` routing on non-gate steps — `on_fail` requires `ensure`; `on_fail` without `ensure` rejected on both inline and flow_ref steps
- `policy` / `policy_fallback` on gate steps — parsed and validated (`policy_fallback` requires `policy`); evaluation deferred to STRAT-ENG-3
- Mode exclusion validation — exactly one of `function`, `intent`, `flow` required per step
- Workflow input validation — `workflow.input` keys must exactly match entry flow input keys

**Testing:** +33 tests; new files: `test_ir_v02_extensions.py` (29 tests), `test_list_workflows.py` (4 tests)

**STRAT-ENG-2: Executor — state model, agent passthrough, inline step execution**

- `_step_mode()` helper — returns `"function"` or `"inline"`; raises `MCPExecutionError` for `flow_ref` (deferred to STRAT-ENG-5)
- `StepRecord` extended — `agent: str | None` and `step_mode: str` fields with backward-compatible defaults
- `get_current_step_info` restructured — mode-branched dispatch; function steps use `fn_def.ensure/retries`, inline steps use `step.step_ensure/step_retries`; `fn_def` lookup moved after `skip_if` evaluation
- `process_step_result` restructured — mode-branched for ensure/retries/output_schema; `_make_record()` helper for StepRecord creation
- `stratum_step_done` gate guard updated — handles inline steps (`function=""`)
- `MCPExecutionError` handling — all `get_current_step_info` call sites wrapped in server.py (3 locations)
- `retries_exhausted` response enriched — includes `step_mode` and `agent` fields

**Testing:** +27 tests; new file: `test_inline_steps.py` (27 tests)

**STRAT-ENG-3: Executor — gate policy evaluation, explicit skip**

- `PolicyRecord` — new audit trace type (`type: "policy"`) for auto-resolved gates; `_record_from_dict` updated for persistence
- `apply_gate_policy()` — evaluates `step.policy ?? "gate"`; `skip`/`flag` auto-approve with PolicyRecord and on_approve routing; does NOT call `resolve_gate` (no GateRecord for auto-approved gates)
- `_apply_policy_loop()` — server-layer loop handling chained auto-approved gates with visited-set cycle detection
- `skip_step()` — extracted helper from `get_current_step_info` skip_if path; gate steps rejected
- `stratum_skip_step` MCP tool — explicit step skipping with reason; gate steps return error
- Policy loop wired into `stratum_plan`, `stratum_step_done`, `stratum_gate_resolve`, `stratum_check_timeouts`

**Testing:** 349 tests passing (+44 from ENG-1/2/3); new file: `test_policy_skip.py` (29 tests)

**STRAT-ENG-4: Executor — per-step iteration tracking**

- `max_iterations` and `exit_criterion` on steps — counted sub-loops with automatic exit on criterion met or max reached; semantic validation (gate steps forbidden, `exit_criterion` requires `max_iterations`, dunder guard)
- `start_iteration()` / `report_iteration()` / `abort_iteration()` — executor functions for iteration lifecycle; `compile_ensure`-based criterion evaluation; append-only history in `state.iterations`
- `stratum_iteration_start` / `stratum_iteration_report` / `stratum_iteration_abort` MCP tools — full tool interface for iteration control
- `iteration_outcome` handoff — persists between iteration exit and `stratum_step_done` for ENG-5 routing; consumed on step completion, cleared on revise
- `archived_iterations` — parallel list to `rounds[]` preserving iteration history across gate revise cycles without breaking `rounds[]` shape
- Persistence — iteration state included in `persist_flow`, `restore_flow`, `commit_checkpoint`, `revert_checkpoint`
- `stratum_audit` — returns `iterations` and `archived_iterations` in audit output
- Inline steps support iteration (agent-based steps with `max_iterations`)

**Testing:** 378 tests passing (+29); new file: `test_iterations.py` (24 tests); `test_ir_v02_extensions.py` +5 contract tests

**STRAT-ENG-5: Executor — routing and flow composition**

- `on_fail` routing — when a step exhausts retries (ensure or schema failure), routes to the named recovery step instead of terminating; failed step output preserved via `_clear_from(preserve=)` for downstream access
- `next` routing — overrides linear step advancement on success; enables review→fix→review loops; target step's attempts cleared for fresh execution
- `on_fail` validator fix — now accepts function-level `fn_def.ensure` and `output_schema` as valid triggers (previously only checked `step_ensure`)
- `_find_step_idx` / `_clear_from` helpers — extracted from `resolve_gate` on_revise; reused by `on_fail`, `next`, and flow composition; `_clear_from` clears attempts, outputs, iteration state, and `active_child_flow_id`
- `flow:` sub-execution — `_step_mode` returns `"flow"` for `flow_ref` steps; `get_current_step_info` creates child FlowState, returns `execute_flow` status; idempotent (reuses existing child); stale child recovery (clear and re-create)
- Result unwrapping — server extracts `result.get("output")` from child payload before calling `process_step_result`; `None` on child failure triggers parent ensure/on_fail chain
- Child audit snapshots — `_build_audit_snapshot` helper captures full child state (trace, rounds, iterations) before deletion; accumulated in `FlowState.child_audits[step_id]` across retries
- `StepRecord.child_flow_id` — set for flow_ref steps; persisted and restored
- FlowState fields — `parent_flow_id`, `parent_step_id`, `active_child_flow_id`, `child_audits`; included in persist/restore and checkpoint commit/revert
- `stratum_step_done` — `on_fail_routed` branch (same as `"ok"` + routing metadata); flow_ref child cleanup on all completion paths (ok, retries_exhausted, ensure_failed, on_fail_routed)
- `stratum_audit` — includes `child_audits` in response

**Testing:** 414 tests passing (+36); new files: `test_routing.py` (13 tests), `test_flow_composition.py` (20 tests); `test_ir_v02_extensions.py` +2 contract tests; `test_inline_steps.py` updated for flow_ref

**STRAT-ENG-6: Contract freeze**

- Frozen contract document — `docs/features/STRAT-ENG-6/design.md` covers spec shape (IR v0.2), MCP tool signatures, flow state (persisted JSON), and audit output
- Normalized error envelope — all error responses now use `error_type` consistently; `resolve_gate()` errors and inline server errors previously used `code`
- `stratum_audit` flow-not-found — now returns `status: "error"` (previously omitted)
- CLI gate handler — updated to read `error_type` from executor return dicts (was `code`)

**STRAT-ENG-HOOKS: Centralized hook installation**

- Hook scripts install to `~/.stratum/hooks/` — single copy shared across projects (was per-project `.claude/hooks/`)
- Absolute paths in settings.json — `bash /abs/path/to/script.sh` (was relative `bash .claude/hooks/script.sh`)
- Migration — `stratum-mcp install` auto-cleans old per-project copies and replaces relative-path settings entries
- Mixed entry safety — migration and uninstall filter individual commands from hook entries, preserving colocated non-Stratum hooks

**Testing:** 418 tests passing (+4)

---

## [0.1.3] — 2026-02-23

### Added

- `stratum-mcp uninstall` CLI command — removes Stratum config from a project: deletes `stratum` entry from `.claude/mcp.json` (removes file if empty), strips `## Stratum Execution Model` block from `CLAUDE.md` (removes file if empty), removes installed skills from `~/.claude/skills/`; `--keep-skills` flag preserves user-customized skill files
- 13 new tests for `uninstall` (mcp.json removal, CLAUDE.md removal, skill removal, `--keep-skills`, roundtrip setup→uninstall→setup, idempotency messaging) — 79 total passing

### Added

**MCP server (Track 2) — `stratum-mcp`**

- `stratum_validate` — validates a `.stratum.yaml` IR spec; returns `{valid, errors}`
- `stratum_plan` — validates a spec, creates in-memory flow execution state, returns the first step to execute with resolved inputs and output contract details
- `stratum_step_done` — accepts a completed step result from Claude Code, checks `ensure` postconditions, returns next step or flow completion; handles retries and exhaustion
- `stratum_audit` — returns per-step execution trace (attempts, duration) for an active or completed flow
- MCP controller model: Claude Code is the executor; the server manages plan state and enforces contracts — no sub-LLM calls, no separate API billing
- `FlowState` — in-memory execution state per flow: ordered steps, accumulated outputs, attempt counts, dispatch timestamps, step records
- `ensure` expressions evaluated by the server against Claude Code's reported output (Python expressions, dunder-blocked, SimpleNamespace-wrapped for dict access)
- `$.input.<field>` and `$.steps.<id>.output[.<field>]` reference resolution for chaining step outputs
- Kahn's topological sort on explicit `depends_on` + implicit `$.steps.*` ref dependencies
- `stratum-mcp install` — one-command project configuration: writes `.claude/mcp.json` (MCP server registration), appends execution model block to `CLAUDE.md`, and installs seven Claude Code skills to `~/.claude/skills/`; idempotent, finds project root via `.git` or `CLAUDE.md`
- Nine Claude Code skills installed by `setup`: `stratum-onboard` (read codebase cold, write `MEMORY.md` from scratch), `stratum-plan` (design feature, present for review — no implementation), `stratum-review` (three-pass code review), `stratum-feature` (read → design → implement → test), `stratum-debug` (hypothesis formation and elimination), `stratum-refactor` (extraction order planning, no broken intermediate states), `stratum-migrate` (rewrite bare LLM calls as `@infer` + `@contract`), `stratum-test` (write test suite for existing code — golden flows, error-path harness), `stratum-learn` (extract patterns from session transcripts into `MEMORY.md`)
- Each skill contains a spec template Claude adapts internally — YAML never shown to the user; Claude narrates in plain English
- All skills include a `## Memory` section: read project `MEMORY.md` before writing spec (incorporate `[stratum-<skill>]` tagged patterns); write new patterns after `stratum_audit`
- CLI triple-mode: `stratum-mcp install`, `stratum-mcp validate <file>`, stdio MCP transport
- 66 passing tests across contracts, invariants, and integration suites

**Dependencies:** `mcp>=1.0`, `jsonschema>=4.20`, `pyyaml>=6.0` — no stratum library dependency

### Architecture decision

The MCP server does not use the Track 1 stratum library at runtime. Executing infer steps via the library (litellm) would spawn separate billed API calls outside the Claude Code subscription. The MCP controller model keeps all execution inside the running Claude Code session: Claude Code writes the spec, reports step results, and the server tracks state and enforces contracts.

---

## [0.1.0] — 2026-02-23

### Added

**Core library (Track 1)**

- `@contract` — registers a pydantic `BaseModel` subclass as a typed contract; generates JSON Schema via `model_json_schema()`, stores a 12-char content hash for drift detection
- `@infer` — LLM-backed inference step; async-first, typed return, structured retry on `ensure` failure, budget enforcement, session cache, OTLP trace records
- `@compute` — deterministic step marker; function executes normally, composes identically with `@infer` at call sites
- `@flow` — async flow wrapper; injects `flow_id` + `Budget` clone into a `ContextVar` so nested `@infer` calls inherit them without explicit passing; session cache scoped per flow execution
- `@refine` — convergence loop stacked on `@infer`; iterates with feedback context until `until(result)` passes or `max_iterations` exhausted → `ConvergenceFailure`
- `parallel(require=)` — `"all"` / `"any"` / N / `0` modes using `asyncio.TaskGroup`; `require=0` returns `list[Success | Failure]`
- `race()` — alias for `parallel(require="any")`
- `debate()` — multi-agent structured argumentation with rebuttal rounds and a synthesizer step
- `await_human()` — HITL gate; suspends flow until a `ReviewSink` resolves a `PendingReview`; supports `timeout` and `on_timeout`
- `quorum=` on `@infer` — runs N parallel calls, asserts `threshold` agreement on `agree_on` field, returns highest-confidence agreeing result
- `stable=False` on `@infer` — return type becomes `Probabilistic[T]`; caller must call `.most_likely()`, `.sample()`, or `.assert_stable()`
- `stable=True` test mode — when `stratum.configure(test_mode=True)` is set, samples `sample_n` times and raises `StabilityAssertionError` if outputs are not unanimous
- `Probabilistic[T]` — wraps a sample of LLM outputs; `.most_likely()`, `.sample()`, `.assert_stable(threshold)`
- `Budget(ms=, usd=, tokens=)` — time + cost + token envelope; enforced via `asyncio.timeout` and LiteLLM cost tracking
- OTLP trace export — built-in emitter posts spans over HTTP/JSON to any OTLP endpoint; no OTel SDK dependency; `traceId` derived from `flow_id` so all `@infer` spans in a flow share a trace
- `opaque[T]` annotation — marks fields excluded from the tool-call schema (present in output but not constrained)

**Exceptions**

- `StratumCompileError` — static violations at decoration time
- `PreconditionFailed` — `given` condition false before LLM call
- `PostconditionFailed` — `ensure` violations after all retries
- `ParseFailure` — LLM output cannot be parsed against contract schema
- `BudgetExceeded` — time or cost budget exceeded
- `ConvergenceFailure` — `@refine` exhausted `max_iterations`
- `ConsensusFailure` — `quorum` could not reach `threshold` agreement
- `ParallelValidationFailed` — `parallel` `validate` callback returned False
- `HITLTimeoutError` — `await_human` wall-clock timeout with `on_timeout="raise"`
- `StabilityAssertionError` — `Probabilistic[T].assert_stable()` below threshold

### Dependencies

- `litellm>=1.0` — LLM client, multi-model routing, cost tracking
- `pydantic>=2.0` — required; `@contract` requires `BaseModel`
- Python 3.11+ — `asyncio.TaskGroup`, `asyncio.timeout`
