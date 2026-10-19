import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Envelope } from "../../src/session/index.js";
import { backend, cli, code, type Fixture, HAVE_OPS, openAll, openPct, py, SEATS, suite } from "./fixture.js";

/**
 * SESSION-MGMT-1-U2: the read-only ops `status` (usage_watch status + launch_gate --status, merged) and
 * `fleet` (launch_gate --fleet) and `policy` (session_policy --json). Real scripts on the fixture for the contracted paths; fixture scripts for
 * the shapes the real ones cannot print on demand (every validator is closed: a missing OR extra key is
 * backend-error, except forge-e0 ruling 1's cited launch_gate additions). Leak gate and fixture env: fixture.ts.
 */

const S = suite("u2sf");
/** A real usage_watch status walks every reading: seconds idle, much longer under a loaded machine. */
const REAL_MS = 180_000;

/** A stand-in for any read-only script: prints $U2_DOC_<stem> (raw text) and exits $U2_EXIT_<stem>. */
const FAKE_DOC = py(`
stem = os.path.basename(sys.argv[0]).split(".")[0]
text = os.environ.get("U2_DOC_" + stem, "")
if text: print(text)
sys.exit(int(os.environ.get("U2_EXIT_" + stem, "0")))`);

function fakeDir(...names: string[]): string {
  const dir = S.fakeScripts(names[0]!, FAKE_DOC);
  for (const name of names.slice(1)) writeFileSync(join(dir, name), FAKE_DOC);
  return dir;
}

type Doc = Record<string, unknown>;
const clone = (doc: Doc): Doc => JSON.parse(JSON.stringify(doc)) as Doc;
const edit = (doc: Doc, change: (copy: Doc) => void): Doc => { const copy = clone(doc); change(copy); return copy; };

/** usage_watch status --json --no-spend as the real script printed it on the fixture (probe 2026-10-20), quota numbers from the fixture. */
function usageDoc(fx: Fixture): Doc {
  const window = { used_pct: openPct(fx), resets_at: 1, status: "ok", source_age_s: 30 };
  return {
    generated_at: 1, target_pct: fx.target,
    accounts: [
      { id: "seat1", vendor: "claude", label: "seat1", status: "missing", windows: { "5h": window, "7d": { ...window, used_pct: null, status: "missing" } }, pace: null,
        ceiling_pct: fx.ceiling, ceiling_source: "row", reserved: false, reserved_why: "", owner_sessions: [], unused_24h_pts: null, fable: { reading: null } },
      { id: "codex", vendor: "codex", label: "codex", status: "missing", windows: {}, pace: null },
    ],
    recommendation: {
      kind: "author", choice: { id: "seat1", vendor: "claude", label: "seat1", command: "ccd1 -n '<name>'" }, reason: "r", rule: "r",
      seats: [{ id: "seat1", ceiling: fx.ceiling, used: openPct(fx), state: "behind", detail: "d" }],
    },
  };
}

/** launch_gate --status --json as the real script printed it on the fixture (probe 2026-10-20). */
const GATE_DOC: Doc = {
  bypassed: false,
  engines: { claude: { reason: "load 53.9>=32", would_pass: false }, codex: { reason: null, would_pass: true } },
  fleet: { count: 0, max: 16 },
  launches: { kept: 0, last_age_s: null, last_label: null, recent: 0, retain_s: 86400.0, window_s: 900.0 },
  limits: { max_recent: 16, spacing_s: 45.0, window_s: 900.0 },
  load1: 3.5, load_max: 32.0, idle: { min: 20, sampled: false, pct: null },
  queue: { mode: "fifo", waiting: [{ engine: "claude", label: "l", pid: 42, waiting_s: 1.5, alive: true }] },
};

const FLEET_DOC: Doc = { count: 1, max: 16, jobs: [{ session: "s", label: "l", pid: 42 }] };
const REFUSAL = { refused: true, reason: "LAUNCH_GATE_MAX_RECENT is not a number (value not shown)" };

/**
 * One row per member of the class "a script answer the door must accept or turn into a named refusal": the closed
 * shape (missing key, extra key, wrong type at each level), the ruling-1 additions, the refusal record, and the exit map.
 * `record` true = the refusal carries the script's record; false = record null.
 */
interface Row {
  readonly name: string;
  readonly op: "status" | "fleet";
  readonly script: "usage_watch" | "launch_gate";
  readonly doc: (fx: Fixture) => Doc | string;
  readonly exit?: number;
  readonly expect: string;
  readonly record?: boolean;
}

const ROWS: Row[] = [
  { name: "status: both documents good", op: "status", script: "launch_gate", doc: () => GATE_DOC, expect: "ok" },
  { name: "status: gate without the ruling-1 additions", op: "status", script: "launch_gate",
    doc: () => edit(GATE_DOC, (c) => { delete c.bypassed; delete c.idle; const l = c.launches as Doc; delete l.last_label; delete l.retain_s; }), expect: "ok" },
  { name: "status: gate idle sampled with a pct (LAUNCH-GATE-IDLE-1)", op: "status", script: "launch_gate", doc: () => ({ ...GATE_DOC, idle: { min: 20, sampled: true, pct: 12.5 } }), expect: "ok" },
  { name: "status: gate idle extra key", op: "status", script: "launch_gate", doc: () => ({ ...GATE_DOC, idle: { min: 20, sampled: false, pct: null, cpu: 1 } }), expect: "backend-error" },
  { name: "status: gate fleet.count null (cap off)", op: "status", script: "launch_gate", doc: () => edit(GATE_DOC, (c) => { (c.fleet as Doc).count = null; }), expect: "ok" },
  { name: "status: gate extra top-level key", op: "status", script: "launch_gate", doc: () => ({ ...GATE_DOC, surprise: 1 }), expect: "backend-error", record: false },
  { name: "status: gate extra launches key", op: "status", script: "launch_gate", doc: () => edit(GATE_DOC, (c) => { (c.launches as Doc).other = 1; }), expect: "backend-error" },
  { name: "status: gate bypassed not a boolean", op: "status", script: "launch_gate", doc: () => ({ ...GATE_DOC, bypassed: "no" }), expect: "backend-error" },
  { name: "status: gate last_label a number", op: "status", script: "launch_gate", doc: () => edit(GATE_DOC, (c) => { (c.launches as Doc).last_label = 3; }), expect: "backend-error" },
  { name: "status: gate missing load1", op: "status", script: "launch_gate", doc: () => edit(GATE_DOC, (c) => { delete c.load1; }), expect: "backend-error" },
  { name: "status: gate engines lacks codex", op: "status", script: "launch_gate", doc: () => edit(GATE_DOC, (c) => { delete (c.engines as Doc).codex; }), expect: "backend-error" },
  { name: "status: gate engines extra engine", op: "status", script: "launch_gate", doc: () => edit(GATE_DOC, (c) => { (c.engines as Doc).devin = { would_pass: true, reason: null }; }), expect: "backend-error" },
  { name: "status: gate queue mode outside the enum", op: "status", script: "launch_gate", doc: () => edit(GATE_DOC, (c) => { (c.queue as Doc).mode = "lifo"; }), expect: "backend-error" },
  { name: "status: gate waiting item extra key", op: "status", script: "launch_gate",
    doc: () => edit(GATE_DOC, (c) => { ((c.queue as Doc).waiting as Doc[])[0]!.extra = 1; }), expect: "backend-error" },
  { name: "status: gate limits extra key", op: "status", script: "launch_gate", doc: () => edit(GATE_DOC, (c) => { (c.limits as Doc).burst = 1; }), expect: "backend-error" },
  { name: "status: gate refusal exit 1 carries its record", op: "status", script: "launch_gate", doc: () => REFUSAL, exit: 1, expect: "backend-error", record: true },
  { name: "status: gate refusal record with an extra key", op: "status", script: "launch_gate", doc: () => ({ ...REFUSAL, env: "x" }), exit: 1, expect: "backend-error", record: false },
  { name: "status: gate exit 2 is usage", op: "status", script: "launch_gate", doc: () => ({ ...REFUSAL, reason: "--status --json takes no other argument" }), exit: 2, expect: "usage", record: true },
  { name: "status: gate exit outside the map", op: "status", script: "launch_gate", doc: () => GATE_DOC, exit: 7, expect: "backend-error", record: false },
  { name: "status: gate stdout not JSON", op: "status", script: "launch_gate", doc: () => "{", expect: "backend-error", record: false },
  { name: "status: usage recommendation null", op: "status", script: "usage_watch", doc: (fx) => ({ ...usageDoc(fx), recommendation: null }), expect: "ok" },
  { name: "status: usage extra top-level key", op: "status", script: "usage_watch", doc: (fx) => ({ ...usageDoc(fx), spend: {} }), expect: "backend-error" },
  { name: "status: usage account extra key", op: "status", script: "usage_watch",
    doc: (fx) => edit(usageDoc(fx), (c) => { (c.accounts as Doc[])[0]!.config_dir = "/x"; }), expect: "backend-error" },
  { name: "status: usage account lacks pace", op: "status", script: "usage_watch",
    doc: (fx) => edit(usageDoc(fx), (c) => { delete (c.accounts as Doc[])[1]!.pace; }), expect: "backend-error" },
  { name: "status: usage recommendation extra key", op: "status", script: "usage_watch",
    doc: (fx) => edit(usageDoc(fx), (c) => { (c.recommendation as Doc).command = "x"; }), expect: "backend-error" },
  { name: "status: usage exit 1 with no JSON (traceback)", op: "status", script: "usage_watch", doc: () => "", exit: 1, expect: "backend-error", record: false },
  { name: "fleet: one job, count 1", op: "fleet", script: "launch_gate", doc: () => FLEET_DOC, expect: "ok" },
  { name: "fleet: jobs.length differs from count", op: "fleet", script: "launch_gate", doc: () => ({ ...FLEET_DOC, count: 2 }), expect: "backend-error" },
  { name: "fleet: job extra key", op: "fleet", script: "launch_gate", doc: () => edit(FLEET_DOC, (c) => { (c.jobs as Doc[])[0]!.account = "seat1"; }), expect: "backend-error" },
  { name: "fleet: extra top-level key", op: "fleet", script: "launch_gate", doc: () => ({ ...FLEET_DOC, cap: true }), expect: "backend-error" },
  { name: "fleet: refusal exit 1 carries its record", op: "fleet", script: "launch_gate", doc: () => REFUSAL, exit: 1, expect: "backend-error", record: true },
  { name: "fleet: exit 2 is outside the contract map", op: "fleet", script: "launch_gate", doc: () => REFUSAL, exit: 2, expect: "backend-error", record: false },
];

describe("status / fleet: closed shapes, the ruling-1 additions, the refusal record, the exit map", () => {
  for (const row of ROWS) {
    it(row.name, async () => {
      const fx = S.fixture({ scripts: fakeDir("usage_watch.py", "launch_gate.py") });
      const doc = row.doc(fx);
      const text = typeof doc === "string" ? doc : JSON.stringify(doc);
      const other = row.script === "usage_watch" ? "launch_gate" : "usage_watch";
      const extra: Record<string, string> = {
        [`U2_DOC_${row.script}`]: text, [`U2_EXIT_${row.script}`]: String(row.exit ?? 0),
        [`U2_DOC_${other}`]: JSON.stringify(other === "usage_watch" ? usageDoc(fx) : GATE_DOC),
      };
      if (row.op === "fleet") extra.U2_DOC_launch_gate = text;
      const door = backend(fx, extra);
      const envelope: Envelope<unknown> = row.op === "status" ? await door.status() : await door.fleet();
      expect(code(envelope), JSON.stringify(envelope)).toBe(row.expect);
      if (envelope.ok) return;
      expect(envelope.refusal.script).toBe(`${row.script}.py`);
      if (row.record !== undefined) expect(envelope.record !== null, JSON.stringify(envelope)).toBe(row.record);
    });
  }

  it("status merges usage_watch accounts/recommendation with the gate document", async () => {
    const fx = S.fixture({ scripts: fakeDir("usage_watch.py", "launch_gate.py") });
    const usage = usageDoc(fx);
    const envelope = await backend(fx, { U2_DOC_usage_watch: JSON.stringify(usage), U2_DOC_launch_gate: JSON.stringify(GATE_DOC) }).status();
    expect(envelope.ok && envelope.data).toEqual({ accounts: usage.accounts, recommendation: usage.recommendation, gate: GATE_DOC });
  });
});

describe.skipIf(!HAVE_OPS)("status / fleet on the real scripts", () => {
  it("status: every fixture account, its fixture ceiling, a recommendation, the gate", async () => {
    const fx = S.fixture();
    openAll(fx);
    const envelope = await backend(fx).status();
    expect(envelope.ok, JSON.stringify(envelope)).toBe(true);
    if (!envelope.ok) return;
    expect(envelope.data.accounts.map((row) => row.id)).toEqual([...SEATS, "codex"]);
    for (const row of envelope.data.accounts.filter((r) => r.vendor === "claude")) {
      expect(row.ceiling_pct, `${String(row.id)} ceiling`).toBe(fx.ceiling);
      expect((row.windows as Record<string, { used_pct: number }>)["5h"]!.used_pct).toBe(openPct(fx));
    }
    expect(SEATS as readonly unknown[]).toContain((envelope.data.recommendation?.choice as { id: string } | null)?.id);
    expect(Object.keys(envelope.data.gate.engines).sort()).toEqual(["claude", "codex"]);
    expect(envelope.data.gate.fleet.count).toBe(0);
  }, REAL_MS);

  it("status: a gate that cannot read its config is backend-error with the {refused, reason} record", async () => {
    const fx = S.fixture();
    const envelope = await backend(fx, { LAUNCH_GATE_MAX_RECENT: "x" }).status();
    expect(code(envelope)).toBe("backend-error");
    if (envelope.ok) return;
    expect([envelope.refusal.script, envelope.refusal.script_exit, (envelope.record as { refused: boolean }).refused]).toEqual(["launch_gate.py", 1, true]);
    expect(envelope.refusal.reason).toContain("LAUNCH_GATE_MAX_RECENT");
  }, REAL_MS);

  it("status: an unreadable accounts file is backend-error from usage_watch (no record)", async () => {
    const fx = S.fixture();
    const envelope = await backend(fx, { USAGE_WATCH_ACCOUNTS: join(fx.root, "absent.json") }).status();
    expect(code(envelope)).toBe("backend-error");
    if (!envelope.ok) expect([envelope.refusal.script, envelope.refusal.script_exit, envelope.record]).toEqual(["usage_watch.py", 1, null]);
  }, REAL_MS);

  it("fleet: no detached jobs in the fixture registry", async () => {
    const fx = S.fixture();
    const envelope = await backend(fx).fleet();
    expect(envelope.ok && [envelope.data.count, envelope.data.jobs]).toEqual([0, []]);
  }, REAL_MS);

  it("fleet: a gate config error is backend-error with the record", async () => {
    const fx = S.fixture();
    const envelope = await backend(fx, { LAUNCH_GATE_MAX_RECENT: "x" }).fleet();
    expect([code(envelope), !envelope.ok && envelope.refusal.script_exit, !envelope.ok && envelope.record !== null]).toEqual(["backend-error", 1, true]);
  }, REAL_MS);

  it("CLI: status and fleet --json exit 0; a refusal exits 4; an extra argument exits 2", () => {
    const fx = S.fixture();
    openAll(fx);
    const status = cli(fx, ["status", "--json"]);
    const fleet = cli(fx, ["fleet", "--json"]);
    const refused = cli(fx, ["fleet", "--json"], { LAUNCH_GATE_MAX_RECENT: "x" });
    expect([status.status, status.envelope?.op, fleet.status, fleet.envelope?.op], JSON.stringify(status.envelope)).toEqual([0, "status", 0, "fleet"]);
    expect([refused.status, refused.envelope && code(refused.envelope)]).toEqual([4, "backend-error"]);
    for (const args of [["status", "extra"], ["fleet", "--bogus"], ["status", "--name=x"]]) expect(cli(fx, args).status, args.join(" ")).toBe(2);
  }, REAL_MS);
});

/** session_policy --json as the real script printed it on the fixture (probe 2026-10-20), trimmed to one key per section. */
const POLICY_DOC: Doc = {
  path: "usage-watch.accounts.json",
  values: { version: 1, seat_map: { "s1-chat": "seat1" }, admission: { quota_limit_pct: 100 }, launch_gate: { fleet_max: 16 } },
  sources: { version: "file", seat_map: "default", "launch_gate.fleet_max": "env:LAUNCH_GATE_FLEET_MAX" },
  warnings: [],
};

const POLICY_ROWS: ReadonlyArray<{ name: string; doc: () => Doc; exit?: number; expect: string }> = [
  { name: "policy: good document (file, default and env sources)", doc: () => POLICY_DOC, expect: "ok" },
  { name: "policy: extra top-level key", doc: () => ({ ...POLICY_DOC, extra: 1 }), expect: "backend-error" },
  { name: "policy: missing top-level key", doc: () => edit(POLICY_DOC, (c) => { delete c.warnings; }), expect: "backend-error" },
  { name: "policy: values with an extra key", doc: () => edit(POLICY_DOC, (c) => { (c.values as Doc).other = 1; }), expect: "backend-error" },
  { name: "policy: values missing a key", doc: () => edit(POLICY_DOC, (c) => { delete (c.values as Doc).launch_gate; }), expect: "backend-error" },
  { name: "policy: path with a slash", doc: () => ({ ...POLICY_DOC, path: "/etc/usage-watch.accounts.json" }), expect: "backend-error" },
  { name: "policy: sources value outside file/default/env:VAR", doc: () => ({ ...POLICY_DOC, sources: { version: "cli" } }), expect: "backend-error" },
  { name: "policy: sources env: without a name", doc: () => ({ ...POLICY_DOC, sources: { version: "env:" } }), expect: "backend-error" },
  { name: "policy: warnings not strings", doc: () => ({ ...POLICY_DOC, warnings: [1] }), expect: "backend-error" },
  { name: "policy: exit 1 is backend-error", doc: () => POLICY_DOC, exit: 1, expect: "backend-error" },
  { name: "policy: exit 2 is outside the contract map", doc: () => POLICY_DOC, exit: 2, expect: "backend-error" },
];

describe("policy: closed shape and the exit map", () => {
  for (const row of POLICY_ROWS) {
    it(row.name, async () => {
      const fx = S.fixture({ scripts: fakeDir("session_policy.py") });
      const envelope = await backend(fx, { U2_DOC_session_policy: JSON.stringify(row.doc()), U2_EXIT_session_policy: String(row.exit ?? 0) }).policy();
      expect(code(envelope), JSON.stringify(envelope)).toBe(row.expect);
      if (!envelope.ok) expect(envelope.refusal.script).toBe("session_policy.py");
    });
  }
});

describe.skipIf(!HAVE_OPS)("policy on the real script", () => {
  it("ok: the four keys, values keys exactly version/seat_map/admission/launch_gate", async () => {
    const fx = S.fixture();
    const envelope = await backend(fx).policy();
    expect(envelope.ok, JSON.stringify(envelope)).toBe(true);
    if (!envelope.ok) return;
    expect(Object.keys(envelope.data).sort()).toEqual(["path", "sources", "values", "warnings"]);
    expect(Object.keys(envelope.data.values).sort()).toEqual(["admission", "launch_gate", "seat_map", "version"]);
    expect(envelope.data.path).not.toContain("/");
  }, REAL_MS);

  it("a bad accounts JSON is backend-error with no record", async () => {
    const fx = S.fixture();
    const bad = join(fx.root, "bad-accounts.json");
    writeFileSync(bad, "{");
    const envelope = await backend(fx, { USAGE_WATCH_ACCOUNTS: bad, SEAT_ACCOUNTS: bad }).policy();
    expect(code(envelope)).toBe("backend-error");
    if (!envelope.ok) expect([envelope.refusal.script, envelope.refusal.script_exit, envelope.record]).toEqual(["session_policy.py", 1, null]);
  }, REAL_MS);

  it("CLI: policy --json exits 0 with op policy; an extra argument exits 2", () => {
    const fx = S.fixture();
    const ok = cli(fx, ["policy", "--json"]);
    expect([ok.status, ok.envelope?.op], JSON.stringify(ok.envelope)).toEqual([0, "policy"]);
    expect(cli(fx, ["policy", "extra"]).status).toBe(2);
  }, REAL_MS);
});
