# STRAT-FLOW-CANCEL-FG: Blueprint

**Date:** 2026-09-09
**Status:** BLUEPRINT — Phase 4. Grounded against the repo state read 2026-09-09/10.
**Repo:** `/Users/ruze/reg/my/forge/stratum`. Every path below is relative to that root
(so `ts/src/engine/engine.ts`, not `src/engine/engine.ts`).
**Design:** `docs/features/STRAT-FLOW-CANCEL-FG/design.md`.
**Binding decisions:** the controller decision set D1..D8 (2026-09-09). Where this blueprint
differs from a decision, the difference is a numbered row in §1 with its reason. Nothing else
re-opens a decision.
**Baseline:** working tree at `b25cd8b` (STRAT-LOOP-CARRY merged). `ts/src/engine/engine.ts` is
3174 lines; `ts/package.json` and both `ts/server.json` version fields are already `0.5.0`.

## Related Documents

- `docs/features/STRAT-FLOW-CANCEL-FG/design.md` — intent and evidence
- `docs/features/STRAT-LOOP-CARRY/blueprint.md` — the sibling prerequisite that just shipped;
  its §9 File Plan and §10 Boundary Map conventions are followed here verbatim
- `/Users/ruze/reg/my/forge/compose/docs/features/COMP-FABLE-ASTRA/design.md` — the first
  consumer; its D5 is what this feature has to satisfy. Read-only from here; the compose wiring
  is **not** part of this ticket
- `docs/features/STRAT-TS-FANOUT-CONSUMER/design.md` — the consumer-dispatch descriptor and
  gate-token fencing this feature reuses rather than changes
- `CHANGELOG.md:146-159` — the 0.4.0 acknowledged-cancellation contract this feature obeys
- `/Users/ruze/reg/my/forge/compose/.claude/skills/compose/templates/boundary-map.md` — the
  grammar the Boundary Map in §10 obeys

---

## 1. Corrections

One row per place where the design, a controller decision, or an explorer report does not match
the code as read on 2026-09-09/10. Every `path:line` in this table was re-read in the file before
the row was written. "Decision" names the D-number that resolves it; rows with no D-number are
grounding corrections that change a citation, not a decision.

| # | Assumption | Reality | Resolution |
|---|---|---|---|
| C1 | "propagate to in-flight agent runs through their recorded cancellation ids" (`design.md:10`) | Cancellation ids are recorded nowhere durable: `foreground` and `completed` are two `Map`s in the closure of `createToolDispatcher` (`ts/src/mcp/server.ts:119-120`), discarded in the `finally` (`:332-339`). Even persisted, a `cancellationId` indexes an in-process `AbortController`, not an OS handle | D4. The durable key is `childPid` + `procStartTime`, exactly as `ts/src/connectors/background.ts:446-451` uses. The `cancellationId` is recorded too, but only for the same-process fast path |
| C2 | A foreground agent run can be found by flow id | The `stratum_agent_run` request contract has no flow field (`ts/contracts/mcp-surface.json:921-951`) | D4/D6. `stratum_agent_run.request` gains `flow?: {runId, stepId?, itemIndex?}`. This is a change to an **existing** tool's schema, so it trips compose's `#agentFields` guard (`/Users/ruze/reg/my/forge/compose/lib/stratum-mcp-client.js:279-291`) by design — see §11 |
| C3 | "refuse any consumer result or patch captured after the cancel mark" needs new code | The refusal already exists. `stepDoneLocked` throws on `run.cancelRequested === true` at `ts/src/engine/engine.ts:552`, **before** `consumerFanoutStepDone` is dispatched at `:558`. `gateResolveLocked` does the same at `:956` | No new refusal path. This feature makes the flag **settable** on a foreground run and **visible** to a second process. Building a second refusal is explicitly out of scope |
| C4 | "or patch" is an engine concept for consumer fanout | `FanoutItemState.patch` is written only on the engine-dispatch worktree path (`engine.ts:1901-1911`) and merged only under `dispatch === "engine"` (`:1772`). A consumer's worktree/patch/merge is delegated through `consumerDescriptor.policy` (`:2471-2476`) | Restated: the engine's lever over a consumer patch is refusing the `stepDone` that would carry it (`:552`) and refusing the mandatory merge gate (`:956`). Both already true. Pinned by T-S01-4 and T-S01-5 |
| C5 | The mandate's "flowPoll ~1226" | `:1226` is inside `advance`. `flowPoll` is at `:839-857` and has **zero** cancel awareness: it returns the persisted `status`, which stays `"running"` forever under a bare mark | D2/D3. The terminal settle is what fixes this, not a `flowPoll` change. `flowPoll` needs no edit once `status` can be `"cancelled"` |
| C6 | A foreground consumer-dispatch run may be pinned in `activeRuns`, so a cross-process cancel is invisible | `retainRun` has exactly four call sites — `engine.ts:473`, `:519`, `:911`, `:1534` — and `scheduleFanout` returns early for consumer dispatch (`:1524`). A consumer-dispatch foreground run is **never** pinned, so every entry point already does a fresh `store.load` | **Load-bearing again after R4-4, for the opposite reason.** Pinning now decides whether a cross-process cancel is *permitted* at all: a pinned run carries a driver lease and only its driver may cancel it. Because `scheduleFanout` returns early for consumer dispatch (`:1524`), compose's team builds are never pinned and are never refused — which is exactly why the v1 boundary is acceptable. The four pin sites are the map of where the lease is written |
| C7 | The sidecar alone heals a clobbered cancel | It healed `cancelRequested` but not `status`, so a clobbering persist restored `running` and nothing re-ran the settle | **RETIRED by R2-1.** There is no clobber to heal: `flowCancel` settles inside the same mutual exclusion every other writer passes through, so `advance:1226` keeps its existing meaning and background cancel keeps abandoning with no discriminator needed (S01-6). The pins at `ts/tests/engine/flow_bg.test.ts:343-354` still hold unchanged |
| C8 | A foreground registry entry can live in `~/.stratum/ts/agent_runs/` beside the background ones (D4) | `loadMeta` (`background.ts:485-503`) accepts any `meta.json` whose `runId` matches the directory, whose `agent` is `codex`/`claude` and whose `model` is a string. A foreground codex entry placed there would be loadable by `cancelBackgroundRun`, which would then take the codex path and `process.kill(-pid)` it as if it were a background run — and `stratum watch` (`ts/src/cli/stratum.ts`) enumerates the same root | Deviation from D4's literal path, same mechanism: foreground records go in a **sibling** root `~/.stratum/ts/agent_fg/<12hex>/meta.json`. `newRunDir` / `atomicWriteJson` / the four-gate kill are reused unchanged. `RUN_ID` (`background.ts:53`) still applies |
| C9 | One foreground run owns one process group (D4's `childPid`, singular) | `ClaudeConnector` collects children in an **array** and terminates all of them (`ts/src/connectors/claude.ts:57` `const children: Array<...> = []`, pushed at `:93`, drained by `terminate()` at `:67-68`). The SDK spawner `spawnClaudeCodeProcess` (`:81-105`) is a callback the SDK may invoke more than once | Shape refinement, not a decision change: the meta carries `groups: Array<{childPid, procStartTime?}>`, appended per spawn. Every entry gets its own four-gate kill. Codex writes exactly one entry (`ts/src/connectors/codex.ts:274`) |
| C10 | `RunStatus` gaining `cancelled` forces changes to `p4.test.ts`'s status list | `ts/tests/engine/p4.test.ts:1190` asserts `[...observedStatuses].sort()` equals a fixed list built **only from responses the test itself collects**. Adding a declared variant nobody exercises there changes nothing. The **events** vocabulary check at `:1177` is the exact-both-directions one | S01-9 adds `flow_cancelled` to `declaredAheadOfEmission` (`p4.test.ts:1150-1159`) exactly as `7e641fa` did for `carry_updated`, and leaves the status list alone |
| C11 | The surface counter is pinned in two places | Three: `ts/tests/mcp/schema-grammar.test.ts:88`, `ts/tests/mcp/contracts-grammar.test.ts:83`, `ts/tests/engine/p4.test.ts:982`. The events counter is pinned twice more, at `p4.test.ts:981` and `contracts-grammar.test.ts:105` **plus its test title at `:104`** | All five updated in S01 (events 3 → 4) and S03 (surface 18 → 19, tools 24 → 25) |
| C12 | `resume` already refuses a cancelled run | It does not, for a foreground run. `assertExternalMutationAllowed` (`engine.ts:2819-2825`) consults `bgFlows`, which has no entry for a foreground run, so `resumeLocked` proceeds, re-emits `resumed` and lands in `advance`'s `{status:"running"}` limbo. Pinned today by `ts/tests/engine/fencing.test.ts:279`: `expect(await restarted.engine.resume(planned.runId)).toMatchObject({ status: "running" })` | D5. S01-7 refuses in `resumeLocked`; **that existing assertion changes in the same commit** and is listed in §9 |
| C13 | `AgentRunOptions` lives in `ts/src/connectors/index.ts` (explorer ref `index.ts:18`, `:94`, `:107`) | `ts/src/connectors/index.ts` is a six-line barrel of `export *`. The type is `ts/src/connectors/runner.ts:11-29`, and the two forwarding sites the explorer meant are `runner.ts:94` (codex) and `runner.ts:107` (claude) | Citation fix only. §4 uses `runner.ts` |
| C14 | `defaultConnector` is at `engine.ts:3150-3159` | It is `engine.ts:3140-3168` | Citation fix. The finding stands: it passes neither `signal` nor `ownProcessGroup`, so engine-dispatch fanout agents are uncancellable. Filed in §12 as STRAT-ENGINE-CONNECTOR-CANCEL |
| C15 | A `cancelled` run can flow through `response()` unchanged | `response()` (`engine.ts:2992-2997`) has a `failed` fallthrough that calls `requiredFailure(run)` (`:3133`), which **invents** `{attempt: 0, reason: "run failed without context"}` when `failure` is unset. D3 keeps `failure` unset, so an un-updated `response()` would report a cancelled run as a failure with a fabricated reason | S01-5 adds an explicit `cancelled` arm **above** the fallthrough, and `EngineResponse` (`engine.ts:213-218`) gains a `cancelled` variant carrying no `failure` |
| C16 | A `flow_cancelled` event needs a new `PersistedRun` field (`cancelledAt`, `cancelReason`) | It does not, and adding one is expensive: `ts/src/engine/checkpoint.ts:34` is a `satisfies Record<Exclude<keyof PersistedRun, CheckpointField>, string>` and `ts/tests/engine/flowctl.test.ts:53-56` asserts the complete sorted 25-name key list | No new persisted field. The timestamp and reason live in the `flow_cancelled` event detail. `flowctl.test.ts` is untouched |
| C17 | A teardown timeout on the new tool reuses the agent error path | `server.ts:317-327` wraps `CANCELLATION_TEARDOWN_TIMEOUT` into the `agent_run_failed` envelope **only** for `stratum_agent_run` / `stratum_cancel_agent_run`. For any other tool the error falls through `:328` and reaches the client as an undeclared raw error | S03-4 adds a `flow_cancel_teardown_timeout` error envelope to `mcp-surface.json` and a branch beside the checkpoint branch at `server.ts:311-315`. `registryError` (`:95-100`) refuses an undeclared envelope, so the contract entry is mandatory, not optional |
| C18 | The engine may not import the connectors | It already does: `engine.ts:8` is `import { runAgent } from "../connectors/runner.js";` | D7's shared module is `ts/src/engine/flow_cancel.ts`, which may import `../connectors/foreground_registry.js`. Both `ts/src/mcp/server.ts` and the new `ts/src/cli/flow.ts` call it |

---

### Round 1 gate findings (R1-1..R1-10)

Codex `gpt-5.6-sol/high`, 2026-09-09. Ten findings, all accepted and folded. Four carried a
controller RULING where the finding left a choice; those are marked.

**Three of these were superseded eight hours later by the round-2 ruling** — R1-1, R1-2 and
R1-3's sidecar half. Their "folded into" cells describe sections that §2.1a replaced, and are
kept as the record of why the lockless design was abandoned rather than as instructions. R1-3's
registry-lifecycle half, and every other row, still stand.

| # | Severity | Finding | Folded into |
|---|---|---|---|
| R1-1 | must-fix | **SUPERSEDED by R2-1.** RULING at the time: a write barrier, not a filesystem lock. The sidecar was consulted only by `loadRun`, so it healed `cancelRequested` but left any writer free to persist `status: "running"` — or `"completed"` — over a settled cancel. `withRunLock` (`engine.ts:372-381`) is in-process and `save` (`state.ts:270-277`) rewrites the whole record, so two engines over one root are last-writer-wins. `StateStore.save` now converts a `running` snapshot in place when the mark is present. | §2.1a in full (the barrier, its four-hazard table and its cost); §3 S01-1 (five edits, not three), S01-3 (`burnIssuances` moves to `state.ts` as an exported function so the barrier and the engine share one implementation), S01-4 (`terminalCancel` calls the shared helper); §7 invariants 1b and 3; tests T-S01-2 (the precommit race, asserting the durable snapshot AND A's in-memory object), T-S01-3 (idempotent), T-S01-3b (a terminal snapshot is never converted), T-S01-8 (the pinned engine-dispatch fanout converges through the barrier at `engine.ts:1917-1923`) |
| R1-2 | must-fix | **SUPERSEDED by R2-1** (no mark, no nonce). RULING at the time: a nonce in the mark. Mark-first poisoned a run that turned out to be terminal: the sidecar stayed on disk forever, and the barrier would later relabel any write. | §2.1 (`CancelMark.nonce`; `clearCancelMark(runId, nonce)` returns whether it removed its own mark); §2.1a (the barrier converts only a `running` snapshot); §3 S01-9 (`flowCancel` retracts its own mark on the already-terminal path and makes no other durable mutation; a second cancel finds a foreign nonce and leaves the standing mark alone); §7 invariant 1; tests T-S01-9, T-S01-10 (no sidecar after `already_completed`; `commit`/`revert` still work), T-S01-10b (a concurrent canceller's mark survives) |
| R1-3 | must-fix | **PARTLY SUPERSEDED by R2-8**: the lifecycle stands, the two checks now read the run record, not a sidecar. RULING: a `starting → running → settled` lifecycle plus two admission checks. An agent whose spawn was in flight when the sweep read the directory had no record and no pid, so it escaped the cancel entirely and kept running against a cancelled flow. | §2.4 (`ForegroundRunState`, `AgentCancelSummary.unresolved`, and the two checks stated as a contract); §4 S02-3 (`flowIsCancelled`, the throwing `recordForegroundGroup`, the rescan loop), S02-4 (the `starting` entry written synchronously before the first await — the reason `server.ts:117-119` registers the foreground map early — the pre-spawn and post-stamp checks, their error envelopes, and the removal of the round-0 `.catch(() => undefined)` on the group write); §7 invariant 15; tests T-S02-0 through T-S02-0e |
| R1-4 | must-fix | The same-process controller abort was orchestrated in the MCP dispatcher, so `stratum flow cancel` silently lacked a phase the tool had. | §5 S03-1 (`CancelFlowOptions.abortLocal`, run inside `cancelFlow` after durable settlement), S03-2 (the dispatch case calls `cancelFlow` and nothing else, and strips the engine-internal `settledByThisCall` before the wire); §7 invariant 6 |
| R1-5 | must-fix | **RULING: `flowSettled` and `acknowledged` are two facts.** One boolean conflated "the run is cancelled" with 0.4.0's "the whole group is reaped" (`CHANGELOG.md:146-159`), and the error envelope hardcoded `status: "cancelled"` for a run whose status it had not read. | §2.2 (`FlowCancelResult.flowSettled` / `settledByThisCall`); §2.6 (both fields on the wire, the two-code table, and `flow_cancel_unacknowledged` carrying the real status plus the partial summary); §5 S03-1 (`acknowledged` computed as a guarantee; anything unresolved throws), S03-2 (the error branch reports the engine's status); §7 invariant 6b; test T-S03-4 |
| R1-6 | must-fix | "Copy the `budget_exhausted` shape" was wrong for four tools: the cancelled arm emits no `failure`, `resume` carries `revisionDigest`, and `revert` cannot return a cancelled status at all after R1-7. Matching is complete-strict default-deny (`ts/src/mcp/contracts.ts:121-123`), so a declared-but-absent required `failure` would fail every cancelled response. | §2.7 rewritten as a per-tool shape table (seven tools, not eight) with the `stratum_plan` worked example showing the difference; §5 S03-4 item 4; test T-S03-7 validates complete representative payloads through `assertToolResponse` |
| R1-7 | must-fix | `new CheckpointOperationError("flow_cancelled", …)` does not compile: `errorType` is a closed union at `engine.ts:290`. The `RunStatus` import at `engine.ts:20` was also missing from the File Plan. | §3 S01-8 (the union extension quoted, and why no contract edit follows); §8 File Plan (both the union and the `state.js` import line); test T-S01-7b pins `{status: "error", error_type: "flow_cancelled"}` through MCP |
| R1-8 | should-fix | Four CLI defects in one: `projectStatus` reported a cancelled run as `running`; an unknown flow id returned 1 instead of 2 because it fell through the catch-all; an already-terminal flow returned 2, which compose maps to `{conflict: true}` and would make an idempotent abort look like a failure; and a teardown timeout printed only a message. | §2.8 (the full exit-code table); §5 S03-3 (the rewritten `flowCommand` with an explicit ENOENT branch and a structured teardown envelope), new §5 S03-3b (`projectStatus` learns `cancelled`, and why not `killed`); §8 File Plan adds `query_gate.ts`; tests T-S03-6 (table-driven exit codes) and T-S03-8; §13 both open questions closed |
| R1-9 | should-fix | The registry root was not injectable, so every test would write to the developer's real `~/.stratum` and two dispatchers could not be isolated. | §4 S02-3 (`registryRoot` on every function, `STRATUM_AGENT_FG_ROOT` fallback, mirroring `RegistryOptions` at `background.ts:100`), S02-4 (`McpDependencies.foregroundRegistryRoot?`), §5 S03-2 (threaded into `cancelFlow`); §7 invariant 12; test T-S02-10 |
| R1-10 | nit | Three citations: the claude `children.push` is `:93` not `:90`; the `carry-golden` save spy spans `:145-149`; and `contracts-grammar.test.ts:104`'s test title carries the frozen events count, so it must be renamed with the assertion. | C9; T-S01-2; §3 S01-11 |

---

### Round 2 gate findings (R2-1..R2-11)

Codex `gpt-5.6-sol/high`, 2026-09-09. Eleven findings (9 must-fix, 2 should-fix), all accepted.

**The round-2 verdict was not a list of defects — it was a non-convergence signal.** Rounds 0 and
1 both shipped a lockless design: a durable mark, a re-apply on load, then a write barrier in
`save`. Each round closed the race it was shown and produced a new one, because every version was
a check followed by an unsynchronised write. Six of the nine must-fixes below are the same bug in
six places. The controller's ruling is to stop patching around the absence of mutual exclusion and
introduce it: **a real cross-process file lock, and the sidecar deleted entirely.**

What that removes from the design: `CancelMark`, the `.cancel` file, the nonce, the
`StateStore.save` barrier, the `loadRun` probe, the sidecar-gated settle in `advance`, and the
`flowIsCancelled` helper in the connector layer. What it adds: `ts/src/engine/run_lock.ts`, a
a refresh of the pinned object at every lock entry — itself replaced in round 4 by the driver
lease (R4-4) — and one honest constraint the ruling did not anticipate, see R2-1a.

| # | Severity | Finding | Folded into |
|---|---|---|---|
| R2-1 | must-fix | **RULING: a real cross-process lock; delete the sidecar.** The barrier was still check-then-write, and the mark could be observed by one process while another was mid-transaction with a stale object. | §2.1 (no `CancelMark`, `StateStore` unmodified), §2.1a (`run_lock.ts` in full), §2.1b (`withRunLock` wraps the file lock; `refreshPinned`; the persist assertion); §3 S01-1 through S01-3 rewritten, S01-6 (`advance:1226` reverts to unchanged), S01-11 (`flowCancel` is one locked section, one persist); C6 and C7 marked RETIRED; §7 invariants 1-4 |
| R2-1a | — | **Correction to the ruling's premise, found while verifying it.** The ruling asks the blueprint to confirm that no locked section awaits a connector. It cannot be confirmed: `stepDoneLocked` → `runEnsures` (`engine.ts:2099`) → `this.judge(...)` (`:2111`) and `advanceScopeLoop`'s `evaluate:` arm → `this.evaluateRunner(...)` (`:1436`) are both long external awaits **inside** the lock, reachable from six of the fourteen sites. The connector proper (`:1861`, `:1092`) is outside, as the ruling says. | §2.1b states it with the full fourteen-site table, and fixes the constants it breaks: `STRATUM_RUN_LOCK_TIMEOUT_MS` defaults to **300000**, not 30000, and the cancel path acquires with its own `STRATUM_CANCEL_TIMEOUT_MS` (15000) reporting a miss as `CANCELLATION_UNCONFIRMED`; §7 invariant 5; test T-S01-14 |
| R2-2 | must-fix | A fanout item's result was accepted outside the lock: `settleFanoutAttempt`, the git patch capture (`engine.ts:1901-1911`), `item.output`, `status = "succeeded"` and the `dispatchToken` → `acceptedDispatchToken` promotion (`:1912-1916`) all ran after the connector await, so a cancel landing during that await was seen only at the next boundary — and a result could be durably accepted after the flow was cancelled. | §3 S01-9 in full, quoting the `:1861-1923` region and showing where the lock is taken; §7 invariant 6; tests T-S01-8, T-S01-8b (the worktree case, asserting no patch is captured); §6.2 gains the abandonment clause |
| R2-3 | — | Moot: there is no nonce and no sidecar to retract (R2-1). | Recorded here so the R1-2 machinery is not reintroduced by a later reader |
| R2-4 | must-fix | Every non-acknowledged outcome raised a cancellation error, including a run that had simply completed on its own — reporting a teardown that was never attempted. And an already-`cancelled` run skipped the sweep, so a caller could never recover from an earlier `CANCELLATION_TEARDOWN_TIMEOUT`. | §2.6 (the three-outcome table); §2.8 (the CLI rows split); §5 S03-1 (`cancelFlow` returns early for a terminal-but-not-cancelled run and re-sweeps an already-cancelled one); tests T-S01-10, T-S03-4b, T-S03-4c, T-S03-6 |
| R2-5 | must-fix | `abortLocal` returned void, so aborting a controller only *started* teardown and the reap pass raced the teardown the same call had begun. | §5 S03-1 (`abortLocal` returns a promise; the five-phase order settle → signal → await local settlement → reap → acknowledge; `cancelFlowAgents` split into `signalFlowAgents` and `reapFlowAgents`), S03-2 (the dispatcher awaits each run's `settled` promise, `server.ts:119`/`:338`, under `teardownDeadline`); §7 invariant 10 |
| R2-6 | must-fix | The group-write rejection was observed only in the dispatcher's `finally`, so a successful agent result could be returned over an unrecorded group; and `procStartTime` returning `undefined` (`ts/src/connectors/proc_identity.ts:50-58`, darwin fails closed) was treated as a degraded success rather than a registration failure — producing an entry that can never be signalled (`:80-83`). | §4 S02-4 (the immediate rejection handler that aborts the controller, kills and reaps, stamps `settled` and rethrows; `recordForegroundGroup` returns what it wrote so the caller can check the token; `killAndReapGroup` exported from its module); §7 invariant 15; tests T-S02-0c, T-S02-0c2 |
| R2-7 | must-fix | The rescan loop had no cross-pass bookkeeping: entries and pids were re-counted every pass, ESRCH was not distinguished from an identity mismatch, and a `running` entry whose groups were reaped was treated as acknowledgeable while its owning dispatcher was still unwinding. | §2.4 step 4 rewritten with the accumulated `Map`, the ESRCH/identity split, the durable-`settled` requirement and its dead-owner exception, and the multi-group Claude rule; §7 invariant 12; tests T-S02-0f through T-S02-0j |
| R2-8 | must-fix | The admission checks read a sidecar that no longer exists, and there was no way for a test to point them at its own state root. | §2.4 (the checks read the run record), §4 S02-3 (`flowIsCancelled` removed; `engine.isCancelled(runId)` added, taking the run lock for one JSON read), S02-4 (`engine.isCancelled` at both checks; `McpDependencies.flowStateRoot?`; the engine `Pick` gains the method) |
| R2-9 | must-fix | `stratum_plan`'s worked `cancelled` variant dropped `revisionDigest`, which its `budget_exhausted` neighbour declares — so every cancelled plan response would have failed the complete-strict match. | §2.7 (the digest restored for `plan`, `step_done` and `gate_resolve` as well as `resume`, and the worked example rewritten as "copy the neighbour and delete `failure`", with an instruction to read each block in the file first) |
| R2-10 | should-fix | Only `revert` was refused on a cancelled run; `commit` would snapshot a run mid-teardown as if it were a recovery point. | §3 S01-8 (both refused, with the reason round 0's carve-out does not survive), golden-flow assertion 7, test T-S01-7 and T-S01-7b |
| R2-11 | should-fix | `driveBg` reads its in-memory `BgFlowState`, which another process cannot set, so a bg run cancelled cross-process settled durably while `flowBgPoll` reported `running` forever. | §3 S01-10; test T-S01-11, which uses two engines over one root because the in-memory shortcut passes a single-engine test |

---

### Round 3 gate findings (R3-1..R3-9)

Codex `gpt-5.6-sol/high`, 2026-09-09. Nine findings, all must-fix, all accepted. Round 2 replaced
the lockless design with a lock; round 3 is the audit of whether the lock is actually a lock. Six
of the nine say it was not yet — the protocol had a publication gap and a stale-break race, three
write paths were outside it, the refresh copied too little, and the admission check answered the
wrong question. None of that reopens R2-1; all of it is the cost of having taken the ruling
seriously enough to specify it.

| # | Severity | Finding | Folded into |
|---|---|---|---|
| R3-1 | must-fix | **RULING: `startTime` is required, no pid-only fallback.** `procStartTime` returns `undefined` when libproc is unreachable (`ts/src/connectors/proc_identity.ts:50-58`, darwin fails closed). A lock owned by a bare pid cannot be aged out safely — pids recycle, so a stale-break would eventually break a live holder's lock or refuse to break a dead one forever. | §2.1a (the required field, and `RUN_LOCK_IDENTITY_UNAVAILABLE` refusing the acquire); §7 invariant 1c; test T-S01-L10, which also asserts **no lock file is created** on the refusal |
| R3-2 | must-fix | **RULING: atomic publication by hard link, plus a break-lock and an inode re-check.** `open("wx")` + `writeFile` is two steps: a crash between them publishes an empty lock file. And the naive stale-break — read, decide, unlink — can delete a *replacement* lock acquired between the read and the unlink. Node core has no advisory locking and this package takes no native dependency, so the primitive must be the filesystem's own atomicity. | §2.1a rewritten in full: the owner record with its `token`, the five-step hard-link acquire, the nine-step break-lock sequence with the step-6 inode re-check, the token-checked release, and tmp-orphan sweeping; §7 invariant 1b; tests T-S01-L1..L10, notably L2 (crash during publication leaves no lock), L5 (two breakers cannot delete a live replacement, driven by a fake identity oracle) and L6 (mismatched-token release is a no-op) |
| R3-3 | must-fix | The round-2 draft asserted every write was locked without auditing it. Three were not: `plan()`'s initial persist and first advance (`engine.ts:445-446`), the whole engine-fanout admission and reservation stretch (`:1803-1857`, including the terminal budget persist at `:1848`), and `ts/src/cli/learn.ts:186-201`, which builds its **own** private `Map`-of-promises lock and calls `store.save` under it — excluding nothing outside that one CLI invocation. | §2.1b's write-path audit in full, with the fanout locked/unlocked/locked split shown against the real line ranges and the note that the locked prologue re-enters per stage attempt; §3 File Plan adds `cli/learn.ts` and a `lockedSave` export; §7 invariant 1; tests T-S01-W1..W3 |
| R3-4 | must-fix | `refreshPinned` copied two booleans, leaving the pinned writer holding its own `steps` map — unburned tokens included — and an `events` array without the `flow_cancelled` entry. Its next persist would undo the settle field by field while `status` said `cancelled`. | §2.1b: when disk is cancelled the pinned object **adopts disk's `steps` and `events` wholesale**, with the reasoning for why that is the right rule rather than an aggressive one; plus a `persist` guard that makes a cancelled run's late fanout `finally` a no-op; §7 invariant 4; test T-S01-8c asserts the post-drain durable snapshot equals the settle snapshot |
| R3-5 | must-fix | Three independent per-phase timeouts let a caller wait 3x its configured budget, and a slow signal pass could leave no time to reap. Failures also left `cancelFlow` in several shapes, and neither surface rendered `reason` or `holderPid`. | §5 S03-1: one absolute deadline computed **after** settlement and passed as remaining time to every phase; `RUN_LOCK_TIMEOUT` normalised into `CANCELLATION_UNCONFIRMED{reason:"run_lock_held", holderPid}`; an `abortLocal` timeout recorded as `reason:"local_teardown_timeout"` and **not** fatal; one exported `CancelFailure` shape; S03-2 and S03-3 render `reason` and `holderPid`; §7 invariants 10 and 10b; tests T-S01-16, T-S01-17 |
| R3-6 | must-fix | The dead-owner exception tested `serverPid` alone, so a recycled pid read as "the server is gone" and would stamp a live dispatcher's entry `settled`. And the summary had no field for "reaped but not settled", so that state was invisible to the acknowledgement. | §2.4: `serverProcStartTime` persisted and required for the exception; `AgentCancelSummary.unsettled` added and threaded through every contract, envelope, CLI envelope and test literal; `acknowledged` requires `unsettled === unresolved === unreachable === 0`; §7 invariant 12; tests T-S02-0i2, T-S02-0i3 |
| R3-7 | must-fix | `isCancelled` returning `false` conflated "healthy", "does not exist" and "could not read the record", and only the first is a reason to start an agent. An unreadable record would admit an uncancellable agent. | §4 S02-3: `admitFlowAgent(runId)` replaces it — a locked operation requiring a readable, existing, `running` record, failing closed with `FLOW_ADMISSION_FAILED` on I/O or corruption and `FLOW_NOT_RUNNING` on terminal or unknown; two new declared envelopes; both call sites in S02-4 use it; tests T-S02-0a2 (three failure rows) and T-S02-0a3 (the run goes terminal between the two checks) |
| R3-8 | must-fix | `registryWrites` was awaited only in the `finally`, after `succeeded = true` and the response were already set — so a group-write failure produced a rejected promise *and* a recorded success. `killAndReapGroup` also took a bare pid, which is a kill by pid alone. | §4 S02-4: the `await registryWrites` insertion shown against `ts/src/mcp/server.ts:229-231`; `killAndReapGroup(pid, {startTime})` requires the recorded identity and re-checks it; where no identity was recorded there is **no group kill**, only the connector's own `AbortController`; post-stamp refusals map through `registryError`; §7 invariants 15 and 15b |
| R3-9 | must-fix | The `cancelled` variants for `stratum_step_done` and `stratum_gate_resolve` declared `revisionDigest`, which those tools do not emit — `ts/tests/mcp/p5.test.ts:334` and `:383` both pin `toBeUndefined()`. The prose also still said "eight tools" after R1-6 cut it to seven. | §2.7: the digest kept on `plan` and `resume` only, with each row naming why; the "eight" corrected; the instruction now says to check whether the tool returns `RevisionedEngineResponse`; T-S03-7 rebuilt to validate payloads produced by the **real dispatcher**, since a hand-built payload is exactly what let R2-9 and R3-9 both through |

---

### Round 4 gate findings (R4-1..R4-8)

Codex `gpt-5.6-sol/high`, 2026-09-09, scoped to §2.1a, §2.1b and §3. Eight findings (5 must-fix,
3 should-fix), all accepted. This is the last review round before implementation.

**R4-4 is the one that changes the shape of the feature, and it is a scope decision rather than a
fix.** Rounds 2 and 3 both tried to let a second process cancel a run whose in-memory object
another process was actively mutating — first by copying two booleans onto it, then by adopting
disk's `steps` and `events` wholesale. The second is more correct than the first and wrong in the
same way: the pinned object has no lock, so a refresh only narrows the window it loses in. That is
the round-1 pattern, a check followed by an unsynchronised write, relocated from disk into memory.
The controller's ruling is to stop reconciling and start refusing: a pinned run declares a
**driver lease**, and a cancel from any other live process is refused with the holder's pid. The
v1 boundary that draws — engine-dispatch fanouts are cancellable only by their driver, consumer
fanouts (compose's actual case) are unaffected — is recorded in §2.1b rather than papered over.

| # | Severity | Finding | Folded into |
|---|---|---|---|
| R4-1 | must-fix | A cancelled run's `persist` was a silent no-op, which would swallow a `usageReport` or receipt update that genuinely needed to fail — a late write disappearing is indistinguishable from one that succeeded. | §2.1b: `persist(run, sanctioned)` throws `PERSIST_ON_CANCELLED_RUN` unless called through `persistTerminalCancel`, the single sanctioned save; the fanout `finally` checks the status itself and skips while still tearing down its worktree; §7 invariant 4b; tests T-S01-8c (exactly one cancelled snapshot saved, via a `save` spy) and T-S01-8e |
| R4-2 | must-fix | The break-lock had an age-based reclaim (mtime > 5000ms). A breaker legitimately waiting out a slow identity probe would be evicted by it, and the eviction then races the breaker it evicted through the very sequence the break-lock exists to serialise. | §2.1a: reclaim **only** on `processIdentity(owner) === "dead"`, with the same inode re-check before unlink and a token-checked release; the record gains `token`; test T-S01-L8 rewritten — a live breaker held over five seconds is not evicted, a dead one is, whatever its age |
| R4-3 | must-fix | `processIdentityMatches` returns a boolean, so "gone" and "could not tell" collapse into `false` — and every reclaim built on it breaks a live holder's lock the moment a probe hits EPERM. | §2.1a: `processIdentity(pid, startTime): "alive" \| "dead" \| "unknown"` added to `ts/src/connectors/proc_identity.ts` beside the existing predicate, which is untouched for its callers; locks and leases reclaim only on `dead`; §8 File Plan; test T-S01-L11 |
| R4-4 | must-fix | **RULING: SCOPE, not a refresh.** See above. `refreshPinned` is deleted along with every "adopt disk's steps/events" claim. | §2.1b rewritten around the driver lease: the `DriverLease` record, the four pin sites that write it, the five-row decision table for `flowCancel`, and the v1 boundary stated plainly; §3 S01-3 (`retainRun`/`releaseRun`/`claimDriverLease`), S01-11 (`flowCancel` claims the lease first); C6's resolution rewritten — pinning is load-bearing again, for the opposite reason; §6.2; §7 invariant 4; §12 absorbs the general problem into STRAT-LOCK-SCOPE together with the pre-existing `stratum gate` lost update (`ts/src/cli/query_gate.ts:316-317`); tests T-S01-D1..D6 |
| R4-5 | must-fix | The connector's **catch** arm (`engine.ts:1868-1870`) mutated before the lock: `recordFanoutAttempt` pushes onto `item.attempts`, so a rejected connector recorded an attempt against an already-cancelled run. R2-2 fixed the success path and left the failure path in the bare catch. | §3 S01-9: both outcomes captured into a discriminated value **without mutation**, then processed inside the one locked transaction, which now returns `"abandon" \| "retry" \| "accepted"`; test T-S01-8d |
| R4-6 | should-fix | `commit`/`revert` call `assertExternalMutationAllowed` before taking the lock, and `"cancelled"` is not in that guard's terminal allowlist — so a cancelled **bg** run reported `is background-driven` while a cancelled foreground run reported `flow_cancelled`. Two errors for one condition, neither true. | §3 S01-8: the cancelled check runs inside the lock and is the first thing that can report; the pre-check is left alone; tests T-S01-7 and T-S01-7b each gain a bg-driven row |
| R4-7 | should-fix | Three new path-building call sites (lock, break-lock, lease) each re-derived the run-id regex inlined in `StateStore.path`. A fourth copy is how one of them ends up admitting a separator. | §3 S01-1: `assertRunId` exported from `state.ts` and called by `path` and by every lock and lease operation before any path is built; §2.1a step 0; test T-S01-L12 covers separators, `..`, absolute-looking ids and the empty string |
| R4-8 | should-fix | T-S01-L2 as written would have to sleep 60 seconds to exercise the tmp-orphan sweep, and nothing asserted the inverse — that a fresh tmp, belonging to a process mid-publication right now, is left alone. | §2.1a: T-S01-L2 backdates the tmp through an injected clock or TTL; new T-S01-L2b asserts a fresh tmp is not swept |

---

## 2. Contract

Everything in this section is exact. An implementer copies it verbatim.

### 2.1 `RunStatus` and the event vocabulary — `ts/src/engine/state.ts`

`RunStatus` (`ts/src/engine/state.ts:8`) today:

```ts
export type RunStatus = "running" | "completed" | "failed" | "budget_exhausted";
```

becomes

```ts
export type RunStatus = "running" | "completed" | "failed" | "budget_exhausted" | "cancelled";
```

D2, and the honest price is paid in full in S03. Note this keeps `RunStatus ⊂ BgStatus`
(`engine.ts:232`), which is what lets `rehydrateBgFlows` (`engine.ts:494`) assign
`{ status: run.status, ... }` into a `BgFlowState` without a cast.

The `AuditEvent` union gains `flow_cancelled` (§2.3). **There is no `CancelMark`, no `.cancel`
sidecar, no nonce and no barrier in `StateStore.save`** — the round-1 design is replaced by
§2.1a. `StateStore` is unmodified by this feature.

The new `EngineResponse` variant, added to `engine.ts:213-218` after the `running` arm:

```ts
export type EngineResponse =
  | { status: "ready"; runId: string; ready: ReadyEntry[]; ledger: LedgerInfo }
  | { status: "completed"; runId: string; output: unknown; ledger: LedgerInfo }
  | { status: "failed"; runId: string; failure: FailureContext; ledger: LedgerInfo }
  | { status: "budget_exhausted"; runId: string; failure: FailureContext; ledger: LedgerInfo }
  | { status: "running"; runId: string; ledger: LedgerInfo }
  | { status: "cancelled"; runId: string; ledger: LedgerInfo };
```

**No `failure` on the cancelled variant.** D3: the status is honest, so a fabricated
`FailureContext` would be a lie in the audit trail.

### 2.1a The cross-process run lock — `ts/src/engine/run_lock.ts` (new)

**RULING (controller, round 2): a real cross-process lock; the sidecar is deleted.** Rounds 0 and
1 tried to make a lockless design safe — a durable mark, then a `loadRun` re-apply, then a write
barrier in `save`. Each round closed the race it was shown and produced a new one, because every
version was a check followed by an unsynchronised write. That is the non-convergence signal: the
problem is not the mark, it is that `withRunLock` (`engine.ts:372-381`) is an in-process promise
chain and `StateStore.save` (`state.ts:270-277`) rewrites the whole record, so two engines over
one state root are last-writer-wins by construction. Stop patching around it and serialise the
writers.

Everything the sidecar was carrying now rides in the run record itself, written under mutual
exclusion. `cancelRequested` and `status: "cancelled"` are ordinary persisted fields again.

**RULING (controller, round 3, R3-2): atomic publication by hard link, and a break-lock for the
stale path.** Node core exposes no advisory file locking (`flock`/`fcntl`) and this package takes
no native dependency, so the primitive is the filesystem's own atomicity. Round 2's
`open(path, "wx")` + `writeFile` was two operations: a crash between them publishes an **empty**
lock file that every later reader must guess about, and the naive stale-break — read, decide,
unlink — can delete a *replacement* lock acquired between the read and the unlink. Both are fixed
below, and every step is named so a reviewer can check the ordering rather than the intent.

#### The owner record

```ts
interface LockRecord {
  pid: number;
  /** REQUIRED (R3-1). */
  startTime: string;
  /** Identifies THIS acquisition, so release cannot unlink a successor's lock. */
  token: string;
  at: string;
}
```

**`startTime` is required, with no pid-only fallback (R3-1).** `procStartTime`
(`ts/src/connectors/proc_identity.ts:50-58`) returns `undefined` when libproc is unreachable, and
darwin deliberately fails closed there. A lock owned by a bare pid cannot be aged out safely —
pids recycle, so a stale-break would eventually kill a live holder's lock, or refuse to break a
dead one forever. If the engine cannot identify itself it must not take the lock:

**Identity is tri-state (R4-3).** `processIdentityMatches`
(`ts/src/connectors/proc_identity.ts:80-83`) returns a boolean, so "this process is gone" and "I
could not tell" collapse into the same `false` — and a reclaim built on that breaks a live
holder's lock whenever a probe hits EPERM or an unreadable start time. A new sibling in the same
module, leaving `processIdentityMatches` untouched for its existing callers:

```ts
/** "dead" is a POSITIVE finding: ESRCH on the probe, or a readable start time that does not
 *  match. "unknown" is EPERM, or a start time we could not read at all. Nothing that reclaims
 *  another process's resource may act on "unknown" (R4-3). */
export async function processIdentity(pid: number, startTime: string): Promise<"alive" | "dead" | "unknown">;
```

Locks (§2.1a) and driver leases (§2.1b) reclaim **only** on `dead`.

```ts
  const startTime = await procStartTime(process.pid);
  if (startTime === undefined) {
    throw Object.assign(new Error("cannot establish process identity; run locking is unavailable"),
      { code: "RUN_LOCK_IDENTITY_UNAVAILABLE" });
  }
```

Captured once per engine, not per acquisition: the value cannot change for a live process.

#### Acquire — publication is one atomic step

```
0. assertRunId(runId)                          // R4-7, before ANY path is built
1. mkdir -p <stateRoot>                       // the lock may precede the run dir (R3-3a)
2. token = randomUUID()
3. write  <runId>.lock.<token>                // a COMPLETE owner record, fsync-free
4. link(<runId>.lock.<token>, <runId>.lock)   // ATOMIC: succeeds or EEXIST
5. success → unlink the tmp, return release()
   EEXIST  → unlink the tmp, go to the stale-break path, then retry from 2
```

`link()` is the whole point: the lock file never exists in a partial state, because it is only
ever created as a second name for a file that was already complete. A crash between steps 3 and 4
leaves a `<runId>.lock.<token>` orphan and **no lock** — the run stays available. Orphans are
swept opportunistically on acquire: any `<runId>.lock.*` whose mtime is older than 60s is
unlinked. The sweep is best-effort and never blocks an acquisition.

#### Stale break — under its own lock, and inode-checked

A dead owner's lock must be removable, and two processes may notice it at the same instant. The
break itself therefore runs under a second, tiny lock, and the removal is guarded by the inode
that was actually inspected:

```
 1. acquire the break-lock: open(<runId>.lock-break, "wx"), write {pid, startTime, at}
    - EEXIST → read it; reclaim ONLY when processIdentity(owner) === "dead" (R4-2); otherwise
      back off and return to the acquire loop. There is NO age-based reclaim: a breaker
      legitimately waiting out a slow identity probe would be evicted by it, and that eviction
      then races the breaker it evicted through the very sequence the break-lock serialises
 2. handle = await open(<runId>.lock)         // ENOENT → released already; release break, retry
 3. ino = (await handle.stat()).ino           // the identity of the file we are judging
 4. record = JSON.parse(await handle.readFile())
    - unparseable, or missing `startTime` → treat as LIVE, release the break-lock, back off
      (never guess; and per R4-3 an unreadable identity is "unknown", not "dead")
 5. if processIdentity(record.pid, record.startTime) !== "dead" → alive OR unknown:
      release the break-lock, back off, return to the acquire loop (R4-2, R4-3)
 6. owner is dead. RE-STAT the path: if (await stat(<runId>.lock)).ino !== ino, someone else
    already broke it and a NEW lock is published — do NOT unlink; release the break-lock, retry
 7. unlink(<runId>.lock)
 8. release the break-lock (unlink, verifying its token is ours — R4-2)
 9. retry the acquire from step 2 of Acquire
```

Step 6 is the finding R3-2 names: without it, breaker A can read a dead owner's record, be
descheduled while breaker B breaks the lock and C acquires it, and then unlink **C's** live lock.
The break-lock alone does not prevent this, because A may have read the record before taking it;
the inode re-check is what makes the removal conditional on the file still being the one that was
judged. A breaker that dies mid-sequence is reclaimed by the same identity rule as any other
owner (step 1); its `.lock-break` is never aged out, because age cannot tell a dead breaker from
a slow one (R4-2).

#### Release

```
1. read <runId>.lock
2. if record.token !== ours → NO-OP, and warn to stderr: our lock was broken and the run may
   have been re-acquired by another process. Unlinking here would delete a live holder's lock.
3. unlink(<runId>.lock)
```

#### Waiting

Between attempts, back off jittered 10-50ms until the deadline
(`options.timeoutMs ?? Number(process.env.STRATUM_RUN_LOCK_TIMEOUT_MS ?? 300000)`), then:

```ts
        throw Object.assign(new Error(`run ${runId} lock is held by pid ${held?.pid ?? "?"}`),
          { code: "RUN_LOCK_TIMEOUT", ...(held?.pid !== undefined ? { holderPid: held.pid } : {}) });
```

`holderPid` rides on the error object, not only in the message, so a surface can put it in a
structured envelope (§2.6) instead of asking a human to read prose.

Lock and break-lock files live beside run records; `StateStore.list()` (`state.ts:283-292`)
filters `.json`, so they are invisible to it.

#### Tests for the protocol (T-S01-L1..L10)

| id | Behaviour |
|---|---|
| T-S01-L1 | Mutual exclusion: two concurrent acquires; the second blocks until the first releases and the critical sections do not interleave |
| T-S01-L2 | **A crash during publication leaves no lock.** Write a `<runId>.lock.<token>` tmp and never link it; assert the next acquire succeeds. The orphan sweep is age-based, so **backdate the tmp** through an injected clock or TTL rather than sleeping 60s (R4-8) |
| T-S01-L2b | The inverse (R4-8): a **fresh** tmp file — another process mid-publication right now — is **not** swept. Sweeping it would delete a lock that is one `link()` away from existing |
| T-S01-L3 | A stale lock is broken: a record naming a dead pid+startTime (spawn a child, wait for exit) is removed and the acquire proceeds |
| T-S01-L4 | A live lock is **not** broken, however long it is held — identity, never age |
| T-S01-L5 | **Two simultaneous breakers cannot delete a live replacement.** Inject a fake identity oracle so both breakers see the owner as dead, let A read the record, let B break and let C acquire, then let A resume; assert A's inode re-check refuses the unlink and C's lock survives |
| T-S01-L6 | Release with a mismatched token is a no-op and warns; the holder's lock survives |
| T-S01-L7 | An unparseable lock record is treated as live and ages out only through the identity check once readable |
| T-S01-L8 | Break-lock reclaim is identity-only (R4-2): a **live** breaker holding its `.lock-break` for well over five seconds is **not** evicted; a **dead** breaker's is removed immediately, whatever its age |
| T-S01-L9 | `timeoutMs` expiry throws `RUN_LOCK_TIMEOUT` carrying `holderPid` |
| T-S01-L10 | `procStartTime` unavailable ⇒ `RUN_LOCK_IDENTITY_UNAVAILABLE` on acquire, and **no lock file is created** (R3-1) |
| T-S01-L11 | `processIdentity` is tri-state (R4-3): ESRCH ⇒ `dead`; a live pid with a mismatched start time ⇒ `dead`; EPERM or an unreadable start time ⇒ `unknown`. A three-row table, and the two reclaim paths are asserted **not** to act on `unknown` |
| T-S01-L12 | Run-id validation (R4-7): `a/b`, `..`, `/etc/passwd`, `` and `a.json` are rejected by every lock, break-lock and lease operation before any path is built. Table-driven over the four entry points |

### 2.1b Where the lock is taken, and the honest audit of what it holds across

`withRunLock` (`engine.ts:372-381`) keeps its in-process promise chain — it still serialises
same-process callers cheaply — and gains the file lock plus a refresh:

```ts
  private withRunLock<T>(runId: string, action: () => Promise<T>, options?: { timeoutMs?: number }): Promise<T> {
    assertRunId(runId);                                     // R4-7
    const previous = this.runLocks.get(runId) ?? Promise.resolve();
    const result = previous.then(async () => {
      const release = await acquireRunLock(this.store.root, runId, { ...this.lockOptions, ...options });
      this.heldLocks.add(runId);
      try {
        return await action();
      } finally {
        this.heldLocks.delete(runId);
        await release();
      }
    });
    const tail = result.catch(() => undefined);
    this.runLocks.set(runId, tail);
    void tail.then(() => { if (this.runLocks.get(runId) === tail) this.runLocks.delete(runId); });
    return result;
  }
```

`StateStore.root` is already public (`state.ts:264`).

**There is no `refreshPinned`. RULING (round 4, R4-4): the pinned object is not reconciled — it is
made exclusive by a driver lease.**

Rounds 2 and 3 tried to let a second process cancel a run whose in-memory object another process
was actively mutating: first by copying two booleans onto it, then by adopting disk's `steps` and
`events` wholesale. The second version is *more* correct than the first and still wrong in the
same way, because the pinned object has no lock of its own. Between the refresh and the driver's
next read, the driver can mutate anything; the refresh only narrows the window it loses in. This
is the round-1 pattern again — a check followed by an unsynchronised write — relocated from disk
into memory, and the honest conclusion is that a pinned run has exactly one legitimate writer.

So say so, durably, and refuse rather than race.

#### The lease

Whenever the engine pins a run — `retainRun` (`engine.ts:359-363`) taking refs from 0 to 1 — it
writes `<stateRoot>/<runId>.driver` under the run lock:

```ts
interface DriverLease { pid: number; startTime: string; token: string; at: string }
```

and unlinks it on the final `releaseRun` (`engine.ts:365-370`, refs back to 0), token-checked
exactly as the run lock's release is. The four pin sites are `engine.ts:473`, `:519`, `:911` and
`:1534`, so the lease is written by `flowRunBg`, `rehydrateBgFlows`, the gate bg re-kick, and
`scheduleFanout` — and `scheduleFanout` returns early for consumer dispatch (`:1524`), which is
what makes the boundary below land where it does.

#### What `flowCancel` does with it

Under the run lock, before anything else:

| Lease state | `flowCancel` |
|---|---|
| absent | proceed: no process holds an in-memory copy, disk is the only truth |
| present, owner `dead` (R4-3) | unlink the stale lease and proceed. The crashed driver's in-memory state died with it; disk is truth again |
| present, owner `alive`, **not us** | **refuse.** No mutation at all. `CANCELLATION_UNCONFIRMED{reason: "engine_dispatch_active", holderPid}` |
| present, owner `alive`, **us** | proceed, and mutate the **pinned** object (`this.activeRuns.get(runId).run`), not a fresh load: set `cancelRequested` and `status`, burn its tokens, append the event, persist once. The in-process brake (`engine.ts:1731`) and `stale()` (`:1802`) read that same object, so they see it immediately |
| present, owner `unknown` (EPERM, unreadable start time) | **refuse**, as for `alive`. Never break a lease we cannot disprove |

#### The v1 boundary this draws, stated plainly

- **Compose's consumer-dispatch team builds are never pinned** (`scheduleFanout` returns at
  `engine.ts:1524`), so they have no lease and cross-process cancel works for them with no
  caveats. That is the feature's first consumer and its whole motivating case.
- **A foreground engine-dispatch fanout can be cancelled only from the process driving it** —
  through the same `stratum_flow_cancel` tool on its own MCP server — **or after that process
  dies.** A second process is told `engine_dispatch_active` with the holder pid, which is
  actionable, rather than being allowed to interleave with a live driver.
- This is a real reduction in scope from rounds 2 and 3, which claimed the pinned case worked.
  It did not; it was three attempts at making a lost update unlikely. Recording the boundary is
  more useful than a fourth attempt.
- **STRAT-LOCK-SCOPE (§12) absorbs the general problem**: making a pinned run's in-memory object
  safe for a second writer is the same restructuring as moving the judged-ensure and
  evaluate-runner awaits out of the lock, and neither should be attempted piecemeal.
- **A pre-existing instance of the same hazard is out of scope and worth naming**: `stratum gate`
  builds a fresh engine over the state root from a second process and calls `gateResolve`
  (`ts/src/cli/query_gate.ts:316-317`). Against a pinned run that is a lost update today, on
  `main`, with no lease and no lock. This feature does not introduce it and does not fix it; the
  lease will refuse the *cancel* path only. Filed with STRAT-LOCK-SCOPE.

#### `persist` has two modes (R4-1)

A cancelled run's record is final, and the round-3 draft enforced that by making `persist` a
silent no-op — which would have swallowed a `usageReport` or a receipt update that genuinely
needed to fail loudly. Refusing is right; refusing silently is not:

```ts
  private persist(run: PersistedRun, sanctioned = false): Promise<void> {
    this.assertLockHeld(run.id);
    // R4-1: after a settle the durable record is final. The ONE sanctioned write is
    // terminalCancel's own; every other caller reaching here on a cancelled run is a bug or a
    // late path that must surface, not disappear.
    if (run.status === "cancelled" && !sanctioned) {
      throw Object.assign(new Error(`run ${run.id} is cancelled; no further writes are accepted`),
        { code: "PERSIST_ON_CANCELLED_RUN" });
    }
    ...
  }

  /** The single sanctioned save of a cancelled run: terminalCancel's own. */
  private persistTerminalCancel(run: PersistedRun): Promise<void> { return this.persist(run, true); }
```

The one caller that must **not** throw is the fanout item `finally` (`engine.ts:1917-1923`), which
runs on the abandon path by design. It checks the status itself and skips:

```ts
    } finally {
      if (run.cancelRequested === true) delete item.dispatchToken;
      if (item.worktree && run.workspaceRoot) { await this.teardownWorktree(...); delete item.worktree; }
      // R4-1/R4-4: the settle already wrote the final record — and on the same object, since the
      // lease guarantees this process performed it. Nothing to add.
      if (run.status !== "cancelled") await this.persist(run);
    }
```

Worktree teardown still runs: a cancelled run must not leak worktrees just because it may not
write.

**Every write to a run record happens inside a locked section — and three did not (R3-3).** The
round-2 draft asserted this without auditing it. The audit found three uncovered write paths, each
of which would have made the lock a partial guarantee, which is worse than none because it reads
as complete:

**(a) `plan()` — `engine.ts:445-446`.** The initial persist and the first `advance` run before any
lock is taken:

```ts
    await this.persist(run);
    return this.withRevisionDigest(await this.advance(run, effectiveValidation.value, effectiveValidation.contracts), run);
```

Both move inside `withRunLock(run.id, ...)`. The run id is minted at `:437` (`randomUUID()`), so
it is known before the persist; `acquireRunLock` `mkdir -p`s the state root, so the lock may
legitimately precede the run file's existence. The `advance` must be inside too, not just the
persist: it is what issues the first dispatch tokens.

**(b) The engine-fanout admission and reservation writes — `engine.ts:1803-1857`.** Everything from
`item.status = "running"` through the pre-dispatch persist at `:1857` mutates and persists the run
outside any lock: the worktree assignment (`:1806-1816`), the stage advance and token deletes
(`:1821-1824`), `recordFanoutAttempt` on a render failure (`:1839`), the ledger debit (`:1841`),
the terminal budget persist at `:1848`, the fresh `item.dispatchToken` (`:1850`), and the two
events plus the persist at `:1852-1857`.

The split, which is the same shape S01-9 applies to the acceptance side:

```
  ── locked ──   worktree setup, stage/when evaluation, render, debit, token mint,
                 fanout_ledger_debit + fanout_item_dispatched events, persist   (:1803-1857)
  ── UNLOCKED ── await this.connector(...)                                       (:1861)
  ── locked ──   settleFanoutAttempt, patch capture, status flip, token promotion,
                 the finally's teardown and persist                              (:1871-1923, S01-9)
```

The connector await is the only thing outside, and that is deliberate: it is the long one, and
holding the lock across it is what STRAT-LOCK-SCOPE (§12) exists to avoid elsewhere. Note the
locked prologue re-enters through `withRunLock` on every stage-attempt iteration of the retry loop
at `:1836`, not once for the whole loop — each attempt is its own short transaction, so a cancel
between attempts is seen at the next acquire.

**(c) `ts/src/cli/learn.ts:186-201` — the egress command builds its own private lock.** It
constructs a `Map`-of-promises `withRunLock` identical in shape to the engine's and calls
`store.save(run)` under it:

```ts
  const locks = new Map<string, Promise<unknown>>();
  const withRunLock = <T>(id: string, operation: () => Promise<T>): Promise<T> => { ... };
```

That map is local to one CLI invocation, so `stratum learn egress` mutating a run record excludes
nothing — not another `stratum learn`, and certainly not a running engine. It must take the real
lock. The smallest change is a `lockedSave(store, runId, mutate)` helper exported from
`run_lock.ts` that acquires, loads, applies, saves and releases; `learn.ts` drops its private map
and calls it, and its `withReceiptUpdate` becomes that helper. The engine's own
`withReceiptUpdate` (`engine.ts:383-391`) already runs under `withRunLock` and is unchanged.

With those three closed, all 38 `this.persist(` call sites (`grep -c 'this.persist(' src/engine/engine.ts`)
are reachable only from a locked section, and `store.save` has no caller outside one. S01-3 adds a
dev-mode assertion rather than leaving this as a comment, because it is the property the whole
design rests on — and because the assertion is what would have caught all three of these.

**The fourteen `withRunLock` sites**, with what each holds the lock across:

| # | `engine.ts` | Entry point | Holds across |
|---|---|---|---|
| 1 | `:387` | `withReceiptUpdate` | a caller-supplied update; short |
| 2 | `:464` | `plan` (bg arm) | validation, first advance |
| 3 | `:547` | `stepDoneOwned` → `stepDoneLocked` | **judged ensures and `evaluate:` — see below** |
| 4 | `:666` | `usageReport` | ledger arithmetic |
| 5 | `:731` | `commit` | `structuredClone` of the snapshot |
| 6 | `:753` | `revert` | clone + `reAdvanceLocked` |
| 7 | `:805` | `resume` | validation + advance |
| 8 | `:878` | `flowCancelBg` | one field + persist |
| 9 | `:889` | `gateResolve` → `gateResolveLocked` | reset closure + advance |
| 10 | `:1059` | `reAdvance` | advance |
| 11 | `:1136` | `driveBg` gate-quiescence probe | one read |
| 12 | `:1153` | `driveBg` terminal-failure path | one persist |
| 13 | `:1543` | `scheduleFanout` error handler | one `terminalFailure` |
| 14 | `:1747` | `settleFanout` | merge, `require`, advance |

**Correction to the ruling's premise (R2-1a).** The ruling asks this section to confirm that no
locked section awaits a connector. **It cannot be confirmed — two do**, and an implementer told
otherwise will pick a lock timeout that breaks in production:

- `stepDoneLocked` → `settleStepAttempt` → `runEnsures` (`engine.ts:2099`) → `this.judge(...)`
  (`:2111`). A judged ensure is an LLM call.
- `advanceScopeLoop`'s `evaluate:` arm → `this.evaluateRunner(...)` (`engine.ts:1436`).

Both are reachable from sites 3, 6, 7, 9, 10 and 14. The fanout driver's own connector await
(`:1861`) **is** outside the lock, as the ruling says, and `driveBg`'s connector await (`:1092`)
is too — so the claim holds for the connector proper and fails for the judge and the evaluate
runner.

**RULING (controller, on R2-1a): keep the design, change the numbers, file the follow-up.**
Three consequences, all binding:

1. **`STRATUM_RUN_LOCK_TIMEOUT_MS` defaults to 300000**, not the 30000 the round-2 ruling
   sketched. A judged ensure routinely outlives thirty seconds, and the waiter would throw
   `RUN_LOCK_TIMEOUT` against a perfectly healthy holder. Staleness is decided by process
   identity, not by age, so a long hold is never mistaken for a dead one and this timeout is a
   backstop against a wedge, not a liveness check.
2. **The cancel path has its own lock-wait budget, and it is a different number from its
   teardown deadline.** Collapsing the two was the round-2 draft's error: they measure different
   things and the earlier text used 15000 for both.

   | Constant | Default | Measures |
   |---|---|---|
   | `STRATUM_CANCEL_LOCK_WAIT_MS` | 120000 | how long `flowCancel` waits to **acquire** the run lock, before anything is settled |
   | `STRATUM_CANCEL_TIMEOUT_MS` | 15000 | the 0.4.0 acknowledgement budget for agent teardown, whose clock starts **only after** settlement |

   Two minutes is long enough to sit behind a judged ensure and short enough that
   `compose build --abort` does not appear to hang forever. On expiry `flowCancel` **mutates
   nothing** and raises `CANCELLATION_UNCONFIRMED` with `reason: "run_lock_held"` and the holder
   pid read from the lock file — a caller can then see *which* process is holding the run, rather
   than a bare timeout.
3. **The underlying problem is filed, not fixed here.** Moving those two awaits out of the locked
   section is `STRAT-LOCK-SCOPE` (§12). It is a pre-existing condition: both already block every
   other locked operation on that run in-process today, on `main`, before this feature. This
   feature makes the blocking visible across processes; it does not create it.

Making the cancel jump the queue was rejected: settle-first (D4) is only meaningful if the settle
is serialised against the transaction that could otherwise accept a result.

### 2.2 `FlowCancelResult` — `ts/src/engine/engine.ts` (new exported interface)

Placed beside `BgFlowPollResponse` (`engine.ts:241-243`).

```ts
/** The engine half of a foreground cancel.
 *
 *  `flowSettled` is true when the run is durably `cancelled` — either because THIS call moved
 *  it there, or because it already was. It is the flow-side fact, and it is deliberately
 *  separate from the caller-facing `acknowledged` (R1-5), which additionally requires every
 *  agent claimed for the flow to be reaped or durably settled and is computed by `cancelFlow`
 *  (§5), not here.
 *
 *  `status` is the run's REAL status: `cancelled` after a settle, or the pre-existing terminal
 *  status when the cancel arrived too late. `reason` carries `already_<status>` in that case. */
export interface FlowCancelResult {
  runId: string;
  status: RunStatus;
  flowSettled: boolean;
  /** True only when this call performed the settle. Distinct from the response-level
   *  `acknowledged` of §2.6. */
  settledByThisCall: boolean;
  reason?: string;
  ledger: LedgerInfo;
}
```

### 2.3 The `flow_cancelled` event

Union member added to `AuditEvent["type"]` (`ts/src/engine/state.ts:196-201`), appended after
`"carry_updated"`. The union today reads:

```ts
  type: "planned" | "ready" | "result" | "judged" | "routed" | "skipped" | "resumed" | "completed" | "failed" | "budget_exhausted"
    | "gate_waiting" | "gate_resolved" | "fanout_item_ready" | "fanout_item_dispatched" | "fanout_attempt_result"
    | "fanout_item_skipped" | "fanout_ledger_debit" | "fanout_merge"
    | "usage_debit" | "step_reset" | "checkpoint_reverted" | "carry_updated";
```

Detail shape:

```ts
{ by: "fg"; reason?: string; burned: { steps: string[]; items: number } }
```

`burned` records what the settle invalidated: the ids of steps whose `dispatchToken`/`gateToken`
was deleted, and the count of consumer/engine fanout items whose `dispatchToken` was deleted. It
is the audit evidence for invariant 3 of §8 — without it, "the settle burned the outstanding
issuances" is a claim only a test can check, never a reader of the trail. No `stepId` is set: a
cancel is run-scoped, and `this.event` (`engine.ts:3010`) already omits an absent `stepId`.

`ts/contracts/events.json` — `"events": 3` (`events.json:2`) becomes `4`, and a kind is appended
after `carry_updated` (`events.json:97-112`):

```json
    "flow_cancelled": {
      "detail": {
        "by": "string",
        "reason?": "string",
        "burned": {
          "steps": { "$array": "string" },
          "items": "number"
        }
      }
    }
```

Event validation is default-deny at the MCP boundary — `assertEvent` runs over every event
returned by `stratum_audit` / `stratum_flow_poll` / `stratum_flow_bg_poll` (`server.ts:294-295`)
— so an undeclared key fails the tool call, not just a test.

### 2.4 The foreground agent registry — `ts/src/connectors/foreground_registry.ts` (new)

Root, deliberately a sibling of the background one (C8):

```ts
export function agentForegroundRoot(): string {
  return join(homedir(), ".stratum", "ts", "agent_fg");
}
```

`~/.stratum/ts/agent_fg/<12hex>/meta.json`, mode `0600` inside a `0700` directory:

```ts
export interface ForegroundGroup {
  childPid: number;
  /** REQUIRED for a kill: processIdentityMatches returns false without it
   *  (ts/src/connectors/proc_identity.ts:80-83), so a group recorded without one is
   *  reported as unreachable rather than signalled. */
  procStartTime?: string;
}

```ts
/** R1-3. The three-state lifecycle exists to close the start-after-cancel window: an agent
 *  whose spawn is in flight when the cancel sweeps has no pid yet, so a registry that only
 *  appeared at spawn time would let it escape and keep running against a cancelled flow.
 *
 *  `starting` — the record exists, the spawn has not happened. Written SYNCHRONOUSLY, before
 *    the first await, mirroring why the foreground map is registered before contract I/O
 *    (ts/src/mcp/server.ts:117-119). A canceller that sees `starting` knows an agent is
 *    coming and must keep watching rather than declaring the flow quiet.
 *  `running` — `onSpawn` has stamped at least one group. Killable.
 *  `settled` — the dispatcher's finally ran. Never signalled again. */
export type ForegroundRunState = "starting" | "running" | "settled";

export interface ForegroundRunMeta {
  runId: string;
  foreground: true;
  state: ForegroundRunState;
  agent: "claude" | "codex";
  cancellationId: string;
  /** The MCP server process that owns the in-memory AbortController. Lets a reader tell
   *  "the server is gone" from "the agent is gone". */
  serverPid: number;
  /** REQUIRED for the dead-owner exception (R3-6). Without it `processIdentityMatches` cannot
   *  distinguish a departed server from a recycled pid, and the sweep would stamp a live
   *  dispatcher's entry `settled` — acknowledging a teardown still in progress. */
  serverProcStartTime?: string;
  flow: { runId: string; stepId?: string; itemIndex?: number };
  cwd: string;
  model?: string;
  createdAt: string;
  /** One entry per cancellable spawn. Claude's SDK spawner may be invoked more than once
   *  (ts/src/connectors/claude.ts:57, :93), so this is an array (C9). Empty while `starting`. */
  groups: ForegroundGroup[];
  /** Stamped with `state: "settled"`. A settled entry is never signalled. */
  settledAt?: string;
}
```

The kill acknowledgement:

```ts
export interface AgentCancelSummary {
  /** Groups that received SIGTERM. */
  signalled: number;
  /** Groups confirmed gone (ESRCH on the group probe) before the deadline. */
  reaped: number;
  /** Identity mismatch, no recorded procStartTime, not a group leader, or EPERM on the probe.
   *  NOT killed, and — on a still-unsettled entry — NOT acknowledgeable either (R1-5). */
  unreachable: number;
  /** Entries whose state is already `settled`. */
  alreadySettled: number;
  /** Entries still `starting` (no pid) at the deadline. A nonzero value is
   *  CANCELLATION_UNCONFIRMED: an agent may be spawning right now and we cannot say it is
   *  gone. */
  unresolved: number;
  /** Every matching entry that is NOT durably `settled` at the deadline, whatever the state of
   *  its groups (R3-6). A `running` entry whose groups are all reaped still counts here while
   *  its owning dispatcher is unwinding — reaping the children is not the same as the run
   *  having finished, and acknowledging on the weaker fact is how a caller re-dispatches into a
   *  half-torn-down agent. */
  unsettled: number;
}
```

**The pre-spawn and post-stamp admission checks (R1-3, R2-8).** The registry alone cannot stop an
agent that starts *after* the sweep read the directory. Two checks close it, both in the server
(S02-4), and both read the **run record** under a short run lock — there is no sidecar (R2-1):

1. **Before spawn**, immediately after writing the `starting` entry, the server calls
   `engine.admitFlowAgent(flow.runId)`. It throws ⇒ stamp `settled`, do not dispatch, fail the
   call with that error's code (R3-7).
2. **Immediately after each pid stamp**, the same call. It throws ⇒ terminate and reap that
   group, stamp `settled`, fail the call.

Between them the window is closed in both directions: an agent that starts before the cancel is
found by the sweep because its `starting` entry is already on disk; an agent that starts after is
refused by its own check. Neither check is best-effort — a failure to write the
`starting` entry, or to stamp the pid, kills and reaps the child and fails the call (S02-4). A
swallowed registry error is precisely an uncancellable orphan, which is the failure
`ts/src/connectors/background.ts:191-196` already refuses to accept on the background path.

**The canceller rescans.** `reapFlowAgents` does not read the directory once. It loops until
every matching entry is `settled` or its groups are reaped, or the deadline expires — because an
entry can transition `starting → running` while the sweep is in progress. `unresolved` counts
what is left.

### 2.5 `stratum_agent_run.request.flow?`

`ts/contracts/mcp-surface.json:922-940`, appended after `"cancellationId?": "string"`:

```json
        "cancellationId?": "string",
        "flow?": {
          "runId": "string",
          "stepId?": "string",
          "itemIndex?": "number"
        }
```

`flow` is legal **only** together with `cancellationId` — without a process group there is
nothing to kill, and `ownProcessGroup` is claimed only for a cancellable run
(`server.ts:212`). Violating that is an `input_validation_failed` error (S02-5).

`schemaForValidated` (`server.ts:469-491`) turns the nested shape into a JSON-Schema object
property named `flow`, so compose's `#agentFields` guard
(`/Users/ruze/reg/my/forge/compose/lib/stratum-mcp-client.js:279-291`) sees it in `listTools`
and stops throwing `UNSUPPORTED_AGENT_OPTIONS` once the new server is installed. That is the
intended tripwire, not a regression.

### 2.6 `stratum_flow_cancel`

Placed in `ts/contracts/mcp-surface.json` immediately after `stratum_flow_cancel_bg`
(`:909-920`), whose existing block is:

```json
    "stratum_flow_cancel_bg": {
      "request": {
        "runId": "string"
      },
      "responses": {
        "running": {},
        "completed": {},
        "failed": {},
        "budget_exhausted": {},
        "cancelled": {}
      }
    },
```

The new block. The four variants carry the **identical** shape — the same repetition
`stratum_flow_poll` (`:770-820`) already uses, because variant selection is by
`response.status` (`ts/src/mcp/contracts.ts:147-151`) and a missing variant throws:

```json
    "stratum_flow_cancel": {
      "request": {
        "runId": "string"
      },
      "responses": {
        "cancelled": {
          "runId": "string",
          "flowSettled": "boolean",
          "acknowledged": "boolean",
          "reason?": "string",
          "ledger": {
            "spent": "object",
            "budget?": "object"
          },
          "agents": {
            "signalled": "number",
            "reaped": "number",
            "unreachable": "number",
            "alreadySettled": "number",
            "unresolved": "number",
            "unsettled": "number"
          }
        },
        "completed": { "…identical…": "" },
        "failed": { "…identical…": "" },
        "budget_exhausted": { "…identical…": "" }
      }
    },
```

(The three `"…identical…"` placeholders are prose, not JSON: the implementer repeats the
`cancelled` shape verbatim in each. There is no `running` variant — a cancel either settles the
run or finds it already terminal.)

**`flowSettled` and `acknowledged` are two different facts (R1-5).** 0.4.0's contract
(`CHANGELOG.md:146-159`) is that an acknowledgement waits for the whole group to be reaped, and
returns `CANCELLATION_TEARDOWN_TIMEOUT` rather than acknowledging a live group. Applied here:

- `flowSettled` — the run is durably `cancelled`. Purely the flow-side fact.
- `acknowledged` — `flowSettled` **and** every registry entry claimed for this flow is reaped
  (its group probe says gone) or durably `settled`. Nothing else may set it.

**Three outcomes, not two (R2-4).** The round-1 draft raised a cancellation error whenever
`acknowledged` was false, which swept in the case where the run had simply finished on its own:

| The run was | Agent teardown | Result |
|---|---|---|
| `running` | full sweep | settle, then acknowledge — or raise, per the codes below |
| `completed` / `failed` / `budget_exhausted` | **none** | success, `flowSettled: false`, `acknowledged: false`, `reason: "already_<status>"`. A terminal run has no agents of ours to reap; raising `CANCELLATION_UNCONFIRMED` here would report a teardown that was never attempted |
| `cancelled` | **full sweep again** | success with `acknowledged: true` only when the sweep confirms every entry reaped or settled; otherwise the codes below. This is the recovery path from an earlier `CANCELLATION_TEARDOWN_TIMEOUT`: retrying the cancel is how a caller re-checks a group it was told about, so the second call must actually look |

For a genuinely unresolved teardown an **error** is right, not a quiet caveat, because a consumer
that reads `acknowledged: false` as "mostly fine" is exactly the consumer that will re-dispatch
work into a live agent. Two error codes, both already in compose's vocabulary
(`/Users/ruze/reg/my/forge/compose/lib/build.js:962`, `:5849`):

| Condition | Code |
|---|---|
| A signalled group is still alive at the deadline, or an entry is still `starting` with no pid | `CANCELLATION_TEARDOWN_TIMEOUT` |
| An unsettled entry is unreachable — identity mismatch, missing `procStartTime`, not a group leader, or EPERM on the probe | `CANCELLATION_UNCONFIRMED` |
| `flowCancel` could not take the run lock within `STRATUM_CANCEL_LOCK_WAIT_MS` (120000, §2.1b) | `CANCELLATION_UNCONFIRMED` with `reason: "run_lock_held"` and `holderPid` — the flow was not settled, `flowSettled: false` says so, and nothing was mutated |

The `acknowledged: true` field remains on the wire because a consumer must be able to read the
guarantee positively rather than infer it from the absence of an error.

New error envelope, appended to the `errors` object of `mcp-surface.json`, shared by both codes:

```json
    "flow_cancel_unacknowledged": {
      "data": {
        "code": "string",
        "runId": "string",
        "status": "string",
        "flowSettled": "boolean",
        "reason?": "string",
        "holderPid?": "number",
        "agents": {
          "signalled": "number",
          "reaped": "number",
          "unreachable": "number",
          "alreadySettled": "number",
          "unresolved": "number",
          "unsettled": "number"
        }
      }
    }
```

`code` is `CANCELLATION_TEARDOWN_TIMEOUT` or `CANCELLATION_UNCONFIRMED`. **`status` is the
engine's actual status, read back after the settle attempt — never a hardcoded `"cancelled"`
(R1-5).** A cancel that raced a completion, or one whose settle itself failed, must not claim a
terminal state it does not have; `flowSettled` says separately whether the flow half succeeded.
`agents` is the partial summary, so a consumer can tell "one group survived" from "we never even
found the agent".

### 2.7 Status-enum extension (D2)

**Seven** tools gain a `cancelled` variant, not eight (R1-6, and the round-2 draft's prose still
said eight — R3-9). Copying each tool's `budget_exhausted` shape verbatim is wrong for several of
them, because the `cancelled` arm of `response()` (S01-6) produces a **different** object: no
`failure`. And `revisionDigest` is present on exactly two of the seven, not four. Each shape below
is exactly what the code emits.

| Tool | `budget_exhausted` block at | `cancelled` shape |
|---|---|---|
| `stratum_plan` | `ts/contracts/mcp-surface.json:195` | `{"runId":"string","revisionDigest":"string","ledger":{"spent":"object","budget?":"object"}}` — no `failure`, no `output`, but **the digest is present** (R2-9): `plan` returns a `RevisionedEngineResponse` (`engine.ts:220`) and its `budget_exhausted` neighbour declares it |
| `stratum_resume` | `:606` | as `stratum_plan` — `resume` also returns a `RevisionedEngineResponse` |
| `stratum_step_done` | `:314` | as `stratum_plan` **without `revisionDigest`** (R3-9). `stepDone` returns a plain `EngineResponse`, and `ts/tests/mcp/p5.test.ts:334` pins `expect(retry.revisionDigest).toBeUndefined()`. Declaring it required would fail every cancelled step-done response |
| `stratum_gate_resolve` | `:756` | as `stratum_step_done`, no digest — pinned by `ts/tests/mcp/p5.test.ts:383`, `expect(revised.revisionDigest).toBeUndefined()` |
| `stratum_audit` | `:649` | copy of its `budget_exhausted` shape verbatim (`runId`, `events`, `steps`, `flowSpent`, `output?`, `carry?`) — `auditResponse` (`server.ts:424-426`) whitelists the same fields for every status |
| `stratum_flow_poll` | `:808` | copy of its `budget_exhausted` shape verbatim — `flowPollResponse` (`server.ts:428`) spreads the whole response, and `failure?`/`output?` are already optional, so a cancelled run simply omits both |
| `stratum_flow_bg_poll` | `:890` | copy of its `budget_exhausted` shape verbatim, same reasoning, plus the `bg` block it already declares |

Worked example — `stratum_plan`'s new variant. It differs from its neighbour by exactly one
field, and **keeps** `revisionDigest` (R2-9): the implementer copies the block and deletes
`failure`, rather than writing a minimal shape from scratch.

```json
        "budget_exhausted": {
          "runId": "string",
          "revisionDigest": "string",
          "failure": "object",
          "ledger": {
            "spent": "object",
            "budget?": "object"
          }
        },
        "cancelled": {
          "runId": "string",
          "revisionDigest": "string",
          "ledger": {
            "spent": "object",
            "budget?": "object"
          }
        }
```

Matching is complete-strict default-deny (`ts/src/mcp/contracts.ts:121-123`), so a declared-but-
absent required `failure` fails every cancelled response and a `revisionDigest` declared on a tool
that does not emit one fails it the other way — which is what R3-9 caught, and which
`ts/tests/mcp/p5.test.ts:334` and `:383` already assert about the non-cancelled variants. **Read
each tool's existing `budget_exhausted` block in the file, and check whether that tool's engine
method returns `RevisionedEngineResponse`, before writing its `cancelled` twin.** The shapes above
are the shape of the emitted object, not a promise about what is already declared.

**`stratum_revert` gets no `cancelled` variant.** After S01-8 a revert on a cancelled run throws
`CheckpointOperationError`, which `server.ts:311-315` turns into the declared `error` envelope.
`revert` can therefore never *return* a cancelled status, and declaring one would advertise a
response the code cannot produce. Its `RevertResponse` also carries `reverted_to`
(`engine.ts:287`), which a cancelled arm would have to fabricate.

`stratum_flow_run_bg` declares only `running` and is not touched. `stratum_commit` declares
`committed`/`error` and is not touched.

### 2.8 CLI surface

```
stratum flow cancel <flow_id>
```

Output envelope, matching `gateCommand`'s `_schema_version: "1"` convention
(`ts/src/cli/query_gate.ts:322`):

```json
{"_schema_version":"1","ok":true,"flow_id":"<id>","status":"cancelled","flowSettled":true,
 "acknowledged":true,
 "agents":{"signalled":1,"reaped":1,"unreachable":0,"alreadySettled":0,"unresolved":0,"unsettled":0}}
```

**Exit codes (R1-8).** The rule is one line: *the exit code says what the caller must do next.*

| Outcome | Exit | Envelope |
|---|---|---|
| Cancelled and acknowledged | `0` | `ok: true` as above |
| Already `completed` / `failed` / `budget_exhausted` | `0` | `ok: true`, `flowSettled: false`, `acknowledged: false`, `detail: "already_<status>"`. **Not a conflict and not an error** (R2-4): the caller asked for the flow to be stopped and the flow is stopped, and no teardown was attempted so no cancellation code applies |
| Already `cancelled` | `0` when the re-run teardown confirms, else `1` | `ok: true`, `flowSettled: true`, `detail: "already_cancelled"`, `acknowledged: true` — but only after the agent sweep runs **again** and confirms (R2-4). This is how a caller recovers from an earlier teardown timeout |
| Unknown flow id | `2` | `conflict: true`, `detail: "flow_not_found"`. This is `gateCommand`'s `notFound` shape (`query_gate.ts:153-156`), and it must be reached by an explicit ENOENT check, **not** by the catch-all, which today would return 1 |
| Teardown timeout or unconfirmed | `1` | `ok: false`, `error: "CANCELLATION_TEARDOWN_TIMEOUT"` or `"CANCELLATION_UNCONFIRMED"`, plus `status`, `flowSettled` and the partial `agents` summary. The structured envelope is printed, not just a message: the caller needs to know the flow **is** settled even though an agent was not confirmed dead |
| Any other error | `1` | `ok: false`, `error: "INVALID"`, `message` |

Compose's mutation client maps exit 2 to `{conflict: true}`
(`/Users/ruze/reg/my/forge/compose/server/stratum-client.js:24-33`), which is why the
already-terminal case must not use it.

---

## 3. Slice S01 — Engine: the run lock, the settle, `cancelled` status, refusals, event

S01 touches no connector and no MCP file. Its whole surface is the engine, one new engine module,
and `ts/contracts/events.json`.

### S01-1 `ts/src/engine/state.ts` (edit) — `RunStatus`, `AuditEvent`, `burnIssuances`

Four edits: the `RunStatus` union at `:8` (§2.1), the `AuditEvent` union at `:196-201` (§2.3),
the exported `burnIssuances` of S01-4, and **an exported `assertRunId` (R4-7)**. The validation
today is inlined in `StateStore.path` (`state.ts:296-299`):

```ts
    if (!/^[a-zA-Z0-9-]+$/.test(runId)) throw new Error("invalid run id");
```

Three new path-building call sites now exist outside that method — the run lock, the break-lock
and the driver lease — and a fourth copy of the regex is how one of them ends up admitting a
separator. It becomes one exported function, called by `path` and by every lock and lease
operation before any path is constructed:

```ts
const RUN_ID_PATTERN = /^[a-zA-Z0-9-]+$/;
export function assertRunId(runId: string): void {
  if (!RUN_ID_PATTERN.test(runId)) throw new Error("invalid run id");
}
```

The pattern already rejects `/`, `\\`, `.` and the empty string, so `..`, `a/b` and
`/etc/passwd` all fail; the point of the export is that they keep failing on the new paths. **`StateStore` is not modified** — the round-1
`writeCancelMark` / `readCancelMark` / `clearCancelMark` / `applyCancelBarrier` are all gone
(R2-1). `PersistedRun` is not touched (C16), so `ts/src/engine/checkpoint.ts` and
`ts/tests/engine/flowctl.test.ts` need no edit.

### S01-2 `ts/src/engine/run_lock.ts` (new)

§2.1a verbatim: `acquireRunLock`, its `readLock` helper, and the `RUN_LOCK_TIMEOUT` error code.
Pure and engine-agnostic — it takes a state root and a run id, and knows nothing about
`PersistedRun`.

### S01-3 `ts/src/engine/engine.ts` (edit) — `withRunLock`, the driver lease, `persist` modes

§2.1b verbatim. Plus the assertion that gives §2.1b's central claim teeth rather than leaving it
as a comment:

```ts
  /** Every persist happens inside a locked section (§2.1b). A persist outside one is a
   *  cross-process last-writer-wins bug that no test would otherwise catch, because it is
   *  correct in a single-process suite. Dev-mode only: the check costs a Map lookup. */
  private assertLockHeld(runId: string): void {
    if (process.env.NODE_ENV === "production") return;
    if (!this.heldLocks.has(runId)) throw new Error(`persist for run ${runId} outside a run lock`);
  }
```

`heldLocks` is a `Set<string>` added and removed by `withRunLock` around the action; `persist`
(`engine.ts:3013`) calls `assertLockHeld(run.id)` on its first line, then its R4-1 mode check.

Also in this slice: `retainRun` (`engine.ts:359-363`) writes the driver lease when refs go 0 → 1,
`releaseRun` (`:365-370`) unlinks it token-checked when they return to 0, and
`claimDriverLease(runId)` implements the five-row table of §2.1b.

`loadRun` (`engine.ts:353-357`) is **unchanged** — the round-0 sidecar probe is deleted (R2-1),
and the pinned-object staleness it was working around is not reconciled at all now: the lease
makes the pinned run single-writer instead (R4-4).

### S01-4 `ts/src/engine/state.ts` (new exported function) — `burnIssuances`

A module-level export in `state.ts`, placed after `CheckpointEntry` (`state.ts:213-216`) and
before `PersistedRun` (`:219`), imported by the engine alongside the types it already takes from
`state.js` (`engine.ts:20`). It stays in `state.ts` rather than moving back into the engine
because the item-settle path (S01-9) and `terminalCancel` (S01-5) both need it and neither should
own it. This is `engine.ts:1918`'s `delete item.dispatchToken` generalised over the whole run
(D3):

```ts
/** Burn every outstanding issuance at the cancel. `cancelRequested` is a CHECKPOINT_FIELD
 *  (ts/src/engine/checkpoint.ts:13), so a later revert could restore `cancelRequested: false`;
 *  a burned token is the durable half of the guarantee, because the fencing at engine.ts:1662
 *  and the gate-token check at :924 reject a stale issuance regardless of the flag. Pure and
 *  synchronous. */
export function burnIssuances(run: PersistedRun): { steps: string[]; items: number } {
  const steps: string[] = [];
  let items = 0;
  const walk = (states: Record<string, StepState>): void => {
    for (const [id, state] of Object.entries(states)) {
      if ((state.status === "ready" || state.status === "running") && state.dispatchToken !== undefined) {
        delete state.dispatchToken;
        steps.push(id);
      }
      if (state.status === "waiting_gate" && state.gateToken !== undefined) {
        delete state.gateToken;
        steps.push(id);
      }
      for (const item of state.fanout?.items ?? []) {
        if ((item.status === "ready" || item.status === "running") && item.dispatchToken !== undefined) {
          delete item.dispatchToken;
          items += 1;
        }
      }
      if (state.sub) walk(state.sub.steps);
    }
  };
  walk(run.steps);
  return { steps, items };
}
```

The subflow recursion mirrors `backfillIssuanceTokens` (`engine.ts:2853-2861`) and
`rotateRestoredIssuances` (`:2867-2890`); copy their `walk` shape so the three stay comparable.

### S01-5 `ts/src/engine/engine.ts` (new private) — `terminalCancel`

Placed beside the other two settle functions. Existing `terminalFailure` at `engine.ts:2942-2948`:

```ts
  private async terminalFailure(run: PersistedRun, failure: FailureContext): Promise<EngineResponse> {
    run.status = "failed";
    run.failure = failure;
    this.event(run, "failed", undefined, failure);
    await this.persist(run);
    this.emitFlowTerminal(run);
    return this.response(run);
  }
```

The new one, same shape. It assumes the run lock is held — every caller is inside a locked
section:

```ts
  /** D3. `failure` stays UNSET: the status is honest, so inventing a FailureContext would put
   *  a lie in the audit trail (and requiredFailure at :3133 would invent a worse one).
   *  Not subject to assertNoForegroundFanout (:2894) — cancel exists precisely to break the
   *  stuck consumer-fanout lifecycle that guard protects — nor to assertExternalMutationAllowed
   *  (:2819): a bg-driven run is cancellable from outside. */
  private async terminalCancel(run: PersistedRun, reason?: string): Promise<EngineResponse> {
    run.cancelRequested = true;
    const burned = burnIssuances(run);
    run.status = "cancelled";
    this.event(run, "flow_cancelled", undefined, { by: "fg", ...(reason !== undefined ? { reason } : {}), burned });
    // R4-1: the ONE sanctioned write of a cancelled record. Every other persist on a cancelled
    // run throws PERSIST_ON_CANCELLED_RUN.
    await this.persistTerminalCancel(run);
    this.emitFlowTerminal(run);
    // A bg run cancelled through the fg surface must report consistently to flowBgPoll — but
    // only in THIS process; another engine's bgFlows map is reached by driveBg's own check
    // (S01-10, R2-11), not from here.
    const bg = this.bgFlows.get(run.id);
    if (bg) { bg.cancelRequested = true; bg.status = "cancelled"; bg.pendingGates = []; }
    return this.response(run);
  }
```

`emitFlowTerminal` (`:2969-2977`) passes `outcome: run.status` into `buildFlowTerminalEvent`,
whose `outcome` is typed `string` (`ts/src/policy/events.ts:62`) — no change needed there.

### S01-6 `ts/src/engine/engine.ts` (edit) — `response()`

Existing code at `engine.ts:2992-2997`:

```ts
  private response(run: PersistedRun): EngineResponse {
    const ledger = this.ledgerInfo(run);
    if (run.status === "completed") return { status: "completed", runId: run.id, output: run.output, ledger };
    if (run.status === "budget_exhausted") return { status: "budget_exhausted", runId: run.id, failure: requiredFailure(run), ledger };
    return { status: "failed", runId: run.id, failure: requiredFailure(run), ledger };
  }
```

One line inserted before the fallthrough (C15):

```ts
    if (run.status === "cancelled") return { status: "cancelled", runId: run.id, ledger };
```

**`advance` (`engine.ts:1226`) is NOT changed.** The round-0 draft turned its
`{status: "running"}` early return into a settle, to heal a cancel that a stale writer had
clobbered. Under the lock there is no such clobber — `flowCancel` settles inside the same mutual
exclusion every other writer passes through — so the early return keeps its existing meaning, and
background cancel keeps its abandon-don't-settle behaviour with no discriminator needed (D5).
That deletes C7 along with the sidecar it depended on.

### S01-7 `ts/src/engine/engine.ts` (edit) — `resumeLocked` refuses (D5)

Existing code at `engine.ts:812-815`:

```ts
  private async resumeLocked(runId: string): Promise<EngineResponse> {
    const run = await this.loadRun(runId);
    const computedDigest = digest(run.spec);
```

gains one guard immediately after the load, **before** the digest check and long before
`this.event(run, "resumed")` at `:819` and the `scheduleFanout` re-arm at `:826`:

```ts
  private async resumeLocked(runId: string): Promise<EngineResponse> {
    const run = await this.loadRun(runId);
    // D5. The lock entry already refreshed a pinned run's cancel bits (§2.1b), so this test
    // sees a cancel performed by any process. Without it, a marked run re-emits `resumed`,
    // re-arms every in-flight fanout at :826, and lands in advance's limbo. The bg guard
    // (assertExternalMutationAllowed, :2819) cannot cover it: a foreground run has no bgFlows
    // entry.
    if (run.cancelRequested === true || run.status === "cancelled") {
      throw new Error(`run ${runId} is cancelled; resume is not permitted`);
    }
    const computedDigest = digest(run.spec);
```

### S01-8 `ts/src/engine/engine.ts` (edit) — `commit` and `revert` refuse (D5, R2-10)

**The order matters, and round 3 had it wrong (R4-6).** `commit` and `revert` both call
`assertExternalMutationAllowed` (`engine.ts:729`, `:751`) **before** taking the lock, and that
guard consults `bgFlows` (`engine.ts:2819-2825`), whose terminal allowlist is
`completed | failed | budget_exhausted`. `"cancelled"` is not in it, so a cancelled **bg** run
throws `is background-driven` — a confusing and wrong reason — while a cancelled **foreground**
run has no `bgFlows` entry and sails through. Two different errors for one condition, neither of
them the truth.

The cancelled check therefore runs **inside** the lock, and it is the first thing that can report
on a cancelled run; `assertExternalMutationAllowed` is left alone. One guard each, immediately
after the load and before `assertNoForegroundFanout`:

```ts
      const run = await this.loadCheckpointRun(runId);
      // D5/R2-10: a cancelled run is terminal. `cancelRequested` is a CHECKPOINT_FIELD
      // (checkpoint.ts:13), so a revert could otherwise restore `cancelRequested: false` and
      // resurrect a run whose agents have already been killed; and a commit would snapshot a
      // half-torn-down run as if it were a recovery point. The status check runs first and is
      // what makes the burned tokens of S01-4 a durable guarantee.
      if (run.status === "cancelled" || run.cancelRequested === true) {
        throw new CheckpointOperationError("flow_cancelled", `Flow '${runId}' is cancelled; ${operation} is not permitted`);
      }
      this.assertNoForegroundFanout(run, "revert");
```

Round 0 refused only `revert` and argued `commit` should stay open because snapshotting a
terminal run is the documented recovery case (`engine.ts:2827-2831`). R2-10 overrides that for
`cancelled` specifically: the recovery case is a run that failed on its own, whose state is
coherent. A cancelled run's state is mid-teardown by construction — issuances burned, agents
being killed — so a checkpoint of it is a trap, not a recovery point.

**`flow_cancelled` is not a legal `errorType` today (R1-7).** `CheckpointOperationError`
(`engine.ts:289-299`) declares a closed union:

```ts
export class CheckpointOperationError extends Error {
  readonly errorType: "flow_not_found" | "invalid_label" | "checkpoint_not_found";
```

which becomes

```ts
  readonly errorType: "flow_not_found" | "invalid_label" | "checkpoint_not_found" | "flow_cancelled";
```

Without that the new throw does not compile. The envelope shape is unchanged —
`checkpointErrorEnvelope` (`server.ts:451-459`) emits `error_type` as a plain string and
`mcp-surface.json` declares it as `"string"` — so no contract edit follows, but the MCP tests must
pin the value or the new arms are untested (T-S01-7b).

### S01-9 `ts/src/engine/engine.ts` (edit) — the fanout item settle takes the lock (R2-2)

**The gap this closes.** `executeFanoutItem` awaits its connector *outside* the run lock — which
is correct, and is why the engine can serve other calls during a long dispatch. But everything
after that await also ran outside the lock, and that stretch accepts the result: it captures a
git patch (`engine.ts:1901-1911`), sets `item.output`, flips `item.status = "succeeded"`, and
promotes `dispatchToken` to `acceptedDispatchToken` (`:1912-1916`). A cancel landing during the
connector await would be visible to `stale()` (`:1802`) only at the *next* await boundary, so a
result could be durably accepted after the flow was cancelled.

The existing region, `engine.ts:1861-1923`:

```ts
            result = await this.connector({ ... });          // :1861  OUTSIDE the lock, by design
          }
          catch (error) {
            if (stale()) return;
            ...
          }
          if (stale()) return;                                // :1871
          const outcome = await this.settleFanoutAttempt(...); // :1873
          if (stale()) return;
          ...
      if (item.worktree) {
        await execFileAsync("git", ["-C", item.worktree, "add", "-N", "."]);   // :1905
        const patch = (await execFileAsync("git", [...])).stdout;              // :1910
        if (patch) item.patch = patch;
      }
      item.output = previous;                                 // :1912
      item.status = "succeeded";
      if (item.dispatchToken !== undefined) item.acceptedDispatchToken = item.dispatchToken;
      delete item.dispatchToken;
    } finally {
      if (run.cancelRequested === true) delete item.dispatchToken;             // :1918
      ...
      await this.persist(run);                                                 // :1923
    }
```

The acceptance stretch — from the connector's return through `settleFanoutAttempt`, the patch
capture, the status flip and the `finally`'s persist — moves inside one `withRunLock`, which
refreshes the pinned object on entry:

The existing catch arm at `engine.ts:1868-1870` **mutates** before the lock is taken:

```ts
          catch (error) {
            if (stale()) return;
            lastFailure = { attempt, reason: message(error) }; this.recordFanoutAttempt(run, step, item, stageIndex, attempt, false, "connector", lastFailure); continue;
          }
```

`recordFanoutAttempt` pushes onto `item.attempts`, so a rejected connector records an attempt
against a run that may already be cancelled — the same defect as the success path, in the arm
nobody looks at (R4-5). Both outcomes are therefore **captured without mutation** and processed
inside one locked transaction:

```ts
          // R4-5: capture, do not act. Neither arm touches the run.
          let outcome: { ok: true; result: StepResult } | { ok: false; error: unknown };
          try { outcome = { ok: true, result: await this.connector({ ... }) }; }
          catch (error) { outcome = { ok: false, error }; }

          // R2-2: everything that ACCEPTS or RECORDS this attempt runs under the run lock.
          // A cancel that landed during the connector await is seen HERE, at the one point
          // where its answer becomes durable — not at some later boundary.
          const disposition = await this.withRunLock(run.id, async () => {
            if (stale()) return "abandon" as const;
            if (!outcome.ok) {
              lastFailure = { attempt, reason: message(outcome.error) };
              this.recordFanoutAttempt(run, step, item, stageIndex, attempt, false, "connector", lastFailure);
              return "retry" as const;
            }
            const settled = await this.settleFanoutAttempt(...);
            if (stale()) return "abandon" as const;
            ...
            return settled.success ? "accepted" as const : "retry" as const;
          });
          if (disposition === "abandon") return;
          if (disposition === "retry") continue;
```

An abandoned item records **no attempt, no output, no patch, no `acceptedDispatchToken`** — it
simply returns, and the `finally` (now also inside the section) burns its `dispatchToken` at
`:1918` exactly as it does today. `stale()` (`:1802`) is unchanged; what changes is that it is
now evaluated against a freshly refreshed object at the one point where its answer becomes
durable.

Note this makes site 14 (`settleFanout`, `:1747`) a *nested* acquisition in the same batch, not a
re-entrant one: the item settle releases before `executeFanout` reaches `:1747`. The in-process
promise chain already serialises them; the file lock now does too.

### S01-10 `ts/src/engine/engine.ts` (edit) — `driveBg` terminalises on a cross-process cancel (R2-11)

`driveBg` (`engine.ts:1076-1084`) reads its **in-memory** `BgFlowState`:

```ts
        if (bg.cancelRequested) {
          bg.status = "cancelled";
          return;
        }
```

which another process cannot set. Its loop is otherwise driven by `reAdvance` responses. One
addition, beside that check: when the response or the refreshed run shows the run cancelled,
terminalise the registry entry:

```ts
        if (response.status === "cancelled" || (await this.loadRun(runId)).status === "cancelled") {
          bg.cancelRequested = true;
          bg.status = "cancelled";
          bg.pendingGates = [];
          return;
        }
```

Without it, a bg-driven run cancelled from a second process settles durably while
`flowBgPoll(...).bg.status` reports `running` forever — the two halves disagreeing is exactly the
hazard `rehydrateBgFlows` (`:497-499`) exists to prevent across restarts. T-S01-11 drives this
with two engines over one root, so the in-memory shortcut cannot pass it.

### S01-11 `ts/src/engine/engine.ts` (new public) — `flowCancel`

Placed immediately after `flowCancelBg` (`engine.ts:871-886`), whose existing body is:

```ts
  async flowCancelBg(runId: string): Promise<{ status: BgStatus }> {
    const bg = this.bgFlows.get(runId);
    if (!bg) throw new Error(`background flow ${runId} not found`);
    bg.cancelRequested = true;
    await this.withRunLock(runId, async () => {
      const run = await this.loadRun(runId);
      if (run.status === "running" && !run.cancelRequested) { run.cancelRequested = true; await this.persist(run); }
    });
    if (bg.status === "paused_gate") { bg.status = "cancelled"; bg.pendingGates = []; }
    return { status: bg.status };
  }
```

`flowCancelBg` is **unchanged** (D5). The new sibling:

```ts
  /** Foreground cancel, addressable by flow id from any process (STRAT-FLOW-CANCEL-FG).
   *  Unlike flowCancelBg this SETTLES the run rather than abandoning it, and it works with no
   *  bgFlows entry — which is the whole point: a compose team build is a foreground
   *  consumer-fanout run, and `compose build --abort` runs in a different process.
   *
   *  One locked section, one persist. No mark-then-settle two-phase: under the lock there is
   *  nothing to race, so the durable mark and the settle ARE the same write (R2-1). */
  async flowCancel(runId: string, reason?: string): Promise<FlowCancelResult> {
    return this.withRunLock(runId, async () => {
      // R4-4: a live lease held by ANOTHER process means that process owns the in-memory copy
      // of this run. Refuse rather than race it; a stale lease (owner provably dead) is removed
      // and we proceed, because the crashed driver's memory is gone and disk is truth again.
      await this.claimDriverLease(runId);   // throws CANCELLATION_UNCONFIRMED{engine_dispatch_active}
      // The terminal decision is read from DISK, not from a pinned object: another process may
      // have completed this run.
      const persisted = await this.store.load(runId);
      if (persisted.status !== "running") {
        return {
          runId, status: persisted.status, flowSettled: persisted.status === "cancelled",
          settledByThisCall: false, reason: `already_${persisted.status}`,
          ledger: this.ledgerInfo(persisted),
        };
      }
      // Mutate the object the rest of the engine is using. When a fanout of OURS holds a pin,
      // loadRun returns that instance, so its brake (:1731) and its item settle see the burn on
      // the very same object — which is the whole reason the lease restricts this path to the
      // driving process (R4-4).
      const run = await this.loadRun(runId);
      await this.terminalCancel(run, reason);
      return { runId, status: run.status, flowSettled: true, settledByThisCall: true, ledger: this.ledgerInfo(run) };
    }, { timeoutMs: Number(process.env.STRATUM_CANCEL_LOCK_WAIT_MS ?? 120000) });
  }
```

The lock-wait budget is `STRATUM_CANCEL_LOCK_WAIT_MS` (120000), **not** the teardown deadline
`STRATUM_CANCEL_TIMEOUT_MS` (15000), which measures a different thing and whose clock starts only
after this call returns (§2.1b). A `RUN_LOCK_TIMEOUT` here propagates as
`CANCELLATION_UNCONFIRMED` with `reason: "run_lock_held"` and the holder pid `acquireRunLock`
read from the lock file, and **nothing is mutated**: the flow was not settled and the caller must
not assume otherwise. An unknown run id surfaces as the ENOENT from `store.load`, which the CLI
maps to exit 2 (§2.8).

`acquireRunLock` therefore attaches the holder pid to its `RUN_LOCK_TIMEOUT` error (§2.1a already
names it in the message; the error object carries it as `holderPid` so a surface can put it in a
structured envelope rather than in prose).

Idempotency falls out of the disk read: a second cancel finds `cancelled`, appends no event,
persists nothing, and returns
`{status: "cancelled", flowSettled: true, settledByThisCall: false, reason: "already_cancelled"}`.

`withRunLock` gains an optional third parameter for the cancel path's shorter deadline.

### S01-12 `ts/contracts/events.json` (edit)

Counter `3` → `4` at `events.json:2`; the `flow_cancelled` kind of §2.3 appended after
`carry_updated` (`events.json:97-112`).

### S01-13 Pin updates for the event vocabulary

Three pins, exactly the set `git show 7e641fa` moved for `carry_updated`:

- `ts/tests/engine/p4.test.ts:981` — `expect(eventsContract.events).toBe(3)` → `toBe(4)`.
- `ts/tests/engine/p4.test.ts:1150-1159` — `declaredAheadOfEmission` gains a `flow_cancelled`
  entry. The vocabulary check at `:1177` is exact in both directions, so a declared-but-never-
  observed kind fails the suite without this. The entry:

  ```ts
      {
        at: "2026-08-30T00:00:00.000Z", type: "flow_cancelled",
        detail: { by: "fg", reason: "abort", burned: { steps: ["work"], items: 0 } },
      },
  ```

- `ts/tests/mcp/contracts-grammar.test.ts:104-105` — the test **title** `"freezes events 3 and
  validates every newly declared event shape strictly"` and
  `expect((await eventContract()).events).toBe(3)` both move to `4`. The title carries the frozen
  value, so renaming it is part of changing the assertion, not cosmetic (R1-10): a title that
  says 3 above an assertion that says 4 is how the next reader is misled. Add an `assertEvent`
  case beside the `carry_updated` one at `:117-124`.

### S01-14 Tests for S01

New files `ts/tests/engine/run_lock.test.ts` and `ts/tests/engine/flow_cancel.test.ts`. Helpers:
`subject(connector?, root?)` from `ts/tests/engine/fencing.test.ts:15-23` (the second argument
reuses a state root — that is the two-process shape); `tokenOf` (`fencing.test.ts:34-39`);
`waitFor` (`fencing.test.ts:41-48`); `settleWave` and `astraFlow` from
`ts/tests/engine/carry-golden.test.ts:50-88` for the consumer fanout driving; `StateStore`
imported directly so every persistence claim reads the file.

**Lock tests** (`run_lock.test.ts`): T-S01-L1..L10, listed in §2.1a beside the protocol they
check — the protocol and its proof belong on one screen.

**Driver-lease tests (R4-4)**, in `flow_cancel.test.ts`:

| id | Behaviour |
|---|---|
| T-S01-D1 | The lease is written when a run is pinned and removed when the last ref is released: assert `<root>/<runId>.driver` exists during an engine-dispatch fanout and is gone after it settles |
| T-S01-D2 | **A cross-process cancel of a pinned run is refused.** Engine A drives an engine-dispatch fanout; engine B over the same root calls `flowCancel`; assert it throws `CANCELLATION_UNCONFIRMED` with `reason: "engine_dispatch_active"` and A's `holderPid`, **and that nothing was mutated** — same status, same event count, no burned tokens |
| T-S01-D3 | **A stale lease is reclaimed.** Same setup with a lease naming a provably dead owner (spawn a child, wait for exit, write its pid+startTime); assert the cancel unlinks the lease and settles the run |
| T-S01-D4 | An `unknown` identity is **not** reclaimed (R4-3): a lease whose owner probes EPERM is treated as live and the cancel is refused |
| T-S01-D5 | **Same-process cancel of a pinned engine-dispatch fanout settles.** Engine A cancels its own pinned run; assert the run reaches `cancelled`, the batch's brake stops it, and the driver's `finally` does **not** overwrite the settle — the durable record after the workers drain still carries exactly one `flow_cancelled` event and every token burned |
| T-S01-D6 | A consumer-dispatch run writes **no** lease (`scheduleFanout` returns at `engine.ts:1524`), so the cross-process cancel of compose's actual case is never refused |

**Write-path tests (R3-3)**, in `flow_cancel.test.ts`:

| id | Behaviour |
|---|---|
| T-S01-W1 | `plan()` holds the lock across its initial persist and first advance: hold the run lock for a run id that `plan` is about to mint — inject the id through the `randomUUID` seam or assert via a `save` spy that no write lands before the lock is free |
| T-S01-W2 | An engine-fanout item's admission writes are locked: a cancel arriving between two stage attempts is seen at the next acquire, and the second attempt never dispatches |
| T-S01-W3 | `stratum learn egress` takes the real lock: hold the run lock from a second process and assert `egressCommand` blocks rather than writing through it |

**Cancel tests** (`flow_cancel.test.ts`):

| id | Behaviour |
|---|---|
| T-S01-1 | Cross-process cancel of a consumer-fanout foreground run. Engine A plans `astraFlow` and settles `plan`; a **second** engine over the same root calls `flowCancel`. Assert `store.load(runId).status === "cancelled"` and a `flow_cancelled` event with `detail.by === "fg"` |
| T-S01-2 | **The precommit race (R1-1, now closed by the lock).** Engine A drives a consumer `stepDone`; engine B calls `flowCancel` concurrently. Assert the two never interleave — using `vi.spyOn(StateStore.prototype, "save")` (`carry-golden.test.ts:145-149`) to capture every durable snapshot in order — and that the final durable state is `cancelled` **whichever order they serialise in**. This is the test that would have caught every race rounds 0 and 1 kept reintroducing |
| T-S01-3 | `persist` outside a locked section throws in dev mode (S01-3's assertion), driven by calling a private persist path directly |
| T-S01-4 | A late consumer `stepDone` is refused. Capture a descriptor's `dispatchToken` before the cancel, cancel from a second engine, then `stepDone` — rejects `/cancelled/`, and the item's `dispatchToken` is burned with no `acceptedDispatchToken` |
| T-S01-5 | A merge-gate decision is refused. Drive `astraFlow` to `execute_merge` `waiting_gate`, read the raw `gateToken` from the store (`fencing.test.ts:259-262`), cancel, then `gateResolve` — rejects, and the token is burned |
| T-S01-6 | `resume` is refused (S01-7) |
| T-S01-7 | **Both** `revert` and `commit` are refused on a cancelled run (S01-8, R2-10), **on a foreground run and on a bg-driven one** (R4-6). The bg row is the one that fails if the cancelled check sits behind `assertExternalMutationAllowed`: it reports `is background-driven` instead of `flow_cancelled` |
| T-S01-7b | Through MCP: `stratum_revert` and `stratum_commit` return `{status: "error", error_type: "flow_cancelled"}` and pass `assertToolResponse`, for both run kinds (R1-7, R4-6) |
| T-S01-8 | **A result returning after the cancel is abandoned (R2-2).** Block the connector inside an engine-dispatch fanout item, cancel from **the driving engine** (the lease refuses a second one — R4-4, T-S01-D2), then release. Assert the item records no attempt, no `output`, no `patch`, and no `acceptedDispatchToken`; its `dispatchToken` is burned; and the durable status is `cancelled`. Use the fanout spec at `fencing.test.ts:245-255`, which pins the run via `scheduleFanout` (`:1534`) |
| T-S01-8b | The same, with `isolation: "worktree"`, asserting **no patch is captured** — the patch is the most expensive thing a cancelled item could wrongly accept |
| T-S01-8c | **The post-drain snapshot equals the settle snapshot (R3-4, R4-1).** After the cancelled batch's workers have fully drained, `store.load(runId)` matches what `terminalCancel` wrote: the `flow_cancelled` event appears exactly once, every issuance token is burned, and no attempt or event the workers were mid-way through appending has appeared. Assert with a `StateStore.prototype.save` spy that **exactly one** cancelled snapshot was written — the sanctioned one (R4-1) |
| T-S01-8d | **A connector that REJECTS after the cancel is abandoned too (R4-5).** Same as T-S01-8 with a connector that throws instead of returning; assert no attempt is recorded, since `recordFanoutAttempt` now runs inside the locked transaction rather than in a bare catch |
| T-S01-8e | `persist` on a cancelled run throws `PERSIST_ON_CANCELLED_RUN` (R4-1): drive a `usageReport` against a run cancelled underneath it and assert it surfaces an error rather than silently doing nothing |
| T-S01-9 | The fanout brake sees a cross-process cancel: `connectorCalls === 1` after cancelling mid-batch (the counting shape of `flow_bg.test.ts:356-384`) |
| T-S01-10 | Cancelling an already-completed run returns `{status: "completed", flowSettled: false, settledByThisCall: false, reason: "already_completed"}`, appends no event, and leaves the run untouched. No cancellation error is raised (R2-4) |
| T-S01-11 | **The bg mirror across processes (R2-11).** Engine A runs a flow with `flowRunBg`; engine B over the same root calls `flowCancel`; assert A's `flowBgPoll(...).bg.status` reaches `cancelled` and the persisted status is `cancelled`. Two engines, because the in-memory shortcut passes a single-engine test |
| T-S01-12 | A **background** cancel still abandons: `flowCancelBg`, then assert `store.load(...).status === "running"` and downstream steps stay `pending` — the existing behaviour of `flow_bg.test.ts:343-354`, re-asserted so a future edit cannot silently change it |
| T-S01-13 | `flowCancel` of an unknown run id rejects with ENOENT |
| T-S01-14 | A cancel that cannot take the lock within `STRATUM_CANCEL_LOCK_WAIT_MS` throws `RUN_LOCK_TIMEOUT` carrying the **holder pid**, and the run is untouched: same `status`, same event count, no `flow_cancelled` (§2.1b). Drive it by holding the lock from a second process and setting the wait to a few milliseconds |
| T-S01-15 | The three constants are independent (R2-1a): a cancel whose lock wait is generous but whose teardown deadline is tiny still settles the flow and fails only on teardown; a cancel whose lock wait is tiny fails before settling. Two rows, one table |
| T-S01-16 | **One absolute deadline (R3-5).** With a 200ms teardown budget, a signal pass that consumes 150ms leaves the reap ~50ms, and the whole call returns within the budget — not 3x it. Assert the wall-clock bound, not just the error |
| T-S01-17 | An `abortLocal` timeout does **not** abort the cancel (R3-5): the reap still runs, and the failure carries `reason: "local_teardown_timeout"` |

Existing test that changes in this slice: `ts/tests/engine/fencing.test.ts:279`
(`expect(await restarted.engine.resume(planned.runId)).toMatchObject({ status: "running" })`)
becomes a `rejects.toThrow(/cancelled/)`. That test sets `cancelRequested` by hand through
`store.save`, so it exercises the flag arm of S01-7's guard; T-S01-6 covers the real cancel.

---

## 4. Slice S02 — The foreground registry and the cross-process kill

S02 touches the two connectors, `runner.ts`, one new connector module, and the MCP dispatcher's
agent-run leg. It adds no tool and no engine code.

### S02-1 `ts/src/connectors/claude.ts` and `codex.ts` (edit) — surfacing the child pid

**The decision D4 leaves open, resolved: a synchronous `onSpawn?: (pid: number) => void`
callback on both connector option types, threaded through `AgentRunOptions`.** A return value
cannot carry the pid, because Claude's child is spawned lazily by the SDK **inside** the injected
`spawnClaudeCodeProcess` closure (`claude.ts:81-105`), long after `run()` is called and possibly
more than once (C9); and the pid must be recorded while the run is still in flight, which is
exactly when no return value exists. The callback is `void`-returning and synchronous so a
connector never awaits registry I/O on the spawn path — the server queues the write (S02-4).

`ClaudeConnectorOptions` (`claude.ts:16-34`) gains, after `cancellationGraceMs` (`:29`):

```ts
  /** Group-leader pid of each cancellable child, reported as it spawns. Invoked only when
   *  ownProcessGroup is true — without a process group there is nothing a cross-process
   *  cancel could signal. Called synchronously; never awaited. */
  onSpawn?: (pid: number) => void;
```

The identical member goes on `CodexConnectorOptions` (`codex.ts:35-51`) after
`cancellationGraceMs` (`:40`), and on `AgentRunOptions` (`ts/src/connectors/runner.ts:11-29`)
after `ownProcessGroup` (`:18`).

Claude call site — existing code at `claude.ts:81-87`:

```ts
        ...(ownProcessGroup ? { spawnClaudeCodeProcess: (options: ClaudeSpawnOptions) => {
          controller.signal.throwIfAborted();
          const child = spawn(options.command, options.args, {
            cwd: options.cwd, env: options.env, detached: process.platform !== "win32",
            stdio: ["pipe", "pipe", "pipe"],
          });
          const termination = processTermination(child, true, this.options.cancellationGraceMs);
```

gains one line between the `spawn` and the `processTermination`:

```ts
          });
          if (child.pid !== undefined) this.options.onSpawn?.(child.pid);
          const termination = processTermination(child, true, this.options.cancellationGraceMs);
```

Codex call site — existing code at `codex.ts:274-278`:

```ts
    const child = this.spawn(command.command, [...command.prefix, ...codexExecArgs(this.model, this.cwd, this.sandboxMode)], {
      cwd: this.cwd,
      env: this.env,
      detached: this.ownProcessGroup && process.platform !== "win32",
    });
    const termination = processTermination(child, this.ownProcessGroup, this.graceMs);
```

gains the same line, guarded on group ownership (a non-detached child is not a group leader, so
recording it would produce an entry that fails the `processGroupId(pid) === pid` gate anyway):

```ts
    });
    if (this.ownProcessGroup && child.pid !== undefined) this.onSpawn?.(child.pid);
    const termination = processTermination(child, this.ownProcessGroup, this.graceMs);
```

`this.onSpawn` is assigned in the constructor beside `this.onEvent = options.onEvent`
(`codex.ts:200`). `runner.ts` forwards it in both constructions, at `:93-103` (codex) and
`:105-117` (claude), with the same presence-based spread every other option uses:

```ts
      ...(options.onSpawn !== undefined ? { onSpawn: options.onSpawn } : {}),
```

`runAgent`'s background branch (`runner.ts:75-90`) does **not** forward it: a background run
already records its own pid (`background.ts:176-191`).

### S02-2 `ts/src/connectors/background.ts` (edit) — export two helpers

`newRunDir` (`:455-464`) and `atomicWriteJson` (`:466-471`) are module-private today. Both gain
`export`. Their bodies do not change — the `0o700` directory mode, the EEXIST retry loop, the
`0o600` file mode and the tmp+rename are exactly the discipline the foreground registry needs,
and a second copy of them would be the drift `reference_engine_dependency_mirror` warns about.

Existing signature lines:

```ts
async function newRunDir(root: string): Promise<{ runId: string; runDir: string }> {
async function atomicWriteJson(path: string, value: unknown): Promise<void> {
```

become `export async function …`. `ts/src/connectors/index.ts:1` already re-exports everything
from `background.js`, so nothing else changes.

### S02-3 `ts/src/connectors/foreground_registry.ts` (new)

Holds §2.4's types plus five functions.

```ts
import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWriteJson, newRunDir } from "./background.js";
import { procStartTime, processGroupId, processIdentityMatches } from "./proc_identity.js";
import { cancellationGraceMs } from "./cancellation.js";
```

**The registry root is injectable (R1-9).** Every function takes
`options: { registryRoot?: string }` and resolves it as
`options.registryRoot ?? process.env.STRATUM_AGENT_FG_ROOT ?? agentForegroundRoot()`, mirroring
how `RegistryOptions` already threads through the background registry
(`ts/src/connectors/background.ts:100`, used at `:387`). Without this no test can run without
writing to the developer's real `~/.stratum`, and two dispatchers in one test cannot be isolated
from each other. `McpDependencies` gains `foregroundRegistryRoot?: string` (S02-4) and the CLI
reads the env var (S03-3).

**`createForegroundRun(meta, options)`** — `newRunDir(root)` then `atomicWriteJson` of the
initial record with `state: "starting"` and `groups: []`. Returns the 12-hex registry id. The
caller writes it **synchronously before its first await** (S02-4).

**`recordForegroundGroup(registryId, pid, options)`** — reads the meta, appends
`{ childPid: pid, procStartTime: await procStartTime(pid) }`, sets `state: "running"`, rewrites
atomically. Serialised by the caller (S02-4 chains the promises), so no lock is needed.
`procStartTime` is captured the same way `background.ts:176` captures it; **without it the group
can never be signalled** (`ts/src/connectors/proc_identity.ts:80-83` returns false for a missing
expected start time), which is why the entry is written with the token rather than backfilled
later. **Throws on failure** — the caller kills the child rather than proceeding with an
unrecorded group (S02-4).

**`settleForegroundRun(registryId, options)`** — stamps `state: "settled"` and `settledAt`
atomically. Never deletes the directory: a reader that raced the settle must see a stamped record
rather than an ENOENT it would have to interpret.

**There is no `flowIsCancelled` in this module (R2-8), and the check is not a boolean (R3-7).**
`isCancelled` returning `false` conflated three different situations — the run is healthy, the run
does not exist, the record could not be read — and only the first is a reason to start an agent.
An unreadable record admitting an uncancellable agent is the failure mode this whole slice exists
to prevent, so the check **fails closed** and states what it wants positively:

```ts
  /** Admission for a foreground agent run (S02-4). The agent may start only against a run that
   *  EXISTS, is readable, and is `running` — not merely "not observed to be cancelled" (R3-7).
   *  Takes the run lock so it cannot read a half-written record, and holds it for one JSON
   *  read. */
  async admitFlowAgent(runId: string): Promise<void> {
    return this.withRunLock(runId, async () => {
      let run: PersistedRun;
      try {
        run = await this.store.load(runId);
      } catch (error) {
        // ENOENT and a parse failure are both refusals. Guessing "probably fine" here is how a
        // cancelled or nonexistent flow acquires an agent nobody can find.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw Object.assign(new Error(`flow ${runId} does not exist`), { code: "FLOW_NOT_RUNNING" });
        }
        throw Object.assign(new Error(`flow ${runId} record is unreadable`), { code: "FLOW_ADMISSION_FAILED" });
      }
      if (run.status !== "running" || run.cancelRequested === true) {
        throw Object.assign(new Error(`flow ${runId} is ${run.status}`), { code: "FLOW_NOT_RUNNING" });
      }
    });
  }
```

Both call sites — pre-spawn and post-stamp — call this same method (S02-4). Two envelopes are
declared for it in `mcp-surface.json`: `flow_not_running` (`{code, runId, status}`) and
`flow_admission_failed` (`{code, runId}`).

`McpDependencies` gains `flowStateRoot?: string` (R2-8) so a test can point the checks at its own
temp root; production resolves it the way `defaultEngine` does (`server.ts:84-89`,
`STRATUM_STATE_ROOT`). An injected engine dependency already carries the method, so the
dispatcher calls `engine.admitFlowAgent(...)` and `flowStateRoot` only names the root for the
default engine it constructs.

**`signalFlowAgents(flowRunId, options)` and `reapFlowAgents(flowRunId, signalled, options)`** —
the enumeration and the kill, split so `cancelFlow` can await the local teardown between them
(R2-5):

```ts
export async function signalFlowAgents(
  flowRunId: string,
  options: { registryRoot?: string } = {},
): Promise<SignalledGroups>;

export async function reapFlowAgents(
  flowRunId: string,
  signalled: SignalledGroups,
  options: { registryRoot?: string; timeoutMs?: number; graceMs?: number } = {},
): Promise<AgentCancelSummary>;
```

Steps 1 and 2 below are `signalFlowAgents`; steps 3 to 5 are `reapFlowAgents`, which carries the
`SignalledGroups` bookkeeping forward so nothing is double-counted (R2-7).

1. `readdir(root)`, ignoring ENOENT (an empty registry is the normal case), filter on the
   `RUN_ID` shape, read each `meta.json`, keep those with `foreground === true`,
   `flow.runId === flowRunId` and `state !== "settled"`.
2. For each recorded group, the four gates from `background.ts:444-452`, **verbatim**:

   ```ts
   const { childPid: pid, procStartTime: expected } = group;
   if (!await processIdentityMatches(pid, expected)) { unreachable += 1; continue; }
   if (await processGroupId(pid) !== pid) { unreachable += 1; continue; }
   // Verify the start-time identity a second time immediately before the only signal.
   if (!await processIdentityMatches(pid, expected)) { unreachable += 1; continue; }
   try { process.kill(-pid, "SIGTERM"); } catch { unreachable += 1; continue; }
   signalled += 1;
   ```

   The first gate of the background version — the stream sentinel scan — has no foreground
   analogue; `settledAt` is its replacement and is checked in step 1.
3. Grace, escalation and reap, bounded by `options.timeoutMs ?? Number(process.env.STRATUM_CANCEL_TIMEOUT_MS ?? 15000)`.
   After `cancellationGraceMs()` (default 5000, `cancellation.ts:11-15`), any group still alive
   gets `SIGKILL`; then poll each group until ESRCH or the deadline. The liveness probe is
   `cancellation.ts:49-53`'s, **not** the test helper at
   `ts/tests/connectors/background-codex-lifecycle.test.ts:34-41`:

   ```ts
   const alive = (pid: number): boolean => {
     try { process.kill(-pid, 0); return true; }
     // Only ESRCH means dead. EPERM means "exists, not ours" — reported as unreachable,
     // never as reaped. The lifecycle test helper's bare catch gets this wrong and must
     // not be copied here.
     catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
   };
   ```
4. **Rescan, with bookkeeping that survives the passes (R2-7).** Steps 1-3 run in a loop, not
   once: an entry can move `starting → running` while the sweep is in progress, and a
   `starting` entry has no pid to signal, so one pass can miss an agent that was mid-spawn when
   the directory was read. Naive re-counting across passes double-counts and produces a summary
   nobody can act on, so the loop carries state:

   - A `Map<registryId, { groups: Map<pid, "signalled" | "reaped" | "unreachable">; settled: boolean }>`
     accumulated across passes. Each registry id is counted **once**, in its final state; each
     pid is counted once in its final state. A pid signalled in pass 1 and reaped in pass 3 is
     one `signalled` and one `reaped`, never two of either.
   - A newly discovered entry joins the map; an entry that vanishes from the directory is kept
     with whatever state it had reached, because deletion is not proof of death.
   - **ESRCH is distinguished from an identity mismatch.** ESRCH on the group probe means the
     group is gone — `reaped`. A `processIdentityMatches` failure means the pid is now some
     other process — the group we recorded is gone too, but we never signalled it, so it is
     `unreachable`, not `reaped`. Collapsing the two would let a recycled pid read as a
     successful teardown.
   - **A `running` entry must reach durable `settled` before it can be acknowledged.** Reaping
     its groups is necessary and not sufficient: the owning dispatcher may still be inside its
     `finally`, and a caller told "acknowledged" could re-dispatch into a run that has not
     finished unwinding. Every entry not durably `settled` at the deadline increments
     `unsettled` (R3-6).
   - **The dead-owner exception requires the owner's identity, not just its pid (R3-6).** The
     sweep stamps `settled` itself only when `processIdentityMatches(serverPid, serverProcStartTime)`
     is **false** and every recorded group is reaped. A pid-only check would read a recycled pid
     as "the server is gone" and stamp a live dispatcher's entry settled. An entry written
     without `serverProcStartTime` — an older record, or one whose capture failed — is never
     eligible for the exception; it stays `unsettled` and the caller is told so.
   - **Multi-group Claude entries (C9) follow the same rule**: the entry settles only when every
     pid in its `groups` array is reaped or unreachable. There is no per-group acknowledgement.
   - A `starting` entry still without a pid at the deadline increments `unresolved`.
5. At the deadline the function returns its summary; the **caller** (`cancelFlow`, S03-1) turns
   a nonzero `unresolved` or a still-alive signalled group into `CANCELLATION_TEARDOWN_TIMEOUT`,
   and an unreachable unsettled entry into `CANCELLATION_UNCONFIRMED` (R1-5). The settle has
   already persisted by then, so it is never lost to a hung teardown.

Windows: `requireProcessGroups()` (`cancellation.ts:18-20`) is not called here. A Windows run
never has a `cancellationId` (it fails before spawn), so it never has a registry entry, so the
enumeration is simply empty. Stating this is the whole Windows story for this feature.

### S02-4 `ts/src/mcp/server.ts` (edit) — write and settle the record

The registration block today, at `server.ts:137-149`:

```ts
        if (tool === "stratum_agent_run" && request.cancellationId !== undefined) {
          if (typeof request.cancellationId !== "string"
            || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(request.cancellationId)) {
            throw await inputValidationError("cancellationId", "cancellationId must be a UUID");
          }
          cancellationId = request.cancellationId;
          if (request.background === true) throw await inputValidationError("background", "cancellationId is only supported for foreground runs");
          if (foreground.has(cancellationId) || completed.has(cancellationId)) throw await inputValidationError("cancellationId", "cancellationId has already been used");
          controller = new AbortController();
          const settled = new Promise<void>((resolve) => { settle = resolve; });
          foreground.set(cancellationId, { controller, settled });
          unlink = linkAbort(context.signal, controller);
        }
```

After `unlink = linkAbort(...)`, and still before `assertToolRequest`, the durable half. **The
`starting` entry is created synchronously — before the first await (R1-3)** — for exactly the
reason the foreground map is registered before contract I/O (`server.ts:117-119`): a cancel that
arrives during startup must not overtake it. `createForegroundRun` is therefore split into a
synchronous id mint plus an awaited write, and it is the awaited write the pre-spawn check
follows:

```ts
          if (isRecord(request.flow)) {
            const flow = {
              runId: string(request.flow, "runId"),
              ...(typeof request.flow.stepId === "string" ? { stepId: request.flow.stepId } : {}),
              ...(typeof request.flow.itemIndex === "number" ? { itemIndex: request.flow.itemIndex } : {}),
            };
            // Throws on failure — a run whose record could not be written is an agent nobody
            // can cancel, the same hazard background.ts:191-196 refuses to accept.
            registryId = await createForegroundRun({
              foreground: true,
              state: "starting",
              agent: String(request.agent) as "claude" | "codex",
              cancellationId,
              serverPid: process.pid,
              flow,
              cwd: string(request, "cwd"),
              ...(typeof request.model === "string" ? { model: request.model } : {}),
              createdAt: new Date().toISOString(),
              groups: [],
            }, registryOptions);
            // R1-3 check 1: the flow may have been cancelled while this request was in
            // flight. Refuse BEFORE spawning anything. Reads the run record under the run
            // lock (R2-8) — there is no sidecar.
            try {
              await engine.admitFlowAgent(flow.runId);
            } catch (error) {
              await settleForegroundRun(registryId, registryOptions);
              throw await admissionError(error, flow.runId);   // flow_not_running | flow_admission_failed
            }
          }
```

`registryId` is a new `let registryId: string | undefined;` beside `cancellationId`
(`server.ts:121`); `registryOptions` is `{ ...(dependencies.foregroundRegistryRoot !== undefined ? { registryRoot: dependencies.foregroundRegistryRoot } : {}) }`
(R1-9). Nothing about the record belongs in a `Map` — it is durable by design.

`flow_cancelled` is a new declared error envelope (`{code, runId}`), added to `mcp-surface.json`
alongside the one in §2.6; `registryError` (`server.ts:95-100`) refuses an undeclared envelope.

The `stratum_agent_run` dispatch case (`server.ts:198-232`) forwards the callback, alongside the
existing `ownProcessGroup` spread at `:212`:

```ts
            ...(registryId !== undefined ? {
              onSpawn: (pid: number) => {
                // Serialised through one promise chain: two spawns cannot interleave a
                // read-modify-write of the same meta.json.
                // R2-6: attach the rejection handler to THIS link immediately. A promise
                // chained but not observed until the finally would let the successful agent
                // result be returned first, and the caller would never learn the group was
                // unrecorded — an uncancellable orphan reported as success.
                registryWrites = registryWrites.then(async () => {
                  const recorded = await recordForegroundGroup(registryId!, pid, registryOptions);
                  // procStartTime returns undefined when libproc is unreachable
                  // (ts/src/connectors/proc_identity.ts:50-58, darwin fails closed). An entry
                  // without it can NEVER be signalled (:80-83), so it is a registration
                  // FAILURE, not a degraded success.
                  if (recorded.procStartTime === undefined) {
                    throw Object.assign(new Error("could not capture process start time; agent would be uncancellable"), { code: "REGISTRY_WRITE_FAILED" });
                  }
                  // R1-3 check 2: the cancel may have swept between the pre-spawn check and
                  // this pid landing. If so this group is ours to kill, right now.
                  try {
                    await engine.admitFlowAgent(flowRunId!);
                  } catch (error) {
                    // R3-8: the recorded identity is REQUIRED to signal a group. It was just
                    // written by recordForegroundGroup above, so pass it explicitly rather than
                    // re-reading the file.
                    await killAndReapGroup(pid, { ...registryOptions, startTime: recorded.procStartTime });
                    throw error;
                  }
                }).catch(async (error: unknown) => {
                  // Any failure in this link — write, start-time capture, or the cancel check
                  // — kills the child and fails the call. It must abort the controller too, so
                  // the agent run itself unwinds rather than completing into a rejected chain.
                  controller?.abort(error instanceof Error ? error : new Error(String(error)));
                  await killAndReapGroup(pid, registryOptions).catch(() => undefined);
                  await settleForegroundRun(registryId!, registryOptions).catch(() => undefined);
                  throw error;
                });
              },
            } : {}),
```

with `let registryWrites: Promise<void> = Promise.resolve();` declared beside `registryId`.

**Neither registry write is swallowed (R1-3, R2-6).** The handler above is attached to the same
link, so it runs the moment that link fails rather than at the dispatcher's `finally`; it aborts
the controller, reaps the child, stamps `settled`, and rethrows so the tool call fails. The
dispatcher additionally awaits `registryWrites` **before** returning a success (below), so a
successful agent result can never be handed back over an unrecorded group. The alternative — the
`.catch(() => undefined)` of the round-0 draft — is an agent running against a cancelled flow
that no canceller can find, which is the precise failure this slice exists to prevent.

`recordForegroundGroup` therefore returns the `ForegroundGroup` it wrote, so the caller can check
`procStartTime` rather than re-reading the file.

`engine.admitFlowAgent` is the engine `Pick` at `server.ts:30` gaining one more method (R2-8,
R3-7); `admissionError(error, runId)` maps its two codes onto the declared envelopes through
`registryError`, and a post-stamp refusal maps the same way (R3-8) rather than throwing a bare
the admission error's own code;
`McpDependencies.flowStateRoot?: string` names the root for the default engine, resolved the way
`defaultEngine` (`server.ts:84-89`) resolves it. Tests supply it so the admission checks read the
same temp root the test's engine writes.

**`await registryWrites` before marking success (R3-8).** The round-2 draft awaited the chain
only in the `finally`, by which point `succeeded = true` had already been set and the response
built — so a group-write failure produced a rejected promise *and* a recorded success. The agent
case at `ts/src/mcp/server.ts:229-231` today reads:

```ts
          unlink?.(); // Provider finished; a late disconnect cannot cancel a completed run.
          succeeded = true;
          response = "status" in executed ? { ...executed } : { status: "complete", ...executed };
```

and becomes

```ts
          unlink?.();
          // R3-8: the registry must be durable BEFORE this run counts as successful. A
          // rejection here propagates as the tool's error, which is the honest outcome: the
          // agent ran, but nobody could have cancelled it.
          await registryWrites;
          succeeded = true;
          response = "status" in executed ? { ...executed } : { status: "complete", ...executed };
```

**`killAndReapGroup(pid, {startTime})` requires the recorded identity (R3-8).** It is **exported**
from `foreground_registry.ts` (R2-6) rather than being an internal helper — S02-4 calls it on the
registration-failure and post-stamp-refusal paths, and a second copy of the
SIGTERM/grace/SIGKILL/reap ladder is exactly the drift `reference_engine_dependency_mirror` warns
about. Its signature takes the start-time token because a `process.kill(-pid, …)` without one is
a kill by pid alone, which is the recycled-pid hazard the four gates exist to close; it runs the
same `processIdentityMatches` check before its first signal.

**Where no identity was recorded, there is no group kill.** If `procStartTime` failed, the entry
was never accepted (R2-6) and the only handle on the child is the connector's own
`AbortController` — `controller?.abort(...)` in the rejection handler above, which reaches
`processTermination`'s ladder (`ts/src/connectors/cancellation.ts:58-83`) through the connector
that owns the child. Signalling a pid we cannot identify is never the fallback.

The `finally` today, at `server.ts:332-339`:

```ts
      } finally {
        unlink?.();
        if (cancellationId !== undefined && controller) {
          completed.set(cancellationId, teardownFailure ?? (succeeded ? "already_complete" : controller.signal.aborted ? "cancelled" : "already_error"));
          foreground.delete(cancellationId);
          if (completed.size > 1024) completed.delete(completed.keys().next().value!);
          settle?.();
        }
      }
```

gains the durable settle, ordered **before** `settle?.()` so a cancel that is awaiting
`running.settled` (`server.ts:238`) cannot observe an unsettled record after the
acknowledgement:

```ts
        if (registryId !== undefined) {
          // Not swallowed (R1-3, R2-6): a rejected group write already aborted the controller
          // and killed its child in its own handler, and the try body awaits this chain before
          // returning success — so reaching here means either success or an error already on
          // its way to the client.
          await registryWrites.catch(() => undefined);
          await settleForegroundRun(registryId, registryOptions).catch(() => undefined);
        }
```

The `settleForegroundRun` catch is the one place a swallow is right: the run is over, and a
failure to stamp costs only a stale entry, which the sweep reports as `unreachable` once
the pid is gone — never a wrong kill, because the identity gates run first. The
`registryWrites.catch` here is a double-settle guard, not an error sink: the rejection has
already propagated out of the try body.

### S02-5 `ts/src/mcp/server.ts` (edit) — `flow` requires `cancellationId`

In the same pre-contract block, before the registration branch:

```ts
        if (tool === "stratum_agent_run" && request.flow !== undefined && request.cancellationId === undefined) {
          throw await inputValidationError("flow", "flow requires a cancellationId: without a process group there is nothing to cancel");
        }
```

Hand-validated here rather than by the contract for the same reason the `cancellationId` checks
are (`server.ts:102-104`): the bookkeeping must be in place before any awaited contract I/O.
The **shape** of `flow` is still validated by `assertToolRequest` against §2.5.

### S02-6 Tests for S02

New file `ts/tests/connectors/foreground_registry.test.ts`, plus additions to
`ts/tests/mcp/agent-run.test.ts`. Helpers: `writerScript(path)` and `waitForDescendant(path)`
(`ts/tests/connectors/cancellation.test.ts:13-23`) for a real parent-plus-grandchild group that
ignores SIGTERM; the injected `SpawnProcess` / `QueryFunction` boundaries
(`cancellation.test.ts:36-45`); the "stopped writing" assertion shape
(`cancellation.test.ts:50-53`); `connected(dependencies)` and `response(result)`
(`ts/tests/mcp/agent-run.test.ts:35-48`); `createToolDispatcher({engine})` over a `mkdtemp` root
(`ts/tests/mcp/flow_bg.test.ts:14-22`). Every registry test passes an explicit `registryRoot`
so nothing touches `~/.stratum`.

| id | Behaviour |
|---|---|
| T-S02-0 | **Cancel before the entry exists (R1-3).** Cancel the flow first, then call `stratum_agent_run` with `flow` — the pre-spawn admission refuses with `flow_not_running`, no child is spawned (assert the injected `SpawnProcess` was never called), and the entry is stamped `settled` |
| T-S02-0a2 | **Admission fails closed (R3-7).** Three rows: an unknown run id ⇒ `flow_not_running`; a corrupt run record (write invalid JSON) ⇒ `flow_admission_failed`; a `completed` run ⇒ `flow_not_running`. In every row no child is spawned |
| T-S02-0a3 | **The run goes terminal between the two checks (R3-7).** Admit pre-spawn against a `running` run, complete or cancel it from the `onSpawn` tick, and assert the post-stamp check refuses, the group is killed and reaped, and the entry is `settled` |
| T-S02-0b | **Cancel between spawn and group write (R1-3).** Cancel from inside the `onSpawn` callback's own tick, so the post-stamp admission refuses: assert the child's group is killed and reaped **with its recorded identity** (R3-8), the call fails with `flow_not_running`, and the entry is `settled` |
| T-S02-0c | **Group-write failure kills the child (R1-3, R2-6).** Fault-inject `recordForegroundGroup` (chmod the run directory `0o500`, the technique at `ts/tests/connectors/background-codex-lifecycle.test.ts:9-23`); assert the tool call **rejects**, the controller was aborted, the spawned group is gone, and the entry is `settled` — never a silent orphan, and never a success returned over an unrecorded group |
| T-S02-0c2 | **A missing `procStartTime` is a registration failure (R2-6).** Stub `procStartTime` to `undefined`; assert the same outcome as T-S02-0c. An entry without the token can never be signalled (`ts/src/connectors/proc_identity.ts:80-83`), so accepting it would manufacture an uncancellable agent |
| T-S02-0d | **The rescan catches a `starting → running` transition.** Hold a `starting` entry with no pid, start the sweep with a generous deadline, stamp the pid mid-sweep, and assert the group is signalled and reaped rather than reported `unresolved` |
| T-S02-0e | A `starting` entry that never gets a pid before the deadline yields `unresolved: 1` |
| T-S02-0f | **No double counting across passes (R2-7).** An entry signalled in an early pass and reaped in a later one yields exactly `{signalled: 1, reaped: 1}`, not 2 or 3. Drive at least three passes |
| T-S02-0g | **ESRCH is not an identity mismatch (R2-7).** Two entries: one whose group really exited (ESRCH ⇒ `reaped`) and one whose pid was recycled by an unrelated live process (identity mismatch ⇒ `unreachable`). Assert the counts do not swap |
| T-S02-0h | **A reaped-but-unsettled `running` entry does not acknowledge.** Kill the groups, leave the entry `running` with a LIVE `serverPid`; assert the sweep does not stamp it settled and the ack is refused |
| T-S02-0i | The dead-owner exception: same setup with a `serverPid` **and `serverProcStartTime`** that are provably gone and all groups reaped; assert the sweep stamps `settled` and the ack succeeds |
| T-S02-0i2 | **A recycled server pid does not trigger the exception (R3-6).** Record a `serverPid` that is alive but whose `serverProcStartTime` does not match; assert the entry stays `unsettled` and the ack is refused |
| T-S02-0i3 | An entry written without `serverProcStartTime` is never eligible for the exception: it stays `unsettled` (R3-6) |
| T-S02-0j | A two-group Claude entry settles only when **both** pids are resolved (C9, R2-7) |
| T-S02-1 | The meta is written and stamped through all three states (`starting`, `running`, `settled`). Dispatch `stratum_agent_run` with `cancellationId` + `flow` against an injected codex spawn; assert the record exists with `foreground: true`, the right `flow.runId`, `serverPid === process.pid`, and one `groups` entry whose `procStartTime` matches `/^\d+\.\d+$/` on darwin (the pin shape of `ts/tests/connectors/proc_identity.test.ts:12-22`). After the run settles, assert `settledAt` is stamped |
| T-S02-2 | **Cross-process kill.** Dispatcher A starts a group-owning fake agent via `writerScript`; an independent `signalFlowAgents` + `reapFlowAgents` pair over the same `registryRoot` — standing in for the second process — kills it. Assert the descendant stops writing (snapshot, wait 120ms, byte-identical) and the summary is `{signalled: 1, reaped: 1, unreachable: 0, alreadySettled: 0, unresolved: 0, unsettled: 0}` |
| T-S02-3 | Teardown timeout. Same setup with `timeoutMs` shorter than the writer's stubborn SIGTERM handler; assert `reaped < signalled` and the caller's deadline fires. Uses the grandchild that ignores SIGTERM, which is the only honest way to reach this branch |
| T-S02-4 | Unreachable, not killed. Hand-write a meta whose `procStartTime` does not match the live pid; assert `unreachable === 1`, `signalled === 0`, and the live process is **still alive** afterwards. This is the test that proves the four gates are load-bearing |
| T-S02-5 | A stamped record is skipped: `alreadySettled === 1`, `signalled === 0` |
| T-S02-6 | A record for a different `flow.runId` is not touched |
| T-S02-7 | `flow` without `cancellationId` is `input_validation_failed` (S02-5); `flow` with `cancellationId` and `background: true` is rejected by the existing `:143` check |
| T-S02-8 | No `flow` field means no registry entry at all — the directory stays empty. Pairs with the existing surface test at `ts/tests/connectors/review-fixes.test.ts:143-145`, which asserts process-group ownership is claimed only for cancellable runs |
| T-S02-9 | A claude run whose SDK spawner is invoked twice records **two** `groups` entries and both are signalled (C9) |
| T-S02-10 | Every registry function honours `registryRoot`, and `STRATUM_AGENT_FG_ROOT` is the fallback (R1-9). Table-driven over create/record/settle/cancel so a future function that forgets the option is caught. No test in this file may touch `agentForegroundRoot()` |

---

## 5. Slice S03 — Surfaces: the shared cancel, the MCP tool, the CLI, the contracts

### S03-1 `ts/src/engine/flow_cancel.ts` (new) — the one function both surfaces call

D7 asks the blueprint to pick the module. It is `ts/src/engine/`, not `ts/src/mcp/`: the CLI must
call it too, and `ts/src/engine/engine.ts:8` already imports `../connectors/runner.js`, so
engine → connectors is an existing, sanctioned direction (C18).

```ts
import { reapFlowAgents, signalFlowAgents, type AgentCancelSummary } from "../connectors/foreground_registry.js";
import type { FlowCancelResult, StratumEngine } from "./engine.js";

export interface FlowCancelAck extends FlowCancelResult {
  /** True only when flowSettled AND every claimed agent entry is reaped or durably settled
   *  (R1-5). Never true alongside an unresolved or unreachable-unsettled entry. */
  acknowledged: boolean;
  agents: AgentCancelSummary;
}

export interface CancelFlowOptions {
  registryRoot?: string;
  timeoutMs?: number;
  reason?: string;
  /** OPTIONAL same-process phase (R1-4). The MCP dispatcher passes a callback that aborts
   *  every foreground AbortController belonging to this flow; the CLI passes nothing. It runs
   *  INSIDE this function, so both surfaces execute the identical ordered sequence.
   *
   *  It returns a PROMISE OF SETTLEMENT (R2-5), not void: aborting a controller starts
   *  teardown, it does not finish it, and the dispatcher already holds the `settled` promise
   *  for each foreground run (ts/src/mcp/server.ts:119, resolved in the finally at :338).
   *  Awaiting it is what lets the sweep that follows see `settled` registry entries instead of
   *  racing the very teardown this call started. */
  abortLocal?: (flowRunId: string, remainingMs: number) => Promise<void>;
}

/** The single failure shape every cancel error carries (R3-5). */
export interface CancelFailure extends Error {
  code: "CANCELLATION_UNCONFIRMED" | "CANCELLATION_TEARDOWN_TIMEOUT";
  runId: string;
  status: RunStatus;
  flowSettled: boolean;
  agents: AgentCancelSummary;
  reason?: "run_lock_held" | "local_teardown_timeout";
  holderPid?: number;
}

/** The phases of a foreground cancel, shared by the MCP tool and the CLI. Both surfaces call
 *  this and NOTHING else (R1-4) — a phase implemented at one call site is a phase the other
 *  surface silently lacks.
 *
 *  Order (R2-5): SETTLE → signal every recorded group → await the local abort's settlement →
 *  await the reap and the registry settlement → compute `acknowledged`.
 *
 *  Settling first (D4) means the acknowledgement is never lost to a hung teardown: the run is
 *  durably cancelled before a single signal is sent, and a teardown failure is reported ON TOP
 *  of a completed settle. Signalling before awaiting the local abort matters because the two
 *  teardowns overlap — SIGTERM to a group and an AbortController on the same run are the same
 *  child from two directions — and serialising them would add a full grace window per agent.
 *  Awaiting the local settlement BEFORE the reap pass is what stops the sweep from reading
 *  `running` entries whose teardown this very call started (R2-5).
 *
 *  A terminal run that was not cancelled skips the agent phases entirely (R2-4): there are no
 *  agents of ours to reap, and sweeping would manufacture a teardown verdict about work that
 *  was never ours. An ALREADY-cancelled run does not skip them — re-running the sweep is how a
 *  caller recovers from an earlier CANCELLATION_TEARDOWN_TIMEOUT. */
export async function cancelFlow(
  engine: Pick<StratumEngine, "flowCancel">,
  runId: string,
  options: CancelFlowOptions = {},
): Promise<FlowCancelAck> {
  // Phase 1: settle. A RUN_LOCK_TIMEOUT here means nothing was mutated (§2.1b) — normalise it
  // rather than letting a raw lock error reach a surface that has no envelope for it (R3-5).
  let settled: FlowCancelResult;
  try {
    settled = await engine.flowCancel(runId, options.reason);
  } catch (error) {
    if ((error as { code?: string }).code !== "RUN_LOCK_TIMEOUT") throw error;
    throw cancelError("CANCELLATION_UNCONFIRMED", {
      runId, status: "running", flowSettled: false, agents: EMPTY_AGENTS,
      reason: "run_lock_held", ...(pidOf(error) !== undefined ? { holderPid: pidOf(error)! } : {}),
    });
  }
  if (!settled.flowSettled) {
    // completed / failed / budget_exhausted: nothing of ours is running (R2-4).
    return { ...settled, acknowledged: false, agents: EMPTY_AGENTS };
  }
  // R3-5: ONE absolute teardown deadline, computed here — after settlement, so the lock wait
  // never eats into it — and shared by every phase. Three independent per-phase timeouts is how
  // a caller ends up waiting 3x the budget it configured, and how a slow signal pass silently
  // leaves no time to reap.
  const deadline = Date.now() + (options.timeoutMs ?? Number(process.env.STRATUM_CANCEL_TIMEOUT_MS ?? 15000));
  const remaining = (): number => Math.max(0, deadline - Date.now());

  const signalled = await signalFlowAgents(runId, { ...options, timeoutMs: remaining() });
  // An abortLocal that times out does NOT abort the cancel: the groups were already signalled
  // and the reap is the authority on whether they died. Record it and keep going (R3-5).
  let localTimedOut = false;
  try {
    await options.abortLocal?.(runId, remaining());
  } catch (error) {
    if ((error as { code?: string }).code !== "CANCELLATION_TEARDOWN_TIMEOUT") throw error;
    localTimedOut = true;
  }
  const agents = await reapFlowAgents(runId, signalled, { ...options, timeoutMs: remaining() });
  // R1-5: acknowledged is a GUARANTEE, not a summary. Anything unresolved is an error.
  // R3-6: unsettled is the strongest of the three and subsumes "groups reaped but the owning
  // dispatcher is still unwinding". All four must be clear.
  const acknowledged = settled.flowSettled
    && agents.unsettled === 0
    && agents.unresolved === 0
    && agents.unreachable === 0
    && agents.signalled === agents.reaped;
  if (!acknowledged) {
    const code = agents.unreachable > 0 && agents.unresolved === 0 && agents.signalled === agents.reaped
      ? "CANCELLATION_UNCONFIRMED"
      : "CANCELLATION_TEARDOWN_TIMEOUT";
    // R3-5: every failure leaves this function as ONE structured error with the same fields,
    // so the MCP and CLI projections have exactly one shape to render. `status` and
    // `flowSettled` come from the engine, never from an assumption (R1-5).
    throw cancelError(code, { runId, status: settled.status, flowSettled: settled.flowSettled, agents,
      ...(localTimedOut ? { reason: "local_teardown_timeout" } : {}) });
  }
  return { ...settled, acknowledged, agents };
}
```

The error carries `status` and `flowSettled` read back from the engine, never a hardcoded
`"cancelled"` (R1-5): the flow half may have succeeded while the agent half did not, and those
are the two facts a consumer needs to tell apart. A `RUN_LOCK_TIMEOUT` from `engine.flowCancel`
(§2.1b) propagates as `CANCELLATION_UNCONFIRMED` with `flowSettled: false`.

`cancelFlowAgents` is therefore split into `signalFlowAgents` (enumerate, four-gate, SIGTERM) and
`reapFlowAgents` (grace, SIGKILL, rescan, registry settlement) so the local abort can be awaited
between them (R2-5). `EMPTY_AGENTS` is the all-zero summary.

### S03-2 `ts/src/mcp/server.ts` (edit) — the `stratum_flow_cancel` tool

Four edits.

The `ToolName` union (`server.ts:46-51`), whose flow line today reads:

```ts
  | "stratum_gate_resolve" | "stratum_flow_poll" | "stratum_flow_run_bg" | "stratum_flow_bg_poll" | "stratum_flow_cancel_bg"
```

gains `| "stratum_flow_cancel"` at the end of that line.

The engine dependency `Pick` (`server.ts:30`), today ending `| "flowCancelBg">`, gains
`| "flowCancel"`.

The dispatch case, immediately after `stratum_flow_cancel_bg` (`server.ts:197`), whose existing
line is:

```ts
        case "stratum_flow_cancel_bg": response = await engine.flowCancelBg(string(request, "runId")); break;
```

becomes those two lines:

```ts
        case "stratum_flow_cancel_bg": response = await engine.flowCancelBg(string(request, "runId")); break;
        case "stratum_flow_cancel": {
          // R1-4: the dispatcher orchestrates NOTHING. It supplies the one capability the CLI
          // cannot have — aborting controllers this process holds — and cancelFlow runs it in
          // the right place. Any phase written here instead would be a phase `stratum flow
          // cancel` silently lacks.
          const ack = await cancelFlow(engine, string(request, "runId"), {
            // R2-5: abort, then AWAIT each run's own `settled` promise — the one the finally
            // resolves at server.ts:338. Aborting only starts teardown; returning before it
            // finishes makes the reap pass race the teardown this call began.
            abortLocal: async (flowRunId, remainingMs) => {
              const settling: Promise<void>[] = [];
              for (const [id, entry] of foreground) {
                if (foregroundFlows.get(id) !== flowRunId) continue;
                entry.controller.abort(new Error("Flow cancelled"));
                settling.push(entry.settled);
              }
              // R3-5: the budget is what cancelFlow has left, not a fresh 15s of its own.
              await teardownDeadline(Promise.all(settling).then(() => undefined), remainingMs,
                "Foreground connector teardown did not settle");
            },
            ...(dependencies.cancellationTimeoutMs !== undefined ? { timeoutMs: dependencies.cancellationTimeoutMs } : {}),
            ...(dependencies.foregroundRegistryRoot !== undefined ? { registryRoot: dependencies.foregroundRegistryRoot } : {}),
          });
          const { settledByThisCall: _, ...wire } = ack;
          response = { ...wire };
          break;
        }
```

`settledByThisCall` is engine-internal bookkeeping and is **not** on the wire (§2.6 declares
`flowSettled` and `acknowledged` only); `assertToolResponse`'s default-deny
(`ts/src/mcp/contracts.ts:122-123`) would reject it otherwise.

`foregroundFlows` is one new `Map<string, string>` beside `foreground` (`server.ts:119`), keyed
by `cancellationId` and holding the flow run id; set beside the `foreground.set` at `:147` and
deleted beside the `foreground.delete` at `:336`. It exists only so the fast path can select
controllers by flow; the durable registry remains the authority.

The teardown-timeout branch, inserted beside the checkpoint branch (`server.ts:311-315`):

```ts
        if (tool === "stratum_flow_cancel" && error instanceof Error && "code" in error
          && ["CANCELLATION_TEARDOWN_TIMEOUT", "CANCELLATION_UNCONFIRMED"].includes(String(error.code))) {
          const failure = error as Error & { status?: string; flowSettled?: boolean; agents?: AgentCancelSummary };
          // R1-5: report the ENGINE'S status and the flow-side fact separately. A hardcoded
          // "cancelled" here would claim a terminal state the run may not have — and a
          // consumer that reads the code as "the cancel failed" will retry into a settled run.
          throw await registryError("flow_cancel_unacknowledged", ErrorCode.InternalError, error.message, {
            code: String(error.code),
            runId: string(request, "runId"),
            status: failure.status ?? "running",
            flowSettled: failure.flowSettled ?? false,
            ...(failure.reason !== undefined ? { reason: failure.reason } : {}),
            ...(failure.holderPid !== undefined ? { holderPid: failure.holderPid } : {}),
            agents: failure.agents ?? { signalled: 0, reaped: 0, unreachable: 0, alreadySettled: 0, unresolved: 0, unsettled: 0 },
          });
        }
```

This is mandatory, not defensive: `registryError` (`server.ts:95-100`) throws
`MCP error registry is missing …` for an undeclared envelope, and without the branch the error
falls through `:328` and reaches the client raw (C17). The same is true of the `flow_cancelled`
envelope S02-4 raises.

### S03-3 `ts/src/cli/flow.ts` (new) and `ts/src/cli/stratum.ts` (edit)

The dispatch table (`ts/src/cli/stratum.ts:24-36`) today:

```ts
  const [command, ...args] = argv;
  if (command === "validate") return validateCommand(args);
  if (command === "migrate") return migrateCommand(args);
  if (command === "query") return queryCommand(args);
  if (command === "gate") return gateCommand(args);
  if (command === "guard") return (await import("./guard.js")).guardCommand(args);
  if (command === "mcp") return (await import("./mcp_install.js")).mcpCommand(args);
  if (command === "doctor") return (await import("./mcp_install.js")).doctorCommand(args);
  if (command === "upgrade" || command === "update") return (await import("./mcp_install.js")).upgradeCommand(args);
  if (command === "learn") return (await import("./learn.js")).learnCommand(args);
  if (command === "watch") return watchCommand(args);
  process.stderr.write("Usage: stratum <validate|migrate|query|gate|guard|learn|mcp|doctor|upgrade|watch> ...\n");
  return 2;
```

gains one lazy-imported line beside `guard`, and the usage string at `:35` gains `flow`:

```ts
  if (command === "flow") return (await import("./flow.js")).flowCommand(args);
```
```ts
  process.stderr.write("Usage: stratum <validate|migrate|query|gate|guard|flow|learn|mcp|doctor|upgrade|watch> ...\n");
```

`ts/src/cli/flow.ts` is modelled on `gateCommand` (`ts/src/cli/query_gate.ts:248-330`): parse,
resolve the state root the same way (`process.env.STRATUM_STATE_ROOT || new StateStore().root`,
`query_gate.ts:24-26`), construct a fresh engine over it exactly as `query_gate.ts:316-317` does
— which is the shipped precedent for a second process mutating a run record — and call
`cancelFlow`.

```ts
export async function flowCommand(args: string[]): Promise<number> {
  if (args[0] !== "cancel" || args.length !== 2) {
    process.stderr.write("Usage: stratum flow cancel <flow_id>\n");
    return 2;
  }
  const runId = args[1]!;
  const root = process.env.STRATUM_STATE_ROOT || new StateStore().root;
  const engine = new StratumEngine({ stateRoot: root, evaluator: createEvaluator(), evaluateRunner: createEvaluateRunner() });
  try {
    const ack = await cancelFlow(engine, runId);
    // R1-8: an already-terminal flow is a SUCCESS, not a conflict. The caller asked for the
    // flow to be stopped and the flow is stopped; exit 2 here maps to {conflict:true} in
    // compose's mutation client (compose/server/stratum-client.js:24-33) and would make every
    // idempotent abort look like a failure.
    writeJson({ _schema_version: "1", ok: true, flow_id: runId, status: ack.status,
      flowSettled: ack.flowSettled, acknowledged: ack.acknowledged, agents: ack.agents,
      ...(ack.reason !== undefined ? { detail: ack.reason } : {}) });
    return 0;
  } catch (error) {
    // An unknown flow is a CONFLICT (exit 2), the shape query_gate.ts:153-156 already uses —
    // reached by an explicit ENOENT test, never by falling through to the catch-all.
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") {
      writeJson({ _schema_version: "1", conflict: true, flow_id: runId, detail: "flow_not_found" });
      return 2;
    }
    const failure = error as Partial<CancelFailure> & Error;
    if (failure.code === "CANCELLATION_TEARDOWN_TIMEOUT" || failure.code === "CANCELLATION_UNCONFIRMED") {
      // Structured, not just a message: the caller must be able to see that the FLOW is
      // settled even though an agent was not confirmed dead.
      // R3-5: print reason and holderPid — "the run is locked by pid 41823" is actionable;
      // "cancel not acknowledged" is not.
      writeJson({ _schema_version: "1", ok: false, error: failure.code, flow_id: runId,
        status: failure.status, flowSettled: failure.flowSettled, agents: failure.agents,
        ...(failure.reason !== undefined ? { reason: failure.reason } : {}),
        ...(failure.holderPid !== undefined ? { holderPid: failure.holderPid } : {}),
        message: failure.message });
      return 1;
    }
    writeJson({ _schema_version: "1", ok: false, error: "INVALID", message: message(error) });
    return 1;
  }
}
```

`writeJson` and `message` are `query_gate.ts:144-146` and `:327-329`; export them from that
module rather than copying (they are currently file-private).

`stratum flow cancel` and the MCP tool run the identical phase sequence because both call
`cancelFlow` and nothing else (R1-4). The one asymmetry is a parameter, not a code path: the CLI
has no `foreground` map, so it passes no `abortLocal` and the sweep does all the work.

### S03-3b `ts/src/cli/query_gate.ts` (edit) — the projection learns `cancelled` (R1-8)

`projectStatus` (`query_gate.ts:48-55`) today:

```ts
export function projectStatus(run: Pick<PersistedRun, "status" | "failure" | "steps" | "spec" | "flowName">): ProjectionStatus {
  if (run.status === "completed") return "complete";
  if (run.status === "budget_exhausted") return "budget_exhausted";
  if (isKilled(run)) return "killed";
  if (run.status === "failed") return "failed";
  if (Object.values(run.steps).some((step) => step.status === "waiting_gate")) return "awaiting_gate";
  return "running";
}
```

A cancelled run matches none of the four guards and falls out of the final `return` as
**`"running"`** — `stratum query` would report an aborted flow as live, which is worse than the
status not existing at all. One new word and one new guard, placed above the `waiting_gate`
check because a cancelled run can still hold a `waiting_gate` step:

```ts
type ProjectionStatus = "complete" | "running" | "awaiting_gate" | "failed" | "budget_exhausted" | "killed" | "cancelled";
```
```ts
  if (run.status === "cancelled") return "cancelled";
```

**Not projected as `killed`.** `killed` is derived by `isKilled` (`query_gate.ts:37-45`) from a
`failed` run whose reason names a specific gate route; it means "a human killed it at a gate".
Overloading it would erase the one distinction the field exists to make. This closes §13 open
question 1.

### S03-4 `ts/contracts/mcp-surface.json` (edit)

Four groups of edits, all specified in §2:

1. `"surface": 18` → `19` at `mcp-surface.json:2`.
2. The new `stratum_flow_cancel` tool block (§2.6), inserted after `stratum_flow_cancel_bg`
   (`:909-920`). Tool count 24 → 25.
3. `"flow?"` on `stratum_agent_run.request` (§2.5), after `"cancellationId?": "string"`.
4. A `cancelled` variant on each of the **seven** run-status tools of §2.7 — each with the exact
   shape that table gives it, which is not always a copy of its `budget_exhausted` neighbour
   (R1-6). `stratum_revert` gets none.
5. Two new error envelopes: `flow_cancel_unacknowledged` (§2.6) and `flow_cancelled`
   (`{"code": "string", "runId": "string"}`, raised by the pre-spawn and post-stamp checks of
   S02-4).

### S03-5 Counter pins

| Pin | From | To |
|---|---|---|
| `ts/tests/engine/p4.test.ts:982` | `expect(surface.surface).toBe(18)` | `19` |
| `ts/tests/engine/p4.test.ts:983` | `toHaveLength(24)` | `25` |
| `ts/tests/mcp/schema-grammar.test.ts:88` | `expect(surface.surface).toBe(18)` | `19` |
| `ts/tests/mcp/contracts-grammar.test.ts:83` | `expect(surface.surface).toBe(18)` | `19` |

The events pins (`p4.test.ts:981`, `contracts-grammar.test.ts:104-105`) moved in S01-11.

### S03-6 Tests for S03

New file `ts/tests/mcp/flow_cancel.test.ts` plus a CLI smoke test in
`ts/tests/cli/flow.test.ts`.

| id | Behaviour |
|---|---|
| T-S03-1 | The tool round-trips. `createToolDispatcher({engine})` over a `mkdtemp` state root (`ts/tests/mcp/flow_bg.test.ts:14-22`); plan a flow, call `stratum_flow_cancel`, and run `assertToolResponse` on the payload — the whole point being that an undeclared key or status fails here (`ts/src/mcp/contracts.ts:145-157`). Assert `{status: "cancelled", acknowledged: true, agents: {signalled: 0, …}}` |
| T-S03-2 | Already-terminal: cancel a completed run and assert `assertToolResponse` accepts the `completed` variant with `acknowledged: false` |
| T-S03-3 | The same-process fast path aborts a live controller: start `stratum_agent_run` with `cancellationId` + `flow` against a `writerScript` boundary, cancel the flow through the same dispatcher, assert the agent call rejects and the descendant stops writing |
| T-S03-4 | The teardown-timeout envelope. Force the reap past its deadline (`cancellationTimeoutMs` in `McpDependencies`) and assert the thrown `McpError` carries `code: "CANCELLATION_TEARDOWN_TIMEOUT"`, `status: "cancelled"`, `flowSettled: true`, and that the run **is** settled on disk. This is the assertion that proves settle-first (D4) |
| T-S03-4b | Already-terminal is not an error (R2-4): cancelling a `completed` run returns success with `flowSettled: false`, `acknowledged: false`, and an all-zero `agents` summary — no sweep was run |
| T-S03-4c | Cancelling an already-`cancelled` run **does** re-run the sweep (R2-4): a still-live registry entry makes the second call raise, and reaping it makes a third call acknowledge |
| T-S03-4d | A lock-wait expiry surfaces as a declared envelope: `flow_cancel_unacknowledged` with `code: "CANCELLATION_UNCONFIRMED"`, `reason: "run_lock_held"`, `flowSettled: false` and a `holderPid`, passing `assertShape` against the contract |
| T-S03-5 | `flow` on `stratum_agent_run` survives the surface: `client.listTools()` through `connected(...)` (`ts/tests/mcp/agent-run.test.ts:35-42`) exposes a `flow` property on the tool's `inputSchema`, which is exactly what compose's `#agentFields` guard reads |
| T-S03-6 | CLI exit codes, table-driven (R1-8): cancel a running flow → `0`, `ok: true`, `acknowledged: true`; a **second** cancel → `0` with `detail: "already_cancelled"` (**not** 2); an unknown flow id → `2` with `conflict: true, detail: "flow_not_found"`; a forced teardown timeout → `1` with a structured envelope carrying `status`, `flowSettled` and `agents`. Every row asserts the printed JSON, not just the code |
| T-S03-8 | `projectStatus` returns `"cancelled"` for a cancelled run, and `stratum query` shows it (R1-8). Placed beside the existing `killed` projection tests |
| T-S03-9 | Both admission envelopes are declared (R3-7): `assertShape` accepts `{code, runId, status}` against `errors.flow_not_running.data` and `{code, runId}` against `errors.flow_admission_failed.data`, and rejects an undeclared key — the shape of `ts/tests/mcp/contracts-grammar.test.ts:159-175` |
| T-S03-7 | Surface completeness, driven by the **real dispatcher** (R3-9). Produce an actual cancelled payload from each of the seven tools of §2.7 — plan a run, cancel it, then call each tool through `createToolDispatcher` — and assert `assertToolResponse` accepts every one. A hand-built payload asserts what the blueprint believes; only a dispatcher-produced one asserts what the code emits, which is exactly where R2-9 and R3-9 both hid. Table-driven over the tool list so an eighth run-status tool added later cannot be forgotten |

---

## 6. Golden-flow test design

One scenario, in `ts/tests/engine/flow_cancel_golden.test.ts`, run against the **real** engine
over a temp state root with a **real** child process. It is the compose team-build abort in
miniature and is the single test that would catch a regression in any of the three slices.

Helpers, all existing: `subject(extra, root)` returning `{engine, raw, store, root}` and the
`astraFlow` consumer-fanout spec from `ts/tests/engine/carry-golden.test.ts:21-25` and `:50-72`;
`settleWave` (`carry-golden.test.ts:74-88`) for driving consumer items through `stepDone` with
descriptor tokens; `writerScript(path)` and `waitForDescendant(path)`
(`ts/tests/connectors/cancellation.test.ts:13-23`) for a real parent-plus-grandchild group;
`createToolDispatcher({engine})` (`ts/tests/mcp/flow_bg.test.ts:14-22`); `StateStore` imported
directly so every persistence claim reads the file, not the in-memory object.

### 6.1 The scenario

1. **Plan and fan out.** Dispatcher A (`createToolDispatcher` over engine A, state root `R`,
   registry root `G`) plans `astraFlow` with `{goal: "g"}` and settles `plan` with two tasks. The
   response is `ready` with two `execute/<n>` consumer descriptors. Claim **one** item: record its
   `dispatchToken`, do not settle it.
2. **A real agent is registered against the flow.** Through dispatcher A, call
   `stratum_agent_run` with `{agent: "codex", cancellationId: <uuid>, flow: {runId, stepId: "execute", itemIndex: 0}, …}`
   against an injected `SpawnProcess` boundary that runs `writerScript(path)`
   (`cancellation.test.ts:36-37`). `await waitForDescendant(path)` so the grandchild is provably
   alive and the registry entry provably carries its group.
3. **Cancel from a second dispatcher over the same state root.** Build engine B and dispatcher B
   on the same `R` and `G` — the two-process shape of
   `ts/tests/engine/flow_bg_rehydrate.test.ts:14-22` — and call
   `stratum_flow_cancel` with `{runId}`. Dispatcher B holds an **empty** `foreground` map, so the
   same-process fast path is a no-op and the cross-process registry path is what does the work.
   This is the exact topology of `compose build --abort` (`/Users/ruze/reg/my/forge/compose/lib/build.js:5815-5817`).

Assertions, in order:

| # | Claim | How |
|---|---|---|
| 1 | The run is settled durably | `store.load(runId).status === "cancelled"`, and `failure` is **undefined** (D3, C15) |
| 1b | No lock is left behind | `<R>/<runId>.lock` does not exist after the call returns — a leaked lock wedges the run for `STRATUM_RUN_LOCK_TIMEOUT_MS` |
| 3 | The event landed | The spine's last event is `flow_cancelled` with `detail.by === "fg"` and `detail.burned.items >= 1` |
| 4 | A late consumer result is refused | Engine A `stepDone(runId, "execute/0", …, <the token from step 1>)` rejects `/cancelled/`, and `store.load(...).steps.execute.fanout.items[0].acceptedDispatchToken` is undefined |
| 5 | The merge gate is refused | Engine A `gateResolve(runId, "execute_merge", "approve", <any token>)` rejects `/cancelled/` |
| 6 | Resume is refused | Engine A `resume(runId)` rejects `/cancelled/` |
| 7 | Revert **and** commit are refused | `commit` before the cancel, then `revert(runId, "before")` and a second `commit` both reject with `flow_cancelled` (R2-10) |
| 8 | The child group is reaped | Snapshot `writerScript`'s output file, `await delay(120)`, assert byte-identical — the honest proof from `cancellation.test.ts:50-53`. "Cancelled" means "stopped writing", not "the promise rejected" |
| 9 | The acknowledgement is contract-shaped | `assertToolResponse("stratum_flow_cancel", payload)` passes; `payload.flowSettled` and `payload.acknowledged` are both true; `payload.agents` is `{signalled: 1, reaped: 1, unreachable: 0, alreadySettled: 0, unresolved: 0, unsettled: 0}` |
| 10 | Engine A observes it without being told | Engine A's `flowPoll(runId)` — which reads disk, `engine.ts:844` — returns `status: "cancelled"`, and `assertToolResponse("stratum_flow_poll", …)` accepts it. Before §2.7 this assertion fails, which is why the status-enum extension is not optional |

### 6.2 The pinned-fanout companion

A second case in the same file, because the descriptor-driven case above is never pinned (C6):
the same cancel against a run whose flow mixes an **engine-dispatch** fanout step (the spec at
`ts/tests/engine/fencing.test.ts:245-255`) with a blocked connector, so `scheduleFanout`
(`engine.ts:1534`) is holding a pin — so it has a driver lease, and per §2.1b the cancel must come
from **the same process that drives it**. Engine B is used for the consumer case above; this case
cancels through engine A's own dispatcher, and a second case asserts that engine B is refused with
`engine_dispatch_active` (T-S01-D2).

Assert, with the connector released only after the cancel returns: the run settles `cancelled`;
`connectorCalls` stays at 1 (the counting shape of `ts/tests/engine/flow_bg.test.ts:356-384`); no
second item is dispatched; and the released item is **abandoned** — no attempt recorded, no
`output`, no `patch`, no `acceptedDispatchToken` (R2-2). That last clause is the one the round-1
design could not make true, and it is the reason this companion case is not optional.

### 6.3 What the golden flow does not cover

Compose's own in-process `isolation: "none"` Claude agents (`result-normalizer.js:553-579`) are
not reachable from Stratum and are compose's to abort — the contract is a split (§12). Windows
has no path here at all: a run without a process group has no registry entry. Claude background
worker-thread runs stay out of scope (§12).

---

## 7. Invariants a reviewer should check

1. **Every write to a run record happens while its file lock is held — including `plan`, the
   engine-fanout admission writes, and `stratum learn egress`** (R3-3). `withRunLock` acquires
   before the action and releases after; `persist` asserts it in dev mode (S01-3), and that
   assertion is what caught the three uncovered paths. This is the single property the whole
   design rests on.
1b. **Publication is atomic and release is token-checked** (R3-2). The lock file is only ever
   created by `link()` from a complete tmp file, so it never exists half-written; the stale break
   runs under its own break-lock and unlinks only after re-checking the inode it judged; release
   is a no-op when the token does not match. Removing any one of the three reintroduces either a
   partial lock, a deleted live replacement, or a self-inflicted double writer.
1c. **The lock owner is identified by pid AND start time, with no fallback** (R3-1). If
   `procStartTime` is unavailable the engine refuses to acquire (`RUN_LOCK_IDENTITY_UNAVAILABLE`)
   rather than taking a lock nobody can safely age out.
2. **A lock is stale only by process identity, never by age.** `acquireRunLock` breaks a lock
   whose `pid`+`startTime` no longer match a live process and waits for one that does. An
   age-based rule would rob a healthy holder mid-judged-ensure; an identity-free rule would wedge
   a run forever after a crash.
3. **Release unlinks only its own lock.** Verify contents before `unlink`. Removing another
   holder's lock is the one way this scheme produces two concurrent writers.
4. **A pinned run has exactly one writer, enforced by the driver lease** (R4-4). No reconciliation
   of the pinned object is attempted, because there is no lock protecting it — rounds 2 and 3
   both tried and both left a window. A live foreign lease means refuse
   (`engine_dispatch_active`); a provably dead one is reclaimed; `unknown` is never reclaimed.
   The lease is written on the 0 → 1 pin and unlinked on the return to 0, or the run wedges.
4b. **A cancelled run is written exactly once, and every other write throws** (R4-1).
   `persistTerminalCancel` is the sole sanctioned save; `persist` raises
   `PERSIST_ON_CANCELLED_RUN` otherwise, so a late `usageReport` surfaces instead of vanishing;
   the fanout `finally` checks the status itself and skips while still tearing down its worktree.
   T-S01-8c and T-S01-8e are the pins.
5. **The lock is held across two long external awaits, and three separate constants reflect
   that.** The judged-ensure call (`engine.ts:2111`) and the evaluate runner (`:1436`) both sit
   inside locked sections (§2.1b, R2-1a; filed as STRAT-LOCK-SCOPE in §12).
   `STRATUM_RUN_LOCK_TIMEOUT_MS` is 300000 for the general waiter;
   `STRATUM_CANCEL_LOCK_WAIT_MS` is 120000 for the cancel's **acquire**; and
   `STRATUM_CANCEL_TIMEOUT_MS` stays 15000 for **agent teardown**, whose clock starts only after
   settlement. They measure three different things — collapsing any two of them, which the
   round-2 draft did, reintroduces either a false `RUN_LOCK_TIMEOUT` against a healthy holder or
   a cancel that appears to hang.
5b. **A lock-wait expiry mutates nothing.** `flowCancel` raises before it loads, so a caller that
   sees `reason: "run_lock_held"` knows the run is untouched and the retry is safe.
6. **Nothing accepts a fanout result outside the lock.** The stretch from the connector's return
   through `settleFanoutAttempt`, the patch capture (`engine.ts:1901-1911`) and the token
   promotion (`:1912-1916`) is inside one locked section (S01-9). An abandoned item records no
   attempt, no output, no patch and no `acceptedDispatchToken`.
7. **The settle burns every outstanding issuance.** `burnIssuances` is one exported function in
   `state.ts` called by `terminalCancel` and nothing else duplicates it. `cancelRequested` is a
   `CHECKPOINT_FIELD` (`ts/src/engine/checkpoint.ts:13`), so a revert could un-cancel a run — the
   burned tokens, rejected by the fencing at `engine.ts:1662` and `:924`, are the durable half,
   and S01-8's refusal of both `commit` and `revert` is the belt.
8. **A cancelled run carries no `failure`.** `response()`'s new arm returns none and never reaches
   `requiredFailure` (`engine.ts:3133`), which would invent one.
9. **Background cancel behaviour is unchanged.** `flowCancelBg` is not edited and `advance:1226`
   is not edited (S01-6). T-S01-12 is the pin.
10. **Settle → signal → await local settlement → reap → acknowledge, all inside `cancelFlow`,
    against ONE absolute deadline computed after settlement** (R1-4, R2-5, R3-5). Per-phase
    timeouts let a caller wait a multiple of the budget it configured. A terminal-but-not-cancelled
    run skips the agent phases; an already-cancelled one does not (R2-4). An `abortLocal` timeout
    is recorded, not fatal — the reap is the authority on whether the groups died.
10b. **Every cancel failure leaves `cancelFlow` as one `CancelFailure`**, carrying `status`,
    `flowSettled`, `agents`, and where applicable `reason` and `holderPid`; both surfaces render
    those fields (R3-5). A raw `RUN_LOCK_TIMEOUT` reaching a surface is a bug.
11. **`acknowledged` is a guarantee, never a summary.** True only when the flow is settled and
    every claimed entry is reaped or durably `settled`; anything else is an error carrying the
    real engine status, `flowSettled`, and the partial summary — never a hardcoded `"cancelled"`
    (R1-5).
12. **The rescan counts each registry id and each pid once, in its final state** (R2-7). ESRCH is
    `reaped`; an identity mismatch is `unreachable`. Every entry not durably `settled` at the
    deadline counts in `unsettled`, and `acknowledged` requires
    `unsettled === unresolved === unreachable === 0` (R3-6). The dead-owner exception needs
    `processIdentityMatches(serverPid, serverProcStartTime)` to be false — a pid-only check would
    stamp a live dispatcher's entry settled.
13. **Only ESRCH means dead.** Both the four-gate kill and the reap probe treat EPERM as
    `unreachable`. The test helper at
    `ts/tests/connectors/background-codex-lifecycle.test.ts:34-41` has a bare `catch` and must not
    be copied into production code (`reference_pid_vs_pgid_eperm`).
14. **The recorded pid is the connector child, never `process.pid`.** Recording the server pid
    would kill the MCP server and every sibling run with it. `serverPid` is a separate,
    never-signalled field.
15. **No registry write is swallowed, and the start-after-cancel window stays closed.** The
    `starting` entry is written before the first await; `admitFlowAgent` runs before spawn and
    again after each pid stamp and **fails closed** on a missing or unreadable record (R3-7);
    `registryWrites` is awaited **before** `succeeded = true` (R3-8); a failed write, a missing
    `procStartTime`, or a refused admission aborts the controller, kills and reaps the child, and
    fails the call (R1-3, R2-6); the sweep rescans rather than reading the directory once.
15b. **A group is only ever signalled with its recorded identity** (R3-8). `killAndReapGroup`
    takes the start-time token and re-checks it. Where no identity was recorded there is no group
    kill at all — only the connector's own `AbortController`.
16. **Nothing in the registry layer touches the real `~/.stratum`.** Every function takes
    `registryRoot`, falling back to `STRATUM_AGENT_FG_ROOT` and then the default (R1-9). A test
    that reaches `agentForegroundRoot()` pollutes the developer's machine and cannot run twice
    concurrently.
17. **Cancel is exempt from both mutation guards, deliberately.** `terminalCancel` runs neither
    `assertNoForegroundFanout` (`engine.ts:2894`) nor `assertExternalMutationAllowed` (`:2819`).
    The comment saying so must survive; without it the next reader will "fix" the omission and
    reintroduce the wedge this feature exists to break.
18. **No new `PersistedRun` field, and no `StateStore` change.** `ts/src/engine/checkpoint.ts` and
    `ts/tests/engine/flowctl.test.ts` stay untouched (C16). If a `cancelledAt` appears later it
    must be classified in the same commit or the file will not compile.

## 8. File Plan

| File | Action | Purpose |
|---|---|---|
| `ts/src/engine/state.ts` | edit | `RunStatus` gains `cancelled`; `AuditEvent` gains `flow_cancelled`; exported `burnIssuances`; exported `assertRunId` (R4-7). **`StateStore`'s behaviour is otherwise unchanged** (R2-1) |
| `ts/src/connectors/proc_identity.ts` | edit | tri-state `processIdentity(pid, startTime)` beside the existing `processIdentityMatches` (R4-3) |
| `ts/src/engine/run_lock.ts` | new | `acquireRunLock` (hard-link publication, identity-only break-lock, token-checked release), the driver-lease read/write/reclaim helpers (R4-4), `lockedSave` for `learn.ts` (R3-3c), the `RUN_LOCK_TIMEOUT` and `RUN_LOCK_IDENTITY_UNAVAILABLE` codes (R2-1, R3-1, R3-2) |
| `ts/src/engine/engine.ts` | edit | `RunStatus` and `burnIssuances` on the `state.js` import at `:20`; `withRunLock` wraps the file lock and takes an optional per-call timeout; `assertRunId` at its head (R4-7); `heldLocks` and `persist`'s dev-mode `assertLockHeld`; `EngineResponse` cancelled variant; `FlowCancelResult`; `CheckpointOperationError["errorType"]` gains `flow_cancelled` at `:290` (R1-7); `terminalCancel`; `response()` arm; `resumeLocked` refusal; `commit` **and** `revert` refusal (R2-10); `plan`'s persist and advance moved under the lock (R3-3a); the engine-fanout admission split (R3-3b) and the item-settle lock (R2-2); `persist` gains its two modes and `persistTerminalCancel` (R4-1); the driver lease on `retainRun`/`releaseRun` plus `claimDriverLease` (R4-4); `driveBg` terminalisation (R2-11); `admitFlowAgent` (R2-8, R3-7); `flowCancel`. **`loadRun` and `advance:1226` are unchanged, and there is no `refreshPinned`** (R2-1, R4-4) |
| `ts/src/engine/flow_cancel.ts` | new | `cancelFlow` — the three-phase orchestrator both surfaces call; `FlowCancelAck` |
| `ts/src/connectors/foreground_registry.ts` | new | `agentForegroundRoot`, `ForegroundRunState`, `ForegroundRunMeta`, `createForegroundRun`, `recordForegroundGroup`, `settleForegroundRun`, `signalFlowAgents`, `reapFlowAgents` (R2-5), exported `killAndReapGroup` (R2-6), `AgentCancelSummary`; every function takes `registryRoot` (R1-9). No `flowIsCancelled` — the admission checks read the run record (R2-8) |
| `ts/src/connectors/background.ts` | edit | `export` on `newRunDir` and `atomicWriteJson`; no body changes |
| `ts/src/connectors/claude.ts` | edit | `onSpawn?` option; the call after the spawn at `:83` |
| `ts/src/connectors/codex.ts` | edit | `onSpawn?` option; constructor assignment; the call after the spawn at `:274` |
| `ts/src/connectors/runner.ts` | edit | `onSpawn?` on `AgentRunOptions`; forwarded in both foreground constructions (`:93-103`, `:105-117`), not the background branch |
| `ts/src/mcp/server.ts` | edit | `ToolName`; engine `Pick` gains `flowCancel` and `admitFlowAgent` (R2-8, R3-7); `McpDependencies.foregroundRegistryRoot?` (R1-9) and `flowStateRoot?` (R2-8); `foregroundFlows` map; `flow` validation; the synchronous `starting` entry, the two `admitFlowAgent` checks (R3-7), the `await registryWrites` before `succeeded` (R3-8), and the non-swallowed group write with its immediate rejection handler (R1-3, R2-6); the `stratum_flow_cancel` case, which calls `cancelFlow` and nothing else and whose `abortLocal` awaits each run's `settled` promise (R1-4, R2-5); the `flow_cancel_unacknowledged` error branch |
| `ts/src/cli/stratum.ts` | edit | `flow` command line at `:33`; usage string at `:35` |
| `ts/src/cli/flow.ts` | new | `flowCommand` — `stratum flow cancel <flow_id>`, with the R1-8 exit-code table |
| `ts/src/cli/query_gate.ts` | edit | `ProjectionStatus` and `projectStatus` learn `cancelled` (R1-8); `writeJson` and `message` exported for reuse by `flow.ts` |
| `ts/src/cli/learn.ts` | edit | the private lock map at `:186-201` is replaced by `lockedSave` from `run_lock.ts` (R3-3c) |
| `ts/contracts/events.json` | edit | `flow_cancelled` kind; counter 3 → 4 |
| `ts/contracts/mcp-surface.json` | edit | `stratum_flow_cancel` tool; `stratum_agent_run.request.flow?`; `cancelled` variant ×7 with per-tool shapes, `revisionDigest` on `plan` and `resume` only (R1-6, R2-9, R3-9); `unsettled` in every agents summary (R3-6); `flow_cancel_unacknowledged` (with `reason?`/`holderPid?`), `flow_not_running` and `flow_admission_failed` envelopes; `surface` 18 → 19 |
| `CHANGELOG.md` | edit | same commit as the code |
| `README.md` | edit | the CLI table gains `stratum flow cancel`; the MCP tool list gains `stratum_flow_cancel`; a cancellation subsection notes the fg/bg split |
| `ts/tests/engine/run_lock.test.ts` | new | T-S01-L1..L10 (§2.1a) |
| `ts/tests/engine/flow_cancel.test.ts` | new | T-S01-W1..W3, T-S01-1..17 |
| `ts/tests/engine/flow_cancel_golden.test.ts` | new | §6 |
| `ts/tests/engine/fencing.test.ts` | edit | `:279` resume assertion becomes a rejection (C12) |
| `ts/tests/engine/p4.test.ts` | edit | events pin `:981` 3 → 4; `declaredAheadOfEmission` `:1150-1159`; surface pins `:982-983` |
| `ts/tests/mcp/contracts-grammar.test.ts` | edit | surface pin `:83`; events pin and title `:104-105`; a `flow_cancelled` `assertEvent` case |
| `ts/tests/mcp/schema-grammar.test.ts` | edit | surface pin `:88` |
| `ts/tests/mcp/flow_cancel.test.ts` | new | T-S03-1..5, T-S03-7 |
| `ts/tests/cli/flow.test.ts` | new | T-S03-6 |
| `ts/tests/connectors/foreground_registry.test.ts` | new | T-S02-1..9 |

Not touched, and deliberately so: `ts/src/engine/checkpoint.ts` and
`ts/tests/engine/flowctl.test.ts` (C16); `ts/src/connectors/index.ts` (a barrel, C13);
`/Users/ruze/reg/my/forge/compose/**` (a separate ticket).

---

## 9. Boundary Map

Slice ids map to the sections above: S01 = §3, S02 = §4, S03 = §5.

### S01: engine cancel mark, settle, refusals and event vocabulary
Produces:
  ts/src/engine/state.ts → RunStatus, CheckpointSnapshot (type)
  ts/src/engine/state.ts → AuditEvent, PersistedRun (interface)
  ts/src/engine/state.ts → burnIssuances (function)
  ts/src/engine/run_lock.ts → acquireRunLock, lockedSave, readDriverLease, writeDriverLease, releaseDriverLease (function)
  ts/src/engine/state.ts → assertRunId (function)
  ts/src/connectors/proc_identity.ts → processIdentity (function)
  ts/src/engine/engine.ts → EngineResponse (type)
  ts/src/engine/engine.ts → FlowCancelResult (interface)
  ts/src/engine/engine.ts → flowCancel, admitFlowAgent, terminalCancel, withRunLock, claimDriverLease, retainRun, releaseRun, persist, persistTerminalCancel, response (function)
  ts/src/engine/engine.ts → CheckpointOperationError (class)

Consumes: nothing (leaf node)

### S02: foreground agent registry and the cross-process kill
Produces:
  ts/src/connectors/foreground_registry.ts → ForegroundRunMeta, ForegroundGroup, AgentCancelSummary (interface)
  ts/src/connectors/foreground_registry.ts → ForegroundRunState (type)
  ts/src/connectors/foreground_registry.ts → agentForegroundRoot, createForegroundRun, recordForegroundGroup, settleForegroundRun, signalFlowAgents, reapFlowAgents, killAndReapGroup (function)
  ts/src/connectors/background.ts → newRunDir, atomicWriteJson (function)
  ts/src/connectors/claude.ts → ClaudeConnectorOptions (interface)
  ts/src/connectors/codex.ts → CodexConnectorOptions (interface)
  ts/src/connectors/runner.ts → AgentRunOptions (interface)

Consumes: nothing (leaf node)

### S03: the shared cancel, the MCP tool, the CLI and the frozen contracts
Produces:
  ts/src/engine/flow_cancel.ts → FlowCancelAck, CancelFlowOptions, CancelFailure (interface)
  ts/src/engine/flow_cancel.ts → cancelFlow (function)
  ts/src/mcp/server.ts → ToolName (type)
  ts/src/cli/flow.ts → flowCommand (function)
  ts/src/cli/query_gate.ts → projectStatus (function)
  ts/src/cli/learn.ts → egressCommand (function)

Consumes:
  from S01: ts/src/engine/engine.ts → FlowCancelResult, flowCancel
  from S02: ts/src/connectors/foreground_registry.ts → signalFlowAgents, reapFlowAgents, AgentCancelSummary

`StratumEngine` is declared in `ts/src/engine/engine.ts` and is produced by S01 from the same
file S03 consumes; the slices touch disjoint regions of it (S01: `loadRun` at `:353`, `advance`
at `:1210`, the settle block at `:2933-2997`, `flowCancel` after `:886`; S03 does not edit
`engine.ts` at all). Wire formats (`ts/contracts/*.json`), event payload shapes, the response
status enums and the twelve invariants of §7 are prose in this blueprint, not Boundary Map
entries — they are not grep-checkable identifiers.

---

## 10. Versioning and docs

**Version stays `0.5.0`** (D6). `ts/package.json:3` and `ts/server.json:10` / `:15` are already
at `0.5.0` from STRAT-LOOP-CARRY, which is unpublished, so this feature rides the same minor. The
surface counter moves 18 → 19 and the events counter 3 → 4 within that minor. **Do not publish.**

**`CHANGELOG.md`** — the `## [0.5.0]` section gains a second feature block beside
STRAT-LOOP-CARRY's:

```markdown
### STRAT-FLOW-CANCEL-FG: foreground flow cancel by flow id

`stratum_flow_cancel` and `stratum flow cancel <flow_id>` cancel a running FOREGROUND flow from
any process. Run records are now serialised across processes by a per-run lock file beside them,
so a cancel settles the run to the new terminal status `cancelled` under the same mutual exclusion
every other writer passes through; every outstanding step, gate and fanout-item issuance is
burned, so a late consumer result or gate decision is refused and an in-flight fanout item whose
agent returns after the cancel is abandoned rather than accepted. Foreground agent runs started with a
`cancellationId` may now declare `flow: {runId, stepId?, itemIndex?}` on `stratum_agent_run`;
those runs get a durable record under `~/.stratum/ts/agent_fg/` carrying the child pid and its
start-time identity, which is what lets a second process terminate their process groups under
the same four-gate discipline and the same bounded acknowledgement as background cancellation
(0.4.0 semantics: SIGTERM, `STRATUM_CANCEL_GRACE_MS`, SIGKILL, bounded reap, and
`CANCELLATION_TEARDOWN_TIMEOUT` rather than a false acknowledgement).

Background flows are unchanged: `stratum_flow_cancel_bg` still abandons a run rather than
settling it. Consumers that run their own in-process agents still abort those themselves; Stratum
terminates only the agents it spawned.

Surface 18 → 19 (one new tool, one new request field, `cancelled` declared on every
run-status-bearing tool). Events 3 → 4 (`flow_cancelled`). Consumers pinning the response status
set must accept `cancelled`; compose's `#agentFields` guard
(`compose/lib/stratum-mcp-client.js:279-291`) must learn `flow` before it can send it.
```

**`README.md`** — three edits: the CLI command table gains a `stratum flow cancel <flow_id>` row;
the MCP tool list gains `stratum_flow_cancel`; and the cancellation section gains a paragraph
stating the split — foreground cancel settles and kills the agents Stratum spawned, background
cancel abandons, and a consumer's own in-process agents are the consumer's to abort.

---

## 11. The contract compose will call

Not part of this ticket. Stated so the consumer ticket has something exact to build against.

- **MCP:** `stratum_flow_cancel({runId})` → §2.6. One-field call, the shape of
  `cancelAgentRun` at `/Users/ruze/reg/my/forge/compose/lib/stratum-mcp-client.js:878-880`. A new
  **tool** does not trip the `#agentFields` guard (`:279-291`); that guard reads
  `stratum_agent_run`'s schema only. A new **request field** on `stratum_agent_run` does trip it,
  by design, and its message ("required execution surface: 17") will need updating to 19 on the
  compose side.
- **CLI subprocess:** `stratum flow cancel <flow_id>`, exit 2 → `{conflict: true}`, matching the
  budgets and exit-code mapping in `/Users/ruze/reg/my/forge/compose/server/stratum-client.js:24-33`.
- **Where it goes:** in `abortBuild`, between the connect and the close
  (`/Users/ruze/reg/my/forge/compose/lib/build.js:5815-5827`), **before** the local status writes
  at `:5829-5842` — the vision flip to `killed`, the `active-build.json` `status: 'aborted'`, and
  the build actuals all stay. And in the SIGINT/SIGTERM handler (`:2976-2981`), which today only
  flips a local variable and closes the stream.
- **Error handling:** `CANCELLATION_TEARDOWN_TIMEOUT` from this tool means **the flow is
  cancelled and some agent group outlived the deadline** — the envelope carries
  `status: "cancelled"` for exactly that reason. Compose already treats that code as
  fatal-and-non-retryable at `build.js:962` and `:5849`; that treatment is still right, but the
  build must not be re-abortable-as-if-nothing-happened.
- **The split:** compose keeps aborting its own `isolation: "none"` local Claude agents
  (`/Users/ruze/reg/my/forge/compose/lib/result-normalizer.js:553-579`). Stratum cannot reach
  them; they never enter it.

---

## 12. Out of scope

- **Claude background runs.** They are `worker_threads.Worker`s in an in-memory registry
  (`ts/src/connectors/background.ts:258-263`, `:396-397` returns `not_found` after a restart), not
  processes, so they are not cross-process cancellable today. A separate ticket.
- **Making a pinned run's in-memory object safe for a second writer — absorbed into
  STRAT-LOCK-SCOPE (R4-4).** The driver lease refuses a cross-process cancel of a pinned run
  rather than racing it, which is the v1 boundary stated in §2.1b. Two consequences are worth
  naming rather than leaving for someone to rediscover:
  - A foreground **engine-dispatch** fanout is cancellable only from the process driving it, or
    once that process dies. Compose's consumer-dispatch builds are unaffected (never pinned).
  - **A pre-existing lost update, not introduced and not fixed here**: `stratum gate` builds a
    fresh engine over the state root from a second process and calls `gateResolve`
    (`ts/src/cli/query_gate.ts:316-317`). Against a pinned run that is a lost update on `main`
    today, with no lease and no lock. This feature adds the run lock, which serialises the two
    writers' *saves*, but the pinned process's in-memory object is still stale afterwards. The
    lease guards the cancel path only. Fixing it properly is the same restructuring as the item
    below, which is why they share a ticket.
- **Narrowing the run lock around the two long external awaits — filed as STRAT-LOCK-SCOPE.**
  `stepDoneLocked` → `runEnsures` (`ts/src/engine/engine.ts:2099`) → `this.judge(...)`
  (`ts/src/engine/engine.ts:2111`), and `advanceScopeLoop`'s `evaluate:` arm →
  `this.evaluateRunner(...)` (`ts/src/engine/engine.ts:1436`), are both LLM-scale awaits inside a
  locked section (§2.1b, R2-1a). **This is pre-existing**: both already serialise every other
  locked operation on that run through `withRunLock`'s in-process promise chain
  (`ts/src/engine/engine.ts:372-381`) on `main` today. This feature makes the wait visible across
  processes and gives it a bounded, named failure (`CANCELLATION_UNCONFIRMED` with
  `reason: "run_lock_held"`); it does not introduce the blocking. Restructuring those two paths
  so the judge and the evaluate runner are called outside the lock, with the result re-validated
  against a re-read record on the way back in, is a separate ticket with its own fencing
  questions — exactly the shape of the R2-2 problem this feature just solved for the fanout
  item settle (S01-9), and it should reuse that pattern.
- **Agents the engine spawns itself.** `defaultConnector` (`ts/src/engine/engine.ts:3140-3168`)
  passes neither `signal` nor `ownProcessGroup`, so engine-dispatch fanout agents survive any
  cancel. **Filed as STRAT-ENGINE-CONNECTOR-CANCEL**, a prerequisite for cancelling an
  engine-dispatch flow's agents rather than merely its dispatch loop.
- **Worktrees.** D8: engine-dispatch worktrees of a cancelled run are left for inspection,
  matching background cancel today (`engine.ts:1918-1923`'s `finally` reaps only the item it
  owns). Consumer worktrees were never the engine's — `consumerDescriptor.policy`
  (`engine.ts:2471-2476`) delegates isolation to the consumer.
- **Settling a background cancel.** D5's optional nit. `flowCancelBg` keeps abandoning; making it
  settle is a behaviour change with its own pins (`ts/tests/engine/flow_bg.test.ts:334-354`).
- **Cancel reasons on the wire.** The tool request is `{runId}` only, matching
  `stratum_flow_cancel_bg`. `flowCancel`'s `reason` parameter exists for the CLI and for future
  use; nothing on the MCP surface supplies it in v1.
- **A `cancelled` column on `stratum query`** (`ts/src/cli/query_gate.ts:164-188`). See §13.
- **Compose wiring.** Every `/Users/ruze/reg/my/forge/compose/**` reference in this blueprint is
  read-only.

---

## 13. Open questions

**None. Both round-0 questions were closed by the R1-8 ruling** and are recorded here so the
decisions are not re-litigated:

1. **The CLI projection word — RESOLVED (R1-8): add `"cancelled"`.** `projectStatus`
   (`ts/src/cli/query_gate.ts:48-55`) gains an honest `cancelled` projection and a test (S03-3b,
   T-S03-8). Projecting it as `killed` was rejected: `killed` is derived by `isKilled`
   (`:37-45`) from a gate route and means "a human killed it at a gate"; overloading it erases
   the distinction the field exists to make. Without the fix a cancelled run falls out of the
   final `return` as `"running"` and `stratum query` reports an aborted flow as live.

2. **Already-cancelled from the CLI — RESOLVED (R1-8): exit 0, not exit 2.** The caller asked
   for the flow to be stopped and the flow is stopped. Exit 2 maps to `{conflict: true}` in
   compose's mutation client
   (`/Users/ruze/reg/my/forge/compose/server/stratum-client.js:24-33`), which would make every
   idempotent abort look like a failure to a retry loop. Exit 2 is now reserved for a genuinely
   unknown flow id, reached by an explicit ENOENT test rather than the catch-all. §2.8 carries
   the full table.

---

## Verification Table (Phase 5, 2026-09-09)

Every `path:line` / `path:line-line` reference in this blueprint was extracted (`grep -oE`,
deduped by resolved-file + line-range), resolved against the real `stratum` tree (bare
filenames like `server.ts:212` or `engine.ts:552` resolved by uniqueness under `ts/src` and
`ts/tests`; the one filename with two on-disk matches, `flow_bg.test.ts`, was disambiguated
per-occurrence from surrounding content — both occurrences here point at
`ts/tests/engine/flow_bg.test.ts`, matching the fully-qualified sibling citations for the same
material elsewhere in the doc), and the file was opened at that line to check the claim.

**Body corrected for the rows below on 2026-09-09.**

**134 unique references checked. 132 OK. 2 non-OK** (both are pre-existing corrections or
line drift, not fresh factual errors):

| # | File | Line(s) | Blueprint line(s) | Status | Note |
|---|---|---|---|---|---|
| 1 | `stratum/CHANGELOG.md` | 146-159 | 24 | OK |  |
| 2 | `stratum/docs/features/STRAT-FLOW-CANCEL-FG/design.md` | 10 | 39 | OK |  |
| 3 | `stratum/ts/contracts/events.json` | 2 | 200,728 | OK |  |
| 4 | `stratum/ts/contracts/events.json` | 97-112 | 201,729 | OK |  |
| 5 | `stratum/ts/contracts/mcp-surface.json` | 2 | 1268 | OK |  |
| 6 | `stratum/ts/contracts/mcp-surface.json` | 195 | 386 | OK |  |
| 7 | `stratum/ts/contracts/mcp-surface.json` | 921-951 | 40 | OK |  |
| 8 | `stratum/ts/contracts/mcp-surface.json` | 922-940 | 279 | OK |  |
| 9 | `stratum/ts/package.json` | 3 | 1497 | OK |  |
| 10 | `stratum/ts/server.json` | 10 | 1497 | OK |  |
| 11 | `stratum/ts/src/cli/query_gate.ts` | 24-26 | 1229 | OK |  |
| 12 | `stratum/ts/src/cli/query_gate.ts` | 48-55 | 1589 | OK |  |
| 13 | `stratum/ts/src/cli/query_gate.ts` | 164-188 | 1581 | OK |  |
| 14 | `stratum/ts/src/cli/query_gate.ts` | 248-330 | 1227 | OK |  |
| 15 | `stratum/ts/src/cli/query_gate.ts` | 258-260 | 430 | OK |  |
| 16 | `stratum/ts/src/cli/query_gate.ts` | 261-266 | 1245 | OK |  |
| 17 | `stratum/ts/src/cli/query_gate.ts` | 316-317 | 1229 | OK |  |
| 18 | `stratum/ts/src/cli/query_gate.ts` | 322 | 423 | OK |  |
| 19 | `stratum/ts/src/cli/stratum.ts` | 24-36 | 1200 | OK |  |
| 20 | `stratum/ts/src/connectors/background.ts` | 53 | 46 | OK |  |
| 21 | `stratum/ts/src/connectors/background.ts` | 176 | 898 | OK |  |
| 22 | `stratum/ts/src/connectors/background.ts` | 176-191 | 860 | OK |  |
| 23 | `stratum/ts/src/connectors/background.ts` | 258-263 | 1566 | OK |  |
| 24 | `stratum/ts/src/connectors/background.ts` | 444-452 | 918 | OK |  |
| 25 | `stratum/ts/src/connectors/background.ts` | 446-451 | 39 | OK |  |
| 26 | `stratum/ts/src/connectors/background.ts` | 485-503 | 46 | OK |  |
| 27 | `stratum/ts/src/connectors/cancellation.ts` | 11-15 | 933 | OK |  |
| 28 | `stratum/ts/src/connectors/cancellation.ts` | 18-20 | 951 | OK |  |
| 29 | `stratum/ts/src/connectors/cancellation.ts` | 49-53 | 935 | OK |  |
| 30 | `stratum/ts/src/connectors/claude.ts` | 16-34 | 798 | OK |  |
| 31 | `stratum/ts/src/connectors/claude.ts` | 57 | 47,254 | OK |  |
| 32 | `stratum/ts/src/connectors/claude.ts` | 81-87 | 811 | OK |  |
| 33 | `stratum/ts/src/connectors/claude.ts` | 81-105 | 793 | OK |  |
| 34 | `stratum/ts/src/connectors/codex.ts` | 35-51 | 807 | OK |  |
| 35 | `stratum/ts/src/connectors/codex.ts` | 200 | 852 | OK |  |
| 36 | `stratum/ts/src/connectors/codex.ts` | 274 | 47 | OK |  |
| 37 | `stratum/ts/src/connectors/codex.ts` | 274-278 | 831 | OK |  |
| 38 | `stratum/ts/src/connectors/index.ts` | 1 | 876 | OK |  |
| 39 | `stratum/ts/src/connectors/index.ts` | 18 | 51 | SELF-CORRECTED | blueprint's own C13 row flags this citation as wrong (file is a 6-line barrel) and supplies the fix (runner.ts:11-29/:94/:107); not a fresh error |
| 40 | `stratum/ts/src/connectors/proc_identity.ts` | 80-83 | 236,899,1399 | OK |  |
| 41 | `stratum/ts/src/connectors/runner.ts` | 11-29 | 51,808 | OK |  |
| 42 | `stratum/ts/src/connectors/runner.ts` | 75-90 | 859 | OK |  |
| 43 | `stratum/ts/src/connectors/runner.ts` | 94 | 51 | OK |  |
| 44 | `stratum/ts/src/connectors/runner.ts` | 107 | 51 | OK |  |
| 45 | `stratum/ts/src/engine/checkpoint.ts` | 13 | 496,658,1378 | OK |  |
| 46 | `stratum/ts/src/engine/checkpoint.ts` | 34 | 54,1402 | OK |  |
| 47 | `stratum/ts/src/engine/engine.ts` | 8 | 56,1092 | OK |  |
| 48 | `stratum/ts/src/engine/engine.ts` | 213-218 | 53,143 | OK |  |
| 49 | `stratum/ts/src/engine/engine.ts` | 232 | 79 | OK |  |
| 50 | `stratum/ts/src/engine/engine.ts` | 241-243 | 160 | OK |  |
| 51 | `stratum/ts/src/engine/engine.ts` | 353-357 | 453 | OK |  |
| 52 | `stratum/ts/src/engine/engine.ts` | 473 | 44 | OK |  |
| 53 | `stratum/ts/src/engine/engine.ts` | 494 | 79 | OK |  |
| 54 | `stratum/ts/src/engine/engine.ts` | 552 | 41,1106 | OK |  |
| 55 | `stratum/ts/src/engine/engine.ts` | 751-755 | 643 | OK |  |
| 56 | `stratum/ts/src/engine/engine.ts` | 812-815 | 618 | OK |  |
| 57 | `stratum/ts/src/engine/engine.ts` | 844 | 1348 | OK |  |
| 58 | `stratum/ts/src/engine/engine.ts` | 871-886 | 674 | OK |  |
| 59 | `stratum/ts/src/engine/engine.ts` | 1226 | 591 | OK |  |
| 60 | `stratum/ts/src/engine/engine.ts` | 1534 | 1355 | OK |  |
| 61 | `stratum/ts/src/engine/engine.ts` | 1662 | 498,1379 | OK |  |
| 62 | `stratum/ts/src/engine/engine.ts` | 1901-1911 | 42 | OK |  |
| 63 | `stratum/ts/src/engine/engine.ts` | 1918-1923 | 1573 | OK |  |
| 64 | `stratum/ts/src/engine/engine.ts` | 2471-2476 | 1575 | OK |  |
| 65 | `stratum/ts/src/engine/engine.ts` | 2819-2825 | 50 | OK |  |
| 66 | `stratum/ts/src/engine/engine.ts` | 2827-2831 | 670 | OK |  |
| 67 | `stratum/ts/src/engine/engine.ts` | 2853-2861 | 527 | OK |  |
| 68 | `stratum/ts/src/engine/engine.ts` | 2894 | 1406 | OK |  |
| 69 | `stratum/ts/src/engine/engine.ts` | 2933 | 491 | OK |  |
| 70 | `stratum/ts/src/engine/engine.ts` | 2992-2997 | 53,572 | OK |  |
| 71 | `stratum/ts/src/engine/engine.ts` | 3010 | 198,721 | OK |  |
| 72 | `stratum/ts/src/engine/engine.ts` | 3133 | 1382 | OK |  |
| 73 | `stratum/ts/src/engine/engine.ts` | 3140-3168 | 52,1568 | OK |  |
| 74 | `stratum/ts/src/engine/engine.ts` | 3150-3159 | 52 | OK |  |
| 75 | `stratum/ts/src/engine/state.ts` | 1 | 140 | OK |  |
| 76 | `stratum/ts/src/engine/state.ts` | 8 | 66 | OK |  |
| 77 | `stratum/ts/src/engine/state.ts` | 196-201 | 178 | OK |  |
| 78 | `stratum/ts/src/engine/state.ts` | 263-300 | 97 | OK |  |
| 79 | `stratum/ts/src/engine/state.ts` | 283-292 | 140 | OK |  |
| 80 | `stratum/ts/src/engine/state.ts` | 296-299 | 98 | OK |  |
| 81 | `stratum/ts/src/mcp/contracts.ts` | 145-157 | 1293 | OK |  |
| 82 | `stratum/ts/src/mcp/contracts.ts` | 147-151 | 322 | OK |  |
| 83 | `stratum/ts/src/mcp/server.ts` | 30 | 1143 | OK |  |
| 84 | `stratum/ts/src/mcp/server.ts` | 46-51 | 1135 | OK |  |
| 85 | `stratum/ts/src/mcp/server.ts` | 95-100 | 1194 | OK |  |
| 86 | `stratum/ts/src/mcp/server.ts` | 102-104 | 1058 | OK |  |
| 87 | `stratum/ts/src/mcp/server.ts` | 119 | 1123,1173 | OK |  |
| 88 | `stratum/ts/src/mcp/server.ts` | 119-120 | 39 | OK |  |
| 89 | `stratum/ts/src/mcp/server.ts` | 121 | 997 | OK |  |
| 90 | `stratum/ts/src/mcp/server.ts` | 137-149 | 957 | OK |  |
| 91 | `stratum/ts/src/mcp/server.ts` | 197 | 1146 | OK |  |
| 92 | `stratum/ts/src/mcp/server.ts` | 198-232 | 1000 | OK |  |
| 93 | `stratum/ts/src/mcp/server.ts` | 212 | 292 | OK |  |
| 94 | `stratum/ts/src/mcp/server.ts` | 238 | 1033 | OK |  |
| 95 | `stratum/ts/src/mcp/server.ts` | 294-295 | 217 | OK |  |
| 96 | `stratum/ts/src/mcp/server.ts` | 311-315 | 55,668,1178 | OK |  |
| 97 | `stratum/ts/src/mcp/server.ts` | 317-327 | 55 | OK |  |
| 98 | `stratum/ts/src/mcp/server.ts` | 332-339 | 1018 | OK |  |
| 99 | `stratum/ts/src/mcp/server.ts` | 469-491 | 294 | OK |  |
| 100 | `stratum/ts/src/policy/events.ts` | 62 | 568 | OK |  |
| 101 | `stratum/ts/tests/connectors/background-codex-lifecycle.test.ts` | 34-41 | 936,1390 | OK |  |
| 102 | `stratum/ts/tests/connectors/cancellation.test.ts` | 13-23 | 1065,1313 | OK |  |
| 103 | `stratum/ts/tests/connectors/cancellation.test.ts` | 36-37 | 1326 | OK |  |
| 104 | `stratum/ts/tests/connectors/cancellation.test.ts` | 36-45 | 1067 | OK |  |
| 105 | `stratum/ts/tests/connectors/cancellation.test.ts` | 50-53 | 1068,1346 | OK |  |
| 106 | `stratum/ts/tests/connectors/proc_identity.test.ts` | 12-22 | 1075 | OK |  |
| 107 | `stratum/ts/tests/connectors/review-fixes.test.ts` | 143-145 | 1082 | OK |  |
| 108 | `stratum/ts/tests/engine/carry-golden.test.ts` | 21-25 | 1310 | OK |  |
| 109 | `stratum/ts/tests/engine/carry-golden.test.ts` | 50-88 | 756 | OK |  |
| 110 | `stratum/ts/tests/engine/carry-golden.test.ts` | 74-88 | 1311 | OK |  |
| 111 | `stratum/ts/tests/engine/carry-golden.test.ts` | 143-152 | 762 | OK |  |
| 112 | `stratum/ts/tests/engine/fencing.test.ts` | 15-23 | 754,761 | OK |  |
| 113 | `stratum/ts/tests/engine/fencing.test.ts` | 34-39 | 755 | OK |  |
| 114 | `stratum/ts/tests/engine/fencing.test.ts` | 41-48 | 755 | OK |  |
| 115 | `stratum/ts/tests/engine/fencing.test.ts` | 245-255 | 768,1354 | OK |  |
| 116 | `stratum/ts/tests/engine/fencing.test.ts` | 259-262 | 765 | OK |  |
| 117 | `stratum/ts/tests/engine/fencing.test.ts` | 279 | 50,775 | OK |  |
| 118 | `stratum/ts/tests/engine/flow_bg.test.ts` | 334-354 | 1577 | OK |  |
| 119 | `stratum/ts/tests/engine/flow_bg.test.ts` | 343-354 | 45,604,772 | OK |  |
| 120 | `stratum/ts/tests/engine/flow_bg.test.ts` | 356-384 | 768,1357 | OK |  |
| 121 | `stratum/ts/tests/engine/flow_bg_rehydrate.test.ts` | 14-22 | 1330 | OK |  |
| 122 | `stratum/ts/tests/engine/flowctl.test.ts` | 53-56 | 54,1403 | OK |  |
| 123 | `stratum/ts/tests/engine/p4.test.ts` | 981 | 49,735,1284 | OK |  |
| 124 | `stratum/ts/tests/engine/p4.test.ts` | 982 | 49,1279 | OK |  |
| 125 | `stratum/ts/tests/engine/p4.test.ts` | 983 | 1280 | OK |  |
| 126 | `stratum/ts/tests/engine/p4.test.ts` | 1150-1159 | 48,736 | OK |  |
| 127 | `stratum/ts/tests/engine/p4.test.ts` | 1191 | 48 | OFF-BY-1 | actual assert is at line 1190, not 1191 |
| 128 | `stratum/ts/tests/mcp/agent-run.test.ts` | 35-42 | 1297 | OK |  |
| 129 | `stratum/ts/tests/mcp/agent-run.test.ts` | 35-48 | 1069 | OK |  |
| 130 | `stratum/ts/tests/mcp/contracts-grammar.test.ts` | 83 | 49,1282 | OK |  |
| 131 | `stratum/ts/tests/mcp/contracts-grammar.test.ts` | 104-105 | 747,1284 | OK |  |
| 132 | `stratum/ts/tests/mcp/contracts-grammar.test.ts` | 105 | 49 | OK |  |
| 133 | `stratum/ts/tests/mcp/flow_bg.test.ts` | 14-22 | 1070,1293,1314 | OK |  |
| 134 | `stratum/ts/tests/mcp/schema-grammar.test.ts` | 88 | 49,1281 | OK |  |

**Note beyond the extracted set:** while spot-checking the §2.7 status-enum table (whose rows
use bare `:NNN` continuations against a header-declared file and so don't match the
`path:line` extraction pattern), one entry does not check out: the table claims
`stratum_audit`'s `budget_exhausted` block is at `ts/contracts/mcp-surface.json:644`; it is
actually at **line 649** (line 644 is inside the `"steps": "object"` line of the same
response). The other seven rows in that table (`:195`, `:314`, `:490`, `:606`, `:756`,
`:808`, `:890`) all check out exactly, including the `stratum_flow_poll:808-818` worked
example reproduced verbatim in the text.

### File Plan check

All 16 `edit` rows resolve to files that exist on disk; all 8 `new` rows resolve to paths that
do not exist yet. No violations.

| Check | Result |
|---|---|
| edit-rows exist | 16/16 |
| new-rows absent | 8/8 |

### Symbol check

Every symbol the blueprint cites as **pre-existing** (i.e. not itself one of this feature's
new deliverables) was greped and confirmed present with the claimed kind:

- `RunStatus`, `CheckpointSnapshot` — `type`, `ts/src/engine/state.ts:8`/`:206` — confirmed
- `AuditEvent`, `PersistedRun` — `interface`, `ts/src/engine/state.ts:196`/`:219` — confirmed
- `StateStore` — `class`, `ts/src/engine/state.ts:263` — confirmed
- `EngineResponse` — `type`, `ts/src/engine/engine.ts:213` — confirmed
- `loadRun`, `response` — private methods (function), `engine.ts:353`/`:2992` — confirmed
- `ToolName` — `type`, `ts/src/mcp/server.ts:46` — confirmed
- `ClaudeConnectorOptions` — `interface`, `ts/src/connectors/claude.ts:16` — confirmed
- `CodexConnectorOptions` — `interface`, `ts/src/connectors/codex.ts:35` — confirmed
- `AgentRunOptions` — `interface`, `ts/src/connectors/runner.ts:11` — confirmed (this is the
  corrected home from C13; the original explorer citation of `index.ts:18` is wrong, and the
  blueprint says so itself)
- `newRunDir`, `atomicWriteJson` — unexported functions, `ts/src/connectors/background.ts:455`/`:466` —
  confirmed present and confirmed **not yet exported**, matching the File Plan's "export on
  `newRunDir` and `atomicWriteJson`; no body changes" note
- `projectStatus` — `ts/src/cli/query_gate.ts:48` — confirmed it falls through to
  `"running"` for any `RunStatus` it doesn't explicitly name, matching the §13/File-Plan
  "not touched" rationale

No pre-existing-symbol claim failed. One (`AgentRunOptions` at `index.ts`) is a citation the
blueprint itself already flags and fixes (C13) — surfaced here as confirmation the fix is
correct, not as a new finding.

### Boundary Map check

All entries use a kind from `{interface, type, function, class, const, hook, component}`. Both
`from S##` back-references were checked against the referenced slice's own `Produces` list and
match exactly:

- `from S01: ts/src/engine/engine.ts → FlowCancelResult, flowCancel` — both listed under S01's
  `Produces`
- `from S02: ts/src/connectors/foreground_registry.ts → cancelFlowAgents, AgentCancelSummary` —
  both listed under S02's `Produces`

Symbols the Boundary Map calls "Produces" but which already exist on disk today (e.g.
`ClaudeConnectorOptions`, `CodexConnectorOptions`, `AgentRunOptions`, `newRunDir`,
`atomicWriteJson`) are consistent with the File Plan's "edit" (not "new") action for those
files — "Produces" here means "this slice is the one that touches/owns the symbol," not
"this slice originates it." No mismatch found between a symbol's Boundary Map kind and its
actual on-disk declaration kind.


## Review log

Round 0: drafted 2026-09-09; verifier pass over 134 references (132 OK, 2 corrected in the body
2026-09-09).

Round 1: Codex `gpt-5.6-sol/high`, 2026-09-09. Ten findings (7 must-fix, 2 should-fix, 1 nit),
all accepted and folded. Four carried a controller RULING — the `StateStore.save` write barrier
(R1-1), the sidecar nonce (R1-2), the registry lifecycle plus its two admission checks (R1-3), and
the split of `flowSettled` from `acknowledged` (R1-5). Both round-0 open questions were closed by
R1-8.

Round 2: Codex `gpt-5.6-sol/high`, 2026-09-09. Eleven findings (9 must-fix, 2 should-fix), all
accepted. **Read as a non-convergence signal rather than a defect list**: six of the nine
must-fixes were the same check-then-write race in six places, which is what the lockless design
made structurally inevitable. The controller replaced it — a real cross-process file lock
(`ts/src/engine/run_lock.ts`), and the sidecar, the nonce and the `save` barrier deleted. R1-1,
R1-2 and R1-3's sidecar half are therefore superseded by R2-1; their registry and
acknowledgement halves survive intact. C6 and C7 are marked RETIRED rather than removed, so the
history of why the lock exists stays legible.

One correction was found while verifying the round-2 ruling and is recorded as R2-1a: two long
external awaits (the judged ensure and the evaluate runner) **do** sit inside locked sections, so
the ruling's premise that no locked section awaits a connector holds only for the connector
proper. The design is unaffected; its timeout constants are not, and §2.1b sets them.

Round 3: Codex `gpt-5.6-sol/high`, 2026-09-09. Nine findings, all must-fix, all accepted and
folded. Round 2 replaced the design; round 3 audited whether the replacement was actually a lock,
and six of the nine say it was not yet — a publication gap and a stale-break race in the protocol
itself (R3-1, R3-2), three write paths outside the lock including `plan()` and
`stratum learn egress` (R3-3), a refresh that copied too little to survive the pinned writer's
next persist (R3-4), and an admission check that answered the wrong question (R3-7). None of it
reopens R2-1; all of it is the cost of specifying that ruling properly.

The standing three-round budget was spent at round 3, but R3-2's lock protocol and R3-3's
write-path coverage were new load-bearing text written in response to a review rather than
validated by one, and a lock that is subtly wrong fails silently and rarely. A scoped round 4 was
therefore requested over §2.1a, §2.1b and §3 only.

Round 4 (scoped): 8 findings folded 2026-09-09; R4-4 resolved by SCOPE (driver lease) not by
refresh; round-4 fixes not re-reviewed — the implementation Codex pass should target the lock
protocol (§2.1a) and the lease refusal first.
