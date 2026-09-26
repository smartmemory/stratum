import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, open, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { resourceLock } from "../guard/lock.js";

const execFileAsync = promisify(execFile);
const roots = new Map<string, Promise<string>>();

/** Bound every git lookup: this runs on the audit/OFF paths too, where a wedged
 *  subprocess must fail fast and land on the retry-next-time branch, never hang. */
const GIT_TIMEOUT_MS = 5_000;

/** Linked worktrees and subdirectories share their main checkout's learn state. */
export function canonicalWorkspace(path: string, timeoutMs: number = GIT_TIMEOUT_MS): Promise<string> {
  const input = resolve(path);
  let root = roots.get(input);
  if (root === undefined) {
    root = (async () => {
      const env = Object.fromEntries(
        Object.entries(process.env).filter(([name]) => !name.startsWith("GIT_")),
      );
      try {
        const gitPath = async (flag: string): Promise<string> => {
          const { stdout } = await execFileAsync("git", [
            "-C", input, "rev-parse", "--path-format=absolute", flag,
          ], { env, timeout: timeoutMs });
          return stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
        };
        let toplevel: string;
        let gitDir: string;
        let commonDir: string;
        try {
          toplevel = await gitPath("--show-toplevel");
          gitDir = await gitPath("--git-dir");
          commonDir = await gitPath("--git-common-dir");
        } catch (error) {
          // --show-toplevel fails in bare repositories, which still cache input.
          try {
            const { stdout } = await execFileAsync("git", [
              "-C", input, "rev-parse", "--is-bare-repository",
            ], { env, timeout: timeoutMs });
            if (stdout.trim() === "true") return input;
          } catch { /* Preserve the original failure for the cache rules below. */ }
          throw error;
        }
        if (!toplevel || !gitDir || !commonDir) throw new Error("Incomplete git paths");
        if (await realpath(gitDir) === await realpath(commonDir)) return toplevel;

        const { stdout } = await execFileAsync("git", [
          "-C", input, "worktree", "list", "--porcelain", "-z",
        ], { env, timeout: timeoutMs });
        const fields = stdout.split("\0");
        const first = fields.findIndex((field) => field.startsWith("worktree "));
        if (first >= 0 && fields[first]!.length > "worktree ".length) {
          const end = fields.indexOf("", first);
          const entry = fields.slice(first, end < 0 ? undefined : end);
          return entry.includes("bare") ? toplevel : fields[first]!.slice("worktree ".length);
        }
        return toplevel;
      } catch (error) {
        const failure = error as { code?: unknown; stderr?: unknown };
        if (typeof failure.code === "number" && failure.code !== 0
          && typeof failure.stderr === "string" && failure.stderr.includes("not a git repository")) {
          return input;
        }
      }
      // Operational failures (including missing git) must be retried next time.
      roots.delete(input);
      return input;
    })();
    roots.set(input, root);
  }
  return root;
}

export async function withWorkspaceLock<T>(root: string, action: () => Promise<T> | T): Promise<T> {
  const canonical = await canonicalWorkspace(root);
  const resource = "learn-workspace-" + createHash("sha256").update(canonical).digest("hex").slice(0, 32);
  return resourceLock(resource, action);
}

/** Caller MUST hold withWorkspaceLock for root, including any read/dedupe step. */
export async function appendJsonlUnderLock(root: string, fileName: string, rows: readonly unknown[]): Promise<void> {
  if (rows.length === 0) return;
  const body = rows.map((row) => JSON.stringify(row)).join("\n") + "\n";
  const dir = join(root, ".stratum", "learn");
  await mkdir(dir, { recursive: true });
  const file = await open(join(dir, fileName), "a+");
  try {
    const { size } = await file.stat();
    if (size > 0) {
      const last = Buffer.alloc(1);
      await file.read(last, 0, 1, size - 1);
      if (last[0] !== 10) await file.writeFile("\n");
    }
    await file.writeFile(body, "utf8");
  } finally {
    await file.close();
  }
}

/**
 * Rewrite each record's `workspaceRoot` to its canonical workspace, in place, before
 * `classify()` keys on the exact string (INLINE-TS-1 §A3). Git lookups run at most 8 at a
 * time: the live store can carry hundreds of distinct temp roots.
 */
export async function canonicalizeRecordRoots(
  records: Array<{ workspaceRoot?: string }>,
  resolveRoot: (path: string) => Promise<string> = canonicalWorkspace,
): Promise<void> {
  const distinct = [...new Set(records.flatMap((record) => record.workspaceRoot === undefined ? [] : [record.workspaceRoot]))];
  const canonical = new Map<string, string>();
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(8, distinct.length) }, async () => {
    while (next < distinct.length) {
      const root = distinct[next++]!;
      canonical.set(root, await resolveRoot(root));
    }
  }));
  for (const record of records) {
    if (record.workspaceRoot !== undefined) record.workspaceRoot = canonical.get(record.workspaceRoot)!;
  }
}
