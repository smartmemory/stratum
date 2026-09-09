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

/** The four OS probes every signal decision is built on, as one injectable bundle.
 *
 *  A test cannot otherwise reach the case F6 is about — an identity that is valid when SIGTERM
 *  is sent and stale by the time SIGKILL would be — because the real probes answer about real
 *  processes and cannot be made to change their answer between two points in one call. */
export interface ProcessProbes {
  startTime: (pid: number) => Promise<string | undefined>;
  groupId: (pid: number) => Promise<number | undefined>;
  groupState: (pid: number) => "alive" | "gone" | "unknown";
  kill: (pid: number, signal: NodeJS.Signals) => void;
}

const REAL_PROBES: ProcessProbes = {
  startTime: procStartTime,
  groupId: processGroupId,
  groupState: (pid) => realGroupState(pid),
  kill: (pid, signal) => { process.kill(-pid, signal); },
};

function resolveProbes(options: { probes?: Partial<ProcessProbes> }): ProcessProbes {
  return options.probes === undefined ? REAL_PROBES : { ...REAL_PROBES, ...options.probes };
}

export interface SweepOptions extends RegistryRootOptions {
  timeoutMs?: number;
  graceMs?: number;
  /** One absolute deadline for the whole teardown, overriding `timeoutMs` (S03 computes it
   *  after settlement so the phases share one budget). It bounds the SIGNAL pass too: a reap
   *  pass that overruns must not be followed by a signal nobody is left to wait on. */
  deadlineAt?: number;
  /** Identity oracle seam, mirroring `RunLockOptions.identity`. Production uses the tri-state
   *  probe; a test injects a deterministic answer. */
  identity?: ProcessIdentity;
  /** Signal-path probe seam (see ProcessProbes). */
  probes?: Partial<ProcessProbes>;
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
  /** Groups confirmed gone (ESRCH on the group probe) before the deadline, AFTER we signalled
   *  them. */
  reaped: number;
  /** Groups that were ALREADY gone when the sweep first probed them — ESRCH on the group,
   *  before any signal of ours. A resolved state, and an acknowledgeable one: the agent exited
   *  on its own before the cancel arrived, which is the outcome the cancel wanted.
   *
   *  Kept apart from `reaped` because `reaped` is a claim that WE tore it down, and apart from
   *  `unreachable` because an entry that can never be acknowledged is exactly the bug this
   *  counter fixes: a group gone before SIGTERM used to fail the first identity gate and be
   *  recorded unreachable, so a flow whose agent had already exited could never report
   *  `acknowledged: true`. */
  gone: number;
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
  /** Groups that reached the deadline in no final state at all — signalled and still answering
   *  the group probe, or never signalled because the deadline expired first.
   *
   *  This is what acknowledgement tests, in place of the old `signalled === reaped` equality.
   *  That equality was wrong in both directions: a group already gone before SIGTERM is never
   *  counted `signalled`, so a perfectly torn-down flow failed it, and a group signalled and
   *  later found unreachable made it accidentally true. */
  unreaped: number;
}

type GroupOutcome = "signalled" | "reaped" | "gone" | "unreachable";

interface TrackedGroup {
  startTime?: string;
  everSignalled: boolean;
  outcome?: GroupOutcome;
  /** The instant this group may be escalated to SIGKILL, recorded when ITS SIGTERM was sent.
   *  A single sweep-wide clock started before the signal pass gives a group signalled late in
   *  that pass less than the configured grace — and a group signalled by a rescan, none at
   *  all. The grace is a promise to each child, so each child's clock starts at its own
   *  SIGTERM. */
  escalateAt?: number;
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
function realGroupState(pid: number): "alive" | "gone" | "unknown" {
  try { process.kill(-pid, 0); return "alive"; }
  catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH" ? "gone" : "unknown";
  }
}

/** Every probe on the signal path is an `await` on another process, and an unbounded one turns
 *  the caller's absolute deadline into a suggestion (F6). A probe that has not answered by the
 *  deadline yields no verdict at all — `undefined` — and the caller stops rather than acting on
 *  an answer nobody is still waiting for. */
async function bounded<T>(work: Promise<T>, deadline: number): Promise<{ value: T } | undefined> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) { void work.catch(() => undefined); return undefined; }
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), remaining);
    timer.unref?.();
  });
  try { return await Promise.race([work.then((value) => ({ value })), expiry]); }
  finally { clearTimeout(timer); }
}

type IdentityVerdict = "match" | "mismatch" | "deadline";

async function identityVerdict(
  probes: ProcessProbes,
  pid: number,
  expected: string | undefined,
  deadline: number,
): Promise<IdentityVerdict> {
  if (!expected) return "mismatch";
  const probed = await bounded(probes.startTime(pid), deadline);
  if (probed === undefined) return "deadline";
  return probed.value === expected ? "match" : "mismatch";
}

/**
 * The four gates from `background.ts:444-452`, plus the prior question they never asked.
 *
 * TRI-STATE, because "we did not signal it" is two different facts. A group that is already
 * gone (ESRCH on the group probe) is RESOLVED — the thing we wanted dead is dead — while a
 * group whose identity does not match, or cannot be read, is UNREACHABLE and can never be
 * acknowledged. The old boolean collapsed both into `false` and recorded both as unreachable,
 * so an agent that exited a moment before the cancel arrived permanently blocked the
 * acknowledgement of a teardown that had already happened.
 */
async function signalGroup(
  probes: ProcessProbes,
  pid: number,
  expected: string | undefined,
  deadline: number,
): Promise<"signalled" | "gone" | "unreachable" | "deadline"> {
  if (Date.now() >= deadline) return "deadline";
  if (probes.groupState(pid) === "gone") return "gone";
  const first = await identityVerdict(probes, pid, expected, deadline);
  if (first === "deadline") return "deadline";
  if (first === "mismatch") {
    // Re-probe: the identity may have failed to read BECAUSE the process exited between the
    // group probe above and here, which is a `gone`, not an unreachable.
    return probes.groupState(pid) === "gone" ? "gone" : "unreachable";
  }
  const leader = await bounded(probes.groupId(pid), deadline);
  if (leader === undefined) return "deadline";
  if (leader.value !== pid) return "unreachable";
  // Verify the start-time identity a second time immediately before the only signal.
  const second = await identityVerdict(probes, pid, expected, deadline);
  if (second === "deadline") return "deadline";
  if (second === "mismatch") return "unreachable";
  // The LAST word before the signal is the clock (F6). A SIGTERM sent after the caller's
  // deadline has no grace window left to run in and no reap pass left to confirm it: it is a
  // signal delivered to a child nobody is waiting on.
  if (Date.now() >= deadline) return "deadline";
  try { probes.kill(pid, "SIGTERM"); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? "gone" : "unreachable"; }
  return "signalled";
}

/**
 * SIGKILL escalation, through the SAME gates as the SIGTERM — re-run here, immediately before
 * the signal, never inherited from the earlier pass.
 *
 * The escalation used to be a bare `process.kill(-pid, "SIGKILL")` on the recorded number. The
 * gap between SIGTERM and SIGKILL is the grace window, by construction the longest pause in the
 * whole teardown, and it is exactly the window in which the group leader exits and its pid is
 * handed to something else. A kill by pid alone at the end of it is a SIGKILL delivered to a
 * stranger's process group.
 */
async function escalateGroup(
  probes: ProcessProbes,
  pid: number,
  expected: string | undefined,
  deadline: number,
): Promise<"escalated" | "gone" | "unreachable" | "deadline"> {
  if (Date.now() >= deadline) return "deadline";
  if (probes.groupState(pid) === "gone") return "gone";
  const first = await identityVerdict(probes, pid, expected, deadline);
  if (first === "deadline") return "deadline";
  if (first === "mismatch") {
    return probes.groupState(pid) === "gone" ? "gone" : "unreachable";
  }
  const leader = await bounded(probes.groupId(pid), deadline);
  if (leader === undefined) return "deadline";
  if (leader.value !== pid) return "unreachable";
  // F5: the identity is checked AGAIN after the group-leader probe, immediately before the
  // SIGKILL — never inherited across that await. The whole reason the escalation re-runs the
  // gates is that a pid can be reissued while they run; a check that stops one await short of
  // the signal reintroduces exactly the window it was added to close.
  const second = await identityVerdict(probes, pid, expected, deadline);
  if (second === "deadline") return "deadline";
  if (second === "mismatch") return "unreachable";
  if (Date.now() >= deadline) return "deadline";
  try { probes.kill(pid, "SIGKILL"); }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH" ? "gone" : "unreachable"; }
  return "escalated";
}

const REAP_POLL_MS = 10;

/** SIGTERM → grace → SIGKILL → reap, for ONE group, using its RECORDED identity (R3-8). A
 *  `process.kill(-pid, …)` without the start-time token is a kill by pid alone, which is the
 *  recycled-pid hazard the four gates exist to close — so a call with no `startTime` signals
 *  nothing and reports `unreachable`. */
export async function killAndReapGroup(
  pid: number,
  options: { startTime?: string; graceMs?: number; timeoutMs?: number; deadlineAt?: number; probes?: Partial<ProcessProbes> } & RegistryRootOptions = {},
): Promise<"reaped" | "gone" | "unreachable" | "timeout"> {
  const probes = resolveProbes(options);
  const deadline = options.deadlineAt ?? Date.now() + requireDuration(options.timeoutMs ?? cancelTimeoutMs(), "timeoutMs");
  const grace = requireDuration(options.graceMs ?? cancellationGraceMs(), "graceMs");
  // No recorded identity, a mismatched one, a non-leader or a refused signal: there is no
  // group we can honestly claim to have killed (invariant 15b). A group already gone is a
  // different answer entirely, and a resolved one.
  //
  // The deadline goes IN (F6). Without it this call could send its SIGTERM after the caller's
  // budget had already expired, then report a timeout for a signal it had just issued.
  const signal = await signalGroup(probes, pid, options.startTime, deadline);
  if (signal === "deadline") return "timeout";
  if (signal !== "signalled") return signal;
  // The grace clock starts at OUR SIGTERM, not at the top of the call.
  const escalateAt = Date.now() + grace;
  let escalated = false;
  let last: "alive" | "unknown" = "alive";
  while (Date.now() < deadline) {
    const state = probes.groupState(pid);
    if (state === "gone") return "reaped";
    last = state;
    if (!escalated && Date.now() >= escalateAt) {
      escalated = true;
      const result = await escalateGroup(probes, pid, options.startTime, deadline);
      if (result === "gone") return "reaped";
      if (result === "unreachable") return "unreachable";
    }
    await delay(REAP_POLL_MS);
  }
  const final = probes.groupState(pid);
  if (final === "gone") return "reaped";
  return final === "unknown" || last === "unknown" ? "unreachable" : "timeout";
}

export function cancelTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const value = Number(env.STRATUM_CANCEL_TIMEOUT_MS ?? 15000);
  if (!Number.isFinite(value) || value < 0) throw new Error("STRATUM_CANCEL_TIMEOUT_MS must be a nonnegative number");
  return value;
}

/** A caller-supplied budget gets the same treatment as an env one (F6): `Date.now() + NaN` is
 *  NaN, `Date.now() >= NaN` is false forever, and the reap loop that trusts it never ends. */
function requireDuration(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a nonnegative finite number`);
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
  options: SweepOptions = {},
): Promise<SignalledGroups> {
  const accumulated: SignalledGroups = { entries: new Map() };
  // The SIGNAL pass shares the caller's one absolute deadline (R3-5). Without it a slow scan
  // can hand the reap a budget that is already spent, and — worse — keep sending SIGTERMs
  // after the caller has given up waiting for anything to answer them.
  await sweepPass(resolveRoot(options), flowRunId, accumulated, {
    escalate: false,
    deadline: options.deadlineAt ?? Date.now() + requireDuration(options.timeoutMs ?? cancelTimeoutMs(), "timeoutMs"),
    graceMs: requireDuration(options.graceMs ?? cancellationGraceMs(), "graceMs"),
    probes: resolveProbes(options),
  });
  return accumulated;
}

async function sweepPass(
  root: string,
  flowRunId: string,
  accumulated: SignalledGroups,
  options: { escalate: boolean; deadline: number; graceMs: number; probes: ProcessProbes },
): Promise<void> {
  const { probes } = options;
  for (const { id, meta } of await scan(root, flowRunId)) {
    const entry = absorb(accumulated, id, meta);
    for (const [pid, group] of entry.groups) {
      if (group.outcome === "reaped" || group.outcome === "gone" || group.outcome === "unreachable") continue;
      // A settled entry is never SIGNALLED again (invariant 14) — but its already-signalled
      // groups are still PROBED below. Skipping a settled entry outright leaves the probe
      // taken during the signal pass as the final verdict, and that probe is `unknown` for
      // the whole window in which the leader is dead but not yet reaped by its parent — so
      // an agent whose teardown demonstrably completed would be reported `unreachable` and
      // could never be acknowledged.
      if (entry.settled && !group.everSignalled) continue;
      if (!group.everSignalled) {
        // Past the deadline nothing new is signalled: a SIGTERM sent now has no grace window
        // left to run in and no reap pass left to confirm it. The group stays unresolved and
        // is reported as such, which is the honest answer.
        if (Date.now() >= options.deadline) continue;
        const signal = await signalGroup(probes, pid, group.startTime, options.deadline);
        // The deadline expired inside the gates: no signal was sent, so the group is left
        // unresolved and reported as such rather than given a verdict nobody probed for.
        if (signal === "deadline") continue;
        if (signal === "gone") { group.outcome = "gone"; delete group.lastProbe; continue; }
        if (signal === "unreachable") {
          // An identity mismatch means the pid is now some other process: the group we
          // recorded is gone too, but we never signalled it, and we cannot prove which — so
          // it is `unreachable`, not `gone`. Collapsing the two would let a recycled pid read
          // as a teardown.
          group.outcome = "unreachable";
          continue;
        }
        group.everSignalled = true;
        group.outcome = "signalled";
        // Per-group grace, clocked from THIS SIGTERM (F5).
        group.escalateAt = Date.now() + options.graceMs;
      }
      const state = probes.groupState(pid);
      if (state === "gone") { group.outcome = "reaped"; delete group.lastProbe; continue; }
      group.lastProbe = state;
      const escalateAt = group.escalateAt ?? options.deadline;
      if (options.escalate && !entry.settled && Date.now() >= escalateAt && Date.now() < options.deadline) {
        // F6: the identity and group-leader gates are re-run here, immediately before the
        // SIGKILL. The grace window is long enough for the leader to exit and its pid to be
        // reissued, and a kill by bare pgid at the end of it lands on a stranger.
        const result = await escalateGroup(probes, pid, group.startTime, options.deadline);
        if (result === "deadline") continue;
        if (result === "gone") { group.outcome = "reaped"; delete group.lastProbe; continue; }
        if (result === "unreachable") { group.outcome = "unreachable"; delete group.lastProbe; }
      }
    }
  }
}

function resolvedOutcome(outcome: GroupOutcome | undefined): boolean {
  return outcome === "reaped" || outcome === "gone" || outcome === "unreachable";
}

function entryResolved(entry: TrackedEntry): boolean {
  // Multi-group Claude entries (C9) follow the same rule: every pid must be resolved.
  for (const group of entry.groups.values()) {
    // A group this sweep never signalled belongs to an entry that was already settled when we
    // arrived: it is not ours to tear down and never blocks resolution. A group we DID signal
    // blocks it until the probe answers, settled entry or not — the entry settling says the
    // dispatcher unwound, not that the process group is gone.
    if (entry.settled && !group.everSignalled) continue;
    if (!resolvedOutcome(group.outcome)) return false;
  }
  // Reaping the groups is not the same as the entry being over, and `summarise` says so:
  // it counts every unsettled entry as `unsettled` whatever its groups did (R3-6). Breaking
  // the poll here would stop watching an entry the owning dispatcher is still unwinding and
  // then report that as a teardown failure — so an unsettled entry keeps the poll alive until
  // it settles or the deadline answers for it.
  return entry.settled;
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
  const deadline = options.deadlineAt ?? Date.now() + requireDuration(options.timeoutMs ?? cancelTimeoutMs(), "timeoutMs");
  const graceMs = requireDuration(options.graceMs ?? cancellationGraceMs(), "graceMs");
  const identity = options.identity ?? processIdentity;
  const probes = resolveProbes(options);
  while (true) {
    // `escalate: true` unconditionally: each group carries its OWN escalation instant now, so
    // the pass decides per group rather than off one clock that started before some of them
    // had even been signalled.
    await sweepPass(root, flowRunId, signalled, { escalate: true, deadline, graceMs, probes });
    await applyDeadOwnerException(root, signalled, identity, deadline);
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
async function applyDeadOwnerException(root: string, accumulated: SignalledGroups, identity: ProcessIdentity, deadline: number): Promise<void> {
  for (const [id, entry] of accumulated.entries) {
    if (entry.settled || entry.state === "starting") continue;
    if (entry.serverPid === undefined || entry.serverProcStartTime === undefined) continue;
    if (entry.groups.size === 0) continue;
    let resolved = true;
    for (const group of entry.groups.values()) {
      if (!resolvedOutcome(group.outcome)) { resolved = false; break; }
    }
    if (!resolved) continue;
    // Bounded like every other probe on this path (F6): the owner probe is a shell-out on
    // darwin, and an unbounded one lets a single slow answer run the reap loop past the
    // caller's deadline.
    const owner = await bounded(identity(entry.serverPid, entry.serverProcStartTime), deadline);
    if (owner === undefined || owner.value !== "dead") continue;
    try { await settleForegroundRun(id, { registryRoot: root }); entry.settled = true; }
    catch { /* a stale entry is reported as unsettled rather than claimed */ }
  }
}

function summarise(accumulated: SignalledGroups): AgentCancelSummary {
  const summary: AgentCancelSummary = { signalled: 0, reaped: 0, gone: 0, unreachable: 0, alreadySettled: 0, unresolved: 0, unsettled: 0, unreaped: 0 };
  for (const entry of accumulated.entries.values()) {
    if (entry.alreadySettled) { summary.alreadySettled += 1; continue; }
    for (const group of entry.groups.values()) {
      // F7: the SAME exclusion `sweepPass` and `entryResolved` already apply. A group belonging
      // to an entry that settled before we signalled it is not ours to tear down — the sweep
      // deliberately never signals it and `entryResolved` deliberately ignores it — so counting
      // its absent outcome as `unreaped` here contradicted both and turned an entry that went
      // `starting → settled` mid-sweep into a teardown timeout for a group nobody touched.
      //
      // ONLY the outcome-less ones. A group that was probed and found `gone` on a settled entry
      // is a real, reported verdict; dropping it too would hide the very counter that lets a
      // flow whose agent exited on its own be acknowledged.
      if (entry.settled && !group.everSignalled && group.outcome === undefined) continue;
      if (group.everSignalled) summary.signalled += 1;
      if (group.outcome === "reaped") summary.reaped += 1;
      else if (group.outcome === "gone") summary.gone += 1;
      else if (group.outcome === "unreachable") summary.unreachable += 1;
      else summary.unreaped += 1;
    }
    if (entry.state === "starting" && !entry.settled) summary.unresolved += 1;
    if (!entry.settled) summary.unsettled += 1;
  }
  return summary;
}
