import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, readdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { processIdentity } from "./proc_identity.js";

/**
 * STRAT-AGENT-DEVIN-1 slice S1b (D2) — the supervisor wrapper and the run-dir
 * layout shared by the foreground connector now and the background path in S2.
 *
 * runDir (mode 0700, under the protected root S) holds ONLY supervisor files —
 * the agent can never write here (D3's profile grants nothing outside A):
 *
 *   runDir/
 *     meta.json       wrapper pid + procStartTime + run bookkeeping (sweep input)
 *     prompt.md       0600 — prompts are private and argv is visible in ps
 *     devin.sb        0600 — generated seatbelt profile (sandboxed modes only)
 *     wrapper.sh      0700 — this module's DEVIN_WRAPPER_SCRIPT
 *     stream.jsonl    supervisor-only: exactly the wrapper's sentinel line
 *     stdout.log      devin's raw stdout (the narration stream, never parsed
 *                     for the sentinel — devin's text is unwrapped, so an agent
 *                     that prints {"__t2f5_done__":0} forges nothing)
 *     .err            devin's raw stderr
 *     exit.rc         the wrapper's atomic exit-status channel (never stdout)
 *     agent.done      created by the wrapper's runner once devin is reaped
 *                     (the wrapper's liveness signal; never a kill by pid)
 *     agent/          A — the ONLY agent-writable area
 *       home/{data,cache,config,state}   per-run devin home (XDG redirects)
 *       home/config/devin/config.json    stratum-owned config (permissions.allow:[])
 *       home/config/devin/mcp_config.json  copy of the owner's (MCP equality)
 *       home/data/devin/credentials.toml 0600 — copied by the WRAPPER, deleted
 *                                          by its trap (exists only while a
 *                                          wrapper that will remove it lives)
 *       tmp/          TMPDIR
 *       trajectory.json  ATIF export (the result channel)
 *       wire.log      ACP thinking signal (private, retained with run logs)
 */

export interface DevinRunLayout {
  runDir: string;
  /** A — the only agent-writable area. */
  agentDir: string;
  homeDir: string;
  tmpDir: string;
  exportPath: string;
  wireLogPath: string;
  promptPath: string;
  profilePath: string;
  wrapperPath: string;
  streamPath: string;
  stdoutPath: string;
  stderrPath: string;
  exitRcPath: string;
  metaPath: string;
  credentialsCopyPath: string;
  devinConfigPath: string;
  mcpConfigPath: string;
}

export function devinRunLayout(runDir: string): DevinRunLayout {
  const agentDir = join(runDir, "agent");
  const homeDir = join(agentDir, "home");
  return {
    runDir,
    agentDir,
    homeDir,
    tmpDir: join(agentDir, "tmp"),
    exportPath: join(agentDir, "trajectory.json"),
    wireLogPath: join(agentDir, "wire.log"),
    promptPath: join(runDir, "prompt.md"),
    profilePath: join(runDir, "devin.sb"),
    wrapperPath: join(runDir, "wrapper.sh"),
    streamPath: join(runDir, "stream.jsonl"),
    stdoutPath: join(runDir, "stdout.log"),
    stderrPath: join(runDir, ".err"),
    exitRcPath: join(runDir, "exit.rc"),
    metaPath: join(runDir, "meta.json"),
    credentialsCopyPath: join(homeDir, "data", "devin", "credentials.toml"),
    devinConfigPath: join(homeDir, "config", "devin", "config.json"),
    mcpConfigPath: join(homeDir, "config", "devin", "mcp_config.json"),
  };
}

/** Where the owner's devin state lives, keyed off the dispatch env's HOME so a
 *  test that redirects HOME redirects every one of these (never the real
 *  ~/.local/share/devin or ~/.stratum). */
export interface DevinHomePaths {
  home: string;
  credentialsSource: string;
  mcpConfigSource: string;
  /** S — the protected state root the grant check defends. */
  stratumRoot: string;
  agentRunsRoot: string;
  devinFgRoot: string;
}

export function devinHomePaths(env: NodeJS.ProcessEnv, fallbackHome: string): DevinHomePaths {
  const home = env.HOME && env.HOME.length > 0 ? env.HOME : fallbackHome;
  const stratumRoot = join(home, ".stratum");
  return {
    home,
    credentialsSource: join(home, ".local", "share", "devin", "credentials.toml"),
    mcpConfigSource: join(home, ".config", "devin", "mcp_config.json"),
    stratumRoot,
    agentRunsRoot: join(stratumRoot, "ts", "agent_runs"),
    devinFgRoot: join(stratumRoot, "ts", "devin_fg"),
  };
}

/**
 * The stratum-owned devin config (D3): `permissions.allow: []` makes the
 * owner's ambient allow-list moot (under --permission-mode dangerous the OS
 * decides anyway) and `shell.setup_complete` keeps the first-run banner off
 * stdout. --config leaves MCP config alone (verified fact 10).
 */
export const DEVIN_CONFIG_JSON = JSON.stringify({
  version: 1,
  permissions: { allow: [] },
  shell: { setup_complete: true },
}, null, 2);

/**
 * The supervisor shell (D2). Runs OUTSIDE the seatbelt; argv arrives as "$@"
 * so the same text serves foreground and background.
 *
 * The trap is installed BEFORE the copy, so every exit that runs a handler
 * removes the credentials copy — normal devin exit, devin signal death, a
 * sandbox-exec that failed to start, and stratum's own cancel (a group
 * SIGTERM). The copy therefore exists only while a wrapper that will delete
 * it is alive. The only handler-less exit is SIGKILL to this process, which
 * the dispatch-time sweep below covers.
 *
 * stdout/stderr are NOT redirected here: the supervisor owns them via the
 * spawn's stdio (a pipe for the foreground overrun rule, a plain file fd for
 * background — D2's codex-parity bounds).
 */
export const DEVIN_WRAPPER_SCRIPT = `#!/bin/sh
# STRAT-AGENT-DEVIN-1 supervisor wrapper — owns the credentials copy's life.
# STRAT-DEVIN-TRAP-1: HUP/INT/TERM end the wrapper in every window (before cp,
# during cp, before the agent starts, while it runs, during the normal-exit
# tail) with rc 128+signo; a handler never returns into the script on the
# cancel path, so a cancel is never consumed. The agent runs in the background
# and the wrapper polls it with short foreground sleeps: this shell runs a
# pending trap only when a foreground command ends (and may lose one that lands
# before a wait starts), so a signal that landed between commands would
# otherwise be held until the agent finished. sleep 0 before the spawn is the
# same checkpoint, so a cancel that landed earlier stops the wrapper before the
# agent starts.
# pending_rc is the first signal's 128+signo; published means the status is
# written; busy means a handler or finish already owns the ending, so a further
# signal only records pending_rc and returns. A handler revokes the credentials
# copy FIRST, then TERMs the run's process group, waits a bounded 2 s
# (10 x 0.2 s, under the 5 s watchdog grace) for the agent to end, reaps it and
# publishes; an agent still running then is KILLed with the group right after
# publication (STRAT-DEVIN-TRAP-FU-3, below).
# Terminal boundary (STRAT-DEVIN-TRAP-FU-1): finish revokes the copy, then
# SELECTS the status: out_rc=$pending_rc is the last read of pending_rc. A
# signal that lands before that read wins (its 128+signo is the status). A
# signal after it changes nothing: the copy is already gone and the agent is
# reaped or marked for the group KILL, so nothing is left to cancel, and the
# run publishes the status it selected. Every step of the tail re-runs until its postcondition holds,
# so a handled signal (which can kill the tail's external rm, mv or sleep)
# costs one attempt, never the step, and SIGKILL is the only way out of it:
# revoke loops until no regular file is left at the copy path, and the status
# is selected only after that; exit.rc is rewritten until reading it back
# gives the selected status, and only then is the one sentinel appended and
# published set. The EXIT trap and a handler that finds the run published
# revoke the same way before exiting, so no handled exit leaves the copy, and
# exit.rc, the sentinel and the process rc are equal (except a TERM-ignoring
# agent's run, whose wrapper process then ends by its own group KILL). A step that can never
# succeed (a disk that stays full, a copy the agent made unremovable) holds the
# wrapper until SIGKILL, which the dispatch-time sweep covers. echo, read and
# printf are builtins, which a trap cannot split.
# Signals (STRAT-DEVIN-TRAP-FU-3): no kill in this script names a pid. Both
# bash and dash reap a finished background child at a point they choose (even
# between two builtins), after which its number can be reused, so a kill by the
# agent's pid could reach a stranger. Every kill here addresses group 0, the
# caller's own process group, which the kernel resolves at the call. Stratum
# spawns the wrapper detached, so it leads a new session and group, and only
# its descendants can be in that group. Before the agent exists the wrapper
# checks that it leads its group (ps pgid = $$); if not, group 0 would be its
# parent's, so it refuses with rc 125 and never starts the agent.
# Liveness needs no kill either: the agent runs under a runner subshell that
# catches HUP/TERM (devin gets the default actions; INT stays ignored for the
# background list), reaps devin in the foreground, creates agent.done in the
# run dir and exits with devin's status, which wait (own children only) then
# returns. The handler sends TERM to the group (the wrapper, busy, only records
# it), waits up to 2 s for agent.done, and if the agent is still there marks
# escalate and publishes the selected status; every exit after that (the
# handler's own, one taken by a signal that lands after publication, the EXIT
# trap) first sends KILL to the group, which ends the wrapper too. The KILL is
# written out at each exit rather than left to the EXIT trap alone: in bash 3.2
# a signal still pending at exit (the wrapper's own TERM from kill -TERM 0)
# runs its trap first, and that trap's exit skips the EXIT trap (dash runs it). So a TERM-ignoring agent ends
# with exit.rc and the sentinel at 128+signo and the wrapper's own process
# status SIGKILL. busy is set while the wrapper forks a shell child (the runner
# and the ps command substitution): bash can run the parent's trap inside such
# a child before the child resets its traps, and a child that ran the full
# handler would publish a second sentinel. The child now only records
# pending_rc and returns; the parent then clears busy and replays a signal it
# deferred meanwhile (release).
trap 'fall' EXIT
pending_rc=""
out_rc=""
published=""
busy=""
agent=""
escalate=""
done_mark="$STRATUM_DEVIN_RUN_DIR/agent.done"
fall() {
  revoke
  [ -z "$escalate" ] || kill -KILL 0
}
revoke() {
  while [ -f "$STRATUM_DEVIN_CREDS_COPY" ]; do rm -f "$STRATUM_DEVIN_CREDS_COPY" || sleep 0.1; done
}
finish() {
  busy=1
  revoke
  out_rc=$pending_rc
  [ -z "$out_rc" ] && out_rc=$1
  while got=""; [ -f "$STRATUM_DEVIN_RUN_DIR/exit.rc" ] && read got < "$STRATUM_DEVIN_RUN_DIR/exit.rc"; [ "$got" != "$out_rc" ]; do
    echo "$out_rc" > "$STRATUM_DEVIN_RUN_DIR/exit.rc.tmp" && mv "$STRATUM_DEVIN_RUN_DIR/exit.rc.tmp" "$STRATUM_DEVIN_RUN_DIR/exit.rc" || sleep 0.1
  done
  printf '{"__t2f5_done__":%d}\\n' "$out_rc" >> "$STRATUM_DEVIN_RUN_DIR/stream.jsonl"
  published=1
}
release() {
  busy=""
  [ -z "$pending_rc" ] || on_signal "$pending_rc"
}
on_signal() {
  [ -z "$pending_rc" ] && pending_rc=$1
  [ -n "$published" ] && { fall; exit "$out_rc"; }
  [ -n "$busy" ] && return
  busy=1
  revoke
  if [ -n "$agent" ]; then
    if [ ! -f "$done_mark" ]; then
      kill -TERM 0 2>/dev/null
      n=0
      while [ ! -f "$done_mark" ]; do
        if [ "$n" -ge 10 ]; then escalate=1; break; fi
        sleep 0.2
        n=$((n+1))
      done
    fi
    [ -n "$escalate" ] || wait "$agent" 2>/dev/null
  fi
  finish "$pending_rc"
  fall
  exit "$out_rc"
}
trap 'on_signal 129' HUP
trap 'on_signal 130' INT
trap 'on_signal 143' TERM
busy=1
group=$(ps -o pgid= -p $$ 2>/dev/null)
release
if [ "\${group##* }" != "$$" ]; then
  echo "stratum devin wrapper: pid $$ does not lead its process group (pgid \${group:-unknown}); refusing to start the agent" >&2
  finish 125
  exit "$out_rc"
fi
cp "$STRATUM_DEVIN_CREDS_SOURCE" "$STRATUM_DEVIN_CREDS_COPY" && chmod 600 "$STRATUM_DEVIN_CREDS_COPY"
sleep 0
busy=1
{ trap : HUP TERM; "$@" < /dev/null; rc=$?; until [ -f "$done_mark" ]; do : > "$done_mark" || sleep 0.1; done; exit "$rc"; } &
agent=$!
release
while [ ! -f "$done_mark" ]; do sleep 0.2; done
wait "$agent"
rc=$?
finish "$rc"
exit "$out_rc"
`;

/** Env the wrapper consumes; also the test seam a fake spawn reads. */
export function devinWrapperEnv(layout: DevinRunLayout, credentialsSource: string): Record<string, string> {
  return {
    STRATUM_DEVIN_RUN_DIR: layout.runDir,
    STRATUM_DEVIN_CREDS_SOURCE: credentialsSource,
    STRATUM_DEVIN_CREDS_COPY: layout.credentialsCopyPath,
  };
}

/** XDG/TMPDIR redirects that give the run its private devin home (D2). */
export function devinHomeEnv(layout: DevinRunLayout): Record<string, string> {
  return {
    XDG_DATA_HOME: join(layout.homeDir, "data"),
    XDG_CACHE_HOME: join(layout.homeDir, "cache"),
    XDG_CONFIG_HOME: join(layout.homeDir, "config"),
    XDG_STATE_HOME: join(layout.homeDir, "state"),
    TMPDIR: `${layout.tmpDir}/`,
  };
}

/**
 * Pre-spawn setup: the per-run home skeleton plus the two files stratum owns.
 * The credentials copy is the WRAPPER's job (its trap must be armed first).
 * A missing mcp_config.json is fine — devin runs without it.
 */
export async function prepareDevinRunHome(layout: DevinRunLayout, mcpConfigSource: string): Promise<void> {
  await Promise.all([
    mkdir(join(layout.homeDir, "data", "devin"), { recursive: true, mode: 0o700 }),
    mkdir(join(layout.homeDir, "cache"), { recursive: true, mode: 0o700 }),
    mkdir(join(layout.homeDir, "config", "devin"), { recursive: true, mode: 0o700 }),
    mkdir(join(layout.homeDir, "state"), { recursive: true, mode: 0o700 }),
    mkdir(layout.tmpDir, { recursive: true, mode: 0o700 }),
  ]);
  await writeFile(layout.devinConfigPath, DEVIN_CONFIG_JSON, { encoding: "utf8", mode: 0o600 });
  try {
    await copyFile(mcpConfigSource, layout.mcpConfigPath);
    await chmod(layout.mcpConfigPath, 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/** A credentials copy older than this with no readable meta.json is orphaned:
 * meta lands milliseconds after spawn, so a meta-less run dir is the
 * meta-write-failure path — whose group was already SIGKILLed (r5 N5). */
export const DEVIN_CREDS_ORPHAN_MS = 10 * 60 * 1000;

export interface DevinCredentialSweepOptions {
  /** Tri-state oracle seam for tests; production uses processIdentity. */
  identity?: (pid: number, startTime: string) => Promise<"alive" | "dead" | "unknown">;
  now?: number;
  orphanMs?: number;
}

/**
 * The dispatch-time sweep over BOTH devin run roots (D2, r5 N5): deletes a
 * credentials.toml copy only on positive proof the wrapper is gone — an
 * exit.rc, a "dead" identity verdict (a reused pid reads dead, never alive),
 * or a meta-less orphan whose copy has outlived the meta-write window. A copy
 * is KEPT on "unknown" or on a young orphan: never delete out from under a
 * live wrapper.
 */
export async function sweepDevinCredentialCopies(
  roots: readonly string[],
  options: DevinCredentialSweepOptions = {},
): Promise<{ deleted: number; kept: number }> {
  const identity = options.identity ?? processIdentity;
  const now = options.now ?? Date.now();
  const orphanMs = options.orphanMs ?? DEVIN_CREDS_ORPHAN_MS;
  let deleted = 0;
  let kept = 0;
  for (const root of roots) {
    let entries;
    try { entries = await readdir(root, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const layout = devinRunLayout(join(root, entry.name));
      let copyStat;
      try { copyStat = await stat(layout.credentialsCopyPath); }
      catch { continue; } // no leaked copy here
      let remove = false;
      if (existsSync(layout.exitRcPath)) {
        remove = true;
      } else {
        let meta: Record<string, unknown> | undefined;
        try {
          const raw: unknown = JSON.parse(await readFile(layout.metaPath, "utf8"));
          if (typeof raw === "object" && raw !== null) meta = raw as Record<string, unknown>;
        } catch { /* unreadable meta — the orphan rule decides below */ }
        if (meta !== undefined) {
          const pid = typeof meta.childPid === "number" ? meta.childPid
            : typeof meta.pid === "number" ? meta.pid : undefined;
          const startTime = typeof meta.procStartTime === "string" ? meta.procStartTime : "";
          // No readable identity is not proof of death — keep (r5 N5).
          remove = pid !== undefined && startTime.length > 0
            && (await identity(pid, startTime)) === "dead";
        } else {
          remove = now - copyStat.mtimeMs > orphanMs;
        }
      }
      if (remove) {
        await unlink(layout.credentialsCopyPath).catch(() => {});
        deleted += 1;
      } else {
        kept += 1;
      }
    }
  }
  return { deleted, kept };
}
