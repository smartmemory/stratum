import { existsSync, realpathSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import type { CodexSandboxMode } from "../config/types.js";

/**
 * STRAT-AGENT-DEVIN-1 slice S1b (D3) — the stratum-owned seatbelt profile and
 * the grant check. Devin's own permission modes cannot give codex-equal
 * guarantees, so devin always runs `--permission-mode dangerous` and the OS
 * supplies the boundary — the way codex's own seatbelt bounds codex.
 *
 * The profile grants NOTHING shared: no ~/.cache, ~/.config/devin,
 * ~/.local/share/devin, $TMPDIR or /private/var/folders — the per-run home
 * (D2) redirects all of devin's state into A, which is the only permanent
 * grant. runDir itself is never granted, so meta.json, exit.rc and
 * stream.jsonl stay supervisor-owned.
 */

/** Named platform refusal (D3): the seatbelt profile is macOS-only in v1. */
export function assertDevinPlatform(sandboxMode: CodexSandboxMode, platform: string = process.platform): void {
  if (platform === "win32") {
    throw new Error(`devin is not supported on ${platform} (no POSIX process groups)`);
  }
  if (platform !== "darwin" && sandboxMode !== "danger-full-access") {
    throw new Error(
      `devin sandboxMode ${JSON.stringify(sandboxMode)} requires macOS seatbelt (sandbox-exec); ` +
      "there is no verified Linux profile in v1 — danger-full-access is available " +
      "with STRATUM_DEVIN_ALLOW_FULL_ACCESS=1",
    );
  }
}

/** Seatbelt string escaping: the scheme reader honours backslash escapes, so
 * `"` and `\` are representable; a control character is not — that path is
 * rejected rather than emitted raw (D3). */
function seatbeltPath(path: string): string {
  if (/[\x00-\x1f\x7f]/.test(path)) {
    throw new Error(`devin cannot grant ${JSON.stringify(path)}: the path cannot be represented in a seatbelt profile`);
  }
  return `"${path.replace(/\\/g, "\\\\").replace(/"/g, "\\\"")}"`;
}

/**
 * Canonicalize for BOTH the emitted grant and the overlap check: realpath the
 * nearest existing ancestor (firmlinks like /tmp→/private/tmp, symlinks, `..`)
 * and rejoin the nonexistent tail so a not-yet-created writableRoots entry
 * still resolves honestly.
 */
export function canonicalizeDevinPath(path: string): string {
  let probe = path;
  const tail: string[] = [];
  while (!existsSync(probe)) {
    const parent = dirname(probe);
    if (parent === probe) break;
    tail.unshift(probe.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
    probe = parent;
  }
  const resolved = realpathSync(probe);
  return tail.length === 0 ? resolved : join(resolved, ...tail);
}

/** Case-folded canonical form for the overlap comparison (APFS folds; on a
 *  case-sensitive volume this over-rejects, which is the safe direction). */
function grantKey(path: string): string {
  return canonicalizeDevinPath(path).toLowerCase();
}

function insideOrEqual(path: string, ancestor: string): boolean {
  if (ancestor === sep) return path.startsWith(sep);
  return path === ancestor || path.startsWith(ancestor + sep);
}

/**
 * The grant check (D3, review r3 H1 / r4 N1): every path the profile would
 * grant beyond A — `cwd` under workspace-write plus each writableRoots entry —
 * is rejected when it overlaps the protected root S in EITHER direction
 * (equals S, an ancestor of S, or anywhere inside S), unless it lives inside
 * this run's own A. Both sides are canonicalized identically before the
 * case-folded comparison.
 */
export function assertDevinGrants(
  paths: readonly string[],
  stratumRoot: string,
  agentDir: string,
): void {
  const s = grantKey(stratumRoot);
  const a = grantKey(agentDir);
  for (const path of paths) {
    const p = grantKey(path);
    if (insideOrEqual(p, a)) continue;
    if (p === s || insideOrEqual(p, s) || insideOrEqual(s, p)) {
      throw new Error(`devin cannot grant ${JSON.stringify(path)}: it overlaps stratum's state directory`);
    }
  }
}

/**
 * The seatbelt profile (D3), emitted 0600 into runDir. `writable` carries the
 * already-grant-checked paths beyond A (empty for read-only). /dev/null,
 * /dev/tty*, /dev/fd/* are granted so redirects and interactive-safe tools do
 * not die on device nodes; the signal rule confines kill to same-sandbox
 * processes so the agent cannot signal the wrapper or the stratum server.
 */
export function devinSeatbeltProfile(agentDir: string, writable: readonly string[]): string {
  const grants = [agentDir, ...writable].map((path) => `\t(subpath ${seatbeltPath(canonicalizeDevinPath(path))})`);
  return [
    "(version 1)",
    "(allow default)",
    "(deny file-write*)",
    "(allow file-write*",
    ...grants,
    '\t(literal "/dev/null")',
    '\t(literal "/dev/tty")',
    '\t(regex #"^/dev/ttys[0-9]+$")',
    '\t(regex #"^/dev/fd/"))',
    "(deny signal)",
    "(allow signal (target same-sandbox))",
    "",
  ].join("\n");
}
