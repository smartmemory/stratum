import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect } from "vitest";
import { createSessionBackend, type Envelope } from "../../src/session/index.js";
import { gate, listing, mintToken, type Listing } from "./leak-gate.js";

/**
 * SESSION-MGMT-1-U2: the shared session-test fixture (contract `test_fixture`), extracted from
 * backend.test.ts. `suite(prefix)` mints the file's run token BEFORE its baseline listing,
 * installs the leak gate (both arms) and the per-file root, and returns the helpers bound to
 * that suite. Every script a test runs gets the fixture env; `assertFixtureEnv` checks it
 * resolves under the fixture root before any script runs.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
export const BIN = join(HERE, "..", "..", "src", "cli", "bin.mjs");
export const CONTRACT_FILE = join(HERE, "..", "..", "..", "docs", "features", "SESSION-MGMT-1", "session-contract.json");
export const OPS_SCRIPTS = process.env.SESSION_MGMT_OPS_SCRIPTS || "/Users/ruze/reg/my/SmartMemory/smart-memory-ops/claude/scripts";
export const HAVE_OPS = existsSync(join(OPS_SCRIPTS, "usage_watch.py")) && existsSync(join(OPS_SCRIPTS, "jobs.py"));

export const py = (body: string) => `import json, os, sys, time\n${body}\n`;

export function code(envelope: Envelope<unknown>): string {
  return envelope.ok ? "ok" : envelope.refusal.code;
}

// ---------------------------------------------------------------- leak gate (contract test_fixture.leak_gate)

const REAL_HOME = homedir();
/** Nothing may be added, removed or changed here (leak-gate.ts: ~/.stratum is quiet outside ts/agent_runs, which other sessions' stratum_agent_run writes). */
export const STRICT_DIRS = [join(REAL_HOME, ".stratum")];
export const LOOSE_DIRS = [join(REAL_HOME, ".stratum", "ts", "agent_runs")];
/** Live sessions and launchd jobs write these all the time (usage: ai.smartmemory.usage-watch every 5 min), so only this run's token fails. */
export const TOKEN_DIRS = [
  join(REAL_HOME, ".claude", "logs"),
  join(REAL_HOME, ".claude", "session-state"),
  join(REAL_HOME, ".claude", "usage"),
  join(OPS_SCRIPTS, "..", "..", "status", "launch-gate"),
];
const WATCHED_DIRS = [...STRICT_DIRS, ...TOKEN_DIRS];

/** A listing walks ~100K real files: 4.5 s idle, over 10 s under a loaded suite (vitest default hook timeout). */
export const HOOK_TIMEOUT_MS = 120_000;

// ---------------------------------------------------------------- the fixture env (contract test_fixture.env_for_every_script_subprocess)

/** Inherited keys that would point a script at real state; every fixture env drops them before setting its own. */
export const STRIPPED_PREFIX = /^(USAGE_WATCH_|LAUNCH_GATE_|DETACH_JOB_|SEAT_|SESSION_HOP_|WORK_MODEL_|STRATUM_SESSION_|CLAUDE_JOBS_DIR$|STRATUM_CONFIG_FILE$|CLAUDECODE$|CLAUDE_CONFIG_DIR$|CODEX_HOME$)/;

/** The contracted keys, read from the contract so the list cannot drift: `{present, removed, scriptPaths, fixed}`. */
export const CONTRACT_ENV = (() => {
  const contract = JSON.parse(readFileSync(CONTRACT_FILE, "utf8")) as { test_fixture: { env_for_every_script_subprocess: Record<string, string> } };
  const present: string[] = [];
  const removed: string[] = [];
  const fixed: Record<string, string> = {};
  for (const [spec, value] of Object.entries(contract.test_fixture.env_for_every_script_subprocess)) {
    const keys = spec.split("/").map((part) => part.trim()).filter(Boolean);
    for (const raw of keys) {
      const [key, pinned] = raw.split("=") as [string, string | undefined];
      if (value === "removed") removed.push(key);
      else present.push(key);
      if (pinned !== undefined) fixed[key] = pinned;
    }
  }
  return Object.freeze({ present, removed, fixed, scriptPaths: ["USAGE_WATCH_JOBS_PY", "DETACH_JOB_JOBS_PY", "DETACH_JOB_LAUNCH_GATE"] });
})();

export interface Fixture {
  readonly root: string;
  readonly env: NodeJS.ProcessEnv;
  readonly configFile: string;
  readonly scripts: string;
  readonly token: string;
  /** Every claude row's explicit 5h `ceiling_pct` (STRAT-SESSION-OPS-PIN-1): open/closed readings derive from it, never from an ops default. */
  readonly ceiling: number;
  /** The accounts file's explicit `target_pct`. */
  readonly target: number;
  /** Whether the accounts file has the Max row (claude, `default: true`, home `<home>/.claude`). */
  readonly withMax: boolean;
}

/** Explicit quota lines written by every fixture. 80 sits below the ops default ceiling (100) so a test that read the default would see a different line. */
export const FIXTURE_CEILING_PCT = 80;
export const FIXTURE_TARGET_PCT = 90;

const under = (path: string, root: string): boolean => path === root || path.startsWith(root + sep);

/**
 * contract test_fixture: every contracted key is present and resolves under `fx.root` (the three
 * script paths name the fixture's scripts dir; DETACH_JOB_RESUME_WAIT is "0"), and CLAUDECODE /
 * LAUNCH_GATE_ADMITTED are absent. `env` defaults to `fx.env`; pass the merged env a test hands a
 * script. `allowAbsent` names keys a row deliberately unsets (probe 1: STRATUM_CONFIG_FILE).
 * `checkRemoved` false is for a merged env whose CLAUDECODE / LAUNCH_GATE_ADMITTED a row adds on
 * purpose to prove the door strips them (the fixture env itself is always checked with it true).
 */
export function assertFixtureEnv(fx: Fixture, env: NodeJS.ProcessEnv = fx.env, allowAbsent: readonly string[] = [], checkRemoved = true): void {
  for (const key of CONTRACT_ENV.present) {
    const value = env[key];
    if (value === undefined && allowAbsent.includes(key)) continue;
    expect(typeof value === "string" && value !== "", `fixture env lacks ${key}`).toBe(true);
    if (key in CONTRACT_ENV.fixed) {
      expect(value, `fixture env ${key}`).toBe(CONTRACT_ENV.fixed[key]);
    } else if (CONTRACT_ENV.scriptPaths.includes(key)) {
      expect(value, `fixture env ${key} names the fixture scripts dir`).toBe(join(fx.scripts, basename(value!)));
    } else {
      expect(under(value!, fx.root), `fixture env ${key} resolves outside the fixture root`).toBe(true);
    }
  }
  if (checkRemoved) for (const key of CONTRACT_ENV.removed) expect(key in env, `fixture env carries ${key}`).toBe(false);
}

export interface FixtureOptions {
  readonly scripts?: string;
  readonly envDir?: "set" | "empty" | "unset";
  readonly config?: string | null;
  readonly withMax?: boolean;
}

export interface Suite {
  /** This file's run token, minted before the baseline listing. */
  readonly token: string;
  root(): string;
  fixture(options?: FixtureOptions): Fixture;
  /** A scripts dir holding one fixture script. */
  fakeScripts(name: string, body: string): string;
  /** Kill this process group in teardown, on the failure path too (fixture engines). */
  trackGroup(pgid: number): void;
}

export function suite(prefix: string): Suite {
  const token = mintToken(prefix);
  let root = "";
  let caseNo = 0;
  let before: Listing = new Map();
  const groups = new Set<number>();

  beforeAll(() => {
    before = listing(WATCHED_DIRS);
    const base = process.env.SESSION_MGMT_TMP || tmpdir();
    mkdirSync(base, { recursive: true });
    root = mkdtempSync(join(base, `stratum-${prefix}-`));
  }, HOOK_TIMEOUT_MS);

  afterAll(() => {
    for (const pgid of groups) {
      try { process.kill(-pgid, "SIGKILL"); } catch { /* already gone */ }
    }
    const { violations, warnings, otherChanges } = gate(before, listing(WATCHED_DIRS), { strictDirs: STRICT_DIRS, looseDirs: LOOSE_DIRS, token });
    for (const warning of warnings) process.stderr.write(`[leak-gate] WARNING ${warning}\n`);
    if (root) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    process.stderr.write(`[leak-gate] token=${token} violations=${violations.length} other-changes(live sessions)=${otherChanges}\n`);
    if (violations.length > 0) throw new Error(`leak gate: real state touched by this run: ${violations.join(", ")}`);
  }, HOOK_TIMEOUT_MS);

  return {
    token,
    root: () => root,
    trackGroup: (pgid) => { groups.add(pgid); },
    fakeScripts(name, body) {
      const dir = join(root, `fake${(caseNo += 1)}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, name), body);
      return dir;
    },
    fixture(options = {}) {
      const caseRoot = join(root, `c${(caseNo += 1)}`);
      const home = join(caseRoot, "home");
      const scripts = options.scripts ?? OPS_SCRIPTS;
      for (const dir of [home, join(home, ".claude", "session-state"), join(caseRoot, "uw-home"), join(caseRoot, "jobs"), join(caseRoot, "gate"), join(caseRoot, "detached")]) {
        mkdirSync(dir, { recursive: true });
      }
      const inherited = Object.fromEntries(Object.entries(process.env).filter(([key]) => !STRIPPED_PREFIX.test(key)));
      const configFile = join(caseRoot, "user-config.toml");
      const env: NodeJS.ProcessEnv = {
        ...inherited,
        HOME: home,
        PYTHONDONTWRITEBYTECODE: "1",
        USAGE_WATCH_ACCOUNTS: join(caseRoot, "accounts.json"),
        USAGE_WATCH_HOME: join(caseRoot, "uw-home"),
        USAGE_WATCH_STATE_DIR: join(home, ".claude", "session-state"),
        USAGE_WATCH_SESSION_STATE: join(home, ".claude", "session-state"),
        USAGE_WATCH_JOBS_DIR: join(caseRoot, "jobs"),
        USAGE_WATCH_DETACHED_DIR: join(caseRoot, "detached"),
        USAGE_WATCH_POLL_DIR: join(caseRoot, "poll"),
        USAGE_WATCH_PROBE_DIR: join(caseRoot, "probe"),
        USAGE_WATCH_SAT_LOG: join(caseRoot, "sat-log.md"),
        USAGE_WATCH_JOBS_PY: join(scripts, "jobs.py"),
        LAUNCH_GATE_STATE_DIR: join(caseRoot, "gate"),
        LAUNCH_GATE_JOBS_DIR: join(caseRoot, "jobs"),
        CLAUDE_JOBS_DIR: join(caseRoot, "jobs"),
        DETACH_JOB_JOBS_PY: join(scripts, "jobs.py"),
        DETACH_JOB_INDEX_DIR: join(caseRoot, "detached"),
        DETACH_JOB_ACTION_LOG: join(caseRoot, "detach-actions.log"),
        DETACH_JOB_LAUNCH_GATE: join(scripts, "launch_gate.py"),
        DETACH_JOB_RESUME_WAIT: "0",
        SEAT_STATE_DIR: join(caseRoot, "seat-state"),
        SEAT_CONTEXT_DIR: join(caseRoot, "seat-context"),
        SEAT_ACCOUNTS: join(caseRoot, "accounts.json"),
        SESSION_HOP_SESSIONS_DIR: join(caseRoot, "hop-sessions"),
        SESSION_HOP_LEDGER: join(caseRoot, "ledger.md"),
        SESSION_HOP_LOG: join(caseRoot, "hop.log"),
        SESSION_HOP_ITERM_FIXTURE: join(caseRoot, "tabs.json"),
        STRATUM_CONFIG_FILE: configFile,
      };
      const envDir = options.envDir ?? "set";
      if (envDir === "set") env.STRATUM_SESSION_SCRIPTS_DIR = scripts;
      if (envDir === "empty") env.STRATUM_SESSION_SCRIPTS_DIR = "";
      if (options.config !== undefined && options.config !== null) writeFileSync(configFile, options.config);
      const fx: Fixture = {
        root: caseRoot, env, configFile, scripts, token,
        ceiling: FIXTURE_CEILING_PCT, target: FIXTURE_TARGET_PCT, withMax: options.withMax === true,
      };
      writeAccounts(fx);
      assertFixtureEnv(fx);
      return fx;
    },
  };
}

/** The Claude seats every fixture has. */
export const SEATS = ["seat1", "seat2", "seat3", "seat4"] as const;

/** The accounts file: seat1-4 (claude, explicit ceiling_pct), codex, Max only when `fx.withMax`; explicit target_pct. */
export function writeAccounts(fx: Fixture): void {
  const home = join(fx.root, "home");
  const accounts = [
    ...(fx.withMax ? [{ id: "max", vendor: "claude", config_dir: join(home, ".claude"), label: "max", default: true, ceiling_pct: fx.ceiling }] : []),
    ...SEATS.map((id) => ({ id, vendor: "claude", config_dir: join(home, `.claude-${id}`), label: id, ceiling_pct: fx.ceiling })),
    { id: "codex", vendor: "codex", config_dir: join(home, ".codex"), label: "codex" },
  ];
  writeFileSync(join(fx.root, "accounts.json"), JSON.stringify({ target_pct: fx.target, accounts }));
  // pick runs a blank account through the spend backstop; a fresh $10 record keeps it ranking pace (as test_seat_reserve.py does).
  const now = Date.now() / 1000;
  const day = new Date().toLocaleDateString("sv-SE");
  writeFileSync(join(fx.root, "uw-home", "spend-status.json"), JSON.stringify({ version: 1, generated_at: now - 60, day, last_1h: 10.0 }));
}

/** A reading well under the ceiling and behind pace at `OPEN_ELAPSED_MIN` (target = ceiling x 150/300 = ceiling/2). */
export const openPct = (fx: Fixture): number => fx.ceiling / 8;
export const OPEN_ELAPSED_MIN = 150;
/** At the ceiling (usage_watch closes at used >= ceiling), late in the window. */
export const closedPct = (fx: Fixture): number => fx.ceiling;
export const CLOSED_ELAPSED_MIN = 299;

/** A 5h reading for `seat` (test_seat_reserve.py put_state shape), stamped now. */
export function putReading(fx: Fixture, seat: string, pct: number, elapsedMin: number): void {
  const now = Date.now() / 1000;
  const file = join(fx.env.USAGE_WATCH_STATE_DIR!, `${fx.token}-${seat}.json`);
  const home = seat === "max" ? join(fx.root, "home", ".claude") : join(fx.root, "home", `.claude-${seat}`);
  writeFileSync(file, JSON.stringify({
    session_id: `${fx.token}-${seat}`, config_dir: home, ts: now - 30,
    rl5_pct: pct, rl5_reset: now + (300 - elapsedMin) * 60, rl5_ts: now - 30,
  }));
  utimesSync(file, now - 30, now - 30);
}

export const openAll = (fx: Fixture): void => { for (const seat of SEATS) putReading(fx, seat, openPct(fx), OPEN_ELAPSED_MIN); };
export const closeAll = (fx: Fixture): void => { for (const seat of SEATS) putReading(fx, seat, closedPct(fx), CLOSED_ELAPSED_MIN); };

/** The env a helper hands the door: the fixture env plus the row's extras, asserted before any script runs. */
export function scriptRunEnv(fx: Fixture, extra: Partial<NodeJS.ProcessEnv> = {}): NodeJS.ProcessEnv {
  assertFixtureEnv(fx);
  const env = { ...fx.env, ...extra };
  for (const [key, value] of Object.entries(extra)) if (value === undefined) delete env[key];
  assertFixtureEnv(fx, env, Object.keys(extra).filter((key) => extra[key] === undefined), false);
  return env;
}

export function backend(fx: Fixture, extra: Partial<NodeJS.ProcessEnv> = {}, timeoutsMs?: Record<string, number>) {
  return createSessionBackend({ env: scriptRunEnv(fx, extra), projectRoot: fx.root, ...(timeoutsMs ? { timeoutsMs } : {}) });
}

export function cli(fx: Fixture, args: string[], extra: Partial<NodeJS.ProcessEnv> = {}, input?: string) {
  const run = spawnSync(process.execPath, [BIN, "session", ...args], {
    env: scriptRunEnv(fx, extra), cwd: fx.root, encoding: "utf8", timeout: 120_000, ...(input !== undefined ? { input } : {}),
  });
  const line = run.stdout.trim().split("\n").filter(Boolean).pop() ?? "";
  let envelope: Envelope<unknown> | null = null;
  try { envelope = JSON.parse(line) as Envelope<unknown>; } catch { envelope = null; }
  return { status: run.status, envelope, stdout: run.stdout, stderr: run.stderr };
}
