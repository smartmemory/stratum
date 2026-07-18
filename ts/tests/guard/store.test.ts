import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson } from "../../src/guard/canonical.js";
import { LedgerCorrupt, ResourceIdMismatch } from "../../src/guard/errors.js";
import {
  GUARDS_DIR,
  GuardRegistry,
  LedgerEntry,
  appendLedger,
  computeEntryDigest,
  currentStateFromLedger,
  findByIdempotencyKey,
  loadRegistry,
  loadRegistryRaw,
  persistRegistry,
  readLedger,
  resourceDir,
  resourceHash,
  setGuardsDir,
  verifyChain,
} from "../../src/guard/store.js";

const originalGuardsDir = GUARDS_DIR;
const roots: string[] = [];

const PYTHON_LEDGER = String.raw`{"entry_digest":"a84c5f214e260ea3a924b4cf7ff6f2f7791727de0163a87c2e11ef138f740362","from_state":"draft","idempotency_key":"req-1","kind":"transition","outcome":"applied","payload_digest":null,"prev_digest":"","rationale":"caf\u00e9 \ud83d\ude00","resolved_by":"agent","to_state":"review","ts_ms":1735689600123,"verdict":{"budget_consumed":{"dollars":0.0,"wall_clock_s":0.0},"ok":true}}
{"entry_digest":"c07627cc4672841435e4ec8bf43bc676669c105bd8a5dd4e464b995bad343c9c","from_state":"review","idempotency_key":"req-2","kind":"deviation","outcome":"deviation","payload_digest":null,"prev_digest":"a84c5f214e260ea3a924b4cf7ff6f2f7791727de0163a87c2e11ef138f740362","rationale":null,"resolved_by":"human","to_state":"done","ts_ms":1735689600456,"verdict":{"approved":true,"budget_consumed":{"dollars":1.0,"wall_clock_s":2.0}}}` + "\n";

async function tempGuardsRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "stratum-guard-store-"));
  roots.push(root);
  setGuardsDir(root);
  return root;
}

function entry(fields: Partial<ConstructorParameters<typeof LedgerEntry>[0]> = {}): LedgerEntry {
  return new LedgerEntry({
    ts_ms: 1735689600123,
    from_state: "draft",
    to_state: "review",
    outcome: "applied",
    kind: "transition",
    ...fields,
  });
}

function tamperEntryDigest(line: string): string {
  return line.replace(
    /^(\{"entry_digest":")([0-9a-f])/,
    (_match, prefix: string, firstDigit: string) => `${prefix}${firstDigit === "0" ? "1" : "0"}`,
  );
}

afterEach(async () => {
  setGuardsDir(originalGuardsDir);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});

describe("guard store Python byte parity", () => {
  it("matches the real Python compute_entry_digest golden exactly", () => {
    const core = {
      ts_ms: 1735689600123,
      from_state: "draft",
      to_state: "review",
      outcome: "applied",
      kind: "transition",
      resolved_by: "agent",
      idempotency_key: "req-δ",
      payload_digest: null,
      rationale: "café 😀",
      verdict: { met: true, score: 7 },
      prev_digest: "prevhex",
    };

    expect(computeEntryDigest(core, "prevhex")).toBe(
      "6b21a05321202cc47bfb794ad232eaefe09421584181e2c653a4bf7b5c3e87b3",
    );
  });

  it("reads and verifies Python ledger bytes whose verdict contains floats", async () => {
    await tempGuardsRoot();
    const path = join(resourceDir("project:δ"), "ledger.jsonl");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, PYTHON_LEDGER, "utf8");

    const entries = readLedger("project:δ");
    expect(entries).toHaveLength(2);
    expect(verifyChain(PYTHON_LEDGER)).toBe(true);
    expect(verifyChain(PYTHON_LEDGER.trimEnd().split("\n"))).toBe(true);
    expect(entries[0]?.rationale).toBe("café 😀");
    expect(entries[0]?.verdict).toEqual({ budget_consumed: { dollars: 0, wall_clock_s: 0 }, ok: true });
    expect(currentStateFromLedger(entries, "draft")).toBe("done");
  });

  // The live "TS writes → Python read_ledger/verify_chain accepts" test was
  // retired with the python tree on merge day (STRAT-PY-RETIRE). Byte parity
  // stays pinned by the captured PYTHON_LEDGER golden and the
  // compute_entry_digest golden above; the python side is archived on the
  // python-legacy branch.
});

describe("guard store paths and registry", () => {
  it("hashes UTF-8 resource ids and rejects unsafe ids", async () => {
    const root = await tempGuardsRoot();
    expect(resourceHash("project:δ")).toBe("5fea8fdb812a07ff567431a7cc56a280");
    expect(resourceDir("project:δ")).toBe(join(root, "5fea8fdb812a07ff567431a7cc56a280"));
    for (const invalid of ["", ".", "..", "nul\0id"]) {
      expect(() => resourceDir(invalid)).toThrow();
    }
  });

  it("persists sorted JSON, ignores unknown fields, and refreshes current_state from the ledger", async () => {
    await tempGuardsRoot();
    const registry = new GuardRegistry({
      resource_id: "registry-1",
      graph: { review: ["done"], draft: ["review"] },
      edge_predicates: {},
      initial: "draft",
      terminal: ["done"],
      checksum: "checksum",
      current_state: "stale-cache",
    });
    persistRegistry(registry);
    const path = join(resourceDir("registry-1"), "registry.json");
    const stored = await readFile(path, "utf8");
    expect(stored.indexOf('"checksum"')).toBeLessThan(stored.indexOf('"current_state"'));
    expect(stored.indexOf('"current_state"')).toBeLessThan(stored.indexOf('"edge_predicates"'));

    const payload = JSON.parse(stored) as Record<string, unknown>;
    payload.future_field = { accepted: true };
    await writeFile(path, JSON.stringify(payload), "utf8");
    appendLedger("registry-1", entry({ to_state: "review" }));

    expect(loadRegistryRaw("registry-1")?.toDict()).not.toHaveProperty("future_field");
    expect(loadRegistry("registry-1")?.current_state).toBe("review");
  });

  it("raises ResourceIdMismatch when the hashed directory stores another raw id", async () => {
    await tempGuardsRoot();
    const path = join(resourceDir("requested"), "registry.json");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify({
      resource_id: "stored",
      graph: {},
      edge_predicates: {},
      initial: "draft",
    }), "utf8");

    expect(() => loadRegistryRaw("requested")).toThrow(ResourceIdMismatch);
  });
});

describe("guard ledger recovery and lookup", () => {
  it("drops an unparseable torn final line and recovers the prior entry", async () => {
    await tempGuardsRoot();
    appendLedger("torn", entry({ idempotency_key: "durable" }));
    appendLedger("torn", entry({ ts_ms: 1735689600456, from_state: "review", to_state: "done" }));
    const path = join(resourceDir("torn"), "ledger.jsonl");
    const [first] = (await readFile(path, "utf8")).trimEnd().split("\n");
    await writeFile(path, `${first}\n{"entry_digest":\n`, "utf8");

    const recovered = readLedger("torn");
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.idempotency_key).toBe("durable");
    expect(verifyChain(first!)).toBe(true);
  });

  it("raises LedgerCorrupt for an unparseable interior line", async () => {
    await tempGuardsRoot();
    appendLedger("tampered", entry({ idempotency_key: "one" }));
    appendLedger("tampered", entry({ ts_ms: 2, idempotency_key: "two" }));
    appendLedger("tampered", entry({ ts_ms: 3, idempotency_key: "three" }));
    const path = join(resourceDir("tampered"), "ledger.jsonl");
    const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
    lines[1] = "not-json";
    await writeFile(path, `${lines.join("\n")}\n`, "utf8");

    expect(() => readLedger("tampered")).toThrow(LedgerCorrupt);
  });

  it("recovers from final digest tampering but rejects the same tampering in an interior entry", async () => {
    await tempGuardsRoot();
    appendLedger("digest-tail", entry({ ts_ms: 1, idempotency_key: "one" }));
    appendLedger("digest-tail", entry({ ts_ms: 2, idempotency_key: "two" }));
    const tailPath = join(resourceDir("digest-tail"), "ledger.jsonl");
    const tailLines = (await readFile(tailPath, "utf8")).trimEnd().split("\n");
    tailLines[1] = tamperEntryDigest(tailLines[1]!);
    await writeFile(tailPath, `${tailLines.join("\n")}\n`, "utf8");

    const recovered = readLedger("digest-tail");
    expect(recovered).toHaveLength(1);
    expect(recovered[0]?.idempotency_key).toBe("one");
    expect(verifyChain(tailPath)).toBe(false);

    appendLedger("digest-interior", entry({ ts_ms: 1, idempotency_key: "one" }));
    appendLedger("digest-interior", entry({ ts_ms: 2, idempotency_key: "two" }));
    appendLedger("digest-interior", entry({ ts_ms: 3, idempotency_key: "three" }));
    const interiorPath = join(resourceDir("digest-interior"), "ledger.jsonl");
    const interiorLines = (await readFile(interiorPath, "utf8")).trimEnd().split("\n");
    interiorLines[1] = tamperEntryDigest(interiorLines[1]!);
    await writeFile(interiorPath, `${interiorLines.join("\n")}\n`, "utf8");

    expect(() => readLedger("digest-interior")).toThrow(LedgerCorrupt);
    expect(verifyChain(interiorPath)).toBe(false);
  });

  it("loads valid entries separated by bare carriage returns", async () => {
    await tempGuardsRoot();
    const path = join(resourceDir("bare-cr"), "ledger.jsonl");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, PYTHON_LEDGER.trimEnd().replace("\n", "\r"), "utf8");

    expect(readLedger("bare-cr")).toHaveLength(2);
    expect(verifyChain(path)).toBe(true);
  });

  it("writes lines whose textual digest excision equals the canonical core", async () => {
    await tempGuardsRoot();
    appendLedger("self-consistent", entry({
      verdict: { approved: true, budget_consumed: { dollars: 0, wall_clock_s: 0 } },
    }));
    const path = join(resourceDir("self-consistent"), "ledger.jsonl");
    const line = (await readFile(path, "utf8")).trimEnd();
    const fullEntry = JSON.parse(line) as Record<string, unknown>;
    delete fullEntry.entry_digest;

    expect(line.replace(/^\{"entry_digest":"[0-9a-f]{64}",/, "{")).toBe(canonicalJson(fullEntry));
    expect(readLedger("self-consistent")).toHaveLength(1);
    expect(verifyChain(path)).toBe(true);
  });

  it("reverse-scans idempotency keys and returns the newest matching entry", async () => {
    await tempGuardsRoot();
    appendLedger("idem", entry({ ts_ms: 1, idempotency_key: "same", to_state: "review" }));
    appendLedger("idem", entry({ ts_ms: 2, idempotency_key: "other", to_state: "blocked" }));
    appendLedger("idem", entry({ ts_ms: 3, idempotency_key: "same", to_state: "done" }));

    expect(findByIdempotencyKey("idem", "same")?.ts_ms).toBe(3);
    expect(findByIdempotencyKey("idem", "missing")).toBeNull();
    expect(findByIdempotencyKey("idem", null)).toBeNull();
  });
});
