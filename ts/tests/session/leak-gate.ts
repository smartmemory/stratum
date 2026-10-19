import { randomBytes } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readdirSync, readlinkSync, readSync } from "node:fs";
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
 *    carries it); other changes are counted and reported, not failed. A REMOVED entry fails only when its
 *    path carries the token: the content of a removed file is not checked, by design. The token is
 *    minted fresh per run (`mintToken`, at least 32 random bits) before the baseline listing, so no
 *    baseline content can carry it; a test that rewrites a real pre-existing file and then deletes it
 *    is prevented by ISOLATION (the fixture env), not detected here (SESSION-MGMT-1-LEAKGATE-TS-1).
 */

/** A fresh run token: `prefix` plus 8 hex chars (32 random bits). Mint it before the baseline listing. */
export function mintToken(prefix: string): string {
  return `${prefix}${randomBytes(4).toString("hex")}`;
}

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

/** Largest file the token arm reads whole. Measured 2026-10-19: the biggest changing file in the token dirs is 32 MB (~/.claude/logs/dispatch.log). */
export const TOKEN_READ_CAP = 128 * 1024 * 1024;

/**
 * What reading a changed entry's whole content gave. Typed so no outcome is silent:
 *  hit/miss: the token is / is not in the content (a symlink's content is its target string);
 *  over-cap: the file is larger than `cap`, so it cannot be checked (a violation);
 *  unreadable: the read failed for a reason other than the file being gone (a violation);
 *  vanished: the file was gone by read time (live sessions rename temp files; counted and warned, never a violation).
 */
export type ContentCheck =
  | { readonly kind: "hit" | "miss" | "vanished" }
  | { readonly kind: "over-cap"; readonly size: number }
  | { readonly kind: "unreadable"; readonly error: string };

/** Read the WHOLE file at `path` (never only the appended part) and look for `token`. */
export function checkContent(path: string, token: string, cap: number = TOKEN_READ_CAP): ContentCheck {
  try {
    if (lstatSync(path).isSymbolicLink()) return { kind: readlinkSync(path).includes(token) ? "hit" : "miss" };
    const fd = openSync(path, "r");
    try {
      const size = fstatSync(fd).size;
      if (size > cap) return { kind: "over-cap", size };
      const buf = Buffer.alloc(size);
      let got = 0;
      while (got < size) {
        const n = readSync(fd, buf, got, size - got, got);
        if (n === 0) break;
        got += n;
      }
      return { kind: buf.subarray(0, got).includes(token) ? "hit" : "miss" };
    } finally { closeSync(fd); }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "vanished" };
    return { kind: "unreadable", error: String(error) };
  }
}

const differs = (a: Entry, b: Entry): boolean => a.kind !== b.kind || a.size !== b.size || a.mtimeMs !== b.mtimeMs;
const under = (path: string, dirs: readonly string[]): boolean => dirs.some((dir) => path === dir || path.startsWith(dir + sep));

export interface GateOptions {
  readonly strictDirs: readonly string[];
  /** Subtrees of a strict dir that ambient writers use: token-filtered like the noisy dirs. */
  readonly looseDirs?: readonly string[];
  readonly token: string;
  /** Token-arm read cap in bytes; default TOKEN_READ_CAP. */
  readonly readCap?: number;
}
export interface GateResult {
  /** Failures: one line each, `added|removed|changed <path>`, `token <path>`, `removed-token <path>` (path carries the token; a removed file's content is never read), `over-cap <path>` or `unreadable <path>`. */
  readonly violations: string[];
  /** Typed fallbacks that did not fail the gate (a file that vanished before its content was read); the caller logs them. */
  readonly warnings: string[];
  /** Changes in the token-filtered dirs that did not carry the token (live sessions). */
  readonly otherChanges: number;
}

export function gate(before: Listing, after: Listing, options: GateOptions): GateResult {
  const violations: string[] = [];
  const warnings: string[] = [];
  let otherChanges = 0;
  const loose = options.looseDirs ?? [];
  const strict = (path: string): boolean => under(path, options.strictDirs) && !under(path, loose);
  for (const [path, now] of after) {
    const prior = before.get(path);
    if (prior !== undefined && !differs(prior, now)) continue;
    if (strict(path)) {
      violations.push(`${prior === undefined ? "added" : "changed"} ${path}`);
      continue;
    }
    if (path.includes(options.token)) { violations.push(`token ${path}`); continue; }
    if (now.kind === "dir") { otherChanges += 1; continue; }
    const content = checkContent(path, options.token, options.readCap);
    if (content.kind === "hit") violations.push(`token ${path}`);
    else if (content.kind === "over-cap") violations.push(`over-cap ${path} (${content.size} bytes)`);
    else if (content.kind === "unreadable") violations.push(`unreadable ${path}: ${content.error}`);
    else {
      if (content.kind === "vanished") warnings.push(`vanished before its content was read: ${path}`);
      otherChanges += 1;
    }
  }
  for (const path of before.keys()) {
    if (after.has(path)) continue;
    if (strict(path)) violations.push(`removed ${path}`);
    else if (path.includes(options.token)) violations.push(`removed-token ${path}`);
  }
  return { violations, warnings, otherChanges };
}
