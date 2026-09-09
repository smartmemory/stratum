import { readdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { atomicWriteJson, newRunDir } from "./background.js";
import { cancellationGraceMs } from "./cancellation.js";
import { processGroupId, processIdentity, processIdentityMatches, procStartTime } from "./proc_identity.js";

/** Deliberately a SIBLING of the background registry, never a member of it (C8). `loadMeta`
 *  (background.ts) accepts any meta.json whose runId matches its directory, so a foreground
 *  codex record dropped into `agent_runs` would be loadable by `cancelBackgroundRun` and
 *  killed as if it were a detached background run. */
export function agentForegroundRoot(): string {
  return join(homedir(), ".stratum", "ts", "agent_fg");
}

const REGISTRY_ID = /^[0-9a-f]{12}$/;

export interface RegistryRootOptions { registryRoot?: string }

export type ProcessIdentity = (pid: number, startTime: string) => Promise<"alive" | "dead" | "unknown">;

export interface SweepOptions extends RegistryRootOptions {
  timeoutMs?: number;
  graceMs?: number;
  /** One absolute deadline for the whole teardown, overriding `timeoutMs` (S03 computes it
   *  after settlement so the phases share one budget). */
  deadlineAt?: number;
  /** Identity oracle seam, mirroring `RunLockOptions.identity`. Production uses the tri-state
   *  probe; a test injects a deterministic answer. */
  identity?: ProcessIdentity;
}

function resolveRoot(options: RegistryRootOptions): string {
  return options.registryRoot ?? process.env.STRATUM_AGENT_FG_ROOT ?? agentForegroundRoot();
}

export interface ForegroundGroup {
  childPid: number;
  /** REQUIRED for a kill: processIdentityMatches returns false without it
   *  (ts/src/connectors/proc_identity.ts:80-83), so a group recorded without one is
   *  reported as unreachable rather than signalled. */
  procStartTime?: string;
}

/** R1-3. The three-state lifecycle exists to close the start-after-cancel window: an agent
 *  whose spawn is in flight when the cancel sweeps has no pid yet, so a registry that only
 *  appeared at spawn time would let it escape and keep running against a cancelled flow.
 *
 *  `starting` — the record exists, the spawn has not happened. A canceller that sees
 *    `starting` knows an agent is coming and must keep watching rather than declaring the
 *    flow quiet.
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
   *  "the server is gone" from "the agent is gone". Never signalled (invariant 14). */
  serverPid: number;
  /** REQUIRED for the dead-owner exception (R3-6). Without it processIdentityMatches cannot
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

export interface AgentCancelSummary {
  /** Groups that received SIGTERM. */
  signalled: number;
  /** Groups confirmed gone (ESRCH on the group probe) before the deadline. */
  reaped: number;
  /** Identity mismatch, no recorded procStartTime, not a group leader, or EPERM on the probe.
   *  NOT killed, and — on a still-unsettled entry — NOT acknowledgeable either (R1-5). */
  unreachable: number;
  /** Entries whose state was already `settled` when the sweep first saw them. */
  alreadySettled: number;
  /** Entries still `starting` (no pid) at the deadline. A nonzero value is
   *  CANCELLATION_UNCONFIRMED: an agent may be spawning right now and we cannot say it is
   *  gone. */
  unresolved: number;
  /** Every matching entry that is NOT durably `settled` at the deadline, whatever the state
   *  of its groups (R3-6). Reaping the children is not the same as the run having finished. */
  unsettled: number;
}

type GroupOutcome = "signalled" | "reaped" | "unreachable";

interface TrackedGroup {
  startTime?: string;
  everSignalled: boolean;
  outcome?: GroupOutcome;
  /** The most recent group probe. `unknown` is NOT a terminal verdict mid-poll: a leader that
   *  has exited but not yet been reaped by its parent answers EPERM on macOS, and ending the
   *  poll there would report a group that is about to be confirmed dead as unreachable. Only
   *  at the deadline does a standing `unknown` become the final `unreachable` (invariant 13). */
  lastProbe?: "alive" | "unknown";
}

interface TrackedEntry {
  groups: Map<number, TrackedGroup>;
  state: ForegroundRunState;
  settled: boolean;
  /** `settled` on the very first observation — reported separately from an entry this sweep
   *  watched settle, because the caller asked us to tear that one down and we did not have to. */
  alreadySettled: boolean;
  serverPid?: number;
  serverProcStartTime?: string;
}

/** The cross-pass bookkeeping (R2-7). Each registry id is counted once in its final state,
 *  and each pid once in its final state: a pid signalled in pass 1 and reaped in pass 3 is
 *  one `signalled` and one `reaped`, never two of either. */
export interface SignalledGroups {
  entries: Map<string, TrackedEntry>;
}

// ── Records ───────────────────────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function metaPath(root: string, registryId: string): string {
  if (!REGISTRY_ID.test(registryId)) throw new Error(`invalid foreground registry id ${JSON.stringify(registryId)}`);
  return join(root, registryId, "meta.json");
}

async function readMeta(root: string, registryId: string): Promise<ForegroundRunMeta | undefined> {
  if (!REGISTRY_ID.test(registryId)) return undefined;
  let raw: unknown;
  try { raw = JSON.parse(await readFile(join(root, registryId, "meta.json"), "utf8")); }
  catch { return undefined; }
  if (!isRecord(raw) || raw.runId !== registryId || raw.foreground !== true) return undefined;
  if (raw.agent !== "claude" && raw.agent !== "codex") return undefined;
  if (!isRecord(raw.flow) || typeof raw.flow.runId !== "string") return undefined;
  if (!Array.isArray(raw.groups)) return undefined;
  if (raw.state !== "starting" && raw.state !== "running" && raw.state !== "settled") return undefined;
  return raw as unknown as ForegroundRunMeta;
}

/** Writes the `starting` record. Throws on failure — the caller must not proceed to a spawn
 *  it could not record, which is the uncancellable-orphan hazard `background.ts:191-196`
 *  already refuses to accept on the durable path. */
export async function createForegroundRun(
  meta: Omit<ForegroundRunMeta, "runId">,
  options: RegistryRootOptions = {},
): Promise<string> {
  const root = resolveRoot(options);
  const { runId, runDir } = await newRunDir(root);
  await atomicWriteJson(join(runDir, "meta.json"), { ...meta, runId } satisfies ForegroundRunMeta);
  return runId;
}

/** Appends one spawned group and promotes the record to `running`. Serialised by the caller
 *  (one promise chain per run), so no lock is needed. Returns what it wrote so the caller can
 *  check `procStartTime` without re-reading the file (R3-8). Throws on failure. */
export async function recordForegroundGroup(
  registryId: string,
  pid: number,
  options: RegistryRootOptions = {},
): Promise<ForegroundGroup> {
  const root = resolveRoot(options);
  const meta = await readMeta(root, registryId);
  if (!meta) throw Object.assign(new Error(`foreground registry entry ${registryId} is missing or unreadable`), { code: "REGISTRY_WRITE_FAILED" });
  const startTime = await procStartTime(pid);
  const group: ForegroundGroup = { childPid: pid, ...(startTime !== undefined ? { procStartTime: startTime } : {}) };
  const next: ForegroundRunMeta = { ...meta, state: "running", groups: [...meta.groups, group] };
  await atomicWriteJson(metaPath(root, registryId), next);
  return group;
}

/** Stamps `settled`. Never deletes the directory: a reader that raced the settle must see a
 *  stamped record rather than an ENOENT it would have to interpret. */
export async function settleForegroundRun(registryId: string, options: RegistryRootOptions = {}): Promise<void> {
  const root = resolveRoot(options);
  const meta = await readMeta(root, registryId);
  if (!meta) throw Object.assign(new Error(`foreground registry entry ${registryId} is missing or unreadable`), { code: "REGISTRY_WRITE_FAILED" });
  if (meta.state === "settled") return;
  await atomicWriteJson(metaPath(root, registryId), { ...meta, state: "settled", settledAt: new Date().toISOString() } satisfies ForegroundRunMeta);
}

// ── Killing ───────────────────────────────────────────────────────────────────

/** Only ESRCH means dead. EPERM means "exists, not ours" — reported as unreachable, never as
 *  reaped. The lifecycle test helper's bare catch
 *  (ts/tests/connectors/background-codex-lifecycle.test.ts:34-41) gets this wrong and must not
 *  be copied here (invariant 13). */
function groupState(pid: number): "alive" | "gone" | "unknown" {
  try { process.kill(-pid, 0); return "alive"; }
  catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "gone" : "unknown";
  }
}

/** The four gates from `background.ts:444-452`, verbatim. Returns whether SIGTERM was sent. */
async function signalGroup(pid: number, expected: string | undefined): Promise<boolean> {
  if (!await processIdentityMatches(pid, expected)) return false;
  if (await processGroupId(pid) !== pid) return false;
  // Verify the start-time identity a second time immediately before the only signal.
  if (!await processIdentityMatches(pid, expected)) return false;
  try { process.kill(-pid, "SIGTERM"); } catch { return false; }
  return true;
}

const REAP_POLL_MS = 10;

/** SIGTERM → grace → SIGKILL → reap, for ONE group, using its RECORDED identity (R3-8). A
 *  `process.kill(-pid, …)` without the start-time token is a kill by pid alone, which is the
 *  recycled-pid hazard the four gates exist to close — so a call with no `startTime` signals
 *  nothing and reports `unreachable`. */
export async function killAndReapGroup(
  pid: number,
  options: { startTime?: string; graceMs?: number; timeoutMs?: number; deadlineAt?: number } & RegistryRootOptions = {},
): Promise<"reaped" | "unreachable" | "timeout"> {
  const deadline = options.deadlineAt ?? Date.now() + (options.timeoutMs ?? cancelTimeoutMs());
  const grace = options.graceMs ?? cancellationGraceMs();
  // No recorded identity, a mismatched one, a non-leader or a refused signal: there is no
  // group we can honestly claim to have killed (invariant 15b).
  if (!await signalGroup(pid, options.startTime)) return "unreachable";
  const escalateAt = Date.now() + grace;
  let escalated = false;
  let last: "alive" | "unknown" = "alive";
  while (Date.now() < deadline) {
    const state = groupState(pid);
    if (state === "gone") return "reaped";
    last = state;
    if (!escalated && Date.now() >= escalateAt) {
      escalated = true;
      try { process.kill(-pid, "SIGKILL"); } catch { /* raced its own exit */ }
    }
    await delay(REAP_POLL_MS);
  }
  const final = groupState(pid);
  if (final === "gone") return "reaped";
  return final === "unknown" || last === "unknown" ? "unreachable" : "timeout";
}

export function cancelTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.STRATUM_CANCEL_TIMEOUT_MS ?? 15000);
  if (!Number.isFinite(value) || value < 0) throw new Error("STRATUM_CANCEL_TIMEOUT_MS must be a nonnegative number");
  return value;
}

// ── The sweep ─────────────────────────────────────────────────────────────────

async function scan(root: string, flowRunId: string): Promise<Array<{ id: string; meta: ForegroundRunMeta }>> {
  let names: string[];
  try { names = await readdir(root); }
  catch (error) {
    // An empty registry is the normal case: most flows never dispatch a foreground agent.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const found: Array<{ id: string; meta: ForegroundRunMeta }> = [];
  for (const name of names) {
    if (!REGISTRY_ID.test(name)) continue;
    const meta = await readMeta(root, name);
    if (!meta || meta.flow.runId !== flowRunId) continue;
    found.push({ id: name, meta });
  }
  return found;
}

function absorb(accumulated: SignalledGroups, id: string, meta: ForegroundRunMeta): TrackedEntry {
  let entry = accumulated.entries.get(id);
  if (!entry) {
    entry = {
      groups: new Map(),
      state: meta.state,
      settled: meta.state === "settled",
      alreadySettled: meta.state === "settled",
      ...(typeof meta.serverPid === "number" ? { serverPid: meta.serverPid } : {}),
      ...(typeof meta.serverProcStartTime === "string" ? { serverProcStartTime: meta.serverProcStartTime } : {}),
    };
    accumulated.entries.set(id, entry);
  }
  entry.state = meta.state;
  if (meta.state === "settled") entry.settled = true;
  // Re-read the owner every pass rather than trusting the first observation: the record a
  // sweep first sees may be a `starting` one whose fields are still being filled in.
  if (typeof meta.serverPid === "number") entry.serverPid = meta.serverPid;
  else delete entry.serverPid;
  if (typeof meta.serverProcStartTime === "string") entry.serverProcStartTime = meta.serverProcStartTime;
  else delete entry.serverProcStartTime;
  for (const group of meta.groups) {
    if (typeof group.childPid !== "number") continue;
    if (entry.groups.has(group.childPid)) continue;
    entry.groups.set(group.childPid, {
      ...(group.procStartTime !== undefined ? { startTime: group.procStartTime } : {}),
      everSignalled: false,
    });
  }
  return entry;
}

/** Steps 1-2 of §2.4: enumerate the flow's unsettled entries and send each recorded group its
 *  one SIGTERM, through the four identity gates. The bookkeeping it returns is carried into
 *  `reapFlowAgents` so nothing is double-counted across the rescan passes. */
export async function signalFlowAgents(
  flowRunId: string,
  options: RegistryRootOptions = {},
): Promise<SignalledGroups> {
  const accumulated: SignalledGroups = { entries: new Map() };
  await sweepPass(resolveRoot(options), flowRunId, accumulated, { escalate: false });
  return accumulated;
}

async function sweepPass(
  root: string,
  flowRunId: string,
  accumulated: SignalledGroups,
  options: { escalate: boolean },
): Promise<void> {
  for (const { id, meta } of await scan(root, flowRunId)) {
    const entry = absorb(accumulated, id, meta);
    if (entry.settled) continue;
    for (const [pid, group] of entry.groups) {
      if (group.outcome === "reaped" || group.outcome === "unreachable") continue;
      if (!group.everSignalled) {
        if (await signalGroup(pid, group.startTime)) {
          group.everSignalled = true;
          group.outcome = "signalled";
        } else {
          // An identity mismatch means the pid is now some other process: the group we
          // recorded is gone too, but we never signalled it, so it is `unreachable`, not
          // `reaped`. Collapsing the two would let a recycled pid read as a teardown.
          group.outcome = "unreachable";
          continue;
        }
      }
      const state = groupState(pid);
      if (state === "gone") { group.outcome = "reaped"; delete group.lastProbe; continue; }
      group.lastProbe = state;
      if (options.escalate) { try { process.kill(-pid, "SIGKILL"); } catch { /* raced its own exit */ } }
    }
  }
}

function entryResolved(entry: TrackedEntry): boolean {
  if (entry.settled) return true;
  if (entry.state === "starting") return false;
  // Multi-group Claude entries (C9) follow the same rule: every pid must be resolved.
  for (const group of entry.groups.values()) {
    if (group.outcome !== "reaped" && group.outcome !== "unreachable") return false;
  }
  return entry.groups.size > 0;
}

/** Steps 3-5 of §2.4: grace, escalation, reap and rescan, all under ONE absolute deadline.
 *  The loop re-reads the directory rather than trusting one snapshot, because an entry can
 *  move `starting → running` while the sweep is in progress. */
export async function reapFlowAgents(
  flowRunId: string,
  signalled: SignalledGroups,
  options: SweepOptions = {},
): Promise<AgentCancelSummary> {
  const root = resolveRoot(options);
  const deadline = options.deadlineAt ?? Date.now() + (options.timeoutMs ?? cancelTimeoutMs());
  const escalateAt = Date.now() + (options.graceMs ?? cancellationGraceMs());
  const identity = options.identity ?? processIdentity;
  while (true) {
    await sweepPass(root, flowRunId, signalled, { escalate: Date.now() >= escalateAt });
    await applyDeadOwnerException(root, signalled, identity);
    if ([...signalled.entries.values()].every(entryResolved)) break;
    if (Date.now() >= deadline) break;
    await delay(REAP_POLL_MS);
  }
  // At the deadline a standing `unknown` is the final answer: EPERM means "exists, not ours",
  // which is never a reap and never a licence to acknowledge (invariant 13).
  for (const entry of signalled.entries.values()) {
    for (const group of entry.groups.values()) {
      if (group.outcome === "signalled" && group.lastProbe === "unknown") group.outcome = "unreachable";
    }
  }
  return summarise(signalled);
}

/** Convenience for callers that do not need to interleave a local teardown between the two
 *  phases (S03 does; the CLI and the tests mostly do not). */
export async function cancelFlowAgents(
  flowRunId: string,
  options: SweepOptions = {},
): Promise<AgentCancelSummary> {
  return reapFlowAgents(flowRunId, await signalFlowAgents(flowRunId, options), options);
}

/** The sweep stamps `settled` itself ONLY when the owning server is PROVABLY dead and every
 *  recorded group is resolved (R3-6, R4-3). A pid-only check would read a recycled pid as "the
 *  server is gone" and stamp a live dispatcher's entry settled, so the owner's start time is
 *  required — an entry written without `serverProcStartTime` is never eligible. And the probe
 *  is the TRI-STATE one: `unknown` (EPERM, or a start time we could not read) is never a
 *  licence to reclaim another process's record. */
async function applyDeadOwnerException(root: string, accumulated: SignalledGroups, identity: ProcessIdentity): Promise<void> {
  for (const [id, entry] of accumulated.entries) {
    if (entry.settled || entry.state === "starting") continue;
    if (entry.serverPid === undefined || entry.serverProcStartTime === undefined) continue;
    if (entry.groups.size === 0) continue;
    let resolved = true;
    for (const group of entry.groups.values()) {
      if (group.outcome !== "reaped" && group.outcome !== "unreachable") { resolved = false; break; }
    }
    if (!resolved) continue;
    if (await identity(entry.serverPid, entry.serverProcStartTime) !== "dead") continue;
    try { await settleForegroundRun(id, { registryRoot: root }); entry.settled = true; }
    catch { /* a stale entry is reported as unsettled rather than claimed */ }
  }
}

function summarise(accumulated: SignalledGroups): AgentCancelSummary {
  const summary: AgentCancelSummary = { signalled: 0, reaped: 0, unreachable: 0, alreadySettled: 0, unresolved: 0, unsettled: 0 };
  for (const entry of accumulated.entries.values()) {
    if (entry.alreadySettled) { summary.alreadySettled += 1; continue; }
    for (const group of entry.groups.values()) {
      if (group.everSignalled) summary.signalled += 1;
      if (group.outcome === "reaped") summary.reaped += 1;
      else if (group.outcome === "unreachable") summary.unreachable += 1;
    }
    if (entry.state === "starting" && !entry.settled) summary.unresolved += 1;
    if (!entry.settled) summary.unsettled += 1;
  }
  return summary;
}
