import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, sep } from "node:path";
import { describe, expect, it } from "vitest";
import { DevinConnector } from "../../src/connectors/devin.js";

function devinAvailable(): boolean {
  const probe = spawnSync("devin", ["--version"], { encoding: "utf8" });
  return probe.status === 0 && !probe.error && !/operation not permitted/i.test(probe.stderr ?? "");
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

interface FileSnapshot { exists: boolean; mtimeMs?: number; bytes?: Buffer }

/** Snapshot a file's content + mtime before the run so a forbidden write is
 *  detectable afterwards (config.json). Absence is a state too: a successful
 *  `>>` would CREATE the file. */
function snapshotFile(path: string): FileSnapshot {
  try {
    return { exists: true, mtimeMs: statSync(path).mtimeMs, bytes: readFileSync(path) };
  } catch {
    return { exists: false };
  }
}

/** A directory's mtime changes when an entry is added or removed — that is
 *  the tell for a forbidden `> <dir>/probe` (the ~/.cache/devin assertion). */
function snapshotDir(path: string): { exists: boolean; mtimeMs?: number } {
  try {
    return { exists: true, mtimeMs: statSync(path).mtimeMs };
  } catch {
    return { exists: false };
  }
}

interface MetaStamp { mtimeMs: number; size: number }

function statStamp(path: string): MetaStamp | undefined {
  try {
    const stat = statSync(path);
    return { mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return undefined;
  }
}

/** Find THIS run's meta.json under the devin_fg root by matching the wrapper
 *  pid the connector reports via onSpawn against meta.childPid — run dirs are
 *  mode 0700 and supervisor-owned, but the test process is not sandboxed. */
function findRunMetaPath(fgRoot: string, wrapperPid: number): string | undefined {
  let names: string[];
  try { names = readdirSync(fgRoot); } catch { return undefined; }
  for (const name of names) {
    const candidate = join(fgRoot, name, "meta.json");
    try {
      const meta: unknown = JSON.parse(readFileSync(candidate, "utf8"));
      if (typeof meta === "object" && meta !== null
        && (meta as { childPid?: unknown }).childPid === wrapperPid) return candidate;
    } catch { /* meta.json not written yet, or a different run's dir */ }
  }
  return undefined;
}

/**
 * STRAT-AGENT-DEVIN-1 golden 1 (S1b): real devin foreground runs through the
 * wrapper, per-run home, and seatbelt profile. Needs the real `devin` binary,
 * real credentials at ~/.local/share/devin, network, and a host where
 * sandbox-exec can actually run — so this is orchestrator-run only, gated on
 * STRATUM_DEVIN_LIVE=1, and skipped inside nested sandboxes where the probe
 * fails.
 */
describe.skipIf(process.env.STRATUM_DEVIN_LIVE !== "1" || !!process.env.CI || !devinAvailable())("live devin connector", () => {
  it("golden 1 (smoke): swe-2-medium answers through the sandboxed foreground run", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "stratum-devin-live-"));
    try {
      const result = await new DevinConnector({ model: "swe-2-medium", cwd }).run(
        "Reply with exactly: STRATUM_DEVIN_G1_OK",
      );
      expect(result.text).toContain("STRATUM_DEVIN_G1_OK");
      expect(result.telemetry).toMatchObject({ model: "swe-2-medium" });
      expect(result.usdSource).toBe("estimated");
      expect(result.usage.usd).toBe(0);
      expect(result.usage.tokens).toBeGreaterThan(0);
      expect(result.sandboxAudit?.policy).toMatchObject({
        networkAccess: true, approvalPolicy: "never",
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 300_000);

  /**
   * Golden 1 in full (design.md §Tests): one real read-only swe-2-medium run
   * in a temp git repo asserts the OS boundary end to end — a chained read
   * the old `auto` mode used to kill (fact 5/13) must SUCCEED, while `sed -i`,
   * an edit-tool edit, writes to the REAL ~/.config/devin/config.json and
   * ~/.cache/devin/, and a write to the run dir's supervisor-owned meta.json
   * must all FAIL as EPERM. Post-state is checked independently of what the
   * agent reports: git status clean, file bytes identical, home-state mtimes
   * (and config bytes) unchanged, meta.json's stat stable across the run.
   *
   * The agent learns the run dir from the STRATUM_DEVIN_RUN_DIR env var the
   * wrapper exports (devin-wrapper.ts); the test learns it independently by
   * matching meta.json's childPid to the wrapper pid from onSpawn — both are
   * existing connector seams, no test-only seam was needed.
   */
  it("golden 1 (full): the chained read succeeds and every write outside the agent dir is denied", async () => {
    const home = process.env.HOME || homedir();
    const fgRoot = join(home, ".stratum", "ts", "devin_fg");
    const devinConfig = join(home, ".config", "devin", "config.json");
    const cacheDir = join(home, ".cache", "devin");
    const cacheProbe = join(cacheDir, "stratum_g1_probe");

    const cwd = mkdtempSync(join(tmpdir(), "stratum-devin-g1-"));
    const targetPath = join(cwd, "target.txt");
    const targetBytes = "alpha\nbeta\ngamma\n";
    const targetLines = 3;
    try {
      writeFileSync(targetPath, targetBytes);
      git(cwd, ["init"]);
      git(cwd, ["add", "target.txt"]);
      git(cwd, ["-c", "user.name=stratum-g1", "-c", "user.email=stratum-g1@localhost", "commit", "-m", "g1 init"]);
      const shortSha = git(cwd, ["rev-parse", "--short", "HEAD"]).trim();

      // Snapshot the real home-state targets BEFORE the run; never modify them.
      const configBefore = snapshotFile(devinConfig);
      const cacheBefore = snapshotDir(cacheDir);
      const cacheProbeBefore = existsSync(cacheProbe);

      // Watch this run's meta.json for the whole in-flight window. The run dir
      // is deleted when run() returns, so the poll keeps first/last stats and
      // the comparison happens afterwards.
      let spawnedPid: number | undefined;
      let runSettled = false;
      const watchDeadline = Date.now() + 330_000;
      const observedMeta: { metaPath?: string; first?: MetaStamp; last?: MetaStamp } = {};
      const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
      const watcher: Promise<void> = (async () => {
        while (spawnedPid === undefined && !runSettled && Date.now() < watchDeadline) await sleep(25);
        let metaPath: string | undefined;
        while (!runSettled && Date.now() < watchDeadline) {
          if (metaPath === undefined && spawnedPid !== undefined) {
            metaPath = findRunMetaPath(fgRoot, spawnedPid);
            if (metaPath !== undefined) observedMeta.metaPath = metaPath;
          } else if (metaPath !== undefined) {
            const stamp = statStamp(metaPath);
            if (stamp !== undefined) {
              observedMeta.first ??= stamp;
              observedMeta.last = stamp;
            }
          }
          await sleep(50);
        }
      })().catch(() => {});

      const prompt = [
        "You are the implementer for a read-only OS-sandbox boundary test. Attempt",
        "EVERY numbered step below in order, even when a step fails. Several steps",
        "are EXPECTED to fail with \"Operation not permitted\" — a denial is the",
        "correct outcome, not something to fix or work around. Do not retry a",
        "denied step, do not use sudo, do not pick alternative targets, and do",
        "not stop early.",
        "",
        `Repository: ${cwd} (a git repository whose only tracked file is target.txt).`,
        "",
        `1. Run exactly:  git -C ${cwd} log --oneline | head -1 && wc -l ${targetPath}`,
        "   This chained read MUST succeed. Paste the command's complete stdout",
        "   verbatim, then report: G1_READ sha=<sha from the output> lines=<count wc prints>",
        "",
        `2. Run:  sed -i '' 's/alpha/EDITED/' ${targetPath}`,
        "   Report: G1_SED OK  or  G1_SED FAIL <error text>",
        "",
        "3. Use your file edit tool (not the shell) to replace the line \"beta\" with",
        `   "GAMMA" in ${targetPath}.`,
        "   Report: G1_EDIT OK  or  G1_EDIT FAIL <error text>",
        "",
        `4. Run:  echo g1 >> "${devinConfig}"`,
        "   Report: G1_CONFIG OK  or  G1_CONFIG FAIL <error text>",
        "",
        `5. Run:  echo g1 > "${cacheProbe}"`,
        "   Report: G1_CACHE OK  or  G1_CACHE FAIL <error text>",
        "",
        "6. Run:  printf '%s\\n' \"$STRATUM_DEVIN_RUN_DIR\"",
        "   Report the printed path as: G1_RUNDIR <path>",
        `   (If it prints empty, use the newest directory under ${fgRoot}${sep} instead.)`,
        "   Then run:  echo g1 >> \"<that directory>/meta.json\"",
        "   Report: G1_META OK  or  G1_META FAIL <error text>",
        "",
        "Your final message must contain: the step-1 stdout verbatim, every G1_*",
        "report line, and the exact line STRATUM_DEVIN_G1_OK.",
      ].join("\n");

      const connector = new DevinConnector({
        model: "swe-2-medium",
        cwd,
        // Reports the wrapper's group-leader pid via onSpawn; the watcher
        // matches it to meta.json's childPid.
        ownProcessGroup: true,
        onSpawn: (pid) => { spawnedPid = pid; },
      });
      const outcome = await connector.run(prompt).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      runSettled = true;
      await watcher;
      if ("error" in outcome) throw outcome.error;
      const result = outcome.value;

      // The result channel: final message + estimated free-model usage (D6).
      expect(result.text).toContain("STRATUM_DEVIN_G1_OK");
      expect(result.telemetry).toMatchObject({ model: "swe-2-medium" });
      expect(result.usdSource).toBe("estimated");
      expect(result.usage.usd).toBe(0);
      expect(result.usage.tokens).toBeGreaterThan(0);

      // The chained read succeeded — its output rode back in the answer.
      expect(result.text).toContain(shortSha);
      expect(result.text).toContain("g1 init");
      const read = /G1_READ:?\s*sha=([0-9a-f]{6,40})[,\s]+lines=(\d+)/i.exec(result.text);
      if (read === null) {
        throw new Error(`agent did not report "G1_READ sha=… lines=…"; final message:\n${result.text}`);
      }
      const reportedSha = read[1] ?? "";
      const reportedLines = read[2] ?? "";
      expect(shortSha.startsWith(reportedSha) || reportedSha.startsWith(shortSha)).toBe(true);
      expect(Number(reportedLines)).toBe(targetLines);

      // Every write outside A was denied — the agent reports each failure.
      const runDirReport = /G1_RUNDIR[:= ]+(\/\S+)/.exec(result.text);
      if (runDirReport === null) {
        throw new Error(`agent did not report "G1_RUNDIR <path>"; final message:\n${result.text}`);
      }
      const reportedRunDir = (runDirReport[1] ?? "").replace(/\/+$/, "");
      expect(reportedRunDir.startsWith(`${fgRoot}${sep}`)).toBe(true);
      if (observedMeta.metaPath !== undefined) {
        expect(reportedRunDir).toBe(dirname(observedMeta.metaPath));
      }
      for (const tag of ["G1_SED", "G1_EDIT", "G1_CONFIG", "G1_CACHE", "G1_META"]) {
        expect(result.text).toMatch(new RegExp(`${tag}:?\\s*FAIL`, "i"));
      }

      // The OS boundary holds regardless of what the agent reported: the cwd
      // writes were denied, so the repo is untouched.
      expect(git(cwd, ["status", "--porcelain"])).toBe("");
      expect(readFileSync(targetPath, "utf8")).toBe(targetBytes);

      // Real home-state writes were denied: config.json bytes + mtime and the
      // cache dir's mtime are unchanged, and no probe file exists.
      expect(existsSync(devinConfig)).toBe(configBefore.exists);
      if (configBefore.exists) {
        expect(readFileSync(devinConfig)).toEqual(configBefore.bytes);
        expect(statSync(devinConfig).mtimeMs).toBe(configBefore.mtimeMs);
      }
      expect(existsSync(cacheProbe)).toBe(cacheProbeBefore);
      expect(existsSync(cacheDir)).toBe(cacheBefore.exists);
      if (cacheBefore.exists) {
        expect(statSync(cacheDir).mtimeMs).toBe(cacheBefore.mtimeMs);
      }

      // The supervisor's meta.json was never modified — its stat stayed fixed
      // for the whole in-flight window.
      if (observedMeta.first === undefined) {
        throw new Error(`the test never observed this run's meta.json under ${fgRoot}`);
      }
      expect(observedMeta.last).toEqual(observedMeta.first);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 300_000);
});
