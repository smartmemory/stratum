import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GUARDS_DIR, setGuardsDir } from "../../src/guard/store.js";
import { harvest } from "../../src/learn/harvest.js";
import { classify, type Cluster } from "../../src/learn/classify.js";
import {
  CandidateError,
  appendCandidates,
  authorCandidate,
  readCandidates,
  targetPathFor,
} from "../../src/learn/candidate.js";

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(here, "..", "fixtures", "learn", "flows");

const originalGuardsDir = GUARDS_DIR;
const temporaries: string[] = [];
afterEach(async () => {
  setGuardsDir(originalGuardsDir);
  await Promise.all(temporaries.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

async function scratch(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "learn-candidate-"));
  temporaries.push(dir);
  setGuardsDir(join(dir, "guards"));
  return dir;
}

async function durableCluster(): Promise<Cluster> {
  const { records } = await harvest(FIXTURES);
  const durable = classify(records).filter((c) => c.class === "durable");
  expect(durable.length).toBe(1);
  return durable[0]!;
}

describe("authorCandidate", () => {
  it("renders the actual note content, not just an intent", async () => {
    // The behavioral critic has nothing to inspect and apply has no `after` bytes
    // unless the candidate carries the real text.
    const candidate = authorCandidate(await durableCluster());
    expect(candidate.rendered.content.length).toBeGreaterThan(0);
    expect(candidate.rendered.content).toContain("outcome");
    expect(candidate.rendered.content).toContain("build");
    for (const value of ["success", "revised", "done", "pass", "approved"]) {
      expect(candidate.rendered.content).toContain(value);
    }
    expect(candidate.rendered.templateId).toBeTruthy();
    expect(candidate.rendered.templateVersion).toBeTruthy();
  });

  it("carries evidence, breadth, and attribution", async () => {
    const candidate = authorCandidate(await durableCluster());
    expect(candidate.evidence.length).toBeGreaterThan(0);
    expect(candidate.recurrence).toEqual({ records: 14, distinctRuns: 2, distinctPairs: 6 });
    expect(candidate.scope.workspaceRoot).toContain("/forge/stratum");
    expect(candidate.targetKind).toBe("memory");
  });

  it("routes a contract lesson to human action, because specs are immutable", async () => {
    // v1 will never write a spec. Surfacing is the deliverable; fixing is not.
    const candidate = authorCandidate(await durableCluster());
    expect(candidate.requiresHumanAction).toBe(true);
  });

  it("keeps cluster identity stable while content identity tracks the bytes", async () => {
    const cluster = await durableCluster();
    const a = authorCandidate(cluster);
    const b = authorCandidate(cluster);
    expect(b.clusterId).toBe(a.clusterId);
    expect(b.revisionId).toBe(a.revisionId);

    // More evidence for the same lesson: same cluster, new immutable revision.
    const grown = authorCandidate({
      ...cluster,
      recurrence: { ...cluster.recurrence, records: cluster.recurrence.records + 1 },
    });
    expect(grown.clusterId).toBe(a.clusterId);
    expect(grown.revisionId).not.toBe(a.revisionId);
  });

  it("refuses a cluster with no evidence", async () => {
    const cluster = await durableCluster();
    expect(() => authorCandidate({ ...cluster, evidence: [] })).toThrow(CandidateError);
  });

  it("refuses a cluster that is not apply-eligible", async () => {
    const cluster = await durableCluster();
    expect(() => authorCandidate({ ...cluster, unattributed: true })).toThrow(CandidateError);
    expect(() => authorCandidate({ ...cluster, mixedProvenance: true })).toThrow(CandidateError);
  });

  it("refuses a cluster that did not qualify as durable", async () => {
    const cluster = await durableCluster();
    expect(() => authorCandidate({ ...cluster, class: "step-local" })).toThrow(CandidateError);
  });
});

describe("targetPathFor", () => {
  it("resolves inside the project's own stratum directory", () => {
    expect(targetPathFor("/project")).toBe(join("/project", ".stratum", "learn", "NOTES.md"));
  });

  it("refuses to escape the workspace root", () => {
    expect(() => targetPathFor("/project/../etc")).toThrow(CandidateError);
  });
});

describe("sidecar", () => {
  it("appends, is idempotent on revision id, and never rewrites history", async () => {
    const dir = await scratch();
    const candidate = authorCandidate(await durableCluster());

    expect(await appendCandidates(dir, [candidate])).toBe(1);
    expect(await appendCandidates(dir, [candidate])).toBe(0);

    const rows = await readCandidates(join(dir, ".stratum", "learn"));
    expect(rows.length).toBe(1);
    expect(rows[0]!.revisionId).toBe(candidate.revisionId);
    expect(rows[0]!.schemaVersion).toBe("learn-1.0");
  });

  it("keeps both revisions of one cluster, newest resolvable", async () => {
    const dir = await scratch();
    const cluster = await durableCluster();
    const first = authorCandidate(cluster);
    const second = authorCandidate({
      ...cluster,
      recurrence: { ...cluster.recurrence, records: 99 },
    });

    await appendCandidates(dir, [first]);
    await appendCandidates(dir, [second]);

    const rows = await readCandidates(join(dir, ".stratum", "learn"));
    expect(rows.length).toBe(2);
    expect(new Set(rows.map((r) => r.clusterId)).size).toBe(1);
  });

  it("writes its own file and touches no pre-existing corpus", async () => {
    const dir = await scratch();
    await appendCandidates(dir, [authorCandidate(await durableCluster())]);
    const raw = await readFile(join(dir, ".stratum", "learn", "candidates.jsonl"), "utf8");
    expect(raw.trimEnd().split("\n").length).toBe(1);
    expect(JSON.parse(raw.trimEnd()).schemaVersion).toBe("learn-1.0");
  });

  it("returns an empty list when no sidecar exists yet", async () => {
    expect(await readCandidates(await scratch())).toEqual([]);
  });
});


describe("template v2 guidance", () => {
  it("renders exact enum guidance and places it after impact in the note", async () => {
    const cluster = await durableCluster();
    const candidate = authorCandidate(cluster);
    const guidance = "When `outcome` has a non-null value, it must be exactly one of: `complete`, `failed`, `skipped`.";
    expect(candidate.rendered.guidance).toBe(guidance);
    expect(candidate.rendered.templateVersion).toBe("2");
    expect(candidate.clusterKey).toBe(cluster.key);
    expect(candidate.shape).toBe(cluster.shape);
    expect(candidate.contract).toEqual(cluster.contract);
    expect(candidate.rendered.content).toMatch(/  \*\*Why it matters:\*\*[^\n]+\n  \*\*Agent guidance:\*\*/);
    expect(candidate.rendered.content).toContain(`  **Agent guidance:** ${guidance}`);
    expect(candidate.rendered.content.indexOf(guidance)).toBeLessThan(candidate.rendered.content.indexOf("<!-- learn:"));
  });

  it("renders exact guidance from a real Zod type issue", async () => {
    const { records } = await harvest(FIXTURES);
    const cluster = classify(records, { minRuns: 1, minPairs: 1 })
      .find((c) => c.contract.code === "invalid_type" && c.class === "durable" && c.applyEligible)!;
    expect(cluster.contract).toEqual({ code: "invalid_type", path: "commit_hash", expected: ["string"], leafArrayDepth: 0 });
    expect(authorCandidate(cluster).rendered.guidance)
      .toBe("When `commit_hash` has a non-null value, it must be a `string`.");
  });

  it("keeps guidance identical when evidence, observed values and counts change", async () => {
    const cluster = await durableCluster();
    const first = authorCandidate(cluster);
    const grown = authorCandidate({ ...cluster,
      evidence: [...cluster.evidence, { ...cluster.evidence[0]!, runId: "new-run", recovered: false }],
      observedValues: ["a different rejected value"],
      recurrence: { records: cluster.recurrence.records + 1, distinctRuns: 3, distinctPairs: 7 },
    });
    expect(grown.rendered.guidance).toBe(first.rendered.guidance);
    expect(grown.clusterId).toBe(first.clusterId);
    expect(grown.revisionId).not.toBe(first.revisionId);
  });

  it("omits guidance for unsupported shapes, codes and incomplete contracts", async () => {
    const cluster = await durableCluster();
    const variants: Cluster[] = [
      ...(["ensure", "gate", "other", "budget"] as const).map((shape) => ({ ...cluster, shape })),
      ...[
        { code: "unrecognized_keys", path: "outcome", expected: ["extra"] },
        { code: "invalid_value", path: "outcome", expected: ["complete"] },
        { code: "invalid_enum_value", path: "", expected: ["complete"] },
        { code: "invalid_enum_value", path: "outcome", expected: [] },
        { code: "invalid_type", path: "", expected: ["string"] },
        { code: "invalid_type", path: "outcome", expected: [] },
        { code: "invalid_type", path: "outcome", expected: ["number", "string"] },
      ].map((contract) => ({ ...cluster, contract })),
    ];
    for (const variant of variants) {
      const candidate = authorCandidate(variant);
      expect(candidate.rendered).not.toHaveProperty("guidance");
      expect(candidate.rendered.content).not.toContain("**Agent guidance:**");
    }
  });
});
