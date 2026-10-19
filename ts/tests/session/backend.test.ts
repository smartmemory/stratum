import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { loadSessionConfig, loadStratumConfig } from "../../src/config/index.js";
import { resolveLearnConfig } from "../../src/config/learn.js";
import { WORK_KINDS } from "../../src/session/backend.js";
import { cliExitFor, configured, createSessionBackend, type Envelope, MARKER_CAP_BYTES } from "../../src/session/index.js";
import {
  assertFixtureEnv, backend, cli, closeAll, code, type Fixture, HAVE_OPS, openAll, OPS_SCRIPTS, py, SEATS, suite,
} from "./fixture.js";

/**
 * SESSION-MGMT-1-U1. Real scripts (the ops checkout's claude/scripts, read-only), never
 * mocks of them; misbehaving fixture scripts only for the error rows the real ones cannot
 * produce on demand (unmapped exit, bad stdout, sleep). Every script subprocess runs under
 * contract `test_fixture` (fixture.ts): HOME and every script override under one root, and the
 * leak gate checks the real ~/.claude/{logs,session-state,usage}, the ops status/launch-gate dir
 * and ~/.stratum around the whole file.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const S = suite("u1lg");
const TOKEN = S.token;
const fixture = S.fixture;
const fakeScripts = S.fakeScripts;
const FIXTURES = JSON.parse(readFileSync(join(HERE, "configured-fixtures.json"), "utf8")) as {
  rows: Array<{
    name: string; env: "set" | "empty" | "unset"; file: string | null | { special: Special };
    stratum: "configured" | "broken" | "unconfigured"; compose: boolean;
  }>;
};

type Special = "file-mode-000" | "ancestor-mode-000" | "directory" | "dangling-symlink";

// ---------------------------------------------------------------- configured(): the shared fixture table

describe("configured(env): contract backend.configured_test, one row per fixture", () => {
  it("every row obeys stratum configured => compose configured", () => {
    for (const row of FIXTURES.rows) if (row.stratum !== "unconfigured") expect(row.compose, row.name).toBe(true);
  });

  for (const row of FIXTURES.rows) {
    it(`${row.name}: stratum ${row.stratum}, compose ${row.compose}`, async () => {
      const fx = fixture({ envDir: row.env, config: null });
      const special = row.file !== null && typeof row.file === "object" ? row.file.special : null;
      // ancestor-mode-000: review F1's repro, a [session] file inside a directory this process cannot search.
      const locked = join(fx.root, "locked");
      const env = special === "ancestor-mode-000" ? { ...fx.env, STRATUM_CONFIG_FILE: join(locked, "user-config.toml") } : fx.env;
      const configFile = env.STRATUM_CONFIG_FILE!;
      if (typeof row.file === "string") writeFileSync(configFile, row.file.replaceAll("{SCRIPTS_DIR}", OPS_SCRIPTS));
      if (special === "file-mode-000") {
        writeFileSync(configFile, `[session]\nscripts_dir = "${OPS_SCRIPTS}"\n`);
        chmodSync(configFile, 0o000);
      }
      if (special === "ancestor-mode-000") {
        mkdirSync(locked);
        writeFileSync(configFile, `[session]\nscripts_dir = "/missing"\n`);
        chmodSync(locked, 0o000);
      }
      if (special === "directory") mkdirSync(configFile);
      if (special === "dangling-symlink") symlinkSync(join(fx.root, "nowhere.toml"), configFile);
      try {
        // compose column = contract configured_test.compose_impl, recomputed so the table cannot drift:
        // env non-empty, or the user config path is not proven absent (stat errno other than ENOENT/ENOTDIR, or stat succeeds).
        let provenAbsent = false;
        try { statSync(configFile); } catch (error) { provenAbsent = ["ENOENT", "ENOTDIR"].includes((error as { code?: string }).code ?? ""); }
        const composeRule = (env.STRATUM_SESSION_SCRIPTS_DIR ?? "") !== "" || !provenAbsent;
        expect(composeRule, "compose column").toBe(row.compose);

        expect(configured(env)).toBe(row.stratum !== "unconfigured");
        const config = loadSessionConfig({ env, projectRoot: fx.root });
        expect(config.error !== null, `error: ${config.error}`).toBe(row.stratum === "broken");

        assertFixtureEnv(fx, env);
        const b = createSessionBackend({ env, projectRoot: fx.root });
        const jobs = await b.jobsList({ session: `${TOKEN}-none` });
        const admit = await b.admit({ engine: "claude", label: "probe", model: "sonnet", launchGate: "none" }, { childEnv: env });
        if (row.stratum === "unconfigured") {
          expect([code(jobs), jobs.backend]).toEqual(["backend-unconfigured", "none"]);
          expect(admit.ok && admit.backend === "none" && admit.childEnv === env).toBe(true);
        } else if (row.stratum === "broken" || config.scriptsDir === null) {
          expect([code(jobs), jobs.backend]).toEqual(["backend-unavailable", "scripts"]);
          expect([code(admit), admit.backend, admit.childEnv]).toEqual(["backend-unavailable", "scripts", null]);
        } else {
          expect(admit.backend).toBe("scripts");
          if (HAVE_OPS) expect(code(jobs)).toBe("ok");
        }
      } finally {
        if (special === "ancestor-mode-000") chmodSync(locked, 0o700);
        if (special === "file-mode-000") chmodSync(configFile, 0o600);
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
    assertFixtureEnv(fx, env);
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

// ---------------------------------------------------------------- every config-file read site (fix round 1)

/**
 * The bug class "a failure to read or parse a Stratum config file is treated as absence",
 * one row per read site (config/index.ts readConfigFile is the only reader). `make` builds the
 * bad path and returns what to restore; `check` asserts the site's broken arm.
 */
const READ_SITE_ROWS: Array<{
  name: string;
  make: (fx: Fixture) => { env: NodeJS.ProcessEnv; bad: string; restore: () => void };
  check: (fx: Fixture, env: NodeJS.ProcessEnv, bad: string) => Promise<void> | void;
}> = [
  {
    name: "sandbox loader: unreadable user file throws, naming it",
    make: (fx) => { writeFileSync(fx.configFile, "[sandbox]\n"); chmodSync(fx.configFile, 0o000); return { env: fx.env, bad: fx.configFile, restore: () => chmodSync(fx.configFile, 0o600) }; },
    check: (fx, env, bad) => { expect(() => loadStratumConfig({ env, projectRoot: fx.root })).toThrow(bad); },
  },
  {
    name: "sandbox loader: a dangling-symlink user file is absent (no throw)",
    make: (fx) => { symlinkSync(join(fx.root, "nowhere.toml"), fx.configFile); return { env: fx.env, bad: fx.configFile, restore: () => {} }; },
    check: (fx, env) => { expect(() => loadStratumConfig({ env, projectRoot: fx.root })).not.toThrow(); },
  },
  {
    name: "learn loader: unreadable user file is a diagnostic, every switch off",
    make: (fx) => { writeFileSync(fx.configFile, "[learn]\ndeliver = true\n"); chmodSync(fx.configFile, 0o000); return { env: fx.env, bad: fx.configFile, restore: () => chmodSync(fx.configFile, 0o600) }; },
    check: (fx, env, bad) => {
      const learn = resolveLearnConfig({ env, projectRoot: fx.root });
      expect([learn.deliver, learn.inline, learn.diagnostics.some((line) => line.includes(bad))]).toEqual([false, false, true]);
    },
  },
  {
    name: "project stratum.toml unreadable: both loaders refuse, door backend-unavailable naming it",
    make: (fx) => {
      const project = join(fx.root, "stratum.toml");
      writeFileSync(project, "[sandbox]\n");
      chmodSync(project, 0o000);
      return { env: fx.env, bad: project, restore: () => chmodSync(project, 0o600) };
    },
    check: async (fx, env, bad) => {
      expect(() => loadStratumConfig({ env, projectRoot: fx.root })).toThrow(bad);
      assertFixtureEnv(fx, env);
      const admit = await createSessionBackend({ env, projectRoot: fx.root }).admit({ engine: "claude", label: "probe", launchGate: "none" }, { childEnv: env });
      expect([code(admit), admit.backend, admit.childEnv, admit.ok ? "" : admit.refusal.reason.includes(bad)]).toEqual(["backend-unavailable", "scripts", null, true]);
    },
  },
  {
    name: "project stratum.toml not TOML: door backend-unavailable naming it",
    make: (fx) => { const project = join(fx.root, "stratum.toml"); writeFileSync(project, "this = = is not toml\n"); return { env: fx.env, bad: project, restore: () => {} }; },
    check: async (fx, env, bad) => {
      assertFixtureEnv(fx, env);
      const jobs = await createSessionBackend({ env, projectRoot: fx.root }).jobsList({ session: `${TOKEN}-none` });
      expect([code(jobs), jobs.backend, jobs.ok ? "" : jobs.refusal.reason.includes(bad)]).toEqual(["backend-unavailable", "scripts", true]);
    },
  },
];

describe("only proven absence is absence: every config-file read site", () => {
  for (const row of READ_SITE_ROWS) {
    it(row.name, async () => {
      const fx = fixture({ envDir: "unset" });
      const { env, bad, restore } = row.make(fx);
      try { await row.check(fx, env, bad); } finally { restore(); }
    });
  }
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

// ---------------------------------------------------------------- shapes: every contracted key, success and refusal (SESSION-MGMT-1-U1-FU1)

type Doc = Record<string, unknown>;
const GOOD_CHOICE = { id: "seat1", vendor: "claude", label: "seat1", command: "ccd1 -n x" };
const GOOD_SEAT = { id: "seat1", ceiling: 90, used: 12.5, state: "behind", detail: "d", target: 40, behind: 27.5 };
const GOOD_PICK: Doc = { kind: "author", choice: GOOD_CHOICE, reason: "r", rule: "u", seats: [GOOD_SEAT] };
const GOOD_ROW: Doc = {
  op: "add", session: TOKEN, kind: "agent", id: `${TOKEN}-1`, report: null, collect: null, label: null, ts: 1.5,
  status: "running", priority: "P2", priority_source: "defaulted",
};
const GOOD_DIAG: Doc = { kind: "bad-line", source: "registry", file: "/x/s.jsonl", line: 3, reason: "r", affects: [{ session: TOKEN, id: null }] };
const GOOD_JOBS: Doc = { rows: [GOOD_ROW], bad_count: 1, diagnostics: [GOOD_DIAG] };
const GOOD_ADD: Doc = { op: "add", session: TOKEN, kind: "agent", id: `${TOKEN}-1`, report: null, collect: null, label: null, ts: 1.5 };

/** `base` with `edit` applied to a deep copy. */
const edit = (base: Doc, change: (copy: Doc) => void): Doc => { const copy = structuredClone(base); change(copy); return copy; };
const without = (...path: string[]) => (copy: Doc) => {
  let node: any = copy;
  for (const key of path.slice(0, -1)) node = Array.isArray(node[key]) ? node[key][0] : node[key];
  delete node[path.at(-1)!];
};
const setAt = (path: string[], value: unknown) => (copy: Doc) => {
  let node: any = copy;
  for (const key of path.slice(0, -1)) node = Array.isArray(node[key]) ? node[key][0] : node[key];
  node[path.at(-1)!] = value;
};

/** `choiceShape`: the row breaks the choice object, which a refusal (choice null) does not carry, so only exit 0 applies. */
interface ShapeRow { name: string; op: "pick" | "jobs" | "register"; doc: Doc; choiceShape?: true }
const ROW_KEYS = Object.keys(GOOD_ROW);
const CHOICE_KEYS = Object.keys(GOOD_CHOICE);
const SEAT_REQUIRED = ["id", "ceiling", "used", "state", "detail"];
const DIAG_KEYS = Object.keys(GOOD_DIAG);
const ADD_KEYS = Object.keys(GOOD_ADD);

const SHAPE_ROWS: ShapeRow[] = [
  // pick: one row per required key at each level
  ...["kind", "choice", "reason", "rule"].map((k): ShapeRow => ({ name: `pick: missing ${k}`, op: "pick", doc: edit(GOOD_PICK, without(k)) })),
  ...CHOICE_KEYS.map((k): ShapeRow => ({ name: `pick: choice missing ${k}`, op: "pick", doc: edit(GOOD_PICK, without("choice", k)), choiceShape: true })),
  ...SEAT_REQUIRED.map((k): ShapeRow => ({ name: `pick: seat missing ${k} (review F3 repro for ceiling/used)`, op: "pick", doc: edit(GOOD_PICK, without("seats", k)) })),
  { name: "pick: seat ceiling is a string", op: "pick", doc: edit(GOOD_PICK, setAt(["seats", "ceiling"], "90")) },
  { name: "pick: seat used is a string", op: "pick", doc: edit(GOOD_PICK, setAt(["seats", "used"], "1")) },
  { name: "pick: seat state outside the enum", op: "pick", doc: edit(GOOD_PICK, setAt(["seats", "state"], "nope")) },
  { name: "pick: seat target is a string", op: "pick", doc: edit(GOOD_PICK, setAt(["seats", "target"], "40")) },
  { name: "pick: seat behind is a string", op: "pick", doc: edit(GOOD_PICK, setAt(["seats", "behind"], "1")) },
  { name: "pick: choice label is a number", op: "pick", doc: edit(GOOD_PICK, setAt(["choice", "label"], 5)), choiceShape: true },
  { name: "pick: choice vendor outside the enum (U1-FU3 repro: gemini)", op: "pick", doc: edit(GOOD_PICK, setAt(["choice", "vendor"], "gemini")), choiceShape: true },
  { name: "pick: choice vendor is a number", op: "pick", doc: edit(GOOD_PICK, setAt(["choice", "vendor"], 1)), choiceShape: true },
  // jobs list: every required row key, every diagnostic key, the enums
  ...ROW_KEYS.map((k): ShapeRow => ({ name: `jobs: row missing ${k}`, op: "jobs", doc: edit(GOOD_JOBS, without("rows", k)) })),
  ...DIAG_KEYS.map((k): ShapeRow => ({ name: `jobs: diagnostic missing ${k}`, op: "jobs", doc: edit(GOOD_JOBS, without("diagnostics", k)) })),
  { name: "jobs: review F3 repro (4-field row, diagnostics [{}])", op: "jobs",
    doc: { rows: [{ session: "review-u1", id: "review-u1-id", kind: "agent", status: "running" }], bad_count: 0, diagnostics: [{}] } },
  { name: "jobs: row status outside the enum", op: "jobs", doc: edit(GOOD_JOBS, setAt(["rows", "status"], "paused")) },
  { name: "jobs: row priority outside the enum", op: "jobs", doc: edit(GOOD_JOBS, setAt(["rows", "priority"], "P9")) },
  { name: "jobs: row priority_source outside the enum", op: "jobs", doc: edit(GOOD_JOBS, setAt(["rows", "priority_source"], "guessed")) },
  { name: "jobs: row kind outside the enum", op: "jobs", doc: edit(GOOD_JOBS, setAt(["rows", "kind"], "thread")) },
  { name: "jobs: row ts is a string", op: "jobs", doc: edit(GOOD_JOBS, setAt(["rows", "ts"], "1")) },
  { name: "jobs: row pid is zero", op: "jobs", doc: edit(GOOD_JOBS, setAt(["rows", "pid"], 0)) },
  { name: "jobs: row outcome outside the enum", op: "jobs", doc: edit(GOOD_JOBS, setAt(["rows", "outcome"], "meh")) },
  { name: "jobs: diagnostic kind outside the enum", op: "jobs", doc: edit(GOOD_JOBS, setAt(["diagnostics", "kind"], "weird")) },
  { name: "jobs: diagnostic source outside the enum", op: "jobs", doc: edit(GOOD_JOBS, setAt(["diagnostics", "source"], "elsewhere")) },
  { name: "jobs: diagnostic affects item lacks session", op: "jobs", doc: edit(GOOD_JOBS, setAt(["diagnostics", "affects"], [{ id: null }])) },
  { name: "jobs: bad_count missing", op: "jobs", doc: edit(GOOD_JOBS, without("bad_count")) },
  { name: "jobs: envelope missing rows (U1-FU3)", op: "jobs", doc: edit(GOOD_JOBS, without("rows")) },
  { name: "jobs: envelope missing diagnostics (U1-FU3)", op: "jobs", doc: edit(GOOD_JOBS, without("diagnostics")) },
  { name: "jobs: diagnostic affects item missing id (U1-FU3)", op: "jobs", doc: edit(GOOD_JOBS, without("diagnostics", "affects", "id")) },
  { name: "jobs: row work_kind outside the enum (U1-FU3 repro: nope)", op: "jobs", doc: edit(GOOD_JOBS, setAt(["rows", "work_kind"], "nope")) },
  { name: "jobs: row vendor outside the enum", op: "jobs", doc: edit(GOOD_JOBS, setAt(["rows", "vendor"], "gemini")) },
  // jobs register: the stored add event
  ...ADD_KEYS.map((k): ShapeRow => ({ name: `register: missing ${k}`, op: "register", doc: edit(GOOD_ADD, without(k)) })),
  { name: "register: pid is a string", op: "register", doc: edit(GOOD_ADD, setAt(["pid"], "1")) },
  { name: "register: log is a number", op: "register", doc: edit(GOOD_ADD, setAt(["log"], 1)) },
  { name: "register: vendor outside the enum", op: "register", doc: edit(GOOD_ADD, setAt(["vendor"], "gemini")) },
  { name: "register: priority outside the enum", op: "register", doc: edit(GOOD_ADD, setAt(["priority"], "P9")) },
  { name: "register: ts is not finite (string)", op: "register", doc: edit(GOOD_ADD, setAt(["ts"], "now")) },
  { name: "register: work_kind outside the enum (U1-FU3 repro: nope)", op: "register", doc: edit(GOOD_ADD, setAt(["work_kind"], "nope")) },
];

const SHAPE_OK_ROWS: ShapeRow[] = [
  { name: "pick: the full documented shape", op: "pick", doc: GOOD_PICK },
  { name: "pick: unmeasured seat (used null, no target/behind)", op: "pick", doc: edit(GOOD_PICK, (c) => { c.seats = [{ id: "seat2", ceiling: 90, used: null, state: "unstarted", detail: "unstarted" }]; }) },
  { name: "jobs: the full documented shape", op: "jobs", doc: GOOD_JOBS },
  { name: "jobs: a done row with every optional key", op: "jobs",
    doc: edit(GOOD_JOBS, (c) => { c.rows = [{ ...GOOD_ROW, status: "done", pid: 7, log: "/l", work_kind: "author", vendor: "codex", model: "m", account: "a", for_id: "f", session_id: "s", done_ts: 2, outcome: "passed", rounds: 1 }]; }) },
  { name: "register: the bare add event", op: "register", doc: GOOD_ADD },
  { name: "pick: choice vendor codex", op: "pick", doc: edit(GOOD_PICK, setAt(["choice", "vendor"], "codex")) },
  { name: "jobs: every work_kind member", op: "jobs", doc: edit(GOOD_JOBS, (c) => { c.rows = WORK_KINDS.map((work_kind, i) => ({ ...GOOD_ROW, id: `${TOKEN}-wk${i}`, work_kind })); }) },
  { name: "register: work_kind land", op: "register", doc: edit(GOOD_ADD, (c) => { c.work_kind = "land"; }) },
];

/** A refusal record must pass the same validator: exit 1 for pick (choice null), jobs and register. */
const asRefusal = (row: ShapeRow, doc: Doc): Doc => (row.op === "pick" && "choice" in doc ? { ...doc, choice: null } : doc);

async function shapeRun(row: ShapeRow, exit: number, doc: Doc): Promise<Envelope<unknown>> {
  const file = row.op === "pick" ? "usage_watch.py" : "jobs.py";
  const fx = fixture({ scripts: fakeScripts(file, py(`print(${JSON.stringify(JSON.stringify(doc))}); sys.exit(${exit})`)) });
  const b = backend(fx);
  return row.op === "pick" ? b.pick({ kind: "author" })
    : row.op === "jobs" ? b.jobsList({ session: TOKEN })
    : b.jobsRegister({ session: TOKEN, kind: "agent", id: `${TOKEN}-1` });
}

describe("script output shapes: every contracted key, the same validator on success and refusal", () => {
  for (const row of SHAPE_ROWS) {
    it(`${row.name}: backend-error at exit 0 and at exit 1`, async () => {
      const ok = await shapeRun(row, 0, row.doc);
      expect(code(ok), JSON.stringify(ok)).toBe("backend-error");
      if (row.choiceShape) return;
      const refused = await shapeRun(row, 1, asRefusal(row, row.doc));
      expect(code(refused), JSON.stringify(refused)).toBe("backend-error");
    }, 30_000);
  }

  for (const row of SHAPE_OK_ROWS) {
    it(`${row.name}: accepted at exit 0, record kept at exit 1`, async () => {
      const ok = await shapeRun(row, 0, row.doc);
      expect(code(ok), JSON.stringify(ok)).toBe("ok");
      const refused = await shapeRun(row, 1, asRefusal(row, row.doc));
      expect(code(refused), JSON.stringify(refused)).toBe(row.op === "pick" ? "no-eligible-account" : "registry-refused");
      expect(refused.ok ? null : typeof refused.record).toBe("object");
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
    openAll(fx);
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
    closeAll(fx);
    const pick = await backend(fx).pick({ kind: "author" });
    expect(code(pick), JSON.stringify(pick)).toBe("no-eligible-account");
    expect(pick.ok ? null : (pick.record as { seats: unknown[] }).seats.length).toBe(SEATS.length);
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
    closeAll(fx);
    const closed = cli(fx, ["pick", "--kind", "author", "--json"]);
    expect([closed.status, closed.envelope && code(closed.envelope)]).toEqual([1, "no-eligible-account"]);
    expect(closed.envelope && !closed.envelope.ok ? (closed.envelope.record as { seats: unknown[] }).seats.length : null).toBe(SEATS.length);

    const open = fixture();
    openAll(open);
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
