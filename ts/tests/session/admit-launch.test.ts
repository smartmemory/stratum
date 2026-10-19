import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AdmitResult, Vendor } from "../../src/session/index.js";
import { backend, cli, code, HAVE_OPS, OPEN_ELAPSED_MIN, openAll, openPct, putReading, py, suite } from "./fixture.js";

/**
 * SESSION-MGMT-1-U2: admit's closed output and default-home rule, and the `admit` CLI verb.
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
