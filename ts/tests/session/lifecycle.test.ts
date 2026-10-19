import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import type { HopData } from "../../src/session/index.js";
import { backend, HAVE_OPS, openAll, suite } from "./fixture.js";

/**
 * SESSION-MGMT-1-U2-FU1 F2 (plan.md "Tests: golden flow"): one joined lifecycle on ONE fixture, in order:
 * policy, status, launch (account auto; launch always admits with the full gate; fixture engine), jobs list shows the launched job, hop --check on the fixture transport.
 * Real ops scripts throughout; the engine is the DETACH_JOB_ENGINE_OVERRIDE seam and hop runs through the python shim, check only, never live.
 * Leak gate (both arms) and the fixture env: fixture.ts.
 */

const S = suite("u2lc");
const TEST_MS = 300_000;
const REAL_PYTHON = execFileSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => boolean, what: string, ms = 60_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(100);
  }
}

/** hop through the shim: logs argv, then execs the real python (check only; a live argv has no canned answer and exits 97). */
const SHIM = `#!${REAL_PYTHON}
import json, os, sys
with open(os.environ["U2_HOP_ARGV_LOG"], "a") as f:
    f.write(json.dumps(sys.argv[1:]) + "\\n")
args = sys.argv[2:]
head = args[:args.index("--")] if "--" in args else args
if any(a.startswith("--check=") for a in head):
    os.execv(${JSON.stringify(REAL_PYTHON)}, [${JSON.stringify(REAL_PYTHON)}] + sys.argv[1:])
sys.exit(97)
`;

const TTY = "/dev/ttys902";

describe.skipIf(!HAVE_OPS)("U2 lifecycle on one fixture: policy, status, launch (auto), jobs, hop check", () => {
  it("every door answers on the same fixture and the launched job is visible to jobs list", async () => {
    const fx = S.fixture();
    openAll(fx);
    const session = `${S.token}-s`;
    const label = `${S.token}-lc`;
    const brief = join(fx.root, "brief.md");
    const report = join(fx.root, "report.md");
    writeFileSync(brief, `fixture brief ${S.token}\n`);
    const engineCmd = `cat > /dev/null; echo done > '${report}'`;

    // hop transport: the shim, the tab fixture and the tab's own session-state file (as hop.test.ts realFx).
    const shim = join(fx.root, "py-shim");
    writeFileSync(shim, SHIM);
    chmodSync(shim, 0o755);
    const tabsFile = fx.env.SESSION_HOP_ITERM_FIXTURE!;
    const tabsBytes = JSON.stringify([{ id: "tab-1", title: session, tty: TTY, processing: false, screen: "> " }]);
    writeFileSync(tabsFile, tabsBytes);
    expect(tabsFile.startsWith(fx.root + sep), "SESSION_HOP_ITERM_FIXTURE under fx.root").toBe(true);
    const stateFile = join(fx.env.USAGE_WATCH_STATE_DIR!, `${fx.token}-tab.json`);
    const now = Date.now() / 1000;
    writeFileSync(stateFile, JSON.stringify({ session_name: session, session_id: `${S.token}-sid`, tty: TTY, config_dir: join(fx.root, "home", ".claude-seat1"), cwd: fx.root, ts: now - 60 }));
    utimesSync(stateFile, now - 60, now - 60);
    const argvLog = join(fx.root, "hop-argv.log");

    const door = backend(fx, { DETACH_JOB_ENGINE_OVERRIDE: engineCmd, LAUNCH_GATE_LOAD_MAX: "100000" });
    const hopDoor = backend(fx, { STRATUM_SESSION_PYTHON: shim, U2_HOP_ARGV_LOG: argvLog });

    const policy = await door.policy();
    expect(policy.ok, JSON.stringify(policy)).toBe(true);

    const status = await door.status();
    expect(status.ok, JSON.stringify(status)).toBe(true);
    if (!status.ok) return;
    // The account `account: "auto"` must land on: what status recommends, from the fixture readings (never a literal).
    const chosen = (status.data.recommendation?.choice as { id: string } | null)?.id;
    expect(chosen, "status names a recommended seat").toMatch(/^seat[1-4]$/);

    const launched = await door.launch({ session, label, engine: "claude", model: "sonnet", brief, report, account: "auto", maxWaitS: 60 });
    expect(launched.ok, JSON.stringify(launched)).toBe(true);
    if (!launched.ok) return;
    S.trackGroup(launched.data.pgid);
    await waitFor(() => existsSync(report), "the fixture engine's report");
    expect(readFileSync(report, "utf8").trim()).toBe("done");
    expect(launched.data.account).toBe(chosen);

    const jobs = await door.jobsList({ session });
    expect(jobs.ok, JSON.stringify(jobs)).toBe(true);
    if (!jobs.ok) return;
    // the launched label is the row id; row.label is the vendor:model tag
    const mine = jobs.data.rows.filter((row) => row.id === label);
    expect(mine.length, JSON.stringify(jobs.data)).toBe(1);
    expect([mine[0]!.account, Number.isInteger(mine[0]!.pid), mine[0]!.pid]).toEqual([chosen, true, launched.data.pid]);

    const launchesFile = join(fx.env.LAUNCH_GATE_STATE_DIR!, "launches.txt");
    const rows = readFileSync(launchesFile, "utf8").split("\n").filter(Boolean);
    expect(rows.length, rows.join(" | ")).toBe(1);
    expect(rows[0]!.split(/\s+/)[1]).toBe(label);

    const hop = await hopDoor.hopCheck({ name: session });
    expect(hop.ok, JSON.stringify(hop)).toBe(true);
    expect((hop.ok ? hop.data : (null as unknown as HopData)).result).toBe("OK");
    expect(readFileSync(tabsFile, "utf8")).toBe(tabsBytes);
    const logged = readFileSync(argvLog, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[]);
    expect(logged.length).toBe(1);
    expect(logged[0]!.some((arg) => arg === `--check=${session}`)).toBe(true);
  }, TEST_MS);
});
