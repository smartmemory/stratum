import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync, closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, rmSync, utimesSync, writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadSessionConfig, loadStratumConfig } from "../../src/config/index.js";
import { cliExitFor, configured, createSessionBackend, type Envelope, MARKER_CAP_BYTES } from "../../src/session/index.js";

/**
 * SESSION-MGMT-1-U1. Real scripts (the ops checkout's claude/scripts, read-only), never
 * mocks of them; misbehaving fixture scripts only for the error rows the real ones cannot
 * produce on demand (unmapped exit, bad stdout, sleep). Every script subprocess runs under
 * contract `test_fixture`: HOME and every script override under one root, and the leak gate
 * below checks the real ~/.claude/{logs,session-state,usage}, the ops status/launch-gate dir
 * and ~/.stratum around the whole file.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, "..", "..", "src", "cli", "bin.mjs");
const OPS_SCRIPTS = process.env.SESSION_MGMT_OPS_SCRIPTS || "/Users/ruze/reg/my/SmartMemory/smart-memory-ops/claude/scripts";
const HAVE_OPS = existsSync(join(OPS_SCRIPTS, "usage_watch.py")) && existsSync(join(OPS_SCRIPTS, "jobs.py"));
const PYTHON = findPython();
const TOKEN = `u1lg${randomBytes(4).toString("hex")}`;
const FIXTURES = JSON.parse(readFileSync(join(HERE, "configured-fixtures.json"), "utf8")) as {
  rows: Array<{ name: string; env: "set" | "empty" | "unset"; file: string | null | { unreadable: true }; stratum: "configured" | "broken" | "unconfigured"; compose: boolean }>;
};

let ROOT = "";

function findPython(): string {
  for (const dir of (process.env.PATH ?? "").split(":")) {
    const candidate = join(dir, "python3");
    if (dir && existsSync(candidate)) return candidate;
  }
  return "python3";
}

// ---------------------------------------------------------------- leak gate (contract test_fixture.leak_gate)

const REAL_HOME = homedir();
const LEAK_DIRS = [
  join(REAL_HOME, ".claude", "logs"),
  join(REAL_HOME, ".claude", "session-state"),
  join(REAL_HOME, ".claude", "usage"),
  join(OPS_SCRIPTS, "..", "..", "status", "launch-gate"),
  join(REAL_HOME, ".stratum"),
];
type Listing = Map<string, { size: number; mtimeMs: number }>;

function listing(): Listing {
  const out: Listing = new Map();
  const walk = (dir: string): void => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile()) {
        try { const st = lstatSync(path); out.set(path, { size: st.size, mtimeMs: st.mtimeMs }); } catch { /* raced away */ }
      }
    }
  };
  for (const dir of LEAK_DIRS) walk(dir);
  return out;
}

/** The bytes a file gained since `before` (whole file, capped, when it shrank or is new). */
function newBytes(path: string, before: { size: number } | undefined): string {
  const cap = 4 * 1024 * 1024;
  try {
    const fd = openSync(path, "r");
    try {
      const size = lstatSync(path).size;
      const start = before !== undefined && size >= before.size ? before.size : 0;
      const length = Math.min(size - start, cap);
      const buf = Buffer.alloc(Math.max(length, 0));
      if (length > 0) readSync(fd, buf, 0, length, start);
      return buf.toString("latin1");
    } finally { closeSync(fd); }
  } catch { return ""; }
}

/**
 * Live sessions on this Mac write these dirs all the time, so "any change fails" would fail
 * every run. The gate fails on any changed or new file whose name or new bytes carry this
 * run's token (every session, id, label and name the tests create carries it) and reports
 * the count of other changes. The fixture's own root is outside every gated dir.
 */
function leaksSince(before: Listing): { leaks: string[]; otherChanges: number } {
  const after = listing();
  const leaks: string[] = [];
  let otherChanges = 0;
  for (const [path, st] of after) {
    const prior = before.get(path);
    if (prior !== undefined && prior.size === st.size && prior.mtimeMs === st.mtimeMs) continue;
    if (path.includes(TOKEN) || newBytes(path, prior).includes(TOKEN)) leaks.push(path);
    else otherChanges += 1;
  }
  return { leaks, otherChanges };
}

let BEFORE: Listing = new Map();

beforeAll(() => {
  BEFORE = listing();
  ROOT = mkdtempSync(join(tmpdir(), "stratum-u1-"));
});

afterAll(() => {
  // Fixture engines: U1 starts none (no launch op); the timeout row kills its own group.
  const { leaks, otherChanges } = leaksSince(BEFORE);
  if (ROOT) rmSync(ROOT, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  process.stderr.write(`[leak-gate] token=${TOKEN} leaks=${leaks.length} other-changes(live sessions)=${otherChanges}\n`);
  if (leaks.length > 0) throw new Error(`leak gate: real state touched by this run: ${leaks.join(", ")}`);
});

// ---------------------------------------------------------------- the fixture (contract test_fixture)

let caseNo = 0;

interface Fixture { root: string; env: NodeJS.ProcessEnv; configFile: string; scripts: string }

const STRIPPED_PREFIX = /^(USAGE_WATCH_|LAUNCH_GATE_|DETACH_JOB_|SEAT_|SESSION_HOP_|WORK_MODEL_|STRATUM_SESSION_|CLAUDE_JOBS_DIR$|STRATUM_CONFIG_FILE$|CLAUDECODE$|CLAUDE_CONFIG_DIR$|CODEX_HOME$)/;

function fixture(options: { scripts?: string; envDir?: "set" | "empty" | "unset"; config?: string | null } = {}): Fixture {
  const root = join(ROOT, `c${(caseNo += 1)}`);
  const home = join(root, "home");
  const scripts = options.scripts ?? OPS_SCRIPTS;
  for (const dir of [home, join(home, ".claude", "session-state"), join(root, "uw-home"), join(root, "jobs"), join(root, "gate"), join(root, "detached")]) {
    mkdirSync(dir, { recursive: true });
  }
  const base = Object.fromEntries(Object.entries(process.env).filter(([key]) => !STRIPPED_PREFIX.test(key)));
  const configFile = join(root, "user-config.toml");
  const env: NodeJS.ProcessEnv = {
    ...base,
    HOME: home,
    PYTHONDONTWRITEBYTECODE: "1",
    USAGE_WATCH_ACCOUNTS: join(root, "accounts.json"),
    USAGE_WATCH_HOME: join(root, "uw-home"),
    USAGE_WATCH_STATE_DIR: join(home, ".claude", "session-state"),
    USAGE_WATCH_SESSION_STATE: join(home, ".claude", "session-state"),
    USAGE_WATCH_JOBS_DIR: join(root, "jobs"),
    USAGE_WATCH_DETACHED_DIR: join(root, "detached"),
    USAGE_WATCH_POLL_DIR: join(root, "poll"),
    USAGE_WATCH_PROBE_DIR: join(root, "probe"),
    USAGE_WATCH_SAT_LOG: join(root, "sat-log.md"),
    USAGE_WATCH_JOBS_PY: join(scripts, "jobs.py"),
    LAUNCH_GATE_STATE_DIR: join(root, "gate"),
    LAUNCH_GATE_JOBS_DIR: join(root, "jobs"),
    CLAUDE_JOBS_DIR: join(root, "jobs"),
    DETACH_JOB_JOBS_PY: join(scripts, "jobs.py"),
    DETACH_JOB_INDEX_DIR: join(root, "detached"),
    DETACH_JOB_ACTION_LOG: join(root, "detach-actions.log"),
    DETACH_JOB_LAUNCH_GATE: join(scripts, "launch_gate.py"),
    DETACH_JOB_RESUME_WAIT: "0",
    SEAT_STATE_DIR: join(root, "seat-state"),
    SEAT_CONTEXT_DIR: join(root, "seat-context"),
    SEAT_ACCOUNTS: join(root, "accounts.json"),
    SESSION_HOP_SESSIONS_DIR: join(root, "hop-sessions"),
    SESSION_HOP_LEDGER: join(root, "ledger.md"),
    SESSION_HOP_LOG: join(root, "hop.log"),
    SESSION_HOP_ITERM_FIXTURE: join(root, "tabs.json"),
    STRATUM_CONFIG_FILE: configFile,
  };
  const envDir = options.envDir ?? "set";
  if (envDir === "set") env.STRATUM_SESSION_SCRIPTS_DIR = scripts;
  if (envDir === "empty") env.STRATUM_SESSION_SCRIPTS_DIR = "";
  if (options.config !== undefined && options.config !== null) writeFileSync(configFile, options.config);
  writeAccounts(root);
  return { root, env, configFile, scripts };
}

function writeAccounts(root: string): void {
  const home = join(root, "home");
  const accounts = [
    ...["seat1", "seat2", "seat3", "seat4"].map((id) => ({ id, vendor: "claude", config_dir: join(home, `.claude-${id}`), label: id })),
    { id: "codex", vendor: "codex", config_dir: join(home, ".codex"), label: "codex" },
  ];
  writeFileSync(join(root, "accounts.json"), JSON.stringify({ target_pct: 90, accounts }));
  // pick runs a blank account through the spend backstop; a fresh $10 record keeps it ranking pace (as test_seat_reserve.py does).
  const now = Date.now() / 1000;
  const day = new Date().toLocaleDateString("sv-SE");
  writeFileSync(join(root, "uw-home", "spend-status.json"), JSON.stringify({ version: 1, generated_at: now - 60, day, last_1h: 10.0 }));
}

/** A 5h reading for `seat` (test_seat_reserve.py put_state shape), stamped now. */
function putReading(fx: Fixture, seat: string, pct: number, elapsedMin: number): void {
  const now = Date.now() / 1000;
  const file = join(fx.env.USAGE_WATCH_STATE_DIR!, `${TOKEN}-${seat}.json`);
  writeFileSync(file, JSON.stringify({
    session_id: `${TOKEN}-${seat}`, config_dir: join(fx.root, "home", `.claude-${seat}`), ts: now - 30,
    rl5_pct: pct, rl5_reset: now + (300 - elapsedMin) * 60, rl5_ts: now - 30,
  }));
  utimesSync(file, now - 30, now - 30);
}

/** A scripts dir holding one fixture script. */
function fakeScripts(name: string, body: string): string {
  const dir = join(ROOT, `fake${(caseNo += 1)}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, name), body);
  return dir;
}

function backend(fx: Fixture, extra: Partial<NodeJS.ProcessEnv> = {}, timeoutsMs?: Record<string, number>) {
  return createSessionBackend({ env: { ...fx.env, ...extra }, projectRoot: fx.root, ...(timeoutsMs ? { timeoutsMs } : {}) });
}

function cli(fx: Fixture, args: string[], extra: Partial<NodeJS.ProcessEnv> = {}) {
  const run = spawnSync(process.execPath, [BIN, "session", ...args], { env: { ...fx.env, ...extra }, cwd: fx.root, encoding: "utf8", timeout: 120_000 });
  const line = run.stdout.trim().split("\n").filter(Boolean).pop() ?? "";
  let envelope: Envelope<unknown> | null = null;
  try { envelope = JSON.parse(line) as Envelope<unknown>; } catch { envelope = null; }
  return { status: run.status, envelope, stdout: run.stdout, stderr: run.stderr };
}

function code(envelope: Envelope<unknown>): string {
  return envelope.ok ? "ok" : envelope.refusal.code;
}

// ---------------------------------------------------------------- configured(): the shared fixture table

describe("configured(env): contract backend.configured_test, one row per fixture", () => {
  it("every row obeys stratum configured => compose configured", () => {
    for (const row of FIXTURES.rows) if (row.stratum !== "unconfigured") expect(row.compose, row.name).toBe(true);
  });

  for (const row of FIXTURES.rows) {
    it(`${row.name}: stratum ${row.stratum}, compose ${row.compose}`, async () => {
      const fx = fixture({ envDir: row.env, config: null });
      if (typeof row.file === "string") writeFileSync(fx.configFile, row.file.replaceAll("{SCRIPTS_DIR}", OPS_SCRIPTS));
      if (row.file !== null && typeof row.file === "object") {
        writeFileSync(fx.configFile, `[session]\nscripts_dir = "${OPS_SCRIPTS}"\n`);
        chmodSync(fx.configFile, 0o000);
      }
      try {
        // compose column = contract configured_test.compose_impl, recomputed so the table cannot drift.
        const text = typeof row.file === "string" ? row.file : "";
        const composeRule = (fx.env.STRATUM_SESSION_SCRIPTS_DIR ?? "") !== ""
          || (row.file !== null && (typeof row.file === "object" || text.includes("session") || text.includes("\\u") || text.includes("\\U")));
        expect(composeRule, "compose column").toBe(row.compose);

        expect(configured(fx.env)).toBe(row.stratum !== "unconfigured");
        const config = loadSessionConfig({ env: fx.env, projectRoot: fx.root });
        expect(config.error !== null, `error: ${config.error}`).toBe(row.stratum === "broken");

        const b = backend(fx);
        const jobs = await b.jobsList({ session: `${TOKEN}-none` });
        const admit = await b.admit({ engine: "claude", label: "probe", model: "sonnet", launchGate: "none" }, { childEnv: fx.env });
        if (row.stratum === "unconfigured") {
          expect([code(jobs), jobs.backend]).toEqual(["backend-unconfigured", "none"]);
          expect(admit.ok && admit.backend === "none" && admit.childEnv === fx.env).toBe(true);
        } else if (row.stratum === "broken" || config.scriptsDir === null) {
          expect([code(jobs), jobs.backend]).toEqual(["backend-unavailable", "scripts"]);
          expect([code(admit), admit.backend]).toEqual(["backend-unavailable", "scripts"]);
        } else {
          expect(admit.backend).toBe("scripts");
          if (HAVE_OPS) expect(code(jobs)).toBe("ok");
        }
      } finally {
        if (existsSync(fx.configFile)) chmodSync(fx.configFile, 0o600);
      }
    });
  }
});

describe("[session] in a project stratum.toml is a config error naming the file", () => {
  it("both loaders refuse it; the door is backend-unavailable, never pass-through", async () => {
    const fx = fixture({ envDir: "unset" });
    const project = join(fx.root, "stratum.toml");
    writeFileSync(project, `[session]\nscripts_dir = "${OPS_SCRIPTS}"\n`);
    const userFile = join(fx.root, "user.toml");
    const env = { ...fx.env, STRATUM_CONFIG_FILE: userFile };
    expect(() => loadStratumConfig({ env, projectRoot: fx.root })).toThrow(project);
    const pick = await createSessionBackend({ env, projectRoot: fx.root }).pick({ kind: "author" });
    expect([code(pick), pick.backend]).toEqual(["backend-unavailable", "scripts"]);
    expect(pick.ok ? "" : pick.refusal.reason).toContain(project);
    // The user file accepts the same table; an unknown key inside it is named.
    writeFileSync(userFile, "[session]\nscripts_dir = \"/x\"\nbogus = 1\n");
    rmSync(project);
    expect(() => loadStratumConfig({ env, projectRoot: fx.root })).not.toThrow();
    expect(loadSessionConfig({ env, projectRoot: fx.root }).error).toContain('"session.bogus"');
  });
});

// ---------------------------------------------------------------- error table (one row per case)

const PICK_OK_DOC = `{"kind": "author", "choice": {"id": "seat1", "vendor": "claude", "label": "seat1", "command": "ccd1 -n x"}, "reason": "r", "rule": "u"}`;

interface ErrorRow {
  name: string;
  script?: { file: string; body: string };
  op: "pick" | "jobs" | "register";
  setup?: (fx: Fixture) => Partial<NodeJS.ProcessEnv>;
  timeoutMs?: number;
  expectCode: string;
  expectRecord?: "null" | "object";
  check?: (envelope: Envelope<unknown>, fx: Fixture) => void;
}

const py = (body: string) => `import json, os, sys, time\n${body}\n`;

const ERROR_ROWS: ErrorRow[] = [
  { name: "configured + scripts dir missing", op: "pick", setup: (fx) => ({ STRATUM_SESSION_SCRIPTS_DIR: join(fx.root, "no-such-dir") }), expectCode: "backend-unavailable" },
  { name: "configured + scripts dir relative", op: "pick", setup: () => ({ STRATUM_SESSION_SCRIPTS_DIR: "claude/scripts" }), expectCode: "backend-unavailable" },
  { name: "configured + script missing", op: "jobs", script: { file: "usage_watch.py", body: "" }, expectCode: "backend-unavailable" },
  { name: "configured + python missing", op: "pick", setup: (fx) => ({ STRATUM_SESSION_PYTHON: join(fx.root, "no-python3") }), expectCode: "backend-unavailable" },
  { name: "configured + python relative path", op: "pick", setup: () => ({ STRATUM_SESSION_PYTHON: "bin/python3" }), expectCode: "backend-unavailable" },
  { name: "config parse error", op: "pick", setup: (fx) => { writeFileSync(fx.configFile, "[session\n"); return {}; }, expectCode: "backend-unavailable" },
  { name: "exit 9 (unmapped)", op: "pick", script: { file: "usage_watch.py", body: py(`print(${JSON.stringify(PICK_OK_DOC)}); sys.exit(9)`) }, expectCode: "backend-error", expectRecord: "null",
    check: (e) => expect(e.ok ? null : e.refusal.script_exit).toBe(9) },
  { name: "exit 0 with non-JSON stdout", op: "pick", script: { file: "usage_watch.py", body: py(`print("not json")`) }, expectCode: "backend-error" },
  { name: "exit 0 with two JSON documents", op: "pick", script: { file: "usage_watch.py", body: py(`print(${JSON.stringify(PICK_OK_DOC)}); print(${JSON.stringify(PICK_OK_DOC)})`) }, expectCode: "backend-error" },
  { name: "exit 0 with no stdout", op: "pick", script: { file: "usage_watch.py", body: py("pass") }, expectCode: "backend-error" },
  { name: "exit 0 wrong shape (no choice)", op: "pick", script: { file: "usage_watch.py", body: py(`print(json.dumps({"kind": "author", "choice": None, "reason": "r", "rule": "u"}))`) }, expectCode: "backend-error" },
  { name: "exit 1 refusal with wrong-shape JSON", op: "pick", script: { file: "usage_watch.py", body: py(`print(json.dumps({"foo": 1})); sys.exit(1)`) }, expectCode: "backend-error" },
  { name: "exit 1 refusal with non-JSON stdout", op: "pick", script: { file: "usage_watch.py", body: py(`print("nope"); sys.exit(1)`) }, expectCode: "backend-error" },
  { name: "exit 1 refusal with its record", op: "pick", script: { file: "usage_watch.py", body: py(`print(json.dumps({"kind": "author", "choice": None, "reason": "all closed", "rule": "u", "seats": []})); sys.exit(1)`) },
    expectCode: "no-eligible-account", expectRecord: "object", check: (e) => expect(e.ok ? "" : e.refusal.reason).toBe("all closed") },
  { name: "exit 3 without code ahead-of-pace", op: "pick", script: { file: "usage_watch.py", body: py(`print(json.dumps({"kind": "author", "choice": None, "reason": "r", "rule": "u"})); sys.exit(3)`) }, expectCode: "backend-error" },
  { name: "exit 3 ahead-of-pace", op: "pick", script: { file: "usage_watch.py", body: py(`print(json.dumps({"kind": "author", "choice": None, "reason": "hold", "rule": "u", "code": "ahead-of-pace"})); sys.exit(3)`) }, expectCode: "ahead-of-pace", expectRecord: "object" },
  { name: "jobs exit 1 with no JSON: record null, reason from stderr", op: "jobs", script: { file: "jobs.py", body: py(`print("REFUSED: unsafe session name", file=sys.stderr); sys.exit(1)`) },
    expectCode: "registry-refused", expectRecord: "null", check: (e) => expect(e.ok ? "" : e.refusal.reason).toBe("REFUSED: unsafe session name") },
  { name: "jobs exit 2 (not in its map)", op: "jobs", script: { file: "jobs.py", body: py(`sys.exit(2)`) }, expectCode: "backend-error" },
  { name: "register echo with another session", op: "register", script: { file: "jobs.py", body: py(`print(json.dumps({"op": "add", "session": "other", "kind": "agent", "id": "${TOKEN}-1", "report": None, "collect": None, "label": None, "ts": 1.0}))`) }, expectCode: "backend-error" },
  { name: "register echo with op done", op: "register", script: { file: "jobs.py", body: py(`print(json.dumps({"op": "done", "session": "${TOKEN}", "kind": "agent", "id": "${TOKEN}-1", "report": None, "collect": None, "label": None, "ts": 1.0}))`) }, expectCode: "backend-error" },
  { name: "killed by a signal", op: "pick", script: { file: "usage_watch.py", body: py(`import signal; os.kill(os.getpid(), signal.SIGTERM)`) }, expectCode: "backend-error" },
  { name: "timeout kills the process group (grandchild too)", op: "pick", timeoutMs: 1500,
    script: { file: "usage_watch.py", body: py(`import subprocess\np = subprocess.Popen(["sleep", "60"])\nopen(os.environ["U1_PIDFILE"], "w").write(str(p.pid))\ntime.sleep(60)`) },
    setup: (fx) => ({ U1_PIDFILE: join(fx.root, "grandchild.pid") }), expectCode: "backend-timeout",
    check: (_e, fx) => {
      const pid = Number(readFileSync(join(fx.root, "grandchild.pid"), "utf8"));
      expect(Number.isInteger(pid) && pid > 0).toBe(true);
      let alive = true;
      for (let i = 0; i < 50 && alive; i += 1) {
        try { process.kill(pid, 0); spawnSync("sleep", ["0.1"]); } catch { alive = false; }
      }
      expect(alive, `grandchild ${pid} survived the timeout`).toBe(false);
    } },
];

describe("error table: every failure is a typed refusal", () => {
  for (const row of ERROR_ROWS) {
    it(row.name, async () => {
      const scripts = row.script ? fakeScripts(row.script.file === "usage_watch.py" && row.name.includes("script missing") ? "unrelated.py" : row.script.file, row.script.body) : OPS_SCRIPTS;
      const fx = fixture({ scripts });
      const extra = row.setup?.(fx) ?? {};
      const b = backend(fx, extra, row.timeoutMs ? { pick: row.timeoutMs } : undefined);
      const envelope = row.op === "pick" ? await b.pick({ kind: "author" })
        : row.op === "jobs" ? await b.jobsList({ session: TOKEN })
        : await b.jobsRegister({ session: TOKEN, kind: "agent", id: `${TOKEN}-1` });
      expect(code(envelope), JSON.stringify(envelope)).toBe(row.expectCode);
      expect(envelope.backend).toBe("scripts");
      if (!envelope.ok && row.expectRecord === "null") expect(envelope.record).toBeNull();
      if (!envelope.ok && row.expectRecord === "object") expect(typeof envelope.record).toBe("object");
      row.check?.(envelope, fx);
    }, 30_000);
  }
});

// ---------------------------------------------------------------- exec boundary: argv, stdin, env

const PROBE_PICK = py(`
same = os.path.samestat(os.fstat(0), os.stat("/dev/null"))
leaked = sorted(k for k in ("CLAUDECODE", "LAUNCH_GATE_ADMITTED") if k in os.environ)
print(json.dumps({"kind": "author", "choice": {"id": "seat1", "vendor": "claude", "label": None, "command": json.dumps(sys.argv[1:])},
                  "reason": "stdin-devnull=%s" % same, "rule": "leaked=%s" % ",".join(leaked)}))`);

const PROBE_ADMIT = py(`
data = sys.stdin.buffer.read()
leaked = sorted(k for k in ("CLAUDECODE", "LAUNCH_GATE_ADMITTED") if k in os.environ)
home = os.environ.get("U1_HOME", "")
extra = {"OTHER": "x"} if os.environ.get("U1_EXTRA") else {}
print(json.dumps({"admitted": True, "code": None, "reason": "stdin=%d argv=%s leaked=%s" % (len(data), json.dumps(sys.argv[1:]), ",".join(leaked)),
                  "engine": "claude", "account": {"id": "seat2", "vendor": "claude", "label": "seat2", "config_dir_name": ".claude-seat2"},
                  "env": dict({"CLAUDE_CONFIG_DIR": home}, **extra), "checks": [], "launch_gate_label": None}))`);

describe("exec boundary", () => {
  it("argv only: a name with spaces and a leading '-' reaches the script verbatim, one argv element", async () => {
    const fx = fixture({ scripts: fakeScripts("usage_watch.py", PROBE_PICK) });
    const name = "-x y $(touch pwned) ;rm";
    const envelope = await backend(fx).pick({ kind: "author", name });
    expect(envelope.ok).toBe(true);
    const argv = JSON.parse((envelope.ok ? envelope.data.choice?.command : "[]") ?? "[]") as string[];
    expect(argv).toEqual(["pick", "--kind=author", "--author-vendor=claude", `--name=${name}`, "--json"]);
    expect(existsSync(join(fx.root, "pwned"))).toBe(false);
  });

  it("stdin is /dev/null and CLAUDECODE / LAUNCH_GATE_ADMITTED are stripped for a non-admit op", async () => {
    const fx = fixture({ scripts: fakeScripts("usage_watch.py", PROBE_PICK) });
    const envelope = await backend(fx, { CLAUDECODE: "1", LAUNCH_GATE_ADMITTED: "x" }).pick({ kind: "author" });
    expect(envelope.ok && [envelope.data.reason, envelope.data.rule]).toEqual(["stdin-devnull=True", "leaked="]);
  });

  it("admit: marker on stdin (capped), never in argv; env stripped; childEnv = candidate + the admitted home", async () => {
    const fx = fixture({ scripts: fakeScripts("session_admit.py", PROBE_ADMIT) });
    const home = join(fx.root, "home", ".claude-seat2");
    const marker = `hard: ${TOKEN} marker ${"é".repeat(MARKER_CAP_BYTES)}`;
    const childEnv = { ...fx.env, U1_HOME: home, CLAUDECODE: "1", LAUNCH_GATE_ADMITTED: "x" };
    const result = await backend(fx).admit({ engine: "claude", label: "lbl", model: "sonnet", markerText: marker }, { childEnv });
    expect(result.ok, JSON.stringify(result)).toBe(true);
    const reason = result.ok ? result.data.reason : "";
    const capped = Number(/stdin=(\d+)/.exec(reason)?.[1]);
    expect(capped <= MARKER_CAP_BYTES && capped >= MARKER_CAP_BYTES - 1).toBe(true);
    expect(reason).not.toContain(TOKEN);
    expect(reason).toContain("leaked=");
    expect(reason.endsWith("leaked=")).toBe(true);
    expect(result.childEnv?.CLAUDE_CONFIG_DIR).toBe(home);
    expect(result.childEnv?.U1_HOME).toBe(home);
  });

  it("admit: an admitted env with any key besides the engine home is backend-error", async () => {
    const fx = fixture({ scripts: fakeScripts("session_admit.py", PROBE_ADMIT) });
    const result = await backend(fx).admit({ engine: "claude", label: "lbl", model: "sonnet" },
      { childEnv: { ...fx.env, U1_HOME: join(fx.root, "home", ".claude-seat2"), U1_EXTRA: "1" } });
    expect([code(result), result.childEnv]).toEqual(["backend-error", null]);
  });

  it("admit: a relative engine home is backend-error", async () => {
    const fx = fixture({ scripts: fakeScripts("session_admit.py", PROBE_ADMIT) });
    const result = await backend(fx).admit({ engine: "claude", label: "lbl", model: "sonnet" }, { childEnv: { ...fx.env, U1_HOME: "rel/.claude-seat2" } });
    expect(code(result)).toBe("backend-error");
  });

  it("admit in mode scripts never passes through when its script is missing (today: no session_admit.py in ops)", async () => {
    const fx = fixture({ scripts: fakeScripts("usage_watch.py", "") });
    const result = await backend(fx).admit({ engine: "claude", label: "lbl", model: "sonnet" }, { childEnv: fx.env });
    expect([code(result), result.backend, result.childEnv]).toEqual(["backend-unavailable", "scripts", null]);
  });
});

// ---------------------------------------------------------------- real scripts: golden flow and register rows

describe.skipIf(!HAVE_OPS)("real scripts (ops claude/scripts, read-only)", () => {
  it("golden flow: register a job -> jobs shows it -> pick returns a seat", async () => {
    const fx = fixture();
    for (const seat of ["seat1", "seat2", "seat3", "seat4"]) putReading(fx, seat, 10, 150);
    const b = backend(fx);
    const session = `${TOKEN}-golden`;
    const reg = await b.jobsRegister({ session, kind: "agent", id: `${TOKEN}-g1`, report: join(fx.root, "report.md"), label: "golden" });
    expect(reg.ok, JSON.stringify(reg)).toBe(true);
    const list = await b.jobsList({ session });
    expect(list.ok && list.data.rows.map((row) => [row.session, row.id, row.status])).toEqual([[session, `${TOKEN}-g1`, "running"]]);
    expect(list.ok && list.data.bad_count).toBe(0);
    expect(readdirSync(join(fx.root, "jobs")).some((f) => f.includes(session))).toBe(true);
    const pick = await b.pick({ kind: "author", name: `${TOKEN} name` });
    expect(pick.ok, JSON.stringify(pick)).toBe(true);
    expect(pick.ok && pick.data.choice?.id).toMatch(/^seat[1-4]$/);
  }, 60_000);

  it("pick: every seat at its ceiling -> no-eligible-account with the seat table as record", async () => {
    const fx = fixture();
    for (const seat of ["seat1", "seat2", "seat3", "seat4"]) putReading(fx, seat, 95, 299);
    const pick = await backend(fx).pick({ kind: "author" });
    expect(code(pick), JSON.stringify(pick)).toBe("no-eligible-account");
    expect(pick.ok ? null : (pick.record as { seats: unknown[] }).seats.length).toBe(4);
    expect(cliExitFor(pick)).toBe(1);
  }, 60_000);

  it("jobs passes bad_count through unchanged", async () => {
    const fx = fixture();
    const session = `${TOKEN}-bad`;
    const b = backend(fx);
    expect((await b.jobsRegister({ session, kind: "bash", id: `${TOKEN}-b1` })).ok).toBe(true);
    const registry = readdirSync(join(fx.root, "jobs")).find((f) => f.includes(session))!;
    writeFileSync(join(fx.root, "jobs", registry), `${readFileSync(join(fx.root, "jobs", registry), "utf8")}not json\n`);
    const list = await b.jobsList({ session });
    expect(list.ok && list.data.bad_count).toBe(1);
  }, 60_000);

  const REGISTER_ROWS: Array<{ name: string; priority?: "P1"; expect: string | undefined }> = [
    { name: "without --priority: no priority_source", expect: undefined },
    { name: "with --priority P1: priority_source explicit", priority: "P1", expect: "explicit" },
  ];
  for (const row of REGISTER_ROWS) {
    it(`register ${row.name}`, async () => {
      const fx = fixture();
      const reg = await backend(fx).jobsRegister({ session: `${TOKEN}-r`, kind: "stratum", id: `${TOKEN}-r1`, pid: 4242, vendor: "codex", ...(row.priority ? { priority: row.priority } : {}) });
      expect(reg.ok, JSON.stringify(reg)).toBe(true);
      expect(reg.ok && reg.data.priority_source).toBe(row.expect);
      expect(reg.ok && [reg.data.op, reg.data.pid, reg.data.vendor]).toEqual(["add", 4242, "codex"]);
    }, 60_000);
  }

  it("register refused by the registry (bad kind for jobs.py is caught first; unsafe session reaches it) -> registry-refused", async () => {
    const fx = fixture();
    const reg = await backend(fx).jobsRegister({ session: `${TOKEN}/x`, kind: "agent", id: `${TOKEN}-1` });
    expect([code(reg), reg.ok ? null : reg.record]).toEqual(["registry-refused", null]);
  }, 60_000);
});

// ---------------------------------------------------------------- the CLI (plan U1 probes as rows)

describe("stratum session CLI", () => {
  it("probe 1: env unset, no config file -> exit 4 backend-unconfigured", () => {
    const fx = fixture({ envDir: "unset" });
    const run = cli(fx, ["pick", "--kind", "author", "--json"], { STRATUM_CONFIG_FILE: undefined });
    expect([run.status, run.envelope && code(run.envelope), run.envelope?.backend]).toEqual([4, "backend-unconfigured", "none"]);
  }, 60_000);

  it("probe 2: [session] with no scripts_dir -> exit 4 backend-unavailable (not unconfigured)", () => {
    const fx = fixture({ envDir: "unset", config: "[session]\n" });
    const run = cli(fx, ["pick", "--kind", "author", "--json"]);
    expect([run.status, run.envelope && code(run.envelope), run.envelope?.backend]).toEqual([4, "backend-unavailable", "scripts"]);
  }, 60_000);

  it("probe 5: a script printing `not json` -> exit 4 backend-error", () => {
    const fx = fixture({ scripts: fakeScripts("usage_watch.py", py(`print("not json")`)) });
    const run = cli(fx, ["pick", "--kind", "author", "--json"]);
    expect([run.status, run.envelope && code(run.envelope)]).toEqual([4, "backend-error"]);
  }, 60_000);

  it("usage: unknown verb, missing --kind, bad kind, stray positional -> exit 2", () => {
    const fx = fixture({ envDir: "unset" });
    for (const args of [["nope"], ["pick", "--json"], ["pick", "--kind", "bogus", "--json"], ["jobs", "extra"], ["register", "--session", "s", "--json"]]) {
      expect(cli(fx, args).status, args.join(" ")).toBe(2);
    }
  }, 60_000);

  it.skipIf(!HAVE_OPS)("probes 3, 4, 7 through the CLI on real scripts", () => {
    const fx = fixture();
    for (const seat of ["seat1", "seat2", "seat3", "seat4"]) putReading(fx, seat, 95, 299);
    const closed = cli(fx, ["pick", "--kind", "author", "--json"]);
    expect([closed.status, closed.envelope && code(closed.envelope)]).toEqual([1, "no-eligible-account"]);
    expect(closed.envelope && !closed.envelope.ok ? (closed.envelope.record as { seats: unknown[] }).seats.length : null).toBe(4);

    const open = fixture();
    for (const seat of ["seat1", "seat2", "seat3", "seat4"]) putReading(open, seat, 10, 150);
    const name = `$(touch ${join(open.root, "x")})`;
    const picked = cli(open, ["pick", "--kind", "author", "--name", name, "--json"]);
    expect(picked.status, picked.stderr).toBe(0);
    expect(picked.envelope?.ok && (picked.envelope.data as { choice: { command: string } }).choice.command).toContain(name);
    expect(existsSync(join(open.root, "x"))).toBe(false);

    const plain = cli(open, ["register", "--session", `${TOKEN}-c`, "--kind", "agent", "--id", `${TOKEN}-c1`, "--json"]);
    expect(plain.status, plain.stderr).toBe(0);
    expect(plain.envelope?.ok && "priority_source" in (plain.envelope.data as object)).toBe(false);
    const explicit = cli(open, ["register", "--session", `${TOKEN}-c`, "--kind", "agent", "--id", `${TOKEN}-c2`, "--priority", "P1", "--json"]);
    expect(explicit.envelope?.ok && (explicit.envelope.data as { priority_source: string }).priority_source).toBe("explicit");
    const jobs = cli(open, ["jobs", "--session", `${TOKEN}-c`, "--json"]);
    expect(jobs.status).toBe(0);
    expect(jobs.envelope?.ok && (jobs.envelope.data as { rows: unknown[] }).rows.length).toBe(2);
  }, 120_000);
});
