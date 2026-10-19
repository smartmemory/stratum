import { mkdirSync, mkdtempSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { gate, listing } from "./leak-gate.js";

/**
 * SESSION-MGMT-1-U1-FU2: the leak gate fails on any difference in a strict dir (review F4's three
 * repros: a new untagged file, a deleted file, an in-place change) and keeps the token filter in
 * the noisy dirs. Run on a scratch-only tree, never the real ones.
 */

const TOKEN = "u1lgfixture";
let TREE = "";
let STRICT = "";
let NOISY = "";
let LOOSE = "";

const run = (mutate: () => void) => {
  const before = listing([STRICT, NOISY]);
  mutate();
  return gate(before, listing([STRICT, NOISY]), { strictDirs: [STRICT], looseDirs: [LOOSE], token: TOKEN });
};

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
  utimesSync(join(STRICT, "a.txt"), 1_700_000_000, 1_700_000_000);
});

afterAll(() => { if (TREE) rmSync(TREE, { recursive: true, force: true }); });

interface Row { name: string; mutate: () => void; violations: RegExp[]; other: number }

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
];

describe("leak gate: strict dirs fail on any difference, noisy dirs on the run token", () => {
  for (const row of ROWS) {
    it(row.name, () => {
      const result = run(row.mutate);
      expect(result.violations.length, result.violations.join(" | ")).toBe(row.violations.length);
      row.violations.forEach((pattern, i) => expect(result.violations[i]).toMatch(pattern));
      expect(result.otherChanges).toBe(row.other);
    });
  }
});
