import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AdmitResult, LaunchData, LaunchInput, Vendor } from "../../src/session/index.js";
import { backend, cli, code, type Fixture, HAVE_OPS, OPEN_ELAPSED_MIN, openAll, openPct, putReading, py, suite } from "./fixture.js";

/**
 * SESSION-MGMT-1-U2: admit's closed output and default-home rule, the `admit` CLI verb, and
 * `launch` (strip, admit with the full gate, detach env from the admitted childEnv only).
 * Fixture scripts only for outputs the real session_admit.py cannot produce on demand (extra keys,
 * a null home on codex); the real script for the Max default-home row and the CLI account row.
 * The leak gate (both arms) and the fixture env come from fixture.ts.
 */

const S = suite("u2al");
const TOKEN = S.token;

/** A session_admit.py stand-in: prints the env from U2_ADMIT_ENV (JSON) for the requested engine, and what it saw. */
const FAKE_ADMIT = py(`
data = sys.stdin.buffer.read()
engine = next(a.split("=", 1)[1] for a in sys.argv[1:] if a.startswith("--engine="))
env = json.loads(os.environ["U2_ADMIT_ENV"])
leaked = sorted(k for k in ("CLAUDECODE", "LAUNCH_GATE_ADMITTED") if k in os.environ)
print(json.dumps({"admitted": True, "code": None, "reason": "stdin=%d leaked=%s caller_home=%s" % (len(data), ",".join(leaked), os.environ.get("CLAUDE_CONFIG_DIR", "<unset>")),
                  "engine": engine, "account": {"id": "seat2", "vendor": engine, "label": "seat2", "config_dir_name": ".claude-seat2"},
                  "env": env, "checks": [], "launch_gate_label": None}))`);

const HOME = "/abs/home/.claude-seat2";

/**
 * contract `operations.admit.script_output.env` (review checklist item 3, forge-e0 ruling 1): one row per member of the class
 * "an admitted env that is not exactly the engine home". `childHome` is the expected CLAUDE_CONFIG_DIR / CODEX_HOME in
 * childEnv for an ok row (`null` = the key is absent).
 */
const ADMIT_ENV_ROWS: Array<{ name: string; engine: Vendor; env: Record<string, string | null>; expect: "ok" | "backend-error"; childHome?: string | null }> = [
  { name: "claude home, absolute", engine: "claude", env: { CLAUDE_CONFIG_DIR: HOME }, expect: "ok", childHome: HOME },
  { name: "codex home, absolute", engine: "codex", env: { CODEX_HOME: "/abs/home/.codex" }, expect: "ok", childHome: "/abs/home/.codex" },
  { name: "claude home null (default-home rule): key deleted", engine: "claude", env: { CLAUDE_CONFIG_DIR: null }, expect: "ok", childHome: null },
  { name: "home missing (env {})", engine: "claude", env: {}, expect: "backend-error" },
  { name: "one extra key", engine: "claude", env: { CLAUDE_CONFIG_DIR: HOME, OTHER: "x" }, expect: "backend-error" },
  { name: "extra PATH", engine: "claude", env: { CLAUDE_CONFIG_DIR: HOME, PATH: "/usr/bin" }, expect: "backend-error" },
  { name: "extra LD_PRELOAD", engine: "claude", env: { CLAUDE_CONFIG_DIR: HOME, LD_PRELOAD: "/abs/evil.so" }, expect: "backend-error" },
  { name: "null home plus an extra key", engine: "claude", env: { CLAUDE_CONFIG_DIR: null, PATH: "/usr/bin" }, expect: "backend-error" },
  { name: "null home on codex", engine: "codex", env: { CODEX_HOME: null }, expect: "backend-error" },
  { name: "the other engine's home var", engine: "codex", env: { CLAUDE_CONFIG_DIR: HOME }, expect: "backend-error" },
  { name: "empty-string home", engine: "claude", env: { CLAUDE_CONFIG_DIR: "" }, expect: "backend-error" },
  { name: "the string \"null\" (relative)", engine: "claude", env: { CLAUDE_CONFIG_DIR: "null" }, expect: "backend-error" },
];

describe("admit: the admitted env is closed (exactly the engine home; null only for claude, and it deletes)", () => {
  for (const row of ADMIT_ENV_ROWS) {
    it(row.name, async () => {
      const fx = S.fixture({ scripts: S.fakeScripts("session_admit.py", FAKE_ADMIT) });
      const candidate = { ...fx.env, U2_ADMIT_ENV: JSON.stringify(row.env), CLAUDE_CONFIG_DIR: "/wrong", CODEX_HOME: "/wrong-codex" };
      const result: AdmitResult = await backend(fx).admit({ engine: row.engine, label: "lbl", model: "sonnet", launchGate: "none" }, { childEnv: candidate });
      expect(code(result), JSON.stringify(result)).toBe(row.expect);
      if (row.expect !== "ok") {
        expect(result.childEnv).toBeNull();
        return;
      }
      const homeVar = row.engine === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME";
      if (row.childHome === null) {
        expect(homeVar in result.childEnv!, `${homeVar} must be removed, not set to ${JSON.stringify(result.childEnv![homeVar])}`).toBe(false);
      } else {
        expect(result.childEnv![homeVar]).toBe(row.childHome);
      }
      expect(result.childEnv!.U2_ADMIT_ENV).toBe(candidate.U2_ADMIT_ENV);
    });
  }

  it("a refusal record carrying an env is backend-error (refused: env {})", async () => {
    const body = py(`print(json.dumps({"admitted": False, "code": "account-unknown", "reason": "r", "engine": "claude", "account": None,
                  "env": {"CLAUDE_CONFIG_DIR": "${HOME}"}, "checks": [], "launch_gate_label": None})); sys.exit(1)`);
    const fx = S.fixture({ scripts: S.fakeScripts("session_admit.py", body) });
    const result = await backend(fx).admit({ engine: "claude", label: "lbl", model: "sonnet", launchGate: "none" }, { childEnv: fx.env });
    expect([code(result), result.childEnv]).toEqual(["backend-error", null]);
  });
});

describe.skipIf(!HAVE_OPS)("admit on the real session_admit.py", () => {
  it("Max (default: true) admitted -> env {CLAUDE_CONFIG_DIR: null}; childEnv has no CLAUDE_CONFIG_DIR even when the caller set one", async () => {
    const fx = S.fixture({ withMax: true });
    openAll(fx);
    putReading(fx, "max", openPct(fx), OPEN_ELAPSED_MIN);
    const result = await backend(fx).admit({ engine: "claude", label: `${TOKEN}-max`, model: "sonnet", account: "max", launchGate: "none" },
      { childEnv: { ...fx.env, CLAUDE_CONFIG_DIR: join(fx.root, "home", ".claude-seat1") } });
    expect(code(result), JSON.stringify(result)).toBe("ok");
    expect(result.ok && result.data.env).toEqual({ CLAUDE_CONFIG_DIR: null });
    expect(result.ok && result.data.account?.id).toBe("max");
    expect("CLAUDE_CONFIG_DIR" in result.childEnv!).toBe(false);
  }, 60_000);
});

describe("stratum session admit (CLI)", () => {
  it.skipIf(!HAVE_OPS)("real script: --account seat2 with caller CLAUDE_CONFIG_DIR=/wrong -> exit 0, env names seat2's home; no childEnv printed", () => {
    const fx = S.fixture();
    openAll(fx);
    const run = cli(fx, ["admit", "--engine", "claude", "--label", `${TOKEN}-c`, "--model", "sonnet", "--account", "seat2", "--launch-gate", "none", "--json"],
      { CLAUDE_CONFIG_DIR: "/wrong" }, "");
    expect(run.status, run.stderr).toBe(0);
    const data = run.envelope?.ok ? run.envelope.data as { env: Record<string, string>; account: { id: string } } : null;
    expect(data?.account.id).toBe("seat2");
    expect(data?.env).toEqual({ CLAUDE_CONFIG_DIR: join(fx.root, "home", ".claude-seat2") });
    expect(run.stdout).not.toContain("childEnv");
    expect(run.stdout).not.toContain(fx.env.USAGE_WATCH_ACCOUNTS!);
  }, 60_000);

  it("marker text comes from stdin, never argv; CLAUDECODE / LAUNCH_GATE_ADMITTED stripped", () => {
    const fx = S.fixture({ scripts: S.fakeScripts("session_admit.py", FAKE_ADMIT) });
    const marker = `hard: ${TOKEN} marker`;
    const run = cli(fx, ["admit", "--engine", "claude", "--label", "lbl", "--model", "sonnet", "--json"],
      { U2_ADMIT_ENV: JSON.stringify({ CLAUDE_CONFIG_DIR: HOME }), CLAUDECODE: "1", LAUNCH_GATE_ADMITTED: "x" }, marker);
    expect(run.status, run.stderr).toBe(0);
    const reason = run.envelope?.ok ? (run.envelope.data as { reason: string }).reason : "";
    expect(reason).toContain(`stdin=${Buffer.byteLength(marker)} leaked= `);
    expect(run.stdout).not.toContain(TOKEN);
  }, 60_000);

  const USAGE_ROWS: Array<{ name: string; args: string[] }> = [
    { name: "missing --engine", args: ["admit", "--label", "l", "--json"] },
    { name: "missing --label", args: ["admit", "--engine", "claude", "--json"] },
    { name: "bad --max-wait-s", args: ["admit", "--engine", "claude", "--label", "l", "--max-wait-s", "soon", "--json"] },
    { name: "--max-wait-s out of range", args: ["admit", "--engine", "claude", "--label", "l", "--max-wait-s", "1801", "--json"] },
    { name: "bad --launch-gate", args: ["admit", "--engine", "claude", "--label", "l", "--launch-gate", "half", "--json"] },
    { name: "label starting with '-'", args: ["admit", "--engine", "claude", "--label=-x", "--json"] },
    { name: "stray positional", args: ["admit", "--engine", "claude", "--label", "l", "extra"] },
  ];
  for (const row of USAGE_ROWS) {
    it(`usage: ${row.name} -> exit 2`, () => {
      const fx = S.fixture({ scripts: S.fakeScripts("session_admit.py", FAKE_ADMIT) });
      expect(cli(fx, row.args, {}, "").status).toBe(2);
    }, 60_000);
  }
});

// ---------------------------------------------------------------- launch (contract operations.launch.steps)

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => boolean, what: string, ms = 30_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

const launchesRows = (fx: Fixture): string[] => {
  const file = join(fx.env.LAUNCH_GATE_STATE_DIR!, "launches.txt");
  return existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : [];
};

interface LaunchRun { fx: Fixture; envelope: Awaited<ReturnType<ReturnType<typeof backend>["launch"]>>; input: LaunchInput; child: Record<string, string> | null }

/**
 * One launch on the REAL session_admit.py + detach_job.py with the fixture engine (DETACH_JOB_ENGINE_OVERRIDE, a /bin/sh -c
 * command): it records only the three variables the rows assert, writes the report and exits. Its group is killed in teardown.
 */
async function realLaunch(options: { engine?: Vendor; account?: string; label?: string; withMax?: boolean; extra?: Partial<NodeJS.ProcessEnv> }): Promise<LaunchRun> {
  const fx = S.fixture({ withMax: options.withMax === true });
  openAll(fx);
  if (options.withMax) putReading(fx, "max", openPct(fx), OPEN_ELAPSED_MIN);
  const brief = join(fx.root, "brief.md");
  const report = join(fx.root, "report.md");
  const childFile = join(fx.root, "child-env.txt");
  writeFileSync(brief, `fixture brief ${S.token}\n`);
  const vars = ["CLAUDE_CONFIG_DIR", "CODEX_HOME", "LAUNCH_GATE_ADMITTED", "CLAUDECODE"];
  const engineCmd = `cat > /dev/null; { ${vars.map((v) => `printf '%s=%s\\n' ${v} "\${${v}-<unset>}"`).join("; ")}; } > '${childFile}'; echo done > '${report}'`;
  const engine = options.engine ?? "claude";
  const input: LaunchInput = {
    session: `${S.token}-s`, label: options.label ?? `${S.token}-l`, engine, model: engine === "claude" ? "sonnet" : "gpt-6.1-sol",
    brief, report, account: options.account ?? "seat2", maxWaitS: 60,
  };
  const envelope = await backend(fx, { DETACH_JOB_ENGINE_OVERRIDE: engineCmd, LAUNCH_GATE_LOAD_MAX: "100000", ...options.extra }).launch(input);
  let child: Record<string, string> | null = null;
  if (envelope.ok) {
    S.trackGroup(envelope.data.pgid);
    await waitFor(() => existsSync(report) && existsSync(childFile) && readFileSync(childFile, "utf8").split("\n").filter(Boolean).length === vars.length, "the fixture engine");
    child = Object.fromEntries(readFileSync(childFile, "utf8").split("\n").filter(Boolean).map((line) => line.split(/=(.*)/s).slice(0, 2) as [string, string]));
  }
  return { fx, envelope, input, child };
}

const meta = (data: LaunchData): Record<string, unknown> => JSON.parse(readFileSync(data.meta, "utf8")) as Record<string, unknown>;

describe.skipIf(!HAVE_OPS)("launch on the real scripts (fixture engine)", () => {
  it("review item 1 / probe 9: inherited LAUNCH_GATE_ADMITTED equal to the label still gives exactly one launches-log row; the child sees the door's marker, no CLAUDECODE", async () => {
    const label = `${S.token}-x`;
    const run = await realLaunch({ label, extra: { LAUNCH_GATE_ADMITTED: label, CLAUDECODE: "1" } });
    expect(code(run.envelope), JSON.stringify(run.envelope)).toBe("ok");
    const rows = launchesRows(run.fx);
    expect(rows.length, rows.join(" | ")).toBe(1);
    expect(rows[0]!.split(/\s+/)[1]).toBe(label);
    expect([run.child!.LAUNCH_GATE_ADMITTED, run.child!.CLAUDECODE]).toEqual([label, "<unset>"]);
  }, 120_000);

  it("review item 2: caller CLAUDE_CONFIG_DIR=/wrong + --account seat2 -> output, meta and child env say seat2; no account_pick", async () => {
    const run = await realLaunch({ account: "seat2", extra: { CLAUDE_CONFIG_DIR: "/wrong" } });
    expect(code(run.envelope), JSON.stringify(run.envelope)).toBe("ok");
    const data = (run.envelope as { data: LaunchData }).data;
    const seat2 = join(run.fx.root, "home", ".claude-seat2");
    expect([data.account, data.label, data.session]).toEqual(["seat2", run.input.label, run.input.session]);
    const m = meta(data);
    expect([m.account, m.account_home, "account_pick" in m]).toEqual(["seat2", seat2, false]);
    expect(run.child!.CLAUDE_CONFIG_DIR).toBe(seat2);
    expect(launchesRows(run.fx).length).toBe(1);
  }, 120_000);

  it("Max (default-home rule): the child has NO CLAUDE_CONFIG_DIR even though the caller set one; meta says max", async () => {
    const run = await realLaunch({ account: "max", withMax: true, extra: { CLAUDE_CONFIG_DIR: "/wrong" } });
    expect(code(run.envelope), JSON.stringify(run.envelope)).toBe("ok");
    const data = (run.envelope as { data: LaunchData }).data;
    expect([data.account, meta(data).account, run.child!.CLAUDE_CONFIG_DIR]).toEqual(["max", "max", "<unset>"]);
  }, 120_000);

  it("codex: the full gate runs for codex too (one launches-log row); the child's CODEX_HOME is the admitted home", async () => {
    const run = await realLaunch({ engine: "codex", account: "codex", extra: { CODEX_HOME: "/wrong-codex" } });
    expect(code(run.envelope), JSON.stringify(run.envelope)).toBe("ok");
    expect(launchesRows(run.fx).length).toBe(1);
    expect(run.child!.CODEX_HOME).toBe(join(run.fx.root, "home", ".codex"));
    expect((run.envelope as { data: LaunchData }).data.account).toBe("codex");
  }, 120_000);

  it("an admit refusal is returned with op launch; detach_job never runs and no launches-log row is written", async () => {
    const run = await realLaunch({ account: "nope" });
    expect([code(run.envelope), run.envelope.op]).toEqual(["account-unknown", "launch"]);
    expect(launchesRows(run.fx)).toEqual([]);
    expect(readdirSync(run.fx.env.DETACH_JOB_INDEX_DIR!)).toEqual([]);
  }, 120_000);
});

/** detach_job.py stand-in beside FAKE_ADMIT: records argv and the env it got, prints U2_DETACH_OUT (JSON, {pid} filled in), exits U2_DETACH_EXIT. */
const FAKE_DETACH = py(`
seen = {k: os.environ.get(k, "<unset>") for k in ("CLAUDE_CONFIG_DIR", "LAUNCH_GATE_ADMITTED", "LAUNCH_GATE_MAX_WAIT", "CLAUDECODE")}
open(os.environ["U2_SEEN"], "w").write(json.dumps({"argv": sys.argv[1:], "env": seen}))
out = os.environ.get("U2_DETACH_OUT")
if out:
    print(out.replace("<pid>", str(os.getpid())))
sys.exit(int(os.environ.get("U2_DETACH_EXIT", "0")))`);

function fakeLaunchFixture(): { fx: Fixture; seen: string; input: LaunchInput } {
  const scripts = S.fakeScripts("session_admit.py", FAKE_ADMIT);
  writeFileSync(join(scripts, "detach_job.py"), FAKE_DETACH);
  const fx = S.fixture({ scripts });
  const input: LaunchInput = { session: "sess", label: "lbl", engine: "claude", model: "sonnet", brief: join(fx.root, "brief.md"), report: join(fx.root, "r.md"), maxWaitS: 45 };
  return { fx, seen: join(fx.root, "seen.json"), input };
}

const GOOD_OUT = { pid: 4242, pgid: 4242, log: "/abs/x.log", meta: "/abs/x.json", label: "lbl", session: "sess", account: "seat2" };

/** detach_job exits and outputs: one row per member of the class "a detach answer that is not the contracted one". */
const DETACH_ROWS: Array<{ name: string; exit: number; out: unknown; expect: string }> = [
  { name: "exit 0, contracted output", exit: 0, out: GOOD_OUT, expect: "ok" },
  { name: "exit 1 refusal record", exit: 1, out: { refused: true, reason: "launch gate refused" }, expect: "detach-refused" },
  { name: "exit 1 without stdout", exit: 1, out: null, expect: "detach-refused" },
  { name: "exit 2 (argparse)", exit: 2, out: null, expect: "usage" },
  { name: "exit 137 (128+SIGKILL) unmapped", exit: 137, out: null, expect: "backend-error" },
  { name: "exit 0 relative log", exit: 0, out: { ...GOOD_OUT, log: "x.log" }, expect: "backend-error" },
  { name: "exit 0 label differs", exit: 0, out: { ...GOOD_OUT, label: "other" }, expect: "backend-error" },
  { name: "exit 0 lacks account", exit: 0, out: { ...GOOD_OUT, account: undefined }, expect: "backend-error" },
  { name: "exit 0 pgid not an integer", exit: 0, out: { ...GOOD_OUT, pgid: "4242" }, expect: "backend-error" },
  { name: "exit 1 refusal record of the wrong shape", exit: 1, out: { refused: "yes" }, expect: "backend-error" },
];

describe("launch: the detach env comes only from admit; detach_job's answer is checked", () => {
  for (const row of DETACH_ROWS) {
    it(`detach ${row.name} -> ${row.expect}`, async () => {
      const { fx, seen, input } = fakeLaunchFixture();
      const extra = {
        U2_ADMIT_ENV: JSON.stringify({ CLAUDE_CONFIG_DIR: HOME }), U2_SEEN: seen, U2_DETACH_EXIT: String(row.exit),
        ...(row.out !== null ? { U2_DETACH_OUT: JSON.stringify(row.out) } : {}),
        CLAUDE_CONFIG_DIR: "/wrong", LAUNCH_GATE_ADMITTED: "inherited", CLAUDECODE: "1",
      };
      const envelope = await backend(fx, extra).launch(input);
      expect([code(envelope), envelope.op], JSON.stringify(envelope)).toEqual([row.expect, "launch"]);
      const got = JSON.parse(readFileSync(seen, "utf8")) as { argv: string[]; env: Record<string, string> };
      expect(got.env).toEqual({ CLAUDE_CONFIG_DIR: HOME, LAUNCH_GATE_ADMITTED: "lbl", LAUNCH_GATE_MAX_WAIT: "45", CLAUDECODE: "<unset>" });
      expect(got.argv).toEqual(["run", "--session=sess", "--label=lbl", "--engine=claude", "--model=sonnet", `--brief=${input.brief}`, `--report=${input.report}`, "--json"]);
    });
  }

  it("admit is asked with the full gate and the brief as the marker file, never marker text", async () => {
    const recorder = py(`
open(os.environ["U2_SEEN"], "w").write(json.dumps(sys.argv[1:]))
print(json.dumps({"admitted": False, "code": "gate-denied", "reason": "no", "engine": "codex", "account": None, "env": {}, "checks": [], "launch_gate_label": None}))
sys.exit(1)`);
    const scripts = S.fakeScripts("session_admit.py", recorder);
    writeFileSync(join(scripts, "detach_job.py"), FAKE_DETACH);
    const fx = S.fixture({ scripts });
    const seen = join(fx.root, "admit-argv.json");
    const brief = join(fx.root, "b.md");
    const envelope = await backend(fx, { U2_SEEN: seen }).launch({ session: "s", label: "l", engine: "codex", model: "m", brief, report: join(fx.root, "r.md"), effort: "high", workKind: "review", priority: "P1" });
    expect([code(envelope), envelope.op]).toEqual(["gate-denied", "launch"]);
    expect(JSON.parse(readFileSync(seen, "utf8"))).toEqual(["--engine=codex", "--label=l", "--model=m", "--account=inherit", "--launch-gate=full", "--max-wait-s=120", `--marker-file=${brief}`, "--json"]);
  });

  it("admit itself runs without an inherited LAUNCH_GATE_ADMITTED or CLAUDECODE (the strip happens before step 1, not only in the detach env)", async () => {
    // Mutation gate-strip (c4b): keeping LAUNCH_GATE_ADMITTED in `base` changed nothing the other rows read, because FAKE_DETACH sees the
    // door's own label either way. This row reads the env admit gets.
    const recorder = py(`
open(os.environ["U2_SEEN"], "w").write(json.dumps({k: os.environ.get(k, "<unset>") for k in ("LAUNCH_GATE_ADMITTED", "CLAUDECODE")}))
print(json.dumps({"admitted": False, "code": "gate-denied", "reason": "no", "engine": "claude", "account": None, "env": {}, "checks": [], "launch_gate_label": None}))
sys.exit(1)`);
    const scripts = S.fakeScripts("session_admit.py", recorder);
    writeFileSync(join(scripts, "detach_job.py"), FAKE_DETACH);
    const fx = S.fixture({ scripts });
    const seen = join(fx.root, "admit-env.json");
    const envelope = await backend(fx, { U2_SEEN: seen, LAUNCH_GATE_ADMITTED: "inherited", CLAUDECODE: "1" }).launch({
      session: "s", label: "l", engine: "claude", model: "m", brief: join(fx.root, "b.md"), report: join(fx.root, "r.md"),
    });
    expect(code(envelope)).toBe("gate-denied");
    expect(JSON.parse(readFileSync(seen, "utf8"))).toEqual({ LAUNCH_GATE_ADMITTED: "<unset>", CLAUDECODE: "<unset>" });
  });

  it("mode none: launch is backend-unconfigured and runs nothing", async () => {
    const fx = S.fixture({ envDir: "unset" });
    const envelope = await backend(fx).launch({ session: "s", label: "l", engine: "claude", model: "m", brief: join(fx.root, "b.md"), report: join(fx.root, "r.md") });
    expect([code(envelope), envelope.backend, envelope.op]).toEqual(["backend-unconfigured", "none", "launch"]);
  });

  const LAUNCH_USAGE: Array<{ name: string; args: string[] }> = [
    { name: "missing --brief", args: ["--session", "s", "--label", "l", "--engine", "claude", "--model", "m", "--report", "/abs/r"] },
    { name: "relative --brief", args: ["--session", "s", "--label", "l", "--engine", "claude", "--model", "m", "--brief", "b.md", "--report", "/abs/r"] },
    { name: "bad --work-kind", args: ["--session", "s", "--label", "l", "--engine", "claude", "--model", "m", "--brief", "/abs/b", "--report", "/abs/r", "--work-kind", "nap"] },
    { name: "bad --engine", args: ["--session", "s", "--label", "l", "--engine", "gpt", "--model", "m", "--brief", "/abs/b", "--report", "/abs/r"] },
  ];
  for (const row of LAUNCH_USAGE) {
    it(`CLI usage: ${row.name} -> exit 2, nothing run`, () => {
      const { fx, seen } = fakeLaunchFixture();
      expect(cli(fx, ["launch", ...row.args, "--json"], { U2_SEEN: seen }, "").status).toBe(2);
      expect(existsSync(seen)).toBe(false);
    }, 60_000);
  }

  it("CLI launch: exit 0 and the envelope carries the detach record", () => {
    const { fx, seen, input } = fakeLaunchFixture();
    const run = cli(fx, ["launch", "--session", "sess", "--label", "lbl", "--engine", "claude", "--model", "sonnet", "--brief", input.brief, "--report", input.report, "--json"],
      { U2_ADMIT_ENV: JSON.stringify({ CLAUDE_CONFIG_DIR: HOME }), U2_SEEN: seen, U2_DETACH_OUT: JSON.stringify(GOOD_OUT) }, "");
    expect(run.status, run.stderr).toBe(0);
    expect(run.envelope?.ok && run.envelope.data).toEqual(GOOD_OUT);
  }, 60_000);
});
