import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  assertDevinGrants,
  assertDevinPlatform,
  canonicalizeDevinPath,
  devinSeatbeltProfile,
} from "../../src/connectors/devin-sandbox.js";

/**
 * STRAT-AGENT-DEVIN-1 slice S1b (D3) — profile text, seatbelt escaping,
 * canonicalization, the both-directions grant check, and the platform gate.
 * Pure functions: no sandbox-exec, no spawn.
 */

const roots: string[] = [];

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "stratum-devin-sb-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("devinSeatbeltProfile (D3)", () => {
  it("emits the exact rule set with only A and granted paths writable", () => {
    const root = temporaryRoot();
    const a = join(root, "run", "agent");
    const cwd = join(root, "work");
    mkdirSync(a, { recursive: true });
    mkdirSync(cwd, { recursive: true });
    const profile = devinSeatbeltProfile(a, [cwd]);
    expect(profile).toContain("(version 1)");
    expect(profile).toContain("(allow default)");
    expect(profile).toContain("(deny file-write*)");
    expect(profile).toContain(`(subpath ${JSON.stringify(canonicalizeDevinPath(a))})`);
    expect(profile).toContain(`(subpath ${JSON.stringify(canonicalizeDevinPath(cwd))})`);
    expect(profile).toContain('(literal "/dev/null")');
    expect(profile).toContain('(literal "/dev/tty")');
    expect(profile).toContain('(regex #"^/dev/ttys[0-9]+$")');
    expect(profile).toContain('(regex #"^/dev/fd/")');
    expect(profile).toContain("(deny signal)");
    expect(profile).toContain("(allow signal (target same-sandbox))");
    // The r2 H1/L8 invariant: no shared devin state or temp root is granted.
    for (const forbidden of [".cache", ".local/share/devin", ".config/devin", '(subpath "/private/var/folders")', "TMPDIR"]) {
      expect(profile).not.toContain(forbidden);
    }
    // Exactly A and cwd are writable subpaths (the test's own temp root may sit under /private/var/folders).
    expect(profile.match(/\(subpath /g)).toHaveLength(2);
    // runDir itself is never granted — supervisor files stay supervisor-owned.
    expect(profile).not.toContain(JSON.stringify(canonicalizeDevinPath(join(root, "run"))));
  });

  it("grants only A for read-only", () => {
    const root = temporaryRoot();
    const a = join(root, "a");
    mkdirSync(a, { recursive: true });
    const profile = devinSeatbeltProfile(a, []);
    expect(profile.match(/\(subpath /g)).toHaveLength(1);
  });

  it("seatbelt-escapes quotes and backslashes, and rejects unrepresentable paths", () => {
    const root = temporaryRoot();
    const quoted = join(root, 'a"b');
    mkdirSync(quoted, { recursive: true });
    expect(devinSeatbeltProfile(quoted, [])).toContain('a\\"b');
    expect(() => devinSeatbeltProfile(join(root, "a\nb"), []))
      .toThrow(/cannot be represented in a seatbelt profile/);
  });

  it("resolves a not-yet-existing path through its real parent (firmlinks, symlinks)", () => {
    const root = temporaryRoot();
    const real = join(root, "real");
    const link = join(root, "link");
    mkdirSync(real, { recursive: true });
    symlinkSync(real, link);
    // The tail under the symlink resolves to the real path.
    expect(canonicalizeDevinPath(join(link, "later", "dir")))
      .toBe(join(canonicalizeDevinPath(real), "later", "dir"));
  });
});

describe("assertDevinGrants (D3, both-directions overlap)", () => {
  it("accepts grants outside S and inside A", () => {
    const root = temporaryRoot();
    const s = join(root, "home", ".stratum");
    const a = join(s, "ts", "devin_fg", "run1", "agent");
    const outside = join(root, "work");
    mkdirSync(a, { recursive: true });
    mkdirSync(outside, { recursive: true });
    expect(() => assertDevinGrants([outside], s, a)).not.toThrow();
    expect(() => assertDevinGrants([join(a, "x")], s, a)).not.toThrow();
  });

  it.each([
    "equals S",
    "inside S",
    "ancestor of S",
    "filesystem root",
  ])("rejects a grant that %s", (kind) => {
    const root = temporaryRoot();
    const s = join(root, "home", ".stratum");
    const a = join(s, "ts", "devin_fg", "run1", "agent");
    mkdirSync(a, { recursive: true });
    const grant = kind === "equals S" ? s
      : kind === "inside S" ? join(s, "ts", "agent_runs")
      : kind === "ancestor of S" ? join(root, "home")
      : "/";
    expect(() => assertDevinGrants([grant], s, a))
      .toThrow(/devin cannot grant .*overlaps stratum's state directory/);
  });

  it("rejects a grant reaching S through a symlink and through case-folding", () => {
    const root = temporaryRoot();
    const s = join(root, "home", ".stratum");
    const a = join(s, "ts", "devin_fg", "run1", "agent");
    mkdirSync(a, { recursive: true });
    const link = join(root, "link-to-stratum");
    symlinkSync(s, link);
    expect(() => assertDevinGrants([link], s, a)).toThrow(/devin cannot grant/);
    expect(() => assertDevinGrants([s.toUpperCase()], s, a)).toThrow(/devin cannot grant/);
  });
});

describe("assertDevinPlatform (D3)", () => {
  it("allows every mode on macOS", () => {
    for (const mode of ["read-only", "workspace-write", "danger-full-access"] as const) {
      expect(() => assertDevinPlatform(mode, "darwin")).not.toThrow();
    }
  });

  it("refuses sandboxed modes off macOS, names the missing seatbelt", () => {
    for (const mode of ["read-only", "workspace-write"] as const) {
      expect(() => assertDevinPlatform(mode, "linux")).toThrow(/requires macOS seatbelt \(sandbox-exec\)/);
      expect(() => assertDevinPlatform(mode, "freebsd")).toThrow(/requires macOS seatbelt/);
    }
  });

  it("permits danger-full-access off macOS (the opt-in lives in the connector)", () => {
    expect(() => assertDevinPlatform("danger-full-access", "linux")).not.toThrow();
  });

  it("refuses win32 entirely (no POSIX process groups)", () => {
    expect(() => assertDevinPlatform("danger-full-access", "win32")).toThrow(/not supported on win32/);
  });
});
