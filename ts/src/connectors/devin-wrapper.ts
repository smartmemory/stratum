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
# copy FIRST, then TERMs the agent, waits a bounded 2 s (10 x 0.2 s, under the
# 5 s watchdog grace), KILLs it, reaps it, and only then publishes.
# Terminal boundary (STRAT-DEVIN-TRAP-FU-1): finish revokes the copy, then
# SELECTS the status: out_rc=$pending_rc is the last read of pending_rc. A
# signal that lands before that read wins (its 128+signo is the status). A
# signal after it changes nothing: the agent is already reaped and the copy
# already gone, so nothing is left to cancel, and the run publishes the status
# it selected. Every exit writes exit.rc, then exactly one sentinel, both equal
# to the process rc. A group signal can kill the tail's external commands, so
# the revoke rm and the exit.rc mv are re-run (bounded); echo and printf are
# builtins, which a trap cannot split.
# Agent bookkeeping (STRAT-DEVIN-TRAP-FU-2): agent_state is the result of the
# latest kill -0, assigned in the same command that probes (a command
# substitution), so no trap runs between seeing the agent gone and recording
# it; a probe killed by the signal yields "" and counts as not gone. The
# handler signals the agent only while agent_state is not "gone", and each
# signal right after its own kill -0 found the pid; a failing probe or the KILL
# ends all signalling. Limit: bash and dash reap a finished background child
# themselves, so the probe that finds the agent gone already lands on a free
# pid; it carries no signal.
trap 'rm -f "$STRATUM_DEVIN_CREDS_COPY"' EXIT
pending_rc=""
out_rc=""
published=""
busy=""
agent=""
agent_state=""
revoke() {
  rm -f "$STRATUM_DEVIN_CREDS_COPY"
  tries=0
  while [ -e "$STRATUM_DEVIN_CREDS_COPY" ] && [ "$tries" -lt 3 ]; do rm -f "$STRATUM_DEVIN_CREDS_COPY"; tries=$((tries+1)); done
}
finish() {
  busy=1
  revoke
  out_rc=$pending_rc
  [ -z "$out_rc" ] && out_rc=$1
  tries=0
  while [ "$tries" -lt 3 ]; do
    tries=$((tries+1))
    echo "$out_rc" > "$STRATUM_DEVIN_RUN_DIR/exit.rc.tmp" && mv "$STRATUM_DEVIN_RUN_DIR/exit.rc.tmp" "$STRATUM_DEVIN_RUN_DIR/exit.rc" && break
  done
  printf '{"__t2f5_done__":%d}\\n' "$out_rc" >> "$STRATUM_DEVIN_RUN_DIR/stream.jsonl"
  published=1
}
on_signal() {
  [ -z "$pending_rc" ] && pending_rc=$1
  [ -n "$published" ] && exit "$out_rc"
  [ -n "$busy" ] && return
  busy=1
  revoke
  target=$agent
  [ -z "$target" ] && target=$!
  if [ "$agent_state" != gone ] && [ -n "$target" ] && kill -0 "$target" 2>/dev/null; then
    kill -TERM "$target" 2>/dev/null
    n=0
    while kill -0 "$target" 2>/dev/null; do
      if [ "$n" -ge 10 ]; then kill -KILL "$target" 2>/dev/null; break; fi
      sleep 0.2
      n=$((n+1))
    done
    wait "$target" 2>/dev/null
  fi
  finish "$pending_rc"
  exit "$out_rc"
}
trap 'on_signal 129' HUP
trap 'on_signal 130' INT
trap 'on_signal 143' TERM
cp "$STRATUM_DEVIN_CREDS_SOURCE" "$STRATUM_DEVIN_CREDS_COPY" && chmod 600 "$STRATUM_DEVIN_CREDS_COPY"
sleep 0
"$@" < /dev/null &
agent=$!
while agent_state=$(kill -0 "$agent" 2>/dev/null && echo alive || echo gone); [ "$agent_state" != gone ]; do sleep 0.2; done
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
