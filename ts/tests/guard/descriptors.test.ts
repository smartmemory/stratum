/**
 * STRAT-GUARD-DESCRIPTOR — the authorization primitive. These tests exist to
 * prove one thing: nothing reaches the privileged apply path except a policy a
 * human installed and pinned into the server environment.
 */

import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DESCRIPTOR_PATH_ENV,
  DESCRIPTOR_PIN_ENV,
  descriptorFileDigest,
  inspectDescriptorFile,
  loadDescriptorFile,
} from "../../src/guard/descriptors.js";
import {
  GuardEngineOwned,
  GuardTampered,
  InvalidStateName,
  UpgradeDescriptorMismatch,
  UpgradeDescriptorUnavailable,
} from "../../src/guard/errors.js";
import { guardChecksum } from "../../src/guard/fingerprint.js";
import {
  guardApplyUpgrade,
  guardHistory,
  guardTransition,
  guardUpgrade,
  registerGuard,
  setGuardLockingForTests,
} from "../../src/guard/transition.js";
import {
  GUARDS_DIR,
  GuardRegistry,
  LedgerEntry,
  ResourceLockManager,
  appendLedger,
  loadRegistry,
  persistRegistry,
  setGuardsDir,
} from "../../src/guard/store.js";

const originalGuardsDir = GUARDS_DIR;
const roots: string[] = [];
let guardsRoot: string;
let fileRoot: string;
let resetLocking: (() => void) | undefined;

// The registered policy every test starts from.
const BASE_GRAPH = { draft: ["shipped"], shipped: [] };
const BASE_PREDICATES = { "draft->shipped": [{ id: "p1", type: "deterministic", statement: "server_file_exists('design.md')" }] };
const BASE_TERMINAL = ["shipped"];
const BASE_CHECKSUM = guardChecksum(BASE_GRAPH, BASE_PREDICATES, BASE_TERMINAL, {});

// What guardUpgrade refuses and a reviewed descriptor is allowed to do: grant a
// new terminal state (a completability grant).
const TARGET_POLICY = {
  graph: { draft: ["shipped", "complete_backfilled"], shipped: [], complete_backfilled: [] },
  edge_predicates: {
    ...BASE_PREDICATES,
    "draft->complete_backfilled": [{ id: "b1", type: "deterministic", statement: "git_commit_exists('HEAD')" }],
  },
  terminal: ["shipped", "complete_backfilled"],
  stakes: { "draft->complete_backfilled": "paranoid" },
};
const TARGET_CHECKSUM = guardChecksum(
  TARGET_POLICY.graph,
  TARGET_POLICY.edge_predicates,
  TARGET_POLICY.terminal,
  TARGET_POLICY.stakes,
);

function descriptorPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    descriptors: [{
      id: "backfill",
      rationale: "COMP-LIFECYCLE-BACKFILL: add the complete_backfilled terminal node. Reviewed in test.",
      from_checksum: BASE_CHECKSUM,
      to_policy: TARGET_POLICY,
      ...overrides,
    }],
  };
}

/** Write a descriptor file and return an env that correctly points at and pins it. */
async function installDescriptors(
  payload: unknown = descriptorPayload(),
  options: { pin?: string | null; mode?: number; name?: string } = {},
): Promise<NodeJS.ProcessEnv> {
  const path = join(fileRoot, options.name ?? "guard-upgrades.json");
  const body = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  await writeFile(path, body, "utf8");
  await chmod(path, options.mode ?? 0o600);
  const pin = options.pin === undefined ? descriptorFileDigest(body) : options.pin;
  return {
    [DESCRIPTOR_PATH_ENV]: path,
    ...(pin === null ? {} : { [DESCRIPTOR_PIN_ENV]: pin }),
  };
}

async function temporaryDirectory(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function registerBase(resourceId = "r"): Promise<void> {
  await registerGuard(resourceId, BASE_GRAPH, BASE_PREDICATES, "draft", BASE_TERMINAL, {}, fileRoot);
}

beforeEach(async () => {
  guardsRoot = await temporaryDirectory("stratum-guard-descriptors-");
  fileRoot = await temporaryDirectory("stratum-descriptor-files-");
  setGuardsDir(guardsRoot);
  const locks = new ResourceLockManager({
    processIdentity: async (pid) => ({ alive: true, startTime: `test-${pid}` }),
  });
  resetLocking = setGuardLockingForTests(
    (resourceId, action, options) => locks.resourceLock(resourceId, action, options),
    (resourceId, token) => locks.assertStillHeld(resourceId, token),
  );
});

afterEach(async () => {
  resetLocking?.();
  resetLocking = undefined;
  setGuardsDir(originalGuardsDir);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});

describe("descriptor file authentication", () => {
  it("refuses when nothing is configured", () => {
    expect(() => loadDescriptorFile({})).toThrow(UpgradeDescriptorUnavailable);
  });

  it("refuses a relative path", async () => {
    const env = await installDescriptors();
    expect(() => loadDescriptorFile({ ...env, [DESCRIPTOR_PATH_ENV]: "guard-upgrades.json" }))
      .toThrow(UpgradeDescriptorUnavailable);
  });

  it("refuses a configured path with NO pin, because an unpinned file authorizes nothing", async () => {
    const env = await installDescriptors(descriptorPayload(), { pin: null });
    expect(() => loadDescriptorFile(env)).toThrow(/not set in server env/);
  });

  it("refuses a pin that does not match the file's bytes", async () => {
    const env = await installDescriptors();
    expect(() => loadDescriptorFile({ ...env, [DESCRIPTOR_PIN_ENV]: "0".repeat(64) }))
      .toThrow(/does not match the pinned/);
  });

  it("refuses a pin that is not a sha256 digest", async () => {
    const env = await installDescriptors();
    expect(() => loadDescriptorFile({ ...env, [DESCRIPTOR_PIN_ENV]: "not-a-digest" }))
      .toThrow(UpgradeDescriptorUnavailable);
  });

  it("refuses a group- or world-writable file even when the pin matches", async () => {
    const env = await installDescriptors(descriptorPayload(), { mode: 0o666 });
    expect(() => loadDescriptorFile(env)).toThrow(/group- or world-writable/);
  });

  it("refuses a missing file", async () => {
    const env = await installDescriptors();
    expect(() => loadDescriptorFile({ ...env, [DESCRIPTOR_PATH_ENV]: join(fileRoot, "absent.json") }))
      .toThrow(UpgradeDescriptorUnavailable);
  });

  it("accepts a correctly installed file", async () => {
    const env = await installDescriptors();
    const file = loadDescriptorFile(env);
    expect(file.digest).toBe(env[DESCRIPTOR_PIN_ENV]);
    expect(file.descriptors.map((entry) => entry.id)).toEqual(["backfill"]);
  });
});

describe("descriptor file schema", () => {
  it.each([
    ["not JSON", "{nope"],
    ["not an object", "[]"],
    ["an unknown top-level key", JSON.stringify({ version: 1, descriptors: [], extra: true })],
    ["a wrong version", JSON.stringify({ version: 2, descriptors: [] })],
    ["a missing descriptors array", JSON.stringify({ version: 1 })],
  ])("refuses a file that is %s", async (_label, body) => {
    const env = await installDescriptors(body);
    expect(() => loadDescriptorFile(env)).toThrow(UpgradeDescriptorUnavailable);
  });

  it.each([
    ["an unknown descriptor key", { note: "hi" }],
    ["a bad id", { id: "not a valid id" }],
    ["a blank rationale", { rationale: "   " }],
    ["a non-digest from_checksum", { from_checksum: "abc" }],
    ["a missing to_policy field", { to_policy: { graph: {}, edge_predicates: {}, terminal: [] } }],
    ["an unknown to_policy key", { to_policy: { ...TARGET_POLICY, initial: "draft" } }],
  ])("refuses a descriptor with %s", async (_label, overrides) => {
    const env = await installDescriptors(descriptorPayload(overrides));
    expect(() => loadDescriptorFile(env)).toThrow(UpgradeDescriptorUnavailable);
  });

  it("refuses duplicate descriptor ids", async () => {
    const payload = descriptorPayload();
    (payload.descriptors as unknown[]).push((payload.descriptors as unknown[])[0]);
    const env = await installDescriptors(payload);
    expect(() => loadDescriptorFile(env)).toThrow(/duplicate upgrade descriptor id/);
  });
});

describe("operator inspection", () => {
  it("reports the digest even with no pin set, so the pin can be installed the first time", async () => {
    const env = await installDescriptors(descriptorPayload(), { pin: null });
    const report = inspectDescriptorFile(env);
    expect(report).toMatchObject({ pinned: false, pin_matches: false, group_or_world_writable: false });
    expect(report.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(report.descriptors).toEqual([{
      id: "backfill",
      rationale: expect.stringContaining("COMP-LIFECYCLE-BACKFILL"),
      from_checksum: BASE_CHECKSUM,
    }]);
    // And the digest it printed is exactly what makes the load succeed.
    expect(loadDescriptorFile({ ...env, [DESCRIPTOR_PIN_ENV]: report.sha256 }).digest).toBe(report.sha256);
  });

  it("flags an insecure mode instead of hiding it", async () => {
    const env = await installDescriptors(descriptorPayload(), { mode: 0o666 });
    expect(inspectDescriptorFile(env)).toMatchObject({ group_or_world_writable: true, pin_matches: true });
  });
});

describe("guardApplyUpgrade", () => {
  it("applies the exact authorized policy, granting a terminal state guardUpgrade refuses", async () => {
    const env = await installDescriptors();
    await registerBase();

    // Proof the two capabilities differ: the same change is refused token-free.
    await expect(guardUpgrade("r", TARGET_POLICY.graph, TARGET_POLICY.edge_predicates, "no", TARGET_POLICY.terminal, TARGET_POLICY.stakes))
      .rejects.toThrow(/not additive-only/);

    const applied = await guardApplyUpgrade("r", "backfill", env);
    expect(applied).toMatchObject({ status: "applied", checksum: TARGET_CHECKSUM, graph_version: 2, descriptor_id: "backfill" });
    expect(loadRegistry("r")).toMatchObject({ terminal: TARGET_POLICY.terminal, checksum: TARGET_CHECKSUM });
    expect(guardHistory("r").ledger).toEqual([expect.objectContaining({
      kind: "graph_version",
      outcome: "graph_version",
      resolved_by: "human",
      rationale: expect.stringContaining(`descriptor backfill (file sha256 ${env[DESCRIPTOR_PIN_ENV]})`),
    })]);
  });

  it("is idempotent: re-application writes nothing", async () => {
    const env = await installDescriptors();
    await registerBase();
    await guardApplyUpgrade("r", "backfill", env);
    const again = await guardApplyUpgrade("r", "backfill", env);
    expect(again).toEqual({ status: "unchanged", checksum: TARGET_CHECKSUM, graph_version: 2, descriptor_id: "backfill" });
    expect(guardHistory("r")).toMatchObject({ graph_version: 2 });
    expect(guardHistory("r").ledger).toHaveLength(1);
  });

  it("refuses an unknown descriptor id", async () => {
    const env = await installDescriptors();
    await registerBase();
    await expect(guardApplyUpgrade("r", "nope", env)).rejects.toBeInstanceOf(UpgradeDescriptorUnavailable);
    expect(guardHistory("r")).toMatchObject({ graph_version: 1, ledger: [] });
  });

  it("refuses a resource whose current policy is not the one the descriptor was authorized against", async () => {
    const env = await installDescriptors();
    await registerGuard("other", { a: ["b"], b: [] }, {}, "a", ["b"], {}, fileRoot);
    await expect(guardApplyUpgrade("other", "backfill", env)).rejects.toBeInstanceOf(UpgradeDescriptorMismatch);
    await expect(guardApplyUpgrade("other", "backfill", env)).rejects.toThrow(BASE_CHECKSUM);
    expect(guardHistory("other")).toMatchObject({ graph_version: 1, ledger: [] });
  });

  it("refuses before touching the resource when the descriptor set is unavailable", async () => {
    await registerBase();
    await expect(guardApplyUpgrade("r", "backfill", {})).rejects.toBeInstanceOf(UpgradeDescriptorUnavailable);
    expect(guardHistory("r")).toMatchObject({ graph_version: 1, ledger: [] });
  });

  it("refuses an authorized policy that is malformed — authorized is not well-formed", async () => {
    const env = await installDescriptors(descriptorPayload({
      to_policy: { ...TARGET_POLICY, graph: { draft: "shipped", shipped: [] } },
    }));
    await registerBase();
    await expect(guardApplyUpgrade("r", "backfill", env)).rejects.toBeInstanceOf(InvalidStateName);
    expect(guardHistory("r")).toMatchObject({ graph_version: 1, ledger: [] });
  });

  it("refuses an authorized policy that would strand the current state", async () => {
    // A policy change never moves the walk, so a target graph that omits the
    // state the resource is actually IN must be refused however well authorized.
    const env = await installDescriptors(descriptorPayload({
      to_policy: {
        graph: { draft: ["elsewhere"], elsewhere: [] },
        edge_predicates: {},
        terminal: ["elsewhere"],
        stakes: {},
      },
    }));
    await writeFile(join(fileRoot, "design.md"), "design", "utf8");
    await registerBase();
    await guardTransition("r", "draft", "shipped");
    expect(guardHistory("r")).toMatchObject({ current_state: "shipped" });
    await expect(guardApplyUpgrade("r", "backfill", env)).rejects.toBeInstanceOf(InvalidStateName);
    expect(guardHistory("r")).toMatchObject({ graph_version: 1, current_state: "shipped" });
  });

  it("refuses a tampered registry, including on the idempotent no-op path", async () => {
    const env = await installDescriptors();
    await registerBase();
    await guardApplyUpgrade("r", "backfill", env);
    const registry = loadRegistry("r")!;
    registry.graph = { ...registry.graph, sneaky: [] };
    persistRegistry(registry); // checksum deliberately left stale
    await expect(guardApplyUpgrade("r", "backfill", env)).rejects.toBeInstanceOf(GuardTampered);
  });

  it("refuses a guard that has not been handed over to the TS engine", async () => {
    const env = await installDescriptors();
    persistRegistry(new GuardRegistry({
      resource_id: "python-owned",
      graph: BASE_GRAPH,
      edge_predicates: BASE_PREDICATES,
      initial: "draft",
      terminal: BASE_TERMINAL,
      stakes: {},
      checksum: BASE_CHECKSUM,
      graph_version: 1,
      workspace_root: null,
      current_state: "draft",
    }));
    appendLedger("python-owned", new LedgerEntry({
      ts_ms: 1, from_state: "draft", to_state: "draft", outcome: "graph_version", kind: "graph_version",
      resolved_by: "human", rationale: "Python-created fixture",
    }));
    await expect(guardApplyUpgrade("python-owned", "backfill", env)).rejects.toBeInstanceOf(GuardEngineOwned);
  });
});
