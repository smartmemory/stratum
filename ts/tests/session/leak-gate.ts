import { closeSync, lstatSync, openSync, readdirSync, readSync } from "node:fs";
import { join, sep } from "node:path";

/**
 * SESSION-MGMT-1-U1 leak gate (contract `test_fixture.leak_gate`), split out so its own
 * behaviour is tested against a scratch tree (leak-gate.test.ts).
 *
 * Two kinds of watched directory:
 *  - STRICT: nothing may be added, removed or changed (path, size, mtime), whoever the writer.
 *    Only trees no live session writes can be strict. Measured 2026-10-19: ~/.stratum is written
 *    only under ts/agent_runs/ (other sessions' stratum_agent_run, 12 files in 24 h, none in the
 *    last hour); that subtree is a LOOSE exception inside the strict dir.
 *  - TOKEN: live sessions and launchd jobs write these all the time (~/.claude/logs,
 *    ~/.claude/session-state, ~/.claude/usage rewritten every 5 min by ai.smartmemory.usage-watch,
 *    the ops status/launch-gate dir: 33 files changed in 20 s). A new or changed file fails the gate when its
 *    path or its new bytes carry this run's token (every session, id, label and name the tests create
 *    carries it); other changes are counted and reported, not failed.
 */

export interface Entry { readonly kind: "file" | "dir"; readonly size: number; readonly mtimeMs: number }
export type Listing = Map<string, Entry>;

/** Every file, symlink and directory under `dirs` (lstat: symlinks are not followed). A missing dir lists as empty. */
export function listing(dirs: readonly string[]): Listing {
  const out: Listing = new Map();
  const walk = (dir: string): void => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      try {
        const st = lstatSync(path);
        out.set(path, { kind: entry.isDirectory() ? "dir" : "file", size: st.size, mtimeMs: st.mtimeMs });
      } catch { continue; /* raced away */ }
      if (entry.isDirectory()) walk(path);
    }
  };
  for (const dir of dirs) walk(dir);
  return out;
}

/** The bytes a file gained since `before` (whole file, capped, when it shrank or is new). */
export function newBytes(path: string, before: Entry | undefined): string {
  const cap = 4 * 1024 * 1024;
  try {
    const fd = openSync(path, "r");
    try {
      const size = lstatSync(path).size;
      const start = before !== undefined && before.kind === "file" && size >= before.size ? before.size : 0;
      const length = Math.min(size - start, cap);
      const buf = Buffer.alloc(Math.max(length, 0));
      if (length > 0) readSync(fd, buf, 0, length, start);
      return buf.toString("latin1");
    } finally { closeSync(fd); }
  } catch { return ""; }
}

const differs = (a: Entry, b: Entry): boolean => a.kind !== b.kind || a.size !== b.size || a.mtimeMs !== b.mtimeMs;
const under = (path: string, dirs: readonly string[]): boolean => dirs.some((dir) => path === dir || path.startsWith(dir + sep));

export interface GateOptions {
  readonly strictDirs: readonly string[];
  /** Subtrees of a strict dir that ambient writers use: token-filtered like the noisy dirs. */
  readonly looseDirs?: readonly string[];
  readonly token: string;
}
export interface GateResult {
  /** Failures: one line each, `added|removed|changed <path>` or `token <path>`. */
  readonly violations: string[];
  /** Changes in the token-filtered dirs that did not carry the token (live sessions). */
  readonly otherChanges: number;
}

export function gate(before: Listing, after: Listing, options: GateOptions): GateResult {
  const violations: string[] = [];
  let otherChanges = 0;
  const loose = options.looseDirs ?? [];
  for (const [path, now] of after) {
    const prior = before.get(path);
    if (prior !== undefined && !differs(prior, now)) continue;
    if (under(path, options.strictDirs) && !under(path, loose)) {
      violations.push(`${prior === undefined ? "added" : "changed"} ${path}`);
    } else if (path.includes(options.token) || (now.kind === "file" && newBytes(path, prior).includes(options.token))) {
      violations.push(`token ${path}`);
    } else {
      otherChanges += 1;
    }
  }
  for (const path of before.keys()) {
    if (!after.has(path) && under(path, options.strictDirs) && !under(path, loose)) violations.push(`removed ${path}`);
  }
  return { violations, otherChanges };
}
