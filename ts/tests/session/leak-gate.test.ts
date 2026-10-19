import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { checkContent, gate, listing, mintToken, TOKEN_READ_CAP } from "./leak-gate.js";

/**
 * SESSION-MGMT-1-U1-FU2: the leak gate fails on any difference in a strict dir (review F4's three
 * repros: a new untagged file, a deleted file, an in-place change) and keeps the token filter in
 * the noisy dirs. U1-FU4: the token arm re-reads whole changed files (same-size rewrite, token
 * before the old EOF while growing), fails a removed token path, and fails closed over the read
 * cap. Run on a scratch-only tree, never the real ones.
 */

const TOKEN = "u1lgfixture";
let TREE = "";
let STRICT = "";
let NOISY = "";
let LOOSE = "";

const run = (mutate: () => void, readCap?: number) => {
  const before = listing([STRICT, NOISY]);
  mutate();
  return gate(before, listing([STRICT, NOISY]), { strictDirs: [STRICT], looseDirs: [LOOSE], token: TOKEN, ...(readCap === undefined ? {} : { readCap }) });
};

const BIG_OLD = "x".repeat(100);
const FIXED_MTIME = 1_700_000_000;

/** Every row starts from the same fresh tree. */
beforeEach(() => {
  if (TREE) rmSync(TREE, { recursive: true, force: true });
  TREE = mkdtempSync(join(tmpdir(), "stratum-u1-gate-"));
  STRICT = join(TREE, "strict");
  NOISY = join(TREE, "noisy");
  LOOSE = join(STRICT, "agent_runs");
  mkdirSync(join(STRICT, "sub"), { recursive: true });
  mkdirSync(LOOSE);
  writeFileSync(join(LOOSE, "run.json"), "{}");
  mkdirSync(NOISY, { recursive: true });
  writeFileSync(join(STRICT, "a.txt"), "aaaa");
  writeFileSync(join(STRICT, "sub", "b.txt"), "bbbb");
  writeFileSync(join(NOISY, "live.log"), "line\n");
  writeFileSync(join(NOISY, "big.log"), BIG_OLD);
  writeFileSync(join(NOISY, `${TOKEN}-old.json`), "{}");
  for (const file of [join(STRICT, "a.txt"), join(NOISY, "big.log")]) utimesSync(file, FIXED_MTIME, FIXED_MTIME); // a rewrite is then always a new mtime
});

afterAll(() => { if (TREE) rmSync(TREE, { recursive: true, force: true }); });

interface Row { name: string; mutate: () => void; violations: RegExp[]; other: number; readCap?: number }

const ROWS: Row[] = [
  { name: "no change passes", mutate: () => undefined, violations: [], other: 0 },
  { name: "F4 repro: a new untagged file in a strict dir", mutate: () => writeFileSync(join(STRICT, "new.txt"), "x"), violations: [/^added .*new\.txt$/], other: 0 },
  { name: "F4 repro: a deleted file in a strict dir", mutate: () => rmSync(join(STRICT, "sub", "b.txt")), violations: [/^changed .*sub$/, /^removed .*b\.txt$/], other: 0 }, // removing a file also changes its parent directory
  { name: "F4 repro: an in-place change (same size, new mtime)", mutate: () => utimesSync(join(STRICT, "a.txt"), 1_700_000_500, 1_700_000_500), violations: [/^changed .*a\.txt$/], other: 0 },
  { name: "an in-place change (new size)", mutate: () => writeFileSync(join(STRICT, "a.txt"), "aaaaaaaa"), violations: [/^changed .*a\.txt$/], other: 0 },
  { name: "a new empty directory in a strict dir", mutate: () => mkdirSync(join(STRICT, "emptydir")), violations: [/^added .*emptydir$/], other: 0 },
  { name: "a new symlink in a strict dir", mutate: () => symlinkSync(join(TREE, "nowhere"), join(STRICT, "link")), violations: [/^added .*link$/], other: 0 },
  { name: "a new untagged file in a loose subtree of a strict dir is counted, not failed", mutate: () => writeFileSync(join(LOOSE, "run2.json"), "{}"), violations: [], other: 2 }, // the file and its directory
  { name: "a tagged file in a loose subtree of a strict dir fails", mutate: () => writeFileSync(join(LOOSE, `${TOKEN}.json`), "{}"), violations: [/^token .*u1lgfixture\.json$/], other: 1 },
  { name: "an untagged change in a noisy dir is counted, not failed", mutate: () => writeFileSync(join(NOISY, "live.log"), "line\nmore\n"), violations: [], other: 1 },
  { name: "a noisy-dir file whose name carries the token fails", mutate: () => writeFileSync(join(NOISY, `${TOKEN}-x.json`), "{}"), violations: [/^token .*u1lgfixture-x\.json$/], other: 0 },
  { name: "a noisy-dir append whose new bytes carry the token fails", mutate: () => writeFileSync(join(NOISY, "live.log"), `line\n${TOKEN} appended\n`), violations: [/^token .*live\.log$/], other: 0 },
  // U1-FU4: the token arm reads whole changed files and watches removals
  { name: "FU4 repro: same-size rewrite that puts the token inside an existing file", mutate: () => writeFileSync(join(NOISY, "big.log"), `${TOKEN}${"x".repeat(100 - TOKEN.length)}`), violations: [/^token .*big\.log$/], other: 0 },
  { name: "FU4 repro: token inserted before the old EOF while the file grows", mutate: () => writeFileSync(join(NOISY, "big.log"), `${TOKEN}${BIG_OLD}${BIG_OLD}`), violations: [/^token .*big\.log$/], other: 0 },
  { name: "FU4 repro: deleting a token-named file", mutate: () => rmSync(join(NOISY, `${TOKEN}-old.json`)), violations: [/^removed-token .*u1lgfixture-old\.json$/], other: 0 },
  { name: "a same-size rewrite without the token is counted, not failed", mutate: () => writeFileSync(join(NOISY, "big.log"), "y".repeat(100)), violations: [], other: 1 },
  { name: "deleting an untagged file in a noisy dir is not a failure", mutate: () => rmSync(join(NOISY, "big.log")), violations: [], other: 0 },
  { name: "a new file whose untagged name hides the token in its content fails", mutate: () => writeFileSync(join(NOISY, "fresh.log"), `a ${TOKEN} b`), violations: [/^token .*fresh\.log$/], other: 0 },
  { name: "a new symlink whose target path carries the token fails", mutate: () => symlinkSync(join(TREE, `${TOKEN}-target`), join(NOISY, "ln")), violations: [/^token .*ln$/], other: 0 },
  { name: "a changed file over the read cap fails closed, token or not", mutate: () => writeFileSync(join(NOISY, "big.log"), "z".repeat(101)), violations: [/^over-cap .*big\.log \(101 bytes\)$/], other: 0, readCap: 100 },
  { name: "an unreadable changed file fails closed", mutate: () => { writeFileSync(join(NOISY, "big.log"), "q"); chmodSync(join(NOISY, "big.log"), 0o000); }, violations: [/^unreadable .*big\.log: .*EACCES/], other: 0 },
  { name: "a loose-subtree file with the token in its content fails", mutate: () => writeFileSync(join(LOOSE, "run.json"), `{"s":"${TOKEN}"}`), violations: [/^token .*run\.json$/], other: 0 },
];

describe("leak gate: strict dirs fail on any difference, noisy dirs on the run token", () => {
  for (const row of ROWS) {
    it(row.name, () => {
      const result = run(row.mutate, row.readCap);
      expect(result.violations.length, result.violations.join(" | ")).toBe(row.violations.length);
      row.violations.forEach((pattern, i) => expect(result.violations[i]).toMatch(pattern));
      expect(result.otherChanges).toBe(row.other);
    });
  }
});

describe("leak gate: typed fallbacks", () => {
  it("a changed file that vanished before its content was read is a warning, not a violation", () => {
    const before = listing([NOISY]);
    const ghost = join(NOISY, "ghost.log");
    const after = new Map(before).set(ghost, { kind: "file", size: 3, mtimeMs: 1 });
    const result = gate(before, after, { strictDirs: [STRICT], token: TOKEN });
    expect(result.violations).toEqual([]);
    expect(result.warnings).toEqual([`vanished before its content was read: ${ghost}`]);
    expect(result.otherChanges).toBe(1);
  });

  it("checkContent reports each outcome as its own kind, and the default cap is 128 MiB", () => {
    const file = join(NOISY, "probe.txt");
    writeFileSync(file, `x${TOKEN}`);
    expect(checkContent(file, TOKEN).kind).toBe("hit");
    expect(checkContent(file, "nomatch").kind).toBe("miss");
    expect(checkContent(file, TOKEN, 2)).toEqual({ kind: "over-cap", size: 1 + TOKEN.length });
    expect(checkContent(join(NOISY, "missing.txt"), TOKEN).kind).toBe("vanished");
    expect(TOKEN_READ_CAP).toBe(128 * 1024 * 1024);
  });
});

describe("leak gate: documented removal boundary (SESSION-MGMT-1-LEAKGATE-TS-1)", () => {
  it("a removed file whose CONTENT carries the token but whose path does not passes: contract test_fixture.leak_gate, isolation covers it", () => {
    const plain = join(NOISY, "plain.log");
    writeFileSync(plain, `${TOKEN} in a baseline file`); // U1-FU34 review F1 repro; unreachable in the real suite (token minted before the baseline)
    const before = listing([STRICT, NOISY]);
    rmSync(plain);
    const result = gate(before, listing([STRICT, NOISY]), { strictDirs: [STRICT], looseDirs: [LOOSE], token: TOKEN });
    expect(result.violations).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("mintToken returns distinct prefixed hex tokens", () => {
    const a = mintToken("u1lg");
    const b = mintToken("u1lg");
    expect(a).toMatch(/^u1lg[0-9a-f]{8,}$/);
    expect(b).toMatch(/^u1lg[0-9a-f]{8,}$/);
    expect(a).not.toBe(b);
  });
});
