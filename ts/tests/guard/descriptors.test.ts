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
  DESCRIPTOR_NAMESPACE,
  DESCRIPTOR_PATH_ENV,
  inspectDescriptorFile,
  loadDescriptorFile,
  setGuardTrustRootForTests,
} from "../../src/guard/descriptors.js";
import { createTestSigner, type TestSigner } from "../helpers/sshsig-sign.js";
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
let resetTrustRoot: (() => void) | undefined;
let operator: TestSigner;

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

/**
 * Write a descriptor file plus a detached signature over its exact bytes, and
 * return an env pointing at it. `signer` defaults to the trusted operator key;
 * pass another to simulate an attacker who signs with a key nobody enrolled.
 */
async function installDescriptors(
  payload: unknown = descriptorPayload(),
  options: { signer?: TestSigner | null; mode?: number; name?: string; namespace?: string; signBytes?: string } = {},
): Promise<NodeJS.ProcessEnv> {
  const path = join(fileRoot, options.name ?? "guard-upgrades.json");
  const body = typeof payload === "string" ? payload : JSON.stringify(payload, null, 2);
  await writeFile(path, body, "utf8");
  await chmod(path, options.mode ?? 0o600);
  const signer = options.signer === undefined ? operator : options.signer;
  if (signer !== null) {
    const signed = options.signBytes ?? body;
    await writeFile(`${path}.sig`, signer.sign(signed, options.namespace ?? DESCRIPTOR_NAMESPACE), "utf8");
  }
  return { [DESCRIPTOR_PATH_ENV]: path };
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
  // A trust root holding exactly one enrolled operator key, standing in for the
  // committed contracts/guard-signers.allowed.
  operator = createTestSigner();
  const trustRoot = join(fileRoot, "guard-signers.allowed");
  await writeFile(trustRoot, `operator ${operator.publicKeyLine}\n`, "utf8");
  resetTrustRoot = setGuardTrustRootForTests(trustRoot);
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
  resetTrustRoot?.();
  resetTrustRoot = undefined;
  setGuardsDir(originalGuardsDir);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});

describe("descriptor file authorization", () => {
  it("refuses when nothing is configured", () => {
    expect(() => loadDescriptorFile({})).toThrow(/not set in server env/);
  });

  it("refuses a relative path", async () => {
    const env = await installDescriptors();
    expect(() => loadDescriptorFile({ ...env, [DESCRIPTOR_PATH_ENV]: "guard-upgrades.json" }))
      .toThrow(UpgradeDescriptorUnavailable);
  });

  it("refuses an UNSIGNED descriptor file", async () => {
    const env = await installDescriptors(descriptorPayload(), { signer: null });
    expect(() => loadDescriptorFile(env)).toThrow(/is not signed/);
  });

  it("refuses a signature over different bytes than the file now holds", async () => {
    const env = await installDescriptors(descriptorPayload(), { signBytes: "something else entirely" });
    expect(() => loadDescriptorFile(env)).toThrow(/signature rejected/);
  });

  it("refuses a valid signature from a key nobody enrolled", async () => {
    // The attack the digest pin could not stop: an attacker-authored file, its
    // own perfectly good signature, and no way to get on the trust root.
    const env = await installDescriptors(descriptorPayload(), { signer: createTestSigner() });
    expect(() => loadDescriptorFile(env)).toThrow(/not an allowed signer/);
  });

  it("refuses a signature made under another namespace", async () => {
    const env = await installDescriptors(descriptorPayload(), { namespace: "stratum-guard-override" });
    expect(() => loadDescriptorFile(env)).toThrow(/namespace/);
  });

  it("refuses everything when the trust root has no enrolled signers", async () => {
    const env = await installDescriptors();
    const empty = join(fileRoot, "empty-signers.allowed");
    await writeFile(empty, "# nobody\n", "utf8");
    const restore = setGuardTrustRootForTests(empty);
    try {
      expect(() => loadDescriptorFile(env)).toThrow(/no allowed signers configured/);
    } finally {
      restore();
    }
  });

  it("refuses a missing trust root rather than trusting everything", async () => {
    const env = await installDescriptors();
    const restore = setGuardTrustRootForTests(join(fileRoot, "absent-signers.allowed"));
    try {
      expect(() => loadDescriptorFile(env)).toThrow(/trust root is unreadable/);
    } finally {
      restore();
    }
  });

  it("refuses a group- or world-writable file even when the signature is good", async () => {
    const env = await installDescriptors(descriptorPayload(), { mode: 0o666 });
    expect(() => loadDescriptorFile(env)).toThrow(/group- or world-writable/);
  });

  it("refuses a missing file", async () => {
    const env = await installDescriptors();
    expect(() => loadDescriptorFile({ ...env, [DESCRIPTOR_PATH_ENV]: join(fileRoot, "absent.json") }))
      .toThrow(UpgradeDescriptorUnavailable);
  });

  it("accepts a correctly signed file and reports who authorized it", async () => {
    const env = await installDescriptors();
    const file = loadDescriptorFile(env);
    expect(file.signedBy).toMatchObject({ principal: "operator", fingerprint: expect.stringMatching(/^SHA256:/) });
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
  it("reports a verified signature and the enrolled signers", async () => {
    const env = await installDescriptors();
    const report = inspectDescriptorFile(env);
    expect(report.signature).toMatch(/^verified: signed by operator \(SHA256:/);
    expect(report.allowed_signers).toEqual([{ principal: "operator", fingerprint: expect.stringMatching(/^SHA256:/) }]);
    expect(report.descriptors).toEqual([{
      id: "backfill",
      rationale: expect.stringContaining("COMP-LIFECYCLE-BACKFILL"),
      from_checksum: BASE_CHECKSUM,
    }]);
  });

  it("reports an unverifiable signature as NOT VERIFIED instead of failing shut", async () => {
    // Inspection is a diagnostic: the operator most needs it when something is
    // wrong, so it must describe the failure rather than throw it.
    const env = await installDescriptors(descriptorPayload(), { signer: null });
    expect(inspectDescriptorFile(env).signature).toMatch(/^NOT VERIFIED: /);
  });

  it("flags an insecure mode instead of hiding it", async () => {
    const env = await installDescriptors(descriptorPayload(), { mode: 0o666 });
    expect(inspectDescriptorFile(env)).toMatchObject({ group_or_world_writable: true });
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
      rationale: expect.stringContaining("descriptor backfill signed by operator (SHA256:"),
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
