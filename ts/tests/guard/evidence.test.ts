import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
  EvidenceParseError,
  evaluateEvidence,
  parsePredicateStatement,
  statementIsTrusted,
  statementUsesCommand,
} from "../../src/guard/evidence.js";

const execFileAsync = promisify(execFile);
const roots: string[] = [];

async function tempRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});

describe("trusted evidence parser", () => {
  it("accepts every builtin with supported literal arguments", () => {
    expect(parsePredicateStatement("server_file_exists('proof.txt')")).toEqual({ name: "server_file_exists", args: ["proof.txt"] });
    expect(parsePredicateStatement('git_commit_exists("deadbeef")')).toEqual({ name: "git_commit_exists", args: ["deadbeef"] });
    expect(parsePredicateStatement("command_exit_zero(['true', '--quiet'])")).toEqual({ name: "command_exit_zero", args: [["true", "--quiet"]] });
    expect(parsePredicateStatement("verdict_receipt_clean('digest')")).toEqual({ name: "verdict_receipt_clean", args: ["digest"] });
    expect(statementIsTrusted("server_file_exists('proof.txt')")).toBe(true);
    expect(statementUsesCommand("command_exit_zero(['true'])")).toBe(true);
    expect(statementUsesCommand("server_file_exists('proof.txt')")).toBe(false);
  });

  it("rejects unknown builtins, non-calls, keyword args, and non-literals", () => {
    for (const statement of ["unknown_builtin('x')", "not a call", "server_file_exists(path='x')", "server_file_exists(path)"]) {
      expect(() => parsePredicateStatement(statement)).toThrow(EvidenceParseError);
    }
    expect(statementIsTrusted("unknown_builtin('x')")).toBe(false);
  });

  it("fails closed on non-string literal forms for server_file_exists", () => {
    for (const statement of ["server_file_exists(1)", "server_file_exists(True)", "server_file_exists(('x'))"]) {
      expect(() => parsePredicateStatement(statement)).toThrow(EvidenceParseError);
    }
  });

  it("does not treat arity as a parse error; the evaluator returns false", async () => {
    expect(parsePredicateStatement("server_file_exists('a', 'b')")).toEqual({ name: "server_file_exists", args: ["a", "b"] });
    const root = await tempRoot("stratum-guard-evidence-arity-");
    const result = await evaluateEvidence([{ id: "arity", statement: "server_file_exists('a', 'b')" }], root, []);
    expect(result).toMatchObject({ met: false, perPredicate: [{ id: "arity", met: false, evidence: "server_file_exists expects one string path" }] });
  });
});

describe("server_file_exists", () => {
  it("checks a real regular file and fails closed on traversal and escaping symlinks", async () => {
    const root = await tempRoot("stratum-guard-evidence-files-");
    const outside = await tempRoot("stratum-guard-evidence-outside-");
    await writeFile(join(root, "proof.txt"), "proof", "utf8");
    await writeFile(join(outside, "secret.txt"), "secret", "utf8");
    await symlink(join(outside, "secret.txt"), join(root, "escape.txt"));

    const result = await evaluateEvidence([
      { id: "present", statement: "server_file_exists('proof.txt')" },
      { id: "missing", statement: "server_file_exists('missing.txt')" },
      { id: "traversal", statement: "server_file_exists('../escape')" },
      { id: "absolute", statement: "server_file_exists('/etc/hosts')" },
      { id: "symlink", statement: "server_file_exists('escape.txt')" },
    ], root, []);

    expect(result.met).toBe(false);
    expect(result.perPredicate).toMatchObject([
      { id: "present", met: true, evidence: "proof.txt exists" },
      { id: "missing", met: false, evidence: "missing.txt missing" },
      { id: "traversal", met: false, evidence: expect.stringContaining("path escapes workspace_root") },
      { id: "absolute", met: false, evidence: expect.stringContaining("path escapes workspace_root") },
      { id: "symlink", met: false, evidence: expect.stringContaining("path escapes workspace_root") },
    ]);
  });
});

describe("git_commit_exists", () => {
  it("uses a real repository and treats bad revisions and non-repositories as unmet", async () => {
    const repo = await tempRoot("stratum-guard-evidence-git-");
    const nonGit = await tempRoot("stratum-guard-evidence-nongit-");
    await execFileAsync("git", ["init", "-q", repo]);
    await execFileAsync("git", ["-C", repo, "config", "user.email", "test@example.com"]);
    await execFileAsync("git", ["-C", repo, "config", "user.name", "Test"]);
    await writeFile(join(repo, "README"), "base\n", "utf8");
    await execFileAsync("git", ["-C", repo, "add", "README"]);
    await execFileAsync("git", ["-C", repo, "commit", "-qm", "base"]);
    const sha = (await execFileAsync("git", ["-C", repo, "rev-parse", "HEAD"])).stdout.trim();

    expect(await evaluateEvidence([{ statement: `git_commit_exists('${sha}')` }], repo, [])).toMatchObject({ met: true, perPredicate: [{ met: true }] });
    expect(await evaluateEvidence([{ statement: "git_commit_exists('0000000000000000000000000000000000000000')" }], repo, [])).toMatchObject({ met: false, perPredicate: [{ met: false }] });
    expect(await evaluateEvidence([{ statement: `git_commit_exists('${sha}')` }], nonGit, [])).toMatchObject({ met: false, perPredicate: [{ met: false }] });
  });
});

describe("command_exit_zero", () => {
  it("requires explicit opt-in, observes exit status, and rejects empty commands", async () => {
    const root = await tempRoot("stratum-guard-evidence-command-");
    const previous = process.env.STRATUM_GUARD_ALLOW_COMMANDS;
    try {
      delete process.env.STRATUM_GUARD_ALLOW_COMMANDS;
      expect(await evaluateEvidence([{ statement: "command_exit_zero(['true'])" }], root, [])).toMatchObject({ met: false, perPredicate: [{ evidence: expect.stringContaining("disabled") }] });

      process.env.STRATUM_GUARD_ALLOW_COMMANDS = "1";
      expect(await evaluateEvidence([{ statement: "command_exit_zero(['true'])" }], root, [])).toMatchObject({ met: true, perPredicate: [{ met: true, evidence: "true exited 0" }] });
      expect(await evaluateEvidence([{ statement: "command_exit_zero(['false'])" }], root, [])).toMatchObject({ met: false, perPredicate: [{ met: false, evidence: "false exited 1" }] });
      expect(await evaluateEvidence([{ statement: "command_exit_zero([])" }], root, [])).toMatchObject({ met: false, perPredicate: [{ met: false, evidence: "empty command" }] });
    } finally {
      if (previous === undefined) delete process.env.STRATUM_GUARD_ALLOW_COMMANDS;
      else process.env.STRATUM_GUARD_ALLOW_COMMANDS = previous;
    }
  });

  it.skipIf(!["darwin", "linux"].includes(process.platform))("kills background descendants when a command times out", async () => {
    const root = await tempRoot("stratum-guard-evidence-command-timeout-");
    const previousAllowCommands = process.env.STRATUM_GUARD_ALLOW_COMMANDS;
    const previousTimeout = process.env.STRATUM_GUARD_CMD_TIMEOUT_S;
    let backgroundPid: number | undefined;
    try {
      process.env.STRATUM_GUARD_ALLOW_COMMANDS = "1";
      process.env.STRATUM_GUARD_CMD_TIMEOUT_S = "1";
      const started = Date.now();
      const result = await evaluateEvidence([
        { statement: "command_exit_zero(['/bin/sh', '-c', 'sleep 30 & echo $! > sleep.pid; echo started; wait'])" },
      ], root, []);

      expect(Date.now() - started).toBeLessThan(5_000);
      expect(result).toMatchObject({
        met: false,
        perPredicate: [{
          met: false,
          evidence: "command failed: Command ['/bin/sh', '-c', 'sleep 30 & echo $! > sleep.pid; echo started; wait'] timed out after 1 seconds",
        }],
      });

      const pid = Number((await readFile(join(root, "sleep.pid"), "utf8")).trim());
      backgroundPid = pid;
      expect(Number.isInteger(pid) && pid > 0).toBe(true);
      await expect.poll(() => {
        try {
          process.kill(pid, 0);
          return false;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
          throw error;
        }
      }, { timeout: 2_000, interval: 50 }).toBe(true);
    } finally {
      if (backgroundPid !== undefined) {
        try {
          process.kill(backgroundPid, "SIGKILL");
        } catch {
          // The fixed implementation has already killed the descendant.
        }
      }
      if (previousAllowCommands === undefined) delete process.env.STRATUM_GUARD_ALLOW_COMMANDS;
      else process.env.STRATUM_GUARD_ALLOW_COMMANDS = previousAllowCommands;
      if (previousTimeout === undefined) delete process.env.STRATUM_GUARD_CMD_TIMEOUT_S;
      else process.env.STRATUM_GUARD_CMD_TIMEOUT_S = previousTimeout;
    }
  });
});

describe("verdict_receipt_clean", () => {
  it("finds only applied and review_clean ledger receipts", async () => {
    const ledger = [
      { entry_digest: "applied-digest", outcome: "applied" },
      { entry_digest: "review-digest", outcome: "review_clean" },
      { entry_digest: "rejected-digest", outcome: "refused" },
    ];
    expect(await evaluateEvidence([{ statement: "verdict_receipt_clean('applied-digest')" }], null, ledger)).toMatchObject({ met: true, perPredicate: [{ met: true }] });
    expect(await evaluateEvidence([{ statement: "verdict_receipt_clean('review-digest')" }], null, ledger)).toMatchObject({ met: true, perPredicate: [{ met: true }] });
    expect(await evaluateEvidence([{ statement: "verdict_receipt_clean('rejected-digest')" }], null, ledger)).toMatchObject({ met: false, perPredicate: [{ met: false }] });
  });
});

describe("evaluateEvidence", () => {
  it("ANDs trusted evidence, skips LLM tiers, and preserves receipt evaluation without a workspace", async () => {
    const root = await tempRoot("stratum-guard-evidence-orchestrator-");
    await writeFile(join(root, "proof.txt"), "proof", "utf8");
    const ledger = [{ entry_digest: "clean-digest", outcome: "applied" }];

    const mixed = await evaluateEvidence([
      { id: "file", statement: "server_file_exists('proof.txt')" },
      { id: "judge", type: "verified", statement: "this is routed to the judge" },
      { id: "receipt", statement: "verdict_receipt_clean('clean-digest')" },
    ], root, ledger);
    expect(mixed).toMatchObject({ met: true, perPredicate: [{ id: "file", met: true }, { id: "receipt", met: true }] });
    expect(mixed.perPredicate).toHaveLength(2);

    const noRoot = await evaluateEvidence([
      { id: "file", statement: "server_file_exists('proof.txt')" },
      { id: "git", statement: "git_commit_exists('deadbeef')" },
      { id: "command", statement: "command_exit_zero(['true'])" },
      { id: "receipt", statement: "verdict_receipt_clean('clean-digest')" },
    ], null, ledger);
    expect(noRoot.met).toBe(false);
    expect(noRoot.perPredicate).toMatchObject([
      { id: "file", met: false, evidence: "no workspace_root registered for trusted file/command/git evidence" },
      { id: "git", met: false, evidence: "no workspace_root registered for trusted file/command/git evidence" },
      { id: "command", met: false, evidence: "no workspace_root registered for trusted file/command/git evidence" },
      { id: "receipt", met: true },
    ]);
  });
});
