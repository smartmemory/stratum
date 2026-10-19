import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CONTRACT_FILE, type Fixture, HAVE_OPS, openAll, OPS_SCRIPTS, py, scriptRunEnv, suite } from "./fixture.js";

/**
 * SESSION-MGMT-1-U2 review item 7: session-contract.json `operations.<op>.script_output` against what the REAL ops script prints on the
 * fixture (missing AND extra keys), cross-checked with the ops json-contract.json entry for the same script. The only keys allowed beyond the
 * session-contract are the table below (the same additions scripts-backend.ts GATE_STATUS_ADDITIONS / GATE_LAUNCHES_ADDITIONS allow);
 * any other extra key fails. Hop runs `--check=` only, under SESSION_HOP_ITERM_FIXTURE; launch runs with the fixture engine
 * (DETACH_JOB_ENGINE_OVERRIDE). No live session, tab or server is ever touched. Leak gate and fixture env: fixture.ts.
 */

const S = suite("u2ct");
const REAL_MS = 180_000;
const OPS_CONTRACT_FILE = join(OPS_SCRIPTS, "json-contract.json");

type Json = Record<string, unknown>;
const sessionContract = (): Record<string, Json> => (JSON.parse(readFileSync(CONTRACT_FILE, "utf8")) as { operations: Record<string, Json> }).operations;
const opsContract = (): Json => JSON.parse(readFileSync(OPS_CONTRACT_FILE, "utf8")) as Json;

/** The contract's key set: `required`, and `optional` (a key whose text starts with "optional", or ends in "?"). */
interface KeySpec { readonly required: readonly string[]; readonly optional: readonly string[] }

/** The first balanced {...} of a prose spec, its top-level parts (commas at depth 1). */
function braceParts(spec: string): string[] {
  const start = spec.indexOf("{");
  if (start === -1) return [];
  const parts: string[] = [];
  let depth = 0;
  let from = start + 1;
  for (let i = start; i < spec.length; i += 1) {
    const ch = spec[i]!;
    if ("{[(".includes(ch)) depth += 1;
    else if ("}])".includes(ch)) {
      depth -= 1;
      if (depth === 0) { parts.push(spec.slice(from, i)); return parts.map((p) => p.trim()).filter(Boolean); }
    } else if (ch === "," && depth === 1) { parts.push(spec.slice(from, i)); from = i + 1; }
  }
  return [];
}

function proseKeys(spec: string): KeySpec {
  const required: string[] = [];
  const optional: string[] = [];
  for (const part of braceParts(spec)) {
    const m = /^([A-Za-z_][A-Za-z0-9_]*)(\?)?/.exec(part);
    if (m) (m[2] ? optional : required).push(m[1]!);
  }
  return { required, optional };
}

/** `script_output` as an object (a key per entry; "optional ..." values are optional) or as prose with a {...} key list. */
function contractKeys(output: unknown): KeySpec {
  if (typeof output === "string") return proseKeys(output);
  const required: string[] = [];
  const optional: string[] = [];
  for (const [key, text] of Object.entries(output as Json)) (typeof text === "string" && text.startsWith("optional") ? optional : required).push(key);
  return { required, optional };
}

/** Every real-script key set against a contract: names the missing and the extra keys, or null. */
function keyProblem(what: string, actual: readonly string[], spec: KeySpec, expectedExtra: readonly string[] = []): string | null {
  const missing = spec.required.filter((key) => !actual.includes(key));
  const known = new Set([...spec.required, ...spec.optional, ...expectedExtra]);
  const extra = actual.filter((key) => !known.has(key));
  if (missing.length === 0 && extra.length === 0) return null;
  return `${what}: missing [${missing.join(", ")}], extra [${extra.join(", ")}]`;
}

/**
 * The ONE expected-extra table: keys the real scripts emit that session-contract does not list, recorded in the ops json-contract
 * (c3 Findings 1). Same additions as scripts-backend.ts `GATE_STATUS_ADDITIONS` (bypassed, idle) and `GATE_LAUNCHES_ADDITIONS`
 * (launches.last_label, launches.retain_s). Any other extra key fails.
 */
const EXPECTED_EXTRA: Readonly<Record<string, readonly string[]>> = {
  "status.launch_gate": ["bypassed", "idle"],
  "status.launch_gate.launches": ["last_label", "retain_s"],
};

/** ops json-contract.json entry per op/part (an entry is a script's required/optional); null = the ops file has no entry for it. */
const OPS_ENTRY: Readonly<Record<string, string | null>> = {
  pick: null, admit: "session_admit", launch: "detach_job run", "status.usage_watch": null, "status.launch_gate": "launch_gate status",
  fleet: "launch_gate fleet", hop: "session_hop", jobs_list: "list.diagnostics.envelope", jobs_register: null, policy: "session_policy",
};

function opsSpec(entry: string): KeySpec {
  const [name, ...path] = entry.startsWith("list.") ? ["list", ...entry.split(".").slice(1)] : [entry];
  let node: unknown = opsContract()[name!];
  for (const step of path) node = (node as Json)[step];
  if (Array.isArray(node)) return { required: node as string[], optional: [] };
  const doc = node as { required: string[]; optional?: string[] };
  return { required: doc.required, optional: doc.optional ?? [] };
}

/** One real script run on the fixture: stdout parsed as the one JSON document. */
function runScript(fx: Fixture, script: string, args: string[], extra: Partial<NodeJS.ProcessEnv> = {}, input = ""): { doc: Json; exit: number | null; stderr: string } {
  const run = spawnSync(fx.env.STRATUM_SESSION_PYTHON ?? "python3", [join(fx.scripts, script), ...args], {
    env: scriptRunEnv(fx, extra), cwd: fx.root, encoding: "utf8", timeout: 120_000, input,
  });
  let doc: Json = {};
  try { doc = JSON.parse(run.stdout) as Json; } catch { /* the row's assertion names the stdout */ }
  expect(Object.keys(doc).length > 0 && !Array.isArray(doc), `${script} ${args[0]}: stdout is one JSON object (exit ${String(run.status)}): ${run.stdout.slice(0, 200)} ${run.stderr.slice(0, 200)}`).toBe(true);
  return { doc, exit: run.status, stderr: run.stderr };
}

interface Part { readonly part: string; readonly keys: readonly string[]; readonly nested?: { readonly part: string; readonly keys: readonly string[] } }

/** The three comparisons for one op: real vs session-contract, real vs ops-contract, and session-contract vs ops-contract. */
function problems(op: string, parts: readonly Part[]): string[] {
  const output = (sessionContract()[op] as Json).script_output;
  const found: string[] = [];
  for (const { part, keys, nested } of parts) {
    const spec = part === op ? contractKeys(output) : contractKeys((output as Json)[part.slice(op.length + 1)]);
    const extra = EXPECTED_EXTRA[part] ?? [];
    const own = keyProblem(`${part} real vs session-contract`, keys, spec, extra);
    if (own !== null) found.push(own);
    const entry = OPS_ENTRY[part];
    if (entry !== null && entry !== undefined) {
      const ops = opsSpec(entry);
      const vsOps = keyProblem(`${part} real vs ops json-contract`, keys, ops);
      if (vsOps !== null) found.push(vsOps);
      // The session-contract may drop an ops key only through the expected-extra table, and may not list a key the ops file lacks.
      const dropped = ops.required.filter((key) => !spec.required.includes(key) && !spec.optional.includes(key)).sort();
      if (JSON.stringify(dropped) !== JSON.stringify([...extra].sort())) found.push(`${part}: ops json-contract required keys absent from session-contract [${dropped.join(", ")}] differ from the expected-extra table [${extra.join(", ")}]`);
      const unknown = spec.required.filter((key) => !ops.required.includes(key) && !ops.optional.includes(key));
      if (unknown.length > 0) found.push(`${part}: session-contract lists keys the ops json-contract lacks [${unknown.join(", ")}]`);
    }
    if (nested !== undefined) {
      const nestedSpec = contractKeys(`{${/launches: \{([^}]*)\}/.exec(typeof output === "string" ? output : String((output as Json)[part.slice(op.length + 1)]))?.[1]?.replace(/\|null/g, "") ?? ""}}`);
      const problem = keyProblem(`${nested.part} real vs session-contract`, nested.keys, nestedSpec, EXPECTED_EXTRA[nested.part] ?? []);
      if (problem !== null) found.push(problem);
      const opsNested = (opsContract()["launch_gate status"] as Json).launches_keys as string[];
      const vsOps = keyProblem(`${nested.part} real vs ops json-contract launches_keys`, nested.keys, { required: opsNested, optional: [] });
      if (vsOps !== null) found.push(vsOps);
    }
  }
  return found;
}

const keysOf = (doc: Json): string[] => Object.keys(doc);

describe.skipIf(!HAVE_OPS)("session-contract script_output vs the real ops scripts, one row per op", () => {
  it("pick (usage_watch pick)", () => {
    const fx = S.fixture();
    openAll(fx);
    const { doc } = runScript(fx, "usage_watch.py", ["pick", "--kind=author", "--author-vendor=claude", "--name=u2ct", "--json"]);
    expect(problems("pick", [{ part: "pick", keys: keysOf(doc) }])).toEqual([]);
  }, REAL_MS);

  it("admit (session_admit, launch-gate none, no queue)", () => {
    const fx = S.fixture();
    openAll(fx);
    const { doc } = runScript(fx, "session_admit.py", ["--engine=claude", `--label=${S.token}-a`, "--model=sonnet", "--account=seat2", "--launch-gate=none", "--max-wait-s=5", "--json"]);
    expect(problems("admit", [{ part: "admit", keys: keysOf(doc) }])).toEqual([]);
  }, REAL_MS);

  it("launch (detach_job run on the fixture engine)", async () => {
    const fx = S.fixture();
    openAll(fx);
    const brief = join(fx.root, "brief.md");
    const report = join(fx.root, "report.md");
    writeFileSync(brief, `fixture brief ${S.token}\n`);
    const engine = `cat > /dev/null; echo done > '${report}'`;
    const { doc } = runScript(fx, "detach_job.py", [
      "run", `--session=${S.token}-s`, `--label=${S.token}-l`, "--engine=claude", "--model=sonnet", `--brief=${brief}`, `--report=${report}`, "--json",
    ], { DETACH_JOB_ENGINE_OVERRIDE: engine, LAUNCH_GATE_LOAD_MAX: "100000" });
    if (typeof doc.pgid === "number") S.trackGroup(doc.pgid);
    const until = Date.now() + 30_000;
    while (!existsSync(report) && Date.now() < until) await new Promise((r) => setTimeout(r, 200));
    expect(problems("launch", [{ part: "launch", keys: keysOf(doc) }])).toEqual([]);
  }, REAL_MS);

  it("status (usage_watch status + launch_gate --status, top level and launches)", () => {
    const fx = S.fixture();
    openAll(fx);
    const usage = runScript(fx, "usage_watch.py", ["status", "--json", "--no-spend"]).doc;
    const gate = runScript(fx, "launch_gate.py", ["--status", "--json"]).doc;
    expect(problems("status", [
      { part: "status.usage_watch", keys: keysOf(usage) },
      { part: "status.launch_gate", keys: keysOf(gate), nested: { part: "status.launch_gate.launches", keys: keysOf(gate.launches as Json) } },
    ])).toEqual([]);
  }, REAL_MS);

  it("fleet (launch_gate --fleet)", () => {
    const fx = S.fixture();
    const { doc } = runScript(fx, "launch_gate.py", ["--fleet", "--json"]);
    expect(problems("fleet", [{ part: "fleet", keys: keysOf(doc) }])).toEqual([]);
  }, REAL_MS);

  it("hop (session_hop --check= only, under SESSION_HOP_ITERM_FIXTURE)", () => {
    const fx = S.fixture();
    openAll(fx);
    const name = `${S.token}-lane`;
    const tty = "/dev/ttys901";
    const tabs = fx.env.SESSION_HOP_ITERM_FIXTURE!;
    expect(tabs.startsWith(fx.root), "SESSION_HOP_ITERM_FIXTURE under fx.root").toBe(true);
    const tabsBytes = JSON.stringify([{ id: "tab-1", title: name, tty, processing: false, screen: "> " }]);
    writeFileSync(tabs, tabsBytes);
    const file = join(fx.env.USAGE_WATCH_STATE_DIR!, `${fx.token}-tab.json`);
    const now = Date.now() / 1000;
    writeFileSync(file, JSON.stringify({ session_name: name, session_id: `${fx.token}-sid`, tty, config_dir: join(fx.root, "home", ".claude-seat1"), cwd: fx.root, ts: now - 60 }));
    utimesSync(file, now - 60, now - 60);
    const { doc } = runScript(fx, "session_hop.py", [`--check=${name}`, "--json"]);
    expect(readFileSync(tabs, "utf8")).toBe(tabsBytes);
    expect(problems("hop", [{ part: "hop", keys: keysOf(doc) }])).toEqual([]);
  }, REAL_MS);

  it("jobs_list (jobs.py list --json --diagnostics)", () => {
    const fx = S.fixture();
    const { doc } = runScript(fx, "jobs.py", ["list", "--json", "--diagnostics"]);
    expect(problems("jobs_list", [{ part: "jobs_list", keys: keysOf(doc) }])).toEqual([]);
  }, REAL_MS);

  it("jobs_register (jobs.py add, the stored event)", () => {
    const fx = S.fixture();
    const { doc } = runScript(fx, "jobs.py", ["add", `--session=${S.token}-s`, "--kind=agent", `--id=${S.token}-1`, `--report=${join(fx.root, "r.md")}`, "--collect=read it", `--label=${S.token}-l`]);
    expect(problems("jobs_register", [{ part: "jobs_register", keys: keysOf(doc) }])).toEqual([]);
  }, REAL_MS);

  it("policy (session_policy --json)", () => {
    const fx = S.fixture();
    const { doc } = runScript(fx, "session_policy.py", ["--json"]);
    expect(problems("policy", [{ part: "policy", keys: keysOf(doc) }])).toEqual([]);
  }, REAL_MS);
});

describe("the comparison itself", () => {
  it("contract parse: every op with a script_output has a non-empty key set", () => {
    // relaunch_print (seat_relaunch.py --all --json) is the one op not run here: the unit brief forbids running seat_relaunch.py.
    const ops = Object.entries(sessionContract()).filter(([name, op]) => op.script_output !== undefined && name !== "relaunch_print");
    expect(ops.map(([name]) => name).sort()).toEqual(["admit", "fleet", "hop", "jobs_list", "jobs_register", "launch", "pick", "policy", "status"]);
    for (const [name, op] of ops) {
      const output = op.script_output;
      const keys = name === "status"
        ? [...contractKeys((output as Json).usage_watch).required, ...contractKeys((output as Json).launch_gate).required]
        : contractKeys(output).required;
      expect(keys.length, name).toBeGreaterThan(0);
    }
  });

  it("a mutated key (a fake script whose fleet output renames `count`) fails the comparison and names it", () => {
    const fx = S.fixture({ scripts: S.fakeScripts("launch_gate.py", py(`print(json.dumps({"cnt": 0, "max": 16, "jobs": []}))`)) });
    const { doc } = runScript(fx, "launch_gate.py", ["--fleet", "--json"]);
    const found = problems("fleet", [{ part: "fleet", keys: keysOf(doc) }]);
    expect(found.length).toBeGreaterThan(0);
    expect(found.join("\n")).toContain("missing [count]");
    expect(found.join("\n")).toContain("extra [cnt]");
  });

  it("an extra key outside the expected-extra table fails (status.launch_gate gains `cpu`)", () => {
    const extra = keyProblem("x", ["engines", "queue", "bypassed", "cpu"], { required: ["engines", "queue"], optional: [] }, EXPECTED_EXTRA["status.launch_gate"]);
    expect(extra).toContain("extra [cpu]");
  });
});
