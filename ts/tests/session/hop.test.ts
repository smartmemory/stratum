import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { cliExitFor, type Envelope, type HopData } from "../../src/session/index.js";
import { backend, cli, code, type Fixture, HAVE_OPS, OPEN_ELAPSED_MIN, openAll, openPct, putReading, py, SEATS, suite } from "./fixture.js";

/**
 * SESSION-MGMT-1-U2 item 5: hop is three doors (check, dry-run, live), each with its own literal argv
 * (contract `operations.hop.script_argv_by_mode`). No row ever runs the real session_hop.py live (forge-e0 ruling 4):
 * every row runs through SHIM, set as the session python. The shim logs its argv and execs the real python only when
 * `--check=` or `--dry-run` sits BEFORE the `--`; anything else (a live argv) prints $U2_HOP_CANNED and exits $U2_HOP_EXIT,
 * or exits 97 when no answer is canned. Every row also carries SESSION_HOP_ITERM_FIXTURE under fx.root and checks the
 * tabs.json bytes are unchanged. Leak gate and fixture env: fixture.ts.
 */

const S = suite("u2hp");
/** A real session_hop run reads every reading and tab: seconds idle, much longer under a loaded machine. */
const REAL_MS = 180_000;
/** A CLI row spawns node plus the shim: about a second idle, several under a loaded machine. */
const CLI_MS = 60_000;
const REAL_PYTHON = execFileSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim();

const SHIM = `#!${REAL_PYTHON}
import json, os, sys
with open(os.environ["U2_HOP_ARGV_LOG"], "a") as f:
    f.write(json.dumps(sys.argv[1:]) + "\\n")
args = sys.argv[2:]
head = args[:args.index("--")] if "--" in args else args
if any(a.startswith("--check=") for a in head) or "--dry-run" in head:
    os.execv(${JSON.stringify(REAL_PYTHON)}, [${JSON.stringify(REAL_PYTHON)}] + sys.argv[1:])
text = os.environ.get("U2_HOP_CANNED")
if text is None:
    sys.exit(97)
if text:
    print(text)
sys.exit(int(os.environ.get("U2_HOP_EXIT", "0")))
`;

/** A stand-in session_hop.py: records that it ran, prints $U2_HOP_CANNED and exits $U2_HOP_EXIT (97 when nothing is canned). */
const FAKE_HOP = py(`
with open(os.environ["U2_HOP_RAN_LOG"], "a") as f: f.write("ran\\n")
text = os.environ.get("U2_HOP_CANNED")
if text is None: sys.exit(97)
if text: print(text)
sys.exit(int(os.environ.get("U2_HOP_EXIT", "0")))`);

const NAME = "u2hp-lane";
const TTY = "/dev/ttys901";
const TABS = JSON.stringify([{ id: "tab-1", title: NAME, tty: TTY, processing: false, screen: "> " }]);

interface HopFx {
  readonly fx: Fixture;
  readonly env: Record<string, string>;
  readonly script: string;
  argv(): string[][];
  ran(): boolean;
  /** SESSION_HOP_ITERM_FIXTURE is under fx.root and exists (before every hop call). */
  assertTabs(): void;
  /** tabs.json bytes are what the fixture wrote (after every hop call). */
  assertTabsUnchanged(): void;
}

function hopFx(real: boolean): HopFx {
  const fx = S.fixture(real ? {} : { scripts: S.fakeScripts("session_hop.py", FAKE_HOP) });
  const shim = join(fx.root, "py-shim");
  writeFileSync(shim, SHIM);
  chmodSync(shim, 0o755);
  const tabs = fx.env.SESSION_HOP_ITERM_FIXTURE!;
  writeFileSync(tabs, TABS);
  const argvLog = join(fx.root, "hop-argv.log");
  const ranLog = join(fx.root, "hop-ran.log");
  const assertTabs = () => {
    expect(tabs.startsWith(fx.root + sep), "SESSION_HOP_ITERM_FIXTURE under fx.root").toBe(true);
    expect(existsSync(tabs), "SESSION_HOP_ITERM_FIXTURE exists").toBe(true);
  };
  assertTabs();
  return {
    fx, script: join(fx.scripts, "session_hop.py"),
    env: { STRATUM_SESSION_PYTHON: shim, U2_HOP_ARGV_LOG: argvLog, U2_HOP_RAN_LOG: ranLog },
    argv: () => existsSync(argvLog) ? readFileSync(argvLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]) : [],
    ran: () => existsSync(ranLog),
    assertTabs,
    assertTabsUnchanged: () => { expect(readFileSync(tabs, "utf8")).toBe(TABS); },
  };
}

/** Every argv a check / dry-run door builds carries --check= or --dry-run before the `--`; a live argv carries neither. */
function assertDoor(argv: readonly string[], door: "check" | "dry-run" | "live"): void {
  const cut = argv.indexOf("--");
  const head = cut === -1 ? argv : argv.slice(0, cut);
  const checkHead = head.some((a) => a.startsWith("--check="));
  const dryHead = head.includes("--dry-run");
  expect([checkHead, dryHead], `door ${door} head ${JSON.stringify(head)}`).toEqual([door === "check", door === "dry-run"]);
}

type Door = "check" | "dry-run" | "live";
type Hop = ReturnType<typeof backend>;

// ---------------------------------------------------------------- argv table (review item 5)

interface ArgvRow {
  readonly name: string;
  readonly door: Door;
  readonly call: (b: Hop) => Promise<Envelope<HopData>>;
  readonly cli: string[];
  readonly argv: string[];
}

const ARGV_ROWS: ArgvRow[] = [
  { name: "check", door: "check", call: (b) => b.hopCheck({ name: NAME }), cli: ["hop", `--check=${NAME}`, "--json"], argv: [`--check=${NAME}`, "--json"] },
  { name: "dry-run, defaults", door: "dry-run", call: (b) => b.hopDryRun({ name: NAME }), cli: ["hop", NAME, "--dry-run", "--json"],
    argv: ["--dry-run", "--to=auto", "--reason=quota hop", "--json", "--", NAME] },
  { name: "dry-run, explicit to and reason", door: "dry-run", call: (b) => b.hopDryRun({ name: NAME, to: "seat2", reason: "5h at 99" }),
    cli: ["hop", NAME, "--dry-run", "--to", "seat2", "--reason", "5h at 99", "--json"], argv: ["--dry-run", "--to=seat2", "--reason=5h at 99", "--json", "--", NAME] },
  { name: "live, defaults", door: "live", call: (b) => b.hopLive({ name: NAME }), cli: ["hop", NAME, "--live", "--json"],
    argv: ["--to=auto", "--reason=quota hop", "--json", "--", NAME] },
  { name: "live, force and allow-closed", door: "live", call: (b) => b.hopLive({ name: NAME, to: "seat3", force: true, allowClosed: true }),
    cli: ["hop", NAME, "--live", "--to=seat3", "--force", "--allow-closed", "--json"], argv: ["--to=seat3", "--reason=quota hop", "--force", "--allow-closed", "--json", "--", NAME] },
  { name: "check, a name starting with -", door: "check", call: (b) => b.hopCheck({ name: "-x" }), cli: ["hop", "--check=-x", "--json"], argv: ["--check=-x", "--json"] },
  { name: "dry-run, a name starting with -", door: "dry-run", call: (b) => b.hopDryRun({ name: "-x" }), cli: ["hop", "--dry-run", "--json", "--", "-x"],
    argv: ["--dry-run", "--to=auto", "--reason=quota hop", "--json", "--", "-x"] },
  { name: "live, a name starting with -", door: "live", call: (b) => b.hopLive({ name: "-x" }), cli: ["hop", "--live", "--json", "--", "-x"],
    argv: ["--to=auto", "--reason=quota hop", "--json", "--", "-x"] },
  // The name `--dry-run` on the live door: only after the `--`, so the shim never execs the (fake) script.
  { name: "live, the name --dry-run", door: "live", call: (b) => b.hopLive({ name: "--dry-run" }), cli: ["hop", "--live", "--json", "--", "--dry-run"],
    argv: ["--to=auto", "--reason=quota hop", "--json", "--", "--dry-run"] },
  { name: "live, the name --check=x", door: "live", call: (b) => b.hopLive({ name: "--check=x" }), cli: ["hop", "--live", "--json", "--", "--check=x"],
    argv: ["--to=auto", "--reason=quota hop", "--json", "--", "--check=x"] },
];

describe("hop argv: each door builds its own literal argv (backend and CLI)", () => {
  for (const row of ARGV_ROWS) {
    it(`backend ${row.name}`, async () => {
      const h = hopFx(false);
      await row.call(backend(h.fx, h.env));
      h.assertTabsUnchanged();
      const logged = h.argv();
      expect(logged).toEqual([[h.script, ...row.argv]]);
      assertDoor(logged[0]!.slice(1), row.door);
      // The shim execs only a check / dry-run argv; a live argv never reaches the script.
      expect(h.ran(), "script ran").toBe(row.door !== "live");
    });
    it(`CLI ${row.name}`, () => {
      const h = hopFx(false);
      h.assertTabs();
      cli(h.fx, row.cli, h.env);
      h.assertTabsUnchanged();
      expect(h.argv()).toEqual([[h.script, ...row.argv]]);
      expect(h.ran(), "script ran").toBe(row.door !== "live");
    }, CLI_MS);
  }
});

// ---------------------------------------------------------------- usage rows: refused before any spawn

interface BackendUsageRow { readonly name: string; readonly call: (b: Hop) => Promise<Envelope<HopData>> }

const NUL = "a\u0000b";
const BACKEND_USAGE_ROWS: BackendUsageRow[] = [
  { name: "check, empty name", call: (b) => b.hopCheck({ name: "" }) },
  { name: "check, NUL in the name", call: (b) => b.hopCheck({ name: NUL }) },
  { name: "check, newline in the name", call: (b) => b.hopCheck({ name: "a\nb" }) },
  { name: "dry-run, empty name", call: (b) => b.hopDryRun({ name: "" }) },
  { name: "dry-run, NUL in the name", call: (b) => b.hopDryRun({ name: NUL }) },
  { name: "dry-run, empty to", call: (b) => b.hopDryRun({ name: NAME, to: "" }) },
  { name: "dry-run, NUL in the reason", call: (b) => b.hopDryRun({ name: NAME, reason: NUL }) },
  { name: "live, empty name", call: (b) => b.hopLive({ name: "" }) },
  { name: "live, NUL in the name", call: (b) => b.hopLive({ name: NUL }) },
  { name: "live, to with a newline", call: (b) => b.hopLive({ name: NAME, to: "seat2\nseat3" }) },
  { name: "live, force not a boolean", call: (b) => b.hopLive({ name: NAME, force: "yes" as unknown as boolean }) },
  { name: "live, allowClosed not a boolean", call: (b) => b.hopLive({ name: NAME, allowClosed: 1 as unknown as boolean }) },
];

const CLI_USAGE_ROWS: ReadonlyArray<readonly [string, string[]]> = [
  ["no door", ["hop", NAME, "--json"]],
  ["no door, no name", ["hop", "--json"]],
  ["check and dry-run", ["hop", `--check=${NAME}`, "--dry-run", "--json"]],
  ["check and live", ["hop", `--check=${NAME}`, "--live", "--json"]],
  ["dry-run and live", ["hop", NAME, "--dry-run", "--live", "--json"]],
  ["check with a positional", ["hop", `--check=${NAME}`, NAME, "--json"]],
  ["check with --to", ["hop", `--check=${NAME}`, "--to=seat2", "--json"]],
  ["check with --reason", ["hop", `--check=${NAME}`, "--reason=r", "--json"]],
  ["check with --force", ["hop", `--check=${NAME}`, "--force", "--json"]],
  ["check with --allow-closed", ["hop", `--check=${NAME}`, "--allow-closed", "--json"]],
  ["check with no value", ["hop", "--check"]],
  ["check, empty name", ["hop", "--check=", "--json"]],
  ["dry-run with no name", ["hop", "--dry-run", "--json"]],
  ["dry-run with two names", ["hop", NAME, "other", "--dry-run", "--json"]],
  ["dry-run with --force", ["hop", NAME, "--dry-run", "--force", "--json"]],
  ["dry-run with --allow-closed", ["hop", NAME, "--dry-run", "--allow-closed", "--json"]],
  ["live with no name", ["hop", "--live", "--json"]],
  ["live with two names", ["hop", NAME, "other", "--live", "--json"]],
  ["live, empty name", ["hop", "--live", "--json", "--", ""]],
  ["live, a value on --force", ["hop", NAME, "--live", "--force=1", "--json"]],
  ["an unknown option", ["hop", NAME, "--live", "--bogus", "--json"]],
  ["a name starting with - without --", ["hop", "--live", "-x", "--json"]],
];

describe("hop usage: refused before any spawn (the argv log stays empty)", () => {
  for (const row of BACKEND_USAGE_ROWS) {
    it(`backend ${row.name}`, async () => {
      const h = hopFx(false);
      const envelope = await row.call(backend(h.fx, h.env));
      expect(code(envelope), JSON.stringify(envelope)).toBe("usage");
      expect([cliExitFor(envelope), h.argv(), h.ran()]).toEqual([2, [], false]);
      h.assertTabsUnchanged();
    });
  }
  for (const [name, args] of CLI_USAGE_ROWS) {
    it(`CLI ${name}`, () => {
      const h = hopFx(false);
      const run = cli(h.fx, args, h.env);
      expect(run.status, run.stderr).toBe(2);
      expect([h.argv(), h.ran()]).toEqual([[], false]);
      h.assertTabsUnchanged();
    }, CLI_MS);
  }
});

// ---------------------------------------------------------------- exit rows on a fake session_hop.py (review item 6)

type Doc = Record<string, unknown>;
const hopDoc = (result: string, change: Doc = {}): Doc => ({
  result, name: NAME, from: "seat1", to: "seat2", hop_recommended: result === "HOP" ? true : result === "OK" ? false : null,
  reason: `r ${result}`, line: `${result} seat1`, left_open: result === "NOT-READY" || result === "PARTIAL" ? ["tab-new"] : [], ...change,
});

interface ExitRow {
  readonly name: string;
  readonly door: Door;
  /** The script's stdout: a record, raw text, or "" for nothing. */
  readonly doc: Doc | string;
  readonly exit: number;
  readonly expect: string;
  readonly cli: number;
  /** For a refusal: whether the envelope carries the script's record. */
  readonly record?: boolean;
}

const EXIT_ROWS: ExitRow[] = [
  { name: "live 0 HOPPED", door: "live", doc: hopDoc("HOPPED"), exit: 0, expect: "ok", cli: 0 },
  { name: "live 0 ALREADY", door: "live", doc: hopDoc("ALREADY", { to: "seat1" }), exit: 0, expect: "ok", cli: 0 },
  { name: "live 2 REFUSED", door: "live", doc: hopDoc("REFUSED"), exit: 2, expect: "hop-refused", cli: 1, record: true },
  { name: "live 3 BUSY", door: "live", doc: hopDoc("BUSY"), exit: 3, expect: "hop-busy", cli: 3, record: true },
  { name: "live 4 NOT-READY with left_open", door: "live", doc: hopDoc("NOT-READY"), exit: 4, expect: "hop-not-ready", cli: 5, record: true },
  { name: "live 5 PARTIAL with left_open", door: "live", doc: hopDoc("PARTIAL"), exit: 5, expect: "hop-partial", cli: 5, record: true },
  { name: "live 5 PARTIAL with no left_open", door: "live", doc: hopDoc("PARTIAL", { left_open: [] }), exit: 5, expect: "hop-partial", cli: 5, record: true },
  { name: "live 4 with no stdout", door: "live", doc: "", exit: 4, expect: "backend-error", cli: 4, record: false },
  { name: "live 5 with no stdout", door: "live", doc: "", exit: 5, expect: "backend-error", cli: 4, record: false },
  { name: "live 2 with no stdout", door: "live", doc: "", exit: 2, expect: "backend-error", cli: 4, record: false },
  { name: "live 4 NOT-READY with an empty left_open", door: "live", doc: hopDoc("NOT-READY", { left_open: [] }), exit: 4, expect: "backend-error", cli: 4, record: false },
  { name: "live 0 DRY-RUN", door: "live", doc: hopDoc("DRY-RUN"), exit: 0, expect: "backend-error", cli: 4 },
  { name: "live 0 OK", door: "live", doc: hopDoc("OK"), exit: 0, expect: "backend-error", cli: 4 },
  { name: "live 1 (outside the map)", door: "live", doc: hopDoc("REFUSED"), exit: 1, expect: "backend-error", cli: 4, record: false },
  { name: "live 0 HOPPED with an extra key", door: "live", doc: hopDoc("HOPPED", { tab: "t" }), exit: 0, expect: "backend-error", cli: 4 },
  { name: "live 0 HOPPED missing left_open", door: "live", doc: (() => { const d = hopDoc("HOPPED"); delete d.left_open; return d; })(), exit: 0, expect: "backend-error", cli: 4 },
  { name: "live 0 HOPPED for another name", door: "live", doc: hopDoc("HOPPED", { name: "other" }), exit: 0, expect: "backend-error", cli: 4 },
  { name: "live 0 HOPPED with hop_recommended false", door: "live", doc: hopDoc("HOPPED", { hop_recommended: false }), exit: 0, expect: "backend-error", cli: 4 },
  { name: "live 0 HOPPED with a non-empty left_open", door: "live", doc: hopDoc("HOPPED", { left_open: ["t"] }), exit: 0, expect: "backend-error", cli: 4 },
  { name: "live 0 stdout not JSON", door: "live", doc: "{", exit: 0, expect: "backend-error", cli: 4 },
  { name: "check 0 OK", door: "check", doc: hopDoc("OK", { to: null }), exit: 0, expect: "ok", cli: 0 },
  { name: "check 1 HOP", door: "check", doc: hopDoc("HOP", { to: null }), exit: 1, expect: "ok", cli: 0 },
  // ruling 1: a stale reading is script exit 2 -> backend-error -> CLI exit 4, with the UNKNOWN record.
  { name: "check 2 UNKNOWN keeps its record", door: "check", doc: hopDoc("UNKNOWN", { from: null, to: null }), exit: 2, expect: "backend-error", cli: 4, record: true },
  { name: "check 2 with no stdout", door: "check", doc: "", exit: 2, expect: "backend-error", cli: 4, record: false },
  { name: "check 0 HOP", door: "check", doc: hopDoc("HOP"), exit: 0, expect: "backend-error", cli: 4 },
  { name: "check 1 OK", door: "check", doc: hopDoc("OK"), exit: 1, expect: "backend-error", cli: 4 },
  { name: "check 1 HOP with hop_recommended false", door: "check", doc: hopDoc("HOP", { hop_recommended: false }), exit: 1, expect: "backend-error", cli: 4 },
  { name: "check 0 HOPPED", door: "check", doc: hopDoc("HOPPED"), exit: 0, expect: "backend-error", cli: 4 },
  { name: "check 3 (outside the map)", door: "check", doc: hopDoc("BUSY"), exit: 3, expect: "backend-error", cli: 4, record: false },
  { name: "dry-run 0 DRY-RUN", door: "dry-run", doc: hopDoc("DRY-RUN"), exit: 0, expect: "ok", cli: 0 },
  { name: "dry-run 0 ALREADY", door: "dry-run", doc: hopDoc("ALREADY"), exit: 0, expect: "ok", cli: 0 },
  { name: "dry-run 2 REFUSED", door: "dry-run", doc: hopDoc("REFUSED"), exit: 2, expect: "hop-refused", cli: 1, record: true },
  { name: "dry-run 3 BUSY", door: "dry-run", doc: hopDoc("BUSY"), exit: 3, expect: "hop-busy", cli: 3, record: true },
  { name: "dry-run 0 HOPPED", door: "dry-run", doc: hopDoc("HOPPED"), exit: 0, expect: "backend-error", cli: 4 },
  { name: "dry-run 4 NOT-READY", door: "dry-run", doc: hopDoc("NOT-READY"), exit: 4, expect: "backend-error", cli: 4, record: false },
  { name: "dry-run 5 PARTIAL", door: "dry-run", doc: hopDoc("PARTIAL"), exit: 5, expect: "backend-error", cli: 4, record: false },
];

const DOOR_CALL: Readonly<Record<Door, (b: Hop) => Promise<Envelope<HopData>>>> = {
  check: (b) => b.hopCheck({ name: NAME }),
  "dry-run": (b) => b.hopDryRun({ name: NAME }),
  live: (b) => b.hopLive({ name: NAME }),
};

const canned = (row: ExitRow) => ({ U2_HOP_CANNED: typeof row.doc === "string" ? row.doc : JSON.stringify(row.doc), U2_HOP_EXIT: String(row.exit) });

describe("hop exits: each door's exit map and result table (fake session_hop.py)", () => {
  for (const row of EXIT_ROWS) {
    it(row.name, async () => {
      const h = hopFx(false);
      const envelope = await DOOR_CALL[row.door](backend(h.fx, { ...h.env, ...canned(row) }));
      h.assertTabsUnchanged();
      expect(code(envelope), JSON.stringify(envelope)).toBe(row.expect);
      expect(cliExitFor(envelope)).toBe(row.cli);
      expect(h.argv().length).toBe(1);
      assertDoor(h.argv()[0]!.slice(1), row.door);
      if (envelope.ok) {
        expect(envelope.data).toEqual(row.doc);
        return;
      }
      expect([envelope.refusal.script, envelope.refusal.script_exit]).toEqual(["session_hop.py", row.exit]);
      if (row.record !== undefined) expect(envelope.record !== null, JSON.stringify(envelope)).toBe(row.record);
      if (row.record === true) expect(envelope.record).toEqual(row.doc);
    });
  }

  it("CLI: the exit codes of a live refusal, a not-ready and a check UNKNOWN", () => {
    const cases: ReadonlyArray<readonly [ExitRow, string[]]> = [
      [EXIT_ROWS.find((r) => r.name === "live 2 REFUSED")!, ["hop", NAME, "--live", "--json"]],
      [EXIT_ROWS.find((r) => r.name === "live 3 BUSY")!, ["hop", NAME, "--live", "--json"]],
      [EXIT_ROWS.find((r) => r.name === "live 4 NOT-READY with left_open")!, ["hop", NAME, "--live", "--json"]],
      [EXIT_ROWS.find((r) => r.name === "check 1 HOP")!, ["hop", `--check=${NAME}`, "--json"]],
      [EXIT_ROWS.find((r) => r.name === "check 2 UNKNOWN keeps its record")!, ["hop", `--check=${NAME}`, "--json"]],
    ];
    const got = cases.map(([row, args]) => {
      const h = hopFx(false);
      const run = cli(h.fx, args, { ...h.env, ...canned(row) });
      h.assertTabsUnchanged();
      return [row.name, run.status, run.envelope && code(run.envelope)];
    });
    expect(got).toEqual(cases.map(([row]) => [row.name, row.cli, row.expect]));
  }, 5 * CLI_MS);
});

// ---------------------------------------------------------------- the real session_hop.py, check and dry-run only

/** The tab's own session-state file (tty -> session) plus an optional transcript of it under the target seat's projects folder. */
function realFx(transcriptSeat: string | null): HopFx & { sid: string } {
  const h = hopFx(true);
  const sid = randomUUID();
  const now = Date.now() / 1000;
  const file = join(h.fx.env.USAGE_WATCH_STATE_DIR!, `${h.fx.token}-tab.json`);
  writeFileSync(file, JSON.stringify({ session_name: NAME, session_id: sid, tty: TTY, config_dir: join(h.fx.root, "home", ".claude-seat1"), cwd: h.fx.root, ts: now - 60 }));
  utimesSync(file, now - 60, now - 60);
  if (transcriptSeat !== null) {
    const dir = join(h.fx.root, "home", `.claude-${transcriptSeat}`, "projects", h.fx.root.replace(/[^A-Za-z0-9]/g, "-"));
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${sid}.jsonl`), `${JSON.stringify({ type: "custom-title", customTitle: NAME, sessionId: sid })}\n`);
  }
  return { ...h, sid };
}

interface RealRow {
  readonly name: string;
  readonly door: "check" | "dry-run";
  readonly readings: (fx: Fixture) => void;
  readonly transcript: string | null;
  readonly to?: string;
  readonly expect: string;
  readonly cli: number;
  readonly scriptExit: number;
  readonly result: string;
  readonly hopRecommended: boolean | null;
  readonly fromTo?: readonly [string | null, string | null];
}

const allAt = (pct: number, elapsedMin: number) => (fx: Fixture) => { for (const seat of SEATS) putReading(fx, seat, pct, elapsedMin); };

const REAL_ROWS: RealRow[] = [
  { name: "check: an open reading is OK", door: "check", readings: openAll, transcript: null, expect: "ok", cli: 0, scriptExit: 0, result: "OK", hopRecommended: false },
  // forge-e0 ruling 2 / c3 Finding 3: the hop line is a script constant (session_hop.py:68-69 TRIP_PCT 100, FLOOR_PCT 95, not read
  // from the policy), so the HOP row uses a full 100% window, over any hop line. Never the fixture ceiling (80) or 95.
  { name: "check: a full window is HOP", door: "check", readings: allAt(100, OPEN_ELAPSED_MIN), transcript: null, expect: "ok", cli: 0, scriptExit: 1, result: "HOP", hopRecommended: true },
  // forge-e0 ruling 1: an expired reading is script exit 2 -> backend-error -> CLI exit 4, record.result UNKNOWN.
  { name: "check: an expired reading is UNKNOWN (backend-error with the record)", door: "check", readings: (fx) => allAt(openPct(fx), 301)(fx), transcript: null,
    expect: "backend-error", cli: 4, scriptExit: 2, result: "UNKNOWN", hopRecommended: null },
  { name: "dry-run: seat1 to seat2 is DRY-RUN", door: "dry-run", readings: openAll, transcript: "seat2", to: "seat2", expect: "ok", cli: 0, scriptExit: 0,
    result: "DRY-RUN", hopRecommended: null, fromTo: ["seat1", "seat2"] },
  { name: "dry-run: seat1 to seat1 is ALREADY", door: "dry-run", readings: openAll, transcript: null, to: "seat1", expect: "ok", cli: 0, scriptExit: 0,
    result: "ALREADY", hopRecommended: null, fromTo: ["seat1", "seat1"] },
  { name: "dry-run: no transcript is REFUSED", door: "dry-run", readings: openAll, transcript: null, to: "auto", expect: "hop-refused", cli: 1, scriptExit: 2,
    result: "REFUSED", hopRecommended: null },
];

describe.skipIf(!HAVE_OPS)("hop on the real session_hop.py: check and dry-run (never live)", () => {
  for (const row of REAL_ROWS) {
    it(row.name, async () => {
      const h = realFx(row.transcript);
      row.readings(h.fx);
      h.assertTabs();
      const door = backend(h.fx, h.env);
      const envelope = row.door === "check" ? await door.hopCheck({ name: NAME }) : await door.hopDryRun({ name: NAME, ...(row.to ? { to: row.to } : {}) });
      h.assertTabsUnchanged();
      expect(h.argv().length).toBe(1);
      assertDoor(h.argv()[0]!.slice(1), row.door);
      expect(code(envelope), JSON.stringify(envelope)).toBe(row.expect);
      expect(cliExitFor(envelope)).toBe(row.cli);
      const record = (envelope.ok ? envelope.data : envelope.record) as HopData | null;
      if (!envelope.ok) expect(envelope.refusal.script_exit).toBe(row.scriptExit);
      expect([record?.result, record?.name, record?.hop_recommended], JSON.stringify(envelope)).toEqual([row.result, NAME, row.hopRecommended]);
      if (row.fromTo) expect([record?.from, record?.to]).toEqual(row.fromTo);
    }, REAL_MS);
  }

  it("CLI on the real scripts: check exits 0, dry-run exits 0, live never reaches the script (exit 97 -> 4)", () => {
    const h = realFx("seat2");
    openAll(h.fx);
    h.assertTabs();
    const check = cli(h.fx, ["hop", `--check=${NAME}`, "--json"], h.env);
    const dry = cli(h.fx, ["hop", NAME, "--dry-run", "--to=seat2", "--json"], h.env);
    const live = cli(h.fx, ["hop", NAME, "--live", "--to=seat2", "--json"], h.env);
    h.assertTabsUnchanged();
    expect([check.status, dry.status, live.status], `${check.stdout}${dry.stdout}${live.stdout}`).toEqual([0, 0, 4]);
    expect([(check.envelope as Envelope<HopData> | null)?.ok && (check.envelope as { data: HopData }).data.result,
      (dry.envelope as Envelope<HopData> | null)?.ok && (dry.envelope as { data: HopData }).data.result]).toEqual(["OK", "DRY-RUN"]);
    expect(live.envelope && !live.envelope.ok && live.envelope.refusal.script_exit).toBe(97);
    const logged = h.argv();
    expect(logged.length).toBe(3);
    assertDoor(logged[0]!.slice(1), "check");
    assertDoor(logged[1]!.slice(1), "dry-run");
    assertDoor(logged[2]!.slice(1), "live");
  }, REAL_MS);
});
