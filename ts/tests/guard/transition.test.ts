import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CommandExecutionDisabled,
  EvidenceParseError,
  GuardAlreadyRegistered,
  GuardEngineOwned,
  GuardTampered,
  IdempotencyConflict,
  IllegalEdge,
  IncompatiblePolicyUpgrade,
  InvalidStateName,
  InvalidWorkspaceRoot,
  OverrideUnavailable,
  ParanoidEdgeNeedsTrustedEvidence,
  StaleFromState,
} from "../../src/guard/errors.js";
import { guardChecksum } from "../../src/guard/fingerprint.js";
import {
  guardHistory,
  guardMigrate,
  guardOverride,
  guardTransition,
  guardUpgrade,
  registerGuard,
  setGuardLockingForTests,
  type GuardJudge,
} from "../../src/guard/transition.js";
import {
  GUARDS_DIR,
  GuardRegistry,
  LedgerEntry,
  ResourceLockManager,
  appendLedger,
  loadRegistry,
  persistRegistry,
  resourceDir,
  setGuardsDir,
} from "../../src/guard/store.js";

const originalGuardsDir = GUARDS_DIR;
const originalOverrideToken = process.env.STRATUM_GUARD_OVERRIDE_TOKEN;
const originalAllowCommands = process.env.STRATUM_GUARD_ALLOW_COMMANDS;
const roots: string[] = [];
let guardsRoot: string;
let workspace: string;
let resetLocking: (() => void) | undefined;

async function temporaryDirectory(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

beforeEach(async () => {
  guardsRoot = await temporaryDirectory("stratum-guard-transition-");
  workspace = await temporaryDirectory("stratum-guard-workspace-");
  setGuardsDir(guardsRoot);
  const locks = new ResourceLockManager({
    processIdentity: async (pid) => ({ alive: true, startTime: `test-${pid}` }),
  });
  resetLocking = setGuardLockingForTests(
    (resourceId, action, options) => locks.resourceLock(resourceId, action, options),
    (resourceId, token) => locks.assertStillHeld(resourceId, token),
  );
  delete process.env.STRATUM_GUARD_OVERRIDE_TOKEN;
  delete process.env.STRATUM_GUARD_ALLOW_COMMANDS;
});

afterEach(async () => {
  resetLocking?.();
  resetLocking = undefined;
  setGuardsDir(originalGuardsDir);
  if (originalOverrideToken === undefined) delete process.env.STRATUM_GUARD_OVERRIDE_TOKEN;
  else process.env.STRATUM_GUARD_OVERRIDE_TOKEN = originalOverrideToken;
  if (originalAllowCommands === undefined) delete process.env.STRATUM_GUARD_ALLOW_COMMANDS;
  else process.env.STRATUM_GUARD_ALLOW_COMMANDS = originalAllowCommands;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});

async function registerSimple(resourceId = "r") {
  return registerGuard(
    resourceId,
    { draft: ["shipped"], shipped: [] },
    { "draft->shipped": [{ id: "p1", type: "deterministic", statement: "server_file_exists('design.md')" }] },
    "draft",
    ["shipped"],
    {},
    workspace,
  );
}

function seedUnmarkedGuard(resourceId: string): void {
  const graph = { a: ["b"], b: [] };
  const edgePredicates = {};
  persistRegistry(new GuardRegistry({
    resource_id: resourceId,
    graph,
    edge_predicates: edgePredicates,
    initial: "a",
    terminal: ["b"],
    stakes: {},
    checksum: guardChecksum(graph, edgePredicates, ["b"], {}),
    graph_version: 1,
    workspace_root: null,
    current_state: "a",
  }));
  appendLedger(resourceId, new LedgerEntry({
    ts_ms: 1,
    from_state: "a",
    to_state: "a",
    outcome: "graph_version",
    kind: "graph_version",
    resolved_by: "human",
    rationale: "Python-created fixture",
  }));
}

function expectCanonicalSafeNumbers(value: unknown): void {
  if (typeof value === "number") {
    expect(Number.isSafeInteger(value)).toBe(true);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) expectCanonicalSafeNumbers(item);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) expectCanonicalSafeNumbers(item);
  }
}

function metJudge(): GuardJudge {
  return async (predicate) => ({
    holds: true,
    reason: `met: ${predicate.statement}`,
    stakes: predicate.stakes ?? "default",
    model: "stub/high",
    usage: { tokens: 7, usd: 0.01 },
  });
}

describe("guardChecksum", () => {
  it("matches a real Python guard_checksum golden and preserves list significance", () => {
    const graph = { draft: ["review", "done"], review: ["done"], done: [] };
    const predicates = {
      "draft->review": [
        { id: "p1", type: "deterministic", statement: "server_file_exists('café.txt')" },
        { id: "p2", type: "verified", statement: "review is complete" },
      ],
      "review->done": [],
    };
    const checksum = guardChecksum(graph, predicates, ["done", "review"], {
      "draft->review": "paranoid",
      "review->done": "cheap",
    });

    expect(checksum).toBe("ed561645bb10c77a488a62f7976cefcfb714f2bd7610ff116d9b75d4669df9e8");
    expect(guardChecksum(graph, predicates, ["review", "done"], {
      "review->done": "cheap",
      "draft->review": "paranoid",
    })).toBe(checksum);
    expect(guardChecksum({ ...graph, draft: ["done", "review"] }, predicates, ["done", "review"], {
      "draft->review": "paranoid",
      "review->done": "cheap",
    })).not.toBe(checksum);
  });
});

describe("guard transition orchestration", () => {
  it("refuses every mutation on an un-handed-over guard while allowing reads", async () => {
    process.env.STRATUM_GUARD_OVERRIDE_TOKEN = "secret";
    for (const resourceId of ["python-transition", "python-override", "python-migrate", "python-upgrade", "python-register"]) {
      seedUnmarkedGuard(resourceId);
    }

    expect(loadRegistry("python-transition")).toMatchObject({ resource_id: "python-transition", current_state: "a" });
    expect(guardHistory("python-transition")).toMatchObject({ resource_id: "python-transition", current_state: "a" });
    await expect(guardTransition("python-transition", "a", "b")).rejects.toBeInstanceOf(GuardEngineOwned);
    await expect(guardOverride("python-override", "a", "b", "secret", "manual move"))
      .rejects.toBeInstanceOf(GuardEngineOwned);
    await expect(guardMigrate("python-migrate", { a: ["b"], b: [] }, {}, "secret", "same graph", ["b"]))
      .rejects.toBeInstanceOf(GuardEngineOwned);
    await expect(guardUpgrade("python-upgrade", { a: ["b"], b: [] }, {}, "same graph", ["b"]))
      .rejects.toBeInstanceOf(GuardEngineOwned);
    await expect(registerGuard("python-register", { a: ["b"], b: [] }, {}, "a", ["b"]))
      .rejects.toBeInstanceOf(GuardEngineOwned);
  });

  it("marks a fresh registration as TS-owned and permits subsequent mutation", async () => {
    await registerGuard("fresh-ts", { a: ["b"], b: [] }, {}, "a", ["b"]);
    const marker = JSON.parse(await readFile(join(resourceDir("fresh-ts"), "engine.json"), "utf8"));
    expect(marker).toMatchObject({ owner: "ts", since: expect.any(String) });

    await expect(guardTransition("fresh-ts", "a", "b"))
      .resolves.toMatchObject({ status: "applied", current_state: "b" });
  });

  it("registers, treats an identical policy as existing, and rejects a changed checksum", async () => {
    const registered = await registerSimple();
    expect(registered).toMatchObject({ guard_id: "r", status: "registered" });
    expect(registered.checksum).toMatch(/^[0-9a-f]{64}$/);
    await expect(registerSimple()).resolves.toMatchObject({ status: "exists", checksum: registered.checksum });
    await expect(registerGuard("r", { draft: ["shipped"], shipped: [] }, {}, "draft", ["shipped"], {}, workspace))
      .rejects.toBeInstanceOf(GuardAlreadyRegistered);
  });

  it("applies deterministic evidence, advances state, returns a ledger ref, and exposes history", async () => {
    await writeFile(join(workspace, "design.md"), "design", "utf8");
    await registerSimple();

    const result = await guardTransition("r", "draft", "shipped");
    expect(result).toMatchObject({ status: "applied", current_state: "shipped", verdict: { clean: true, met: true } });
    expect(result.ledger_ref).toMatch(/^[0-9a-f]{64}$/);
    expect(guardHistory("r")).toMatchObject({ resource_id: "r", current_state: "shipped", graph_version: 1 });
    expect(guardHistory("r").ledger).toMatchObject([{ outcome: "applied", to_state: "shipped" }]);
  });

  it("records a refusal with the true target and leaves state unchanged", async () => {
    await registerSimple();
    const result = await guardTransition("r", "draft", "shipped");
    expect(result).toMatchObject({ status: "refused", current_state: "draft", verdict: { clean: false, met: false } });
    expect(guardHistory("r").ledger).toMatchObject([{ outcome: "refused", to_state: "shipped" }]);
  });

  it("rejects stale sources and illegal graph edges", async () => {
    await registerSimple();
    await expect(guardTransition("r", "shipped", "draft")).rejects.toBeInstanceOf(StaleFromState);
    await expect(guardTransition("r", "draft", "draft")).rejects.toBeInstanceOf(IllegalEdge);
  });

  it("detects a policy mutated without recomputing its checksum", async () => {
    await registerSimple();
    const path = join(resourceDir("r"), "registry.json");
    const registry = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    registry.edge_predicates = { "draft->shipped": [] };
    await writeFile(path, JSON.stringify(registry), "utf8");
    await expect(guardTransition("r", "draft", "shipped")).rejects.toBeInstanceOf(GuardTampered);
  });

  it("replays the original verdict and ledger ref, but conflicts on a changed payload", async () => {
    await writeFile(join(workspace, "design.md"), "design", "utf8");
    await registerSimple();
    const first = await guardTransition("r", "draft", "shipped", { idempotencyKey: "k" });
    const replay = await guardTransition("r", "draft", "shipped", { idempotencyKey: "k" });
    expect(replay).toEqual({ status: "replayed", verdict: first.verdict, ledger_ref: first.ledger_ref, current_state: "shipped" });
    await expect(guardTransition("r", "draft", "shipped", { idempotencyKey: "k", artifacts: { x: "different" } }))
      .rejects.toBeInstanceOf(IdempotencyConflict);
    expect(guardHistory("r").ledger).toHaveLength(1);
  });

  it("routes LLM predicates at edge stakes and ANDs their verdict with deterministic evidence", async () => {
    await writeFile(join(workspace, "design.md"), "design", "utf8");
    await registerGuard("r", { a: ["b"], b: [] }, {
      "a->b": [
        { id: "e", type: "deterministic", statement: "server_file_exists('design.md')" },
        { id: "j", type: "verified", statement: "the design is complete" },
      ],
    }, "a", ["b"], { "a->b": "cheap" }, workspace);
    const seen: string[] = [];
    const result = await guardTransition("r", "a", "b", {
      artifacts: { design: "present" },
      judge: async (predicate, context) => {
        seen.push(`${predicate.stakes}:${String((context.result as Record<string, unknown>).artifacts !== undefined)}`);
        return metJudge()(predicate, context);
      },
    });
    expect(result).toMatchObject({ status: "applied", verdict: { met: true, predicates: [{ type: "deterministic" }, { type: "verified" }] } });
    expect(seen).toEqual(["cheap:true"]);
  });

  it("refuses an LLM predicate when no verifier is available", async () => {
    await registerGuard("r", { a: ["b"], b: [] }, {
      "a->b": [{ id: "j", type: "judged", statement: "the release is sound" }],
    }, "a", ["b"]);
    const result = await guardTransition("r", "a", "b", { judge: null });
    expect(result).toMatchObject({ status: "refused", current_state: "a", verdict: { clean: false, summary: expect.stringContaining("no verifier available") } });
  });

  it("re-checks current state after evaluation outside the lock", async () => {
    process.env.STRATUM_GUARD_OVERRIDE_TOKEN = "secret";
    await registerGuard("r", { a: ["b", "c"], b: [], c: [] }, {
      "a->b": [{ id: "j", type: "judged", statement: "slow check" }],
    }, "a", ["b", "c"]);
    let releaseJudge!: () => void;
    let judgeStarted!: () => void;
    const started = new Promise<void>((resolve) => { judgeStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseJudge = resolve; });
    const transitioning = guardTransition("r", "a", "b", {
      judge: async (predicate, context) => {
        judgeStarted();
        await release;
        return metJudge()(predicate, context);
      },
    });
    await started;
    await expect(guardOverride("r", "a", "c", "secret", "concurrent human move")).resolves.toMatchObject({ status: "deviation" });
    releaseJudge();
    await expect(transitioning).rejects.toBeInstanceOf(StaleFromState);
    expect(guardHistory("r")).toMatchObject({ current_state: "c", ledger: [{ outcome: "deviation" }] });
  });

  it("refuses at commit when a concurrent migration removes the evaluated edge", async () => {
    process.env.STRATUM_GUARD_OVERRIDE_TOKEN = "secret";
    await registerGuard("r", { a: ["b", "c"], b: [], c: [] }, {
      "a->b": [{ id: "j", type: "judged", statement: "slow check" }],
    }, "a", ["b", "c"]);
    let releaseJudge!: () => void;
    let judgeStarted!: () => void;
    const started = new Promise<void>((resolve) => { judgeStarted = resolve; });
    const release = new Promise<void>((resolve) => { releaseJudge = resolve; });
    const transitioning = guardTransition("r", "a", "b", {
      judge: async (predicate, context) => {
        judgeStarted();
        await release;
        return metJudge()(predicate, context);
      },
    });
    await started;
    await guardMigrate("r", { a: ["c"], b: [], c: [] }, {}, "secret", "remove a->b", ["b", "c"]);
    releaseJudge();

    await expect(transitioning).rejects.toBeInstanceOf(IllegalEdge);
    const current = loadRegistry("r");
    expect(current).toMatchObject({ current_state: "a", graph: { a: ["c"], b: [], c: [] } });
    expect(Object.hasOwn(current!.graph, current!.current_state)).toBe(true);
  });

  it("normalizes fractional judge telemetry before storing and replaying a MET verdict", async () => {
    await registerGuard("r", { a: ["b"], b: [] }, {
      "a->b": [{ id: "j", type: "judged", statement: "fractional telemetry" }],
    }, "a", ["b"]);
    const first = await guardTransition("r", "a", "b", {
      idempotencyKey: "fractional",
      judge: async (predicate) => ({
        holds: true,
        reason: "met",
        stakes: predicate.stakes ?? "default",
        model: "stub/high",
        usage: { tokens: 0.5, usd: 0.01 },
      }),
    });

    expect(first).toMatchObject({ status: "applied", verdict: { meta: { judge_results: [{ usage: { tokens: 1 } }] } } });
    expectCanonicalSafeNumbers(first.verdict);
    const replay = await guardTransition("r", "a", "b", { idempotencyKey: "fractional" });
    expect(replay).toEqual({ status: "replayed", verdict: first.verdict, ledger_ref: first.ledger_ref, current_state: "b" });
    expectCanonicalSafeNumbers(replay.verdict);
  });
});

describe("override and migrate", () => {
  it("applies a human token-gated deviation while still enforcing graph legality", async () => {
    process.env.STRATUM_GUARD_OVERRIDE_TOKEN = "secret";
    await registerSimple();
    await expect(guardOverride("r", "draft", "shipped", "secret", "manual ship"))
      .resolves.toMatchObject({ status: "deviation", current_state: "shipped", rationale: "manual ship" });
    expect(guardHistory("r").ledger.at(-1)).toMatchObject({ kind: "deviation", rationale: "manual ship" });

    await registerSimple("r2");
    await expect(guardOverride("r2", "draft", "draft", "secret", "manual"))
      .rejects.toBeInstanceOf(IllegalEdge);
  });

  it.each([
    ["non-human", () => guardOverride("r", "draft", "shipped", "secret", "why", "agent")],
    ["missing rationale", () => guardOverride("r", "draft", "shipped", "secret", "  ")],
    ["bad token", () => guardOverride("r", "draft", "shipped", "bad", "why")],
  ])("rejects override when %s", async (_label, action) => {
    process.env.STRATUM_GUARD_OVERRIDE_TOKEN = "secret";
    await registerSimple();
    await expect(action()).rejects.toBeInstanceOf(OverrideUnavailable);
  });

  it("migrates a full valid policy and bumps graph_version", async () => {
    process.env.STRATUM_GUARD_OVERRIDE_TOKEN = "secret";
    await registerSimple();
    const result = await guardMigrate(
      "r",
      { draft: ["review", "shipped"], review: ["shipped"], shipped: [] },
      { "draft->shipped": [{ id: "p1", statement: "server_file_exists('design.md')" }] },
      "secret",
      "add review",
      ["shipped"],
    );
    expect(result).toMatchObject({ status: "migrated", graph_version: 2, rationale: "add review" });
    expect(guardHistory("r")).toMatchObject({ graph_version: 2, ledger: [{ outcome: "graph_version" }] });
  });

  it("re-validates the entire migrated policy", async () => {
    process.env.STRATUM_GUARD_OVERRIDE_TOKEN = "secret";
    await registerSimple();
    await expect(guardMigrate(
      "r",
      { draft: ["shipped"], shipped: [] },
      { "draft->shipped": [{ type: "bogus", statement: "anything" }] },
      "secret",
      "invalid weakening",
      ["shipped"],
    )).rejects.toBeInstanceOf(EvidenceParseError);
    expect(guardHistory("r")).toMatchObject({ graph_version: 1, ledger: [] });
  });

  it("refuses a migration that strands the current state", async () => {
    process.env.STRATUM_GUARD_OVERRIDE_TOKEN = "secret";
    await writeFile(join(workspace, "design.md"), "design", "utf8");
    await registerGuard("r", { a: ["b"], b: ["c"], c: [] }, {
      "a->b": [{ statement: "server_file_exists('design.md')" }],
    }, "a", ["c"], {}, workspace);
    await guardTransition("r", "a", "b");
    await expect(guardMigrate("r", { a: ["c"], c: [] }, {}, "secret", "remove b", ["c"]))
      .rejects.toBeInstanceOf(InvalidStateName);
    expect(guardHistory("r")).toMatchObject({ graph_version: 1, current_state: "b" });
  });
});

// STRAT-GUARD-UPGRADE. Every test here runs with STRATUM_GUARD_OVERRIDE_TOKEN
// deleted (beforeEach), so the whole block is also the assertion that the
// routine path is token-free.
const SIMPLE_PREDICATES = { "draft->shipped": [{ id: "p1", type: "deterministic", statement: "server_file_exists('design.md')" }] };
// A graft: one new non-terminal state reached by one new edge. `terminal` is
// unchanged, because guardUpgrade may never grant a new way to be complete.
const GRAFT_GRAPH = { draft: ["shipped", "audited"], shipped: [], audited: [] };
const GRAFT_PREDICATES = {
  ...SIMPLE_PREDICATES,
  "draft->audited": [{ id: "b1", type: "deterministic", statement: "git_commit_exists('HEAD')" }],
};
const GRAFT_TERMINAL = ["shipped"];

describe("guard upgrade (routine, token-free)", () => {
  it("no-ops on an identical policy without touching the ledger or the version", async () => {
    const registered = await registerSimple();
    const result = await guardUpgrade("r", { draft: ["shipped"], shipped: [] }, SIMPLE_PREDICATES, "lazy re-apply", ["shipped"]);
    expect(result).toEqual({ status: "unchanged", checksum: registered.checksum, graph_version: 1, rationale: "lazy re-apply" });
    expect(guardHistory("r")).toMatchObject({ graph_version: 1, ledger: [], current_state: "draft" });
  });

  it("applies an additive upgrade once and is idempotent on re-application", async () => {
    await registerSimple();
    const first = await guardUpgrade("r", GRAFT_GRAPH, GRAFT_PREDICATES, "graft audited", GRAFT_TERMINAL, {
      "draft->audited": "paranoid",
    });
    expect(first).toMatchObject({ status: "migrated", graph_version: 2, rationale: "graft audited" });
    expect(guardHistory("r")).toMatchObject({
      graph_version: 2,
      current_state: "draft",
      // Same ledger kind guardMigrate writes; resolved_by is what separates a
      // routine upgrade from a token-held emergency migration.
      ledger: [{ kind: "graph_version", outcome: "graph_version", resolved_by: "agent", rationale: "graft audited" }],
    });

    const second = await guardUpgrade("r", GRAFT_GRAPH, GRAFT_PREDICATES, "graft audited", GRAFT_TERMINAL, {
      "draft->audited": "paranoid",
    });
    expect(second).toMatchObject({ status: "unchanged", graph_version: 2 });
    expect(guardHistory("r").ledger).toHaveLength(1);
  });

  it("makes the new edge immediately transitionable", async () => {
    await registerSimple();
    await guardUpgrade("r", GRAFT_GRAPH, { ...SIMPLE_PREDICATES, "draft->audited": [] }, "graft audited", GRAFT_TERMINAL);
    await expect(guardTransition("r", "draft", "audited"))
      .resolves.toMatchObject({ status: "applied", current_state: "audited" });
  });

  it.each([
    ["an edge is removed", { draft: [], shipped: [] }, SIMPLE_PREDICATES, ["shipped"], {}],
    ["a node is removed", { draft: ["shipped"] }, SIMPLE_PREDICATES, ["shipped"], {}],
    ["an existing edge's predicates are edited", { draft: ["shipped"], shipped: [] },
      { "draft->shipped": [{ id: "p1", type: "deterministic", statement: "server_file_exists('other.md')" }] }, ["shipped"], {}],
    ["an existing edge gains a stake", { draft: ["shipped"], shipped: [] }, SIMPLE_PREDICATES, ["shipped"], { "draft->shipped": "paranoid" }],
    ["a new edge routes around an existing gate", { draft: ["shipped", "stamp"], stamp: ["shipped"], shipped: [] },
      SIMPLE_PREDICATES, ["shipped"], {}],
    ["a new edge duplicates an existing route", { draft: ["shipped"], review: ["shipped"], shipped: [] },
      SIMPLE_PREDICATES, ["shipped"], {}],
    ["a terminal state is removed", { draft: ["shipped"], shipped: [] }, SIMPLE_PREDICATES, [], {}],
    ["an existing node is flipped to terminal", { draft: ["shipped"], shipped: [] }, SIMPLE_PREDICATES, ["shipped", "draft"], {}],
    ["a NEW terminal state is granted", { draft: ["shipped", "rubber_stamp"], shipped: [], rubber_stamp: [] },
      SIMPLE_PREDICATES, ["shipped", "rubber_stamp"], {}],
    ["a new edge LEAVES a terminal state", { draft: ["shipped"], shipped: ["reopened"], reopened: [] },
      SIMPLE_PREDICATES, ["shipped"], {}],
  ])("refuses the upgrade when %s", async (_label, graph, predicates, terminal, stakes) => {
    await registerSimple();
    await expect(guardUpgrade("r", graph, predicates, "not additive", terminal, stakes))
      .rejects.toBeInstanceOf(IncompatiblePolicyUpgrade);
    expect(guardHistory("r")).toMatchObject({ graph_version: 1, ledger: [] });
  });

  it("refuses predicates newly added to an edge that had none", async () => {
    await registerGuard("bare", { a: ["b"], b: [] }, {}, "a", ["b"], {}, workspace);
    await expect(guardUpgrade("bare", { a: ["b"], b: [] }, {
      "a->b": [{ id: "p1", type: "deterministic", statement: "server_file_exists('design.md')" }],
    }, "strengthen a->b", ["b"])).rejects.toBeInstanceOf(IncompatiblePolicyUpgrade);
    expect(guardHistory("bare")).toMatchObject({ graph_version: 1, ledger: [] });
  });

  it("re-validates the submitted policy before comparing it", async () => {
    await registerSimple();
    await expect(guardUpgrade("r", GRAFT_GRAPH, {
      ...SIMPLE_PREDICATES,
      "draft->audited": [{ type: "bogus", statement: "anything" }],
    }, "invalid", GRAFT_TERMINAL)).rejects.toBeInstanceOf(EvidenceParseError);
    expect(guardHistory("r")).toMatchObject({ graph_version: 1, ledger: [] });
  });

  it("refuses a tampered registry even when the submitted policy would be a no-op", async () => {
    await registerSimple();
    const registry = loadRegistry("r")!;
    registry.graph = { draft: ["shipped", "sneaky"], shipped: [], sneaky: [] };
    persistRegistry(registry); // checksum left stale on purpose
    await expect(guardUpgrade("r", registry.graph, SIMPLE_PREDICATES, "no-op over tampered state", ["shipped"]))
      .rejects.toBeInstanceOf(GuardTampered);
  });

  it("refuses a string adjacency, which would make edge legality match substrings", async () => {
    // `["b"]` and `"b"` both survive the state-name check (a string iterates as
    // chars), but a stored string adjacency makes the transition path's
    // `.includes(toState)` a SUBSTRING test. Refused at registration and on
    // every policy-changing path.
    const stringGraph = { a: "bxyz", bxyz: [] } as unknown as Record<string, string[]>;
    await expect(registerGuard("shape", stringGraph, {}, "a", ["bxyz"])).rejects.toBeInstanceOf(InvalidStateName);

    await registerGuard("shape", { a: ["b"], b: [] }, {}, "a", ["b"]);
    await expect(guardUpgrade("shape", stringGraph, {}, "string adjacency", ["b", "bxyz"]))
      .rejects.toBeInstanceOf(InvalidStateName);
    expect(guardHistory("shape")).toMatchObject({ graph_version: 1, ledger: [] });
  });

  it.each([
    ["terminal is not an array", { a: ["b"], b: [] }, {}, "b" as unknown as string[], InvalidStateName],
    ["a predicate list is not an array", { a: ["b"], b: [] },
      { "a->b": "server_file_exists('x')" } as unknown as Record<string, Array<Record<string, unknown>>>, ["b"], EvidenceParseError],
    ["a stake is not a string", { a: ["b"], b: [] }, {}, ["b"], InvalidStateName],
  ])("refuses a malformed policy when %s", async (label, graph, predicates, terminal, expected) => {
    await registerGuard("shape2", { a: ["b"], b: [] }, {}, "a", ["b"]);
    const stakes = label === "a stake is not a string"
      ? ({ "a->b": 1 } as unknown as Record<string, string>)
      : {};
    await expect(guardUpgrade("shape2", graph, predicates, "malformed", terminal, stakes))
      .rejects.toBeInstanceOf(expected);
  });

  it("fails closed on a registry that already holds a string adjacency", async () => {
    // The shape check guards the way IN. A registry persisted before it existed
    // still loads through an unchecked cast, so edge legality itself must not
    // fall back to String.prototype.includes (a substring match).
    await registerGuard("legacy", { a: ["b"], b: [] }, {}, "a", ["b"]);
    const registry = loadRegistry("legacy")!;
    registry.graph = { a: "bxyz", b: [] } as unknown as Record<string, string[]>;
    registry.checksum = guardChecksum(registry.graph, {}, ["b"], {});
    persistRegistry(registry);
    await expect(guardTransition("legacy", "a", "xyz")).rejects.toBeInstanceOf(IllegalEdge);
  });

  it("refuses a duplicated terminal entry, so the freeze cannot be gamed by set equality", async () => {
    await registerSimple();
    await expect(guardUpgrade("r", { draft: ["shipped"], shipped: [] }, SIMPLE_PREDICATES, "dup terminal", ["shipped", "shipped"]))
      .rejects.toBeInstanceOf(InvalidStateName);
  });

  it("requires a non-empty rationale", async () => {
    await registerSimple();
    await expect(guardUpgrade("r", { draft: ["shipped"], shipped: [] }, SIMPLE_PREDICATES, "   ", ["shipped"]))
      .rejects.toBeInstanceOf(OverrideUnavailable);
  });

  it("refuses an unregistered resource exactly as migrate does", async () => {
    // Ownership is asserted before the registry is loaded, so a resource that
    // was never registered reads as un-handed-over rather than not-found. This
    // is guardMigrate's existing behaviour, asserted here as parity, not as a
    // new quirk of the upgrade path.
    process.env.STRATUM_GUARD_OVERRIDE_TOKEN = "secret";
    await expect(guardUpgrade("missing", { a: [] }, {}, "why")).rejects.toBeInstanceOf(GuardEngineOwned);
    await expect(guardMigrate("missing", { a: [] }, {}, "secret", "why")).rejects.toBeInstanceOf(GuardEngineOwned);
  });
});

describe("policy validation slugs", () => {
  it.each([
    ["invalid_state_name", () => registerGuard("r", { "a/b": ["c"], c: [] }, {}, "a/b")],
    ["evidence_parse_error", () => registerGuard("r", { a: ["b"], b: [] }, { "a->b": [{ statement: "server_file_exist('x')" }] }, "a")],
    ["evidence_parse_error", () => registerGuard("r", { a: ["b"], b: [] }, { "a->b": [{ type: null, statement: "anything" }] }, "a")],
    ["command_execution_disabled", () => registerGuard("r", { a: ["b"], b: [] }, { "a->b": [{ statement: "command_exit_zero(['true'])" }] }, "a", [], {}, workspace)],
    ["invalid_workspace_root", () => registerGuard("r", { a: ["b"], b: [] }, { "a->b": [{ statement: "server_file_exists('x')" }] }, "a")],
    ["paranoid_edge_needs_trusted_evidence", () => registerGuard("r", { a: ["b"], b: [] }, { "a->b": [{ type: "judged", statement: "ready" }] }, "a", [], { "a->b": "paranoid" })],
  ])("raises %s", async (slug, action) => {
    await expect(action()).rejects.toMatchObject({ errorType: slug });
  });

  it("exports the expected named error classes", () => {
    expect(new InvalidWorkspaceRoot("x").errorType).toBe("invalid_workspace_root");
    expect(new CommandExecutionDisabled("x").errorType).toBe("command_execution_disabled");
    expect(new EvidenceParseError("x").errorType).toBe("evidence_parse_error");
    expect(new ParanoidEdgeNeedsTrustedEvidence("x").errorType).toBe("paranoid_edge_needs_trusted_evidence");
  });
});
