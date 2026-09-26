import { spawn } from "node:child_process";
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

  it("SIGTERM to the group (stratum cancel): the trap still removes the credentials copy", async () => {
    const { layout, env, stub } = scaffold(temporaryRoot());
    stub("devin", "sleep 30");
    const child = spawn("sh", [layout.wrapperPath, "devin", "-p"], {
      env, stdio: ["ignore", "ignore", "ignore"], detached: true,
    });
    // Wait for the copy to exist, then SIGTERM the wrapper's group.
    const deadline = Date.now() + 5_000;
    while (!existsSync(layout.credentialsCopyPath)) {
      if (Date.now() > deadline) throw new Error("wrapper never copied credentials");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    process.kill(-child.pid!, "SIGTERM");
    await new Promise<void>((resolve) => child.once("close", () => resolve()));
    expect(existsSync(layout.credentialsCopyPath)).toBe(false);
    // On this sh the TERM trap fires and the script continues: devin's rc is
    // still written — an exit.rc is present on every handled exit (verified:
    // group SIGTERM yields 143). A wrapper that dies on SIGKILL is the only
    // exit without one, and that is the sweep's case (D2).
    expect(readFileSync(layout.exitRcPath, "utf8").trim()).toBe("143");
    expect(readFileSync(layout.streamPath, "utf8")).toBe('{"__t2f5_done__":143}\n');
  });

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
