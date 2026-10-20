import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chmodSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEVIN_WRAPPER_SCRIPT,
  devinRunLayout,
  prepareDevinRunHome,
  sweepDevinCredentialCopies,
} from "../../src/connectors/devin-wrapper.js";

/**
 * STRAT-AGENT-DEVIN-1 slice S1b (D2) — the supervisor wrapper exercised by a
 * REAL shell with stub executables first on PATH (never the real devin, the
 * real ~/.stratum, or the real ~/.local/share/devin). A fake `sandbox-exec`
 * covers the start-failure path — nested seatbelt cannot run inside our own
 * sandbox, so the real sandbox-exec exec is the live/orchestrator check.
 */

const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "stratum-devin-wrap-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A run dir laid out the way the connector leaves it, plus a stub bin dir. */
function scaffold(root: string) {
  const home = join(root, "home");
  const binDir = join(root, "bin");
  const runDir = join(home, ".stratum", "ts", "devin_fg", "run1");
  const layout = devinRunLayout(runDir);
  mkdirSync(binDir, { recursive: true });
  mkdirSync(runDir, { recursive: true });
  mkdirSync(join(layout.homeDir, "data", "devin"), { recursive: true });
  mkdirSync(join(layout.homeDir, "config", "devin"), { recursive: true });
  mkdirSync(layout.tmpDir, { recursive: true });
  writeFileSync(layout.streamPath, "");
  writeFileSync(layout.wrapperPath, DEVIN_WRAPPER_SCRIPT, { mode: 0o700 });
  const credsSource = join(home, ".local", "share", "devin", "credentials.toml");
  mkdirSync(join(home, ".local", "share", "devin"), { recursive: true });
  writeFileSync(credsSource, "token = \"owner\"\n", { mode: 0o600 });
  const env = {
    PATH: `${binDir}:/usr/bin:/bin`,
    HOME: home,
    STRATUM_DEVIN_RUN_DIR: layout.runDir,
    STRATUM_DEVIN_CREDS_SOURCE: credsSource,
    STRATUM_DEVIN_CREDS_COPY: layout.credentialsCopyPath,
  };
  const stub = (name: string, body: string): void => {
    writeFileSync(join(binDir, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  };
  return { home, binDir, runDir, layout, env, credsSource, stub };
}

function runWrapper(env: NodeJS.ProcessEnv, wrapperPath: string, argv: string[]): Promise<{ code: number | null; signal: string | null }> {
  return new Promise((resolve) => {
    const child = spawn("sh", [wrapperPath, ...argv], { env, stdio: ["ignore", "ignore", "ignore"] });
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
}

/** The wrapper in its own process group (a stratum cancel signals the group). */
function startWrapper(env: NodeJS.ProcessEnv, wrapperPath: string) {
  const child = spawn("sh", [wrapperPath, "devin", "-p"], { env, stdio: ["ignore", "ignore", "ignore"], detached: true });
  const closed = new Promise<{ code: number | null }>((resolve) => child.once("close", (code) => resolve({ code })));
  return { child, closed };
}

async function waitFor(condition: () => boolean, message: string, boundMs = 5_000): Promise<void> {
  const deadline = Date.now() + boundMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function closeWithin<T>(closed: Promise<T>, boundMs: number, message: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), boundMs); });
  return Promise.race([closed, timeout]).finally(() => clearTimeout(timer));
}

/** True when `pid` has a live child whose command name is `name`. */
function hasChild(pid: number, name: string): boolean {
  const out = execFileSync("ps", ["-axo", "pid=,ppid=,comm="], { encoding: "utf8" });
  return out.split("\n").some((line) => {
    const [, ppid, ...comm] = line.trim().split(/\s+/);
    return Number(ppid) === pid && comm.join(" ").split("/").pop() === name;
  });
}

/** Cleanup: KILL the probe's own process group (exact pgid, never by pattern). */
function killGroup(pgid: number): void {
  try { process.kill(-pgid, "SIGKILL"); } catch { /* already gone */ }
}

describe("DEVIN_WRAPPER_SCRIPT — real shell (D2)", () => {
  it("exit 0: credentials copy removed, exit.rc=0, sentinel written", async () => {
    const { layout, env, credsSource, stub } = scaffold(temporaryRoot());
    // The copy exists and is 0600 while devin runs (D2: per-run home contents).
    stub("devin", 'test -f "$STRATUM_DEVIN_CREDS_COPY" || exit 42\n'
      + '[ "$(stat -f%p "$STRATUM_DEVIN_CREDS_COPY" | tail -c 4)" = "600" ] || exit 43');
    const { code } = await runWrapper(env, layout.wrapperPath, ["devin", "-p"]);
    expect(code).toBe(0);
    expect(readFileSync(layout.exitRcPath, "utf8").trim()).toBe("0");
    expect(readFileSync(layout.streamPath, "utf8")).toBe('{"__t2f5_done__":0}\n');
    expect(existsSync(layout.credentialsCopyPath)).toBe(false);
    // The owner's source is never touched.
    expect(readFileSync(credsSource, "utf8")).toContain("owner");
  });

  it("exit 3: rc and sentinel propagate devin's status, credentials still removed", async () => {
    const { layout, env, stub } = scaffold(temporaryRoot());
    stub("devin", "exit 3");
    const { code } = await runWrapper(env, layout.wrapperPath, ["devin", "-p"]);
    expect(code).toBe(3);
    expect(readFileSync(layout.exitRcPath, "utf8").trim()).toBe("3");
    expect(readFileSync(layout.streamPath, "utf8")).toBe('{"__t2f5_done__":3}\n');
    expect(existsSync(layout.credentialsCopyPath)).toBe(false);
  });

  it("devin self-SIGKILL: rc=137, sentinel agrees, credentials removed", async () => {
    const { layout, env, stub } = scaffold(temporaryRoot());
    stub("devin", "kill -9 $$");
    const { code } = await runWrapper(env, layout.wrapperPath, ["devin", "-p"]);
    expect(code).toBe(137);
    expect(readFileSync(layout.exitRcPath, "utf8").trim()).toBe("137");
    expect(readFileSync(layout.streamPath, "utf8")).toBe('{"__t2f5_done__":137}\n');
    expect(existsSync(layout.credentialsCopyPath)).toBe(false);
  });

  it("sandbox-exec failing to start: rc propagates, credentials removed", async () => {
    const { layout, env, stub } = scaffold(temporaryRoot());
    stub("sandbox-exec", 'echo "sandbox-exec: cannot exec" >&2; exit 71');
    stub("devin", "exit 0");
    const { code } = await runWrapper(env, layout.wrapperPath,
      ["sandbox-exec", "-f", join(layout.runDir, "devin.sb"), "devin", "-p"]);
    expect(code).toBe(71);
    expect(readFileSync(layout.exitRcPath, "utf8").trim()).toBe("71");
    expect(readFileSync(layout.streamPath, "utf8")).toBe('{"__t2f5_done__":71}\n');
    expect(existsSync(layout.credentialsCopyPath)).toBe(false);
  });

  // One table: a group signal while the agent runs (stratum cancel is TERM; INT and HUP are handled the same).
  // The agent signals readiness itself, so the signal lands while it really runs. The stub sleeps 30 s, so a
  // close later than 5 s means the cancel was consumed. rc is 128+signo. Outer timeout 15 s covers setup + both bounds.
  it.each([
    ["SIGTERM", 143],
    ["SIGINT", 130],
    ["SIGHUP", 129],
  ] as const)("%s to the group while the agent runs: prompt exit, copy removed, rc %i, one sentinel", async (signal, rc) => {
    const { layout, env, home, stub } = scaffold(temporaryRoot());
    stub("devin", `touch "${join(home, "agent-ready")}"; sleep 30`);
    const { child, closed } = startWrapper(env, layout.wrapperPath);
    try {
      await waitFor(() => existsSync(join(home, "agent-ready")), "agent never started");
      expect(existsSync(layout.credentialsCopyPath)).toBe(true);
      const sentAt = Date.now();
      process.kill(-child.pid!, signal);
      await closeWithin(closed, 5_000, `${signal} consumed: wrapper still alive after 5 s`);
      expect(Date.now() - sentAt).toBeLessThan(5_000);
      expect(existsSync(layout.credentialsCopyPath)).toBe(false);
      expect(readFileSync(layout.exitRcPath, "utf8").trim()).toBe(String(rc));
      expect(readFileSync(layout.streamPath, "utf8")).toBe(`{"__t2f5_done__":${rc}}\n`);
    } finally {
      killGroup(child.pid!);
    }
  }, 15_000);

  // F1: an agent that ignores TERM must not keep the credentials copy alive. The handler revokes the copy first,
  // then waits a bounded time and KILLs the agent, so the wrapper still ends with 143 and one sentinel.
  it("SIGTERM to the group with a TERM-ignoring agent: copy revoked before any external KILL, rc 143, one sentinel", async () => {
    const { layout, env, home, stub } = scaffold(temporaryRoot());
    stub("devin", `trap '' TERM; echo $$ > "${join(home, "agent-pid")}"; touch "${join(home, "agent-ready")}"; while :; do sleep 0.1; done`);
    const { child, closed } = startWrapper(env, layout.wrapperPath);
    try {
      await waitFor(() => existsSync(join(home, "agent-ready")), "agent never started");
      process.kill(-child.pid!, "SIGTERM");
      // The copy goes at once (next checkpoint, <= 0.2 s), while the wrapper is still inside its 2 s bound: the
      // TERM-ignoring agent is still alive then, i.e. the revoke came before the wrapper's own KILL.
      await waitFor(() => !existsSync(layout.credentialsCopyPath), "copy still present 5 s after TERM", 5_000);
      const agentPid = Number(readFileSync(join(home, "agent-pid"), "utf8").trim());
      expect(() => process.kill(agentPid, 0)).not.toThrow();
      await closeWithin(closed, 5_000, "wrapper still alive 5 s after TERM (unbounded agent wait)");
      expect(readFileSync(layout.exitRcPath, "utf8").trim()).toBe("143");
      expect(readFileSync(layout.streamPath, "utf8")).toBe('{"__t2f5_done__":143}\n');
    } finally {
      killGroup(child.pid!);
    }
  }, 15_000);

  // FU-1: the publication tail, one row per command it runs (rm revokes the copy, echo and mv commit exit.rc, printf
  // appends the sentinel), the signals spread across rows. The agent has already exited 7. finish selects the status
  // at out_rc=$pending_rc, after the revoke rm and before the echo: a signal held in rm wins (128+signo), a signal at
  // echo, mv or printf leaves 7 (the boundary). For rm and mv one PATH shim ignores the signal while it holds; the
  // other lets the group signal kill it mid-hold, so the wrapper must re-run it (a killed rm must not leave the copy,
  // a killed mv must not leave exit.rc missing). echo and printf are shell builtins, which a trap cannot split, so
  // their rows hold at a checkpoint right before the builtin: a shell function of the same name (it shadows the
  // builtin in both shells) is put in front of the unchanged script, holds in a foreground /bin/sleep loop that the
  // group signal interrupts, then runs `command <builtin>`. The echo hold skips the poll's alive/gone echoes.
  it.each([
    ["rm", "shim ignores the signal", "SIGTERM", 143],
    ["rm", "shim killed by the signal", "SIGHUP", 129],
    ["echo", "held just before the builtin", "SIGINT", 7],
    ["mv", "shim ignores the signal", "SIGINT", 7],
    ["mv", "shim killed by the signal", "SIGTERM", 7],
    ["printf", "held just before the builtin", "SIGHUP", 7],
  ] as const)("%s held in the publication tail (%s), %s: rc %i in rc, exit.rc and one sentinel", async (command, shim, signal, rc) => {
    const { layout, env, home, stub } = scaffold(temporaryRoot());
    stub("devin", "exit 7");
    const held = join(home, `${command}-held`);
    const release = join(home, `${command}-release`);
    const hold = `if [ ! -f "${release}" ]; then\ntouch "${held}"\nwhile [ ! -f "${release}" ]; do /bin/sleep 0.05; done\nfi\n`;
    if (shim === "held just before the builtin") {
      const skip = command === "echo" ? 'case "$1" in alive|gone) command echo "$@"; return ;; esac\n' : "";
      const script = DEVIN_WRAPPER_SCRIPT.replace("#!/bin/sh\n", `#!/bin/sh\n${command}() {\n${skip}${hold}command ${command} "$@"\n}\n`);
      expect(script).not.toBe(DEVIN_WRAPPER_SCRIPT);
      writeFileSync(layout.wrapperPath, script, { mode: 0o700 });
    } else {
      const ignore = shim === "shim ignores the signal" ? "trap '' HUP INT TERM\n" : "";
      stub(command, `${ignore}${hold}exec /bin/${command} "$@"`);
    }
    const { child, closed } = startWrapper(env, layout.wrapperPath);
    try {
      await waitFor(() => existsSync(held), `finish never reached ${command}`);
      process.kill(-child.pid!, signal);
      writeFileSync(release, "");
      const { code } = await closeWithin(closed, 5_000, `wrapper still alive 5 s after ${signal}`);
      expect(code).toBe(rc);
      expect(readFileSync(layout.exitRcPath, "utf8").trim()).toBe(String(rc));
      expect(readFileSync(layout.streamPath, "utf8")).toBe(`{"__t2f5_done__":${rc}}\n`);
      expect(existsSync(layout.credentialsCopyPath)).toBe(false);
    } finally {
      writeFileSync(release, "");
      killGroup(child.pid!);
    }
  }, 15_000);

  // FU-1 fix r1 (review F1, F2): a tail step re-runs until its postcondition holds, however many attempts a handled
  // signal kills. The shim is killed by a group SIGTERM at each of its first `holds` calls, then runs the real
  // command. rm: 5 kills exhausted the old revoke (1 + 3 retries) and the EXIT trap's single rm, leaving the copy on a
  // handled exit; now the revoke loop runs until the copy is gone and the first TERM (before selection) wins. mv: 3
  // kills exhausted the old publish retries and the sentinel was written with exit.rc missing; now exit.rc is
  // rewritten until it reads back as the selected status (7, chosen before any signal).
  it.each([
    ["rm", 5, 143],
    ["mv", 3, 7],
  ] as const)("%s killed by a group SIGTERM at each of its first %i calls: postcondition still met, rc %i everywhere, one sentinel", async (command, holds, rc) => {
    const { layout, env, home, stub } = scaffold(temporaryRoot());
    stub("devin", "exit 7");
    const count = join(home, `${command}-count`);
    const held = (n: number): string => join(home, `${command}-held-${n}`);
    stub(command, `n=0\n[ ! -f "${count}" ] || read n < "${count}"\nn=$((n+1))\necho "$n" > "${count}"\n`
      + `if [ "$n" -le ${holds} ]; then\ntouch "${home}/${command}-held-$n"\nwhile :; do /bin/sleep 0.01; done\nfi\nexec /bin/${command} "$@"`);
    const { child, closed } = startWrapper(env, layout.wrapperPath);
    try {
      for (let n = 1; n <= holds; n++) {
        await waitFor(() => existsSync(held(n)), `${command} call ${n} never held`);
        process.kill(-child.pid!, "SIGTERM");
      }
      const { code } = await closeWithin(closed, 5_000, `wrapper still alive 5 s after the last SIGTERM`);
      expect(existsSync(layout.credentialsCopyPath)).toBe(false);
      expect(code).toBe(rc);
      expect(readFileSync(layout.exitRcPath, "utf8").trim()).toBe(String(rc));
      expect(readFileSync(layout.streamPath, "utf8")).toBe(`{"__t2f5_done__":${rc}}\n`);
    } finally {
      killGroup(child.pid!);
    }
  }, 15_000);

  // FU-1 fix r1 (found by devin-background's cancel test, ~1 in 40 on /bin/sh = bash 3.2): bash can run the parent's
  // trap inside a forked shell child (the poll's command substitution, the agent spawn) before the child resets its
  // traps. A child that ran the full handler published its own sentinel, so the stream held two. The race itself is
  // not schedulable, so each row makes the child run the inherited handler deterministically (an on_signal call at
  // the start of the child) and no signal reaches the wrapper: the wrapper holds busy across the fork, so the child
  // only records and returns, and the run ends with the agent's own 7 once, the agent having seen the copy.
  it.each([
    ["poll probe", "agent_state=$(kill -0", "agent_state=$(on_signal 129; kill -0"],
    ["agent spawn", '"$@" < /dev/null &', '{ on_signal 130; "$@" < /dev/null; } &'],
  ] as const)("a forked shell child running the inherited handler (%s) publishes nothing: rc 7, one sentinel", async (_window, anchor, child) => {
    const { layout, env, home, stub } = scaffold(temporaryRoot());
    const saw = join(home, "agent-saw-copy");
    stub("devin", `test -f "$STRATUM_DEVIN_CREDS_COPY" && touch "${saw}"; exit 7`);
    expect(DEVIN_WRAPPER_SCRIPT.split(anchor)).toHaveLength(2);
    writeFileSync(layout.wrapperPath, DEVIN_WRAPPER_SCRIPT.replace(anchor, child), { mode: 0o700 });
    const { code } = await runWrapper(env, layout.wrapperPath, ["devin", "-p"]);
    expect(readFileSync(layout.streamPath, "utf8")).toBe('{"__t2f5_done__":7}\n');
    expect(code).toBe(7);
    expect(readFileSync(layout.exitRcPath, "utf8").trim()).toBe("7");
    expect(existsSync(saw)).toBe(true);
    expect(existsSync(layout.credentialsCopyPath)).toBe(false);
  }, 15_000);

  // FU-2: the wrapper never signals the agent's pid once it has seen it gone. kill is a shell builtin, so a PATH shim
  // cannot see it; instead a shell function named kill (which shadows the builtin in both shells) is put in front of
  // the unchanged script and logs every call as "<args> rc=<status>". Invariant on every row: for the agent's pid,
  // nothing follows the first failing call or the KILL. Rows: the post-wait window (R2-F2; a checkpoint is inserted
  // after the wrapper's wait), the agent already reaped by the shell while the wrapper sleeps between probes, SIGINT
  // (a background job inherits INT as ignored, so the handler's TERM ends the agent), and a TERM-ignoring agent.
  it.each([
    ["post-wait", "SIGTERM", 143],
    ["reaped-between-probes", "SIGHUP", 129],
    ["handler-term", "SIGINT", 130],
    ["handler-kill", "SIGTERM", 143],
  ] as const)("%s, %s: no signal to the agent's pid after it is seen gone, rc %i, one sentinel", async (row, signal, rc) => {
    const { layout, env, home, stub } = scaffold(temporaryRoot());
    const log = join(home, "kill.log");
    const held = join(home, "held");
    const release = join(home, "release");
    const pidFile = join(home, "agent-pid");
    let script = DEVIN_WRAPPER_SCRIPT.replace("#!/bin/sh\n",
      `#!/bin/sh\nkill() { command kill "$@"; kr=$?; printf '%s rc=%s\\n' "$*" "$kr" >> "${log}"; return $kr; }\n`);
    if (row === "post-wait") {
      const anchor = '\nwait "$agent"\n';
      expect(script.split(anchor)).toHaveLength(2);
      script = script.replace(anchor, `${anchor}wrc=$?; touch "${held}"; while [ ! -f "${release}" ]; do /bin/sleep 0.01; done; (exit $wrc)\n`);
      stub("devin", `echo $$ > "${pidFile}"; exit 7`);
    } else if (row === "reaped-between-probes") {
      // The poll's sleep holds once the agent has started; the agent exits only after that, so the wrapper's last
      // probe saw it alive and the shell reaps it during the held sleep.
      stub("sleep", `if [ -f "${pidFile}" ] && [ ! -f "${held}" ]; then\ntrap '' HUP INT TERM\ntouch "${held}"\nwhile [ ! -f "${release}" ]; do /bin/sleep 0.01; done\nexit 0\nfi\nexec /bin/sleep "$@"`);
      stub("devin", `echo $$ > "${pidFile}"; while [ ! -f "${held}" ]; do /bin/sleep 0.01; done; exit 7`);
    } else if (row === "handler-term") {
      stub("devin", `echo $$ > "${pidFile}"; touch "${held}"; sleep 30`);
    } else {
      stub("devin", `trap '' TERM; echo $$ > "${pidFile}"; touch "${held}"; while :; do /bin/sleep 0.1; done`);
    }
    writeFileSync(layout.wrapperPath, script, { mode: 0o700 });
    const { child, closed } = startWrapper(env, layout.wrapperPath);
    try {
      await waitFor(() => existsSync(held), `${row}: never reached its window`);
      const agentPid = readFileSync(pidFile, "utf8").trim();
      const calls = (): { args: string; rc: number }[] => (existsSync(log) ? readFileSync(log, "utf8") : "").split("\n")
        .filter((line) => line.split(" ")[1] === agentPid)
        .map((line) => ({ args: line.replace(/ rc=\d+$/, ""), rc: Number(line.split(" rc=")[1]) }));
      if (row === "reaped-between-probes") {
        // The agent is gone from the process table (a zombie would still answer signal 0): the shell reaped it.
        await waitFor(() => { try { process.kill(Number(agentPid), 0); return false; } catch { return true; } }, "agent never reaped");
      }
      const before = calls().length;
      process.kill(-child.pid!, signal);
      writeFileSync(release, "");
      const { code } = await closeWithin(closed, 5_000, `wrapper still alive 5 s after ${signal}`);
      expect(code).toBe(rc);
      expect(readFileSync(layout.exitRcPath, "utf8").trim()).toBe(String(rc));
      expect(readFileSync(layout.streamPath, "utf8")).toBe(`{"__t2f5_done__":${rc}}\n`);
      expect(existsSync(layout.credentialsCopyPath)).toBe(false);
      const all = calls();
      const stop = all.findIndex((call) => call.rc !== 0 || call.args.startsWith("-KILL "));
      expect(stop, `${row}: the agent was never seen gone or KILLed`).toBeGreaterThanOrEqual(0);
      expect(all.slice(stop + 1), `${row}: signalled after seen gone`).toEqual([]);
      const after = all.slice(before).map((call) => call.args.split(" ")[0]);
      if (row === "post-wait") expect(after).toEqual([]);
      if (row === "reaped-between-probes") expect(after).toEqual(["-0"]);
      if (row === "handler-term") expect(after).toContain("-TERM");
      if (row === "handler-term") expect(after).not.toContain("-KILL");
      if (row === "handler-kill") expect(after).toContain("-TERM");
      if (row === "handler-kill") expect(after[after.length - 1]).toBe("-KILL");
    } finally {
      writeFileSync(release, "");
      killGroup(child.pid!);
    }
  }, 15_000);

  it("SIGTERM to the group while cp is blocked (before the agent starts): exit at once, no copy, no agent, rc 143, one sentinel", async () => {
    const { layout, env, home, stub, credsSource } = scaffold(temporaryRoot());
    // The credentials source is a FIFO with no writer, so cp blocks on open: the deterministic cp window.
    rmSync(credsSource);
    execFileSync("mkfifo", [credsSource]);
    const ranMarker = join(home, "agent-ran");
    stub("devin", `touch "${ranMarker}"; sleep 30`);
    const { child, closed } = startWrapper(env, layout.wrapperPath);
    try {
      // Observable readiness: the wrapper's own cp child exists (and is blocked on the FIFO, which has no writer).
      await waitFor(() => hasChild(child.pid!, "cp"), "wrapper never reached cp");
      const sentAt = Date.now();
      process.kill(-child.pid!, "SIGTERM");
      await closeWithin(closed, 3_000, "TERM consumed: wrapper still alive after 3 s");
      expect(Date.now() - sentAt).toBeLessThan(3_000);
      expect(existsSync(layout.credentialsCopyPath)).toBe(false);
      expect(existsSync(ranMarker)).toBe(false);
      expect(readFileSync(layout.exitRcPath, "utf8").trim()).toBe("143");
      expect(readFileSync(layout.streamPath, "utf8")).toBe('{"__t2f5_done__":143}\n');
    } finally {
      killGroup(child.pid!);
    }
  }, 15_000);

  it("devin's stdout is narration, never a status channel: a printed sentinel forges nothing", async () => {
    const { layout, env, stub } = scaffold(temporaryRoot());
    stub("devin", 'echo \'{"__t2f5_done__":0}\'; exit 7');
    const { code } = await runWrapper(env, layout.wrapperPath, ["devin", "-p"]);
    expect(code).toBe(7);
    // stream.jsonl holds only the wrapper's own sentinel — the agent's echo
    // went to stdout (ignored here), not into the supervisor file.
    expect(readFileSync(layout.streamPath, "utf8")).toBe('{"__t2f5_done__":7}\n');
    expect(readFileSync(layout.exitRcPath, "utf8").trim()).toBe("7");
  });
});

describe("prepareDevinRunHome (D2)", () => {
  it("creates the per-run home, the stratum config, and copies mcp_config when present", async () => {
    const root = temporaryRoot();
    const layout = devinRunLayout(join(root, "run"));
    const mcp = join(root, "mcp_config.json");
    writeFileSync(mcp, "{\"mcpServers\":{\"agentmail\":{}}}\n");
    await prepareDevinRunHome(layout, mcp);
    for (const dir of ["home/data/devin", "home/cache", "home/config/devin", "home/state", "tmp"]) {
      expect(existsSync(join(layout.agentDir, dir)), dir).toBe(true);
    }
    const config = JSON.parse(await readFile(layout.devinConfigPath, "utf8"));
    expect(config.permissions.allow).toEqual([]);
    expect(await readFile(layout.mcpConfigPath, "utf8")).toContain("agentmail");
    expect((await stat(layout.mcpConfigPath)).mode & 0o777).toBe(0o600);
  });

  it("succeeds without an owner mcp_config.json", async () => {
    const root = temporaryRoot();
    const layout = devinRunLayout(join(root, "run"));
    await prepareDevinRunHome(layout, join(root, "absent", "mcp_config.json"));
    expect(existsSync(layout.mcpConfigPath)).toBe(false);
  });
});

describe("sweepDevinCredentialCopies (D2, positive-proof invariant)", () => {
  function plantCopy(root: string, runId: string, opts: { exitRc?: boolean; meta?: string; oldMtime?: boolean }) {
    const layout = devinRunLayout(join(root, runId));
    mkdirSync(join(layout.homeDir, "data", "devin"), { recursive: true });
    writeFileSync(layout.credentialsCopyPath, "token = \"leaked\"\n");
    if (opts.exitRc) writeFileSync(layout.exitRcPath, "0\n");
    if (opts.meta !== undefined) writeFileSync(layout.metaPath, opts.meta);
    if (opts.oldMtime) {
      const old = new Date(Date.now() - 11 * 60 * 1000);
      utimesSync(layout.credentialsCopyPath, old, old);
    }
    return layout;
  }

  it("deletes on exit.rc, on a 'dead' identity, and on a meta-less orphan past 10 min", async () => {
    const root = temporaryRoot();
    const runsRoot = join(root, "agent_runs");
    const fgRoot = join(root, "devin_fg");
    mkdirSync(runsRoot, { recursive: true });
    mkdirSync(fgRoot, { recursive: true });
    const byRc = plantCopy(runsRoot, "r1", { exitRc: true });
    const byDead = plantCopy(fgRoot, "r2", {
      meta: JSON.stringify({ childPid: 999, procStartTime: "old-start" }),
    });
    const orphan = plantCopy(runsRoot, "r3", { oldMtime: true });
    const result = await sweepDevinCredentialCopies([runsRoot, fgRoot],
      { identity: async () => "dead" });
    expect(result.deleted).toBe(3);
    for (const layout of [byRc, byDead, orphan]) {
      expect(existsSync(layout.credentialsCopyPath)).toBe(false);
    }
  });

  it("keeps on 'alive' and on 'unknown', and on a young meta-less orphan", async () => {
    const root = temporaryRoot();
    const runsRoot = join(root, "agent_runs");
    mkdirSync(runsRoot, { recursive: true });
    const meta = JSON.stringify({ childPid: 1, procStartTime: "start" });
    const alive = plantCopy(runsRoot, "r1", { meta });
    const unknown = plantCopy(runsRoot, "r2", { meta });
    const young = plantCopy(runsRoot, "r3", {});
    let verdict: "alive" | "dead" | "unknown" = "alive";
    const identity = async () => verdict;
    expect((await sweepDevinCredentialCopies([runsRoot], { identity })).deleted).toBe(0);
    verdict = "unknown";
    expect((await sweepDevinCredentialCopies([runsRoot], { identity })).deleted).toBe(0);
    for (const layout of [alive, unknown, young]) {
      expect(existsSync(layout.credentialsCopyPath)).toBe(true);
    }
  });
});
