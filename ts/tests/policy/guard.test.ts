import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { AUTHORIZATION_NAMESPACES, authorizationPayload } from "../../src/guard/authorization.js";
import { GUARDS_DIR, ResourceLockManager, loadRegistry, readLedger, setGuardsDir } from "../../src/guard/store.js";
import { _ledgerHead, guardOverride, guardTransition, registerGuard, setGuardLockingForTests } from "../../src/guard/transition.js";
import { setGuardTrustRootForTests } from "../../src/guard/trust.js";
import { bundleIdForRules } from "../../src/policy/bundle.js";
import type { EnforcementEvent, PolicyBundle, Rule, Source } from "../../src/policy/types.js";
import { createToolDispatcher } from "../../src/mcp/server.js";
import { createTestSigner, type TestSigner } from "../helpers/sshsig-sign.js";

const originalGuardsDir = GUARDS_DIR;
const roots: string[] = [];
const fetchMock = vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => ({ ok: true, status: 204 }));
const originalEnv = {
  url: process.env.SMARTMEMORY_API_URL,
  key: process.env.SMARTMEMORY_API_KEY,
  workspace: process.env.SMARTMEMORY_WORKSPACE_ID,
};
let resetLocking: (() => void) | undefined;
let resetTrustRoot: (() => void) | undefined;
let workspace: string;
let operator: TestSigner;

const source: Source = {
  record_id: "decision-guard",
  memory_type: "decision",
  version: 3,
  content_hash: "a".repeat(64),
  chain_hash: "b".repeat(64),
  workspace_id: "workspace-1",
};
const rule: Rule = {
  rule_id: "decision-guard#0",
  source,
  bind: { kind: "guard_edge", resource_selector: "resource-*", edge: "draft->done" },
  predicate: { file_exists: "proof.txt" },
  on_fail: "refuse",
};
const policyBundle: PolicyBundle = {
  bundle_id: bundleIdForRules([rule]),
  workspace_id: "workspace-1",
  compiled_at: "2026-08-21T00:00:00.000Z",
  selector: { status: ["active"] },
  rules: [rule],
};

function bundle(rules: Rule[]): PolicyBundle {
  return {
    bundle_id: bundleIdForRules(rules),
    workspace_id: "workspace-1",
    compiled_at: "2026-08-21T00:00:00.000Z",
    selector: { status: ["active"] },
    rules,
  };
}

function postedEvents(): EnforcementEvent[] {
  return fetchMock.mock.calls.map((call) => JSON.parse(String(call[1]?.body)) as EnforcementEvent);
}

beforeAll(() => {
  process.env.SMARTMEMORY_API_URL = "https://memory.example";
  process.env.SMARTMEMORY_API_KEY = "secret";
  process.env.SMARTMEMORY_WORKSPACE_ID = "workspace-1";
  vi.stubGlobal("fetch", fetchMock);
});

beforeEach(async () => {
  const guardRoot = await mkdtemp(join(tmpdir(), "stratum-policy-guard-"));
  workspace = await mkdtemp(join(tmpdir(), "stratum-policy-workspace-"));
  roots.push(guardRoot, workspace);
  setGuardsDir(guardRoot);
  await writeFile(join(workspace, "proof.txt"), "proof", "utf8");
  const locks = new ResourceLockManager({ processIdentity: async (pid) => ({ alive: true, startTime: `test-${pid}` }) });
  resetLocking = setGuardLockingForTests(
    (resourceId, action, options) => locks.resourceLock(resourceId, action, options),
    (resourceId, token) => locks.assertStillHeld(resourceId, token),
  );
  operator = createTestSigner();
  const trustRoot = join(workspace, "guard-signers.allowed");
  await writeFile(trustRoot, `operator ${operator.publicKeyLine}\n`, "utf8");
  resetTrustRoot = setGuardTrustRootForTests(trustRoot);
});

afterEach(async () => {
  resetLocking?.();
  resetLocking = undefined;
  resetTrustRoot?.();
  resetTrustRoot = undefined;
  setGuardsDir(originalGuardsDir);
  fetchMock.mockClear();
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

afterAll(() => {
  vi.unstubAllGlobals();
  if (originalEnv.url === undefined) delete process.env.SMARTMEMORY_API_URL;
  else process.env.SMARTMEMORY_API_URL = originalEnv.url;
  if (originalEnv.key === undefined) delete process.env.SMARTMEMORY_API_KEY;
  else process.env.SMARTMEMORY_API_KEY = originalEnv.key;
  if (originalEnv.workspace === undefined) delete process.env.SMARTMEMORY_WORKSPACE_ID;
  else process.env.SMARTMEMORY_WORKSPACE_ID = originalEnv.workspace;
});

async function register(resourceId: string): Promise<void> {
  await registerGuard(
    resourceId,
    { draft: ["done"], done: [] },
    {},
    "draft",
    ["done"],
    {},
    workspace,
    policyBundle,
  );
}

describe.sequential("guard policy seam", () => {
  it("binds source-stamped guardChecksum into payload and entry digests", async () => {
    const ruleFor = (chainHash: string): Rule => ({
      ...rule,
      source: { ...source, chain_hash: chainHash },
    });
    const firstRegistration = await registerGuard(
      "resource-digest-a", { draft: ["done"], done: [] }, {}, "draft", ["done"], {}, workspace,
      bundle([ruleFor("b".repeat(64))]),
    );
    const secondRegistration = await registerGuard(
      "resource-digest-b", { draft: ["done"], done: [] }, {}, "draft", ["done"], {}, workspace,
      bundle([ruleFor("c".repeat(64))]),
    );
    vi.spyOn(Date, "now").mockReturnValue(1_777_777_777_777);
    const first = await guardTransition("resource-digest-a", "draft", "done", { runId: "run-a", judge: null });
    const second = await guardTransition("resource-digest-b", "draft", "done", { runId: "run-b", judge: null });
    expect(firstRegistration.checksum).not.toBe(secondRegistration.checksum);
    expect(first.payload_digest).not.toBe(second.payload_digest);
    expect(first.entry_digest).not.toBe(second.entry_digest);
    expect(readLedger("resource-digest-a")[0]?.payload_digest_version).toBe(2);
    expect(readLedger("resource-digest-b")[0]?.payload_digest_version).toBe(2);
  });

  it.each([
    ["file_exists", { file_exists: "proof.txt" }],
    ["file_contains", { file_contains: { path: "proof.txt", text: "roo" } }],
  ] as const)("maps %s guard rules to trusted builtins that can transition", async (name, predicate) => {
    const builtinRule: Rule = {
      ...rule,
      rule_id: `decision-guard#${name}`,
      predicate,
    };
    const resourceId = `resource-${name}`;
    await registerGuard(resourceId, { draft: ["done"], done: [] }, {}, "draft", ["done"], {}, workspace, bundle([builtinRule]));
    await expect(guardTransition(resourceId, "draft", "done", { runId: `run-${name}`, judge: null }))
      .resolves.toMatchObject({ status: "applied", current_state: "done" });
  });

  it("raises rule-level judged stakes and validates paranoid trusted evidence", async () => {
    const paranoidRule: Rule = {
      ...rule,
      rule_id: "decision-guard#paranoid",
      predicate: { judged: { statement: "safe to ship", stakes: "paranoid" } },
    };
    await expect(registerGuard(
      "resource-paranoid-refused", { draft: ["done"], done: [] }, {}, "draft", ["done"], {}, workspace,
      bundle([paranoidRule]),
    )).rejects.toThrow(/decision-guard#paranoid.*draft->done/);

    const deterministicRule: Rule = {
      ...rule,
      rule_id: "decision-guard#proof",
      predicate: { file_exists: "proof.txt" },
    };
    await registerGuard(
      "resource-paranoid-valid", { draft: ["done"], done: [] }, {}, "draft", ["done"], {}, workspace,
      bundle([paranoidRule, deterministicRule]),
    );
    expect(loadRegistry("resource-paranoid-valid")?.stakes).toEqual({ "draft->done": "paranoid" });
  });

  it("refreshes a stale bundle_id on checksum-equal registration", async () => {
    const firstBundle = bundle([]);
    const secondBundle = bundle([{
      rule_id: "decision-ensure#0",
      source,
      bind: { kind: "ensure", step_selector: "finish" },
      predicate: { expr: "true" },
      on_fail: "refuse",
    }]);
    await registerGuard("resource-refresh-bundle", { draft: ["done"], done: [] }, {}, "draft", ["done"], {}, workspace, firstBundle);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(registerGuard(
      "resource-refresh-bundle", { draft: ["done"], done: [] }, {}, "draft", ["done"], {}, workspace, secondBundle,
    )).resolves.toMatchObject({ status: "exists" });
    expect(loadRegistry("resource-refresh-bundle")?.bundle_id).toBe(secondBundle.bundle_id);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/resource-refresh-bundle.*bundle_id/));
  });

  it("backfills bundle_id on a checksum-equal legacy registration", async () => {
    const policy = bundle([]);
    await registerGuard(
      "resource-backfill-bundle", { draft: ["done"], done: [] }, { "draft->done": [] }, "draft", ["done"], {}, workspace,
    );
    await expect(registerGuard(
      "resource-backfill-bundle", { draft: ["done"], done: [] }, {}, "draft", ["done"], {}, workspace, policy,
    )).resolves.toMatchObject({ status: "exists" });
    expect(loadRegistry("resource-backfill-bundle")?.bundle_id).toBe(policy.bundle_id);
  });

  it("emits evaluated source-stamped rules after a committed transition", async () => {
    const dispatcher = createToolDispatcher({ guardJudge: null });
    await dispatcher.call("stratum_guard_register", {
      resource_id: "resource-transition",
      graph: { draft: ["done"], done: [] },
      edge_predicates: {},
      initial: "draft",
      terminal: ["done"],
      stakes: {},
      workspace_root: workspace,
      policy_bundle: policyBundle,
    });
    const result = await dispatcher.call("stratum_guard_transition", {
      resource_id: "resource-transition", from_state: "draft", to_state: "done", artifacts: {}, run_id: "flow-run-1",
    });
    expect(result).toMatchObject({
      status: "applied",
      entry_digest: expect.stringMatching(/^[0-9a-f]{64}$/),
      prev_digest: "",
      payload_digest: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    await vi.waitFor(() => expect(postedEvents()).toContainEqual(expect.objectContaining({
      event_id: `flow-run-1:${String(result.entry_digest)}`,
      kind: "guard_transition",
      run_id: "flow-run-1",
      resource_id: "resource-transition",
      outcome: "applied",
      entry_digest: String(result.entry_digest),
      prev_digest: String(result.prev_digest),
      payload_digest: String(result.payload_digest),
      rules_evaluated: [{ rule_id: "decision-guard#0", source, met: true, predicate_type: "deterministic" }],
    })));
  });

  it("falls back to resource_id and warns once when no run_id is supplied", async () => {
    await register("resource-fallback");
    await register("resource-fallback-second");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await guardTransition("resource-fallback", "draft", "done", { judge: null });
    await guardTransition("resource-fallback-second", "draft", "done", { judge: null });
    const fallbackWarnings = warning.mock.calls.filter(([message]) => String(message).includes("resource_id as run_id"));
    expect(fallbackWarnings).toHaveLength(1);
    await vi.waitFor(() => expect(postedEvents()).toContainEqual(expect.objectContaining({
      kind: "guard_transition", run_id: "resource-fallback", resource_id: "resource-fallback",
    })));
  });

  it("warns but still sends a deviation event when user_id is absent", async () => {
    await register("resource-override");
    const rationale = "emergency approval";
    const authorization = operator.sign(authorizationPayload("override", {
      resource_id: "resource-override",
      from_state: "draft",
      to_state: "done",
      rationale,
      ledger_head: _ledgerHead("resource-override"),
    }), AUTHORIZATION_NAMESPACES.override);
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const result = await guardOverride("resource-override", "draft", "done", authorization, rationale, "human", undefined, "flow-override-1");
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("SmartMemory will reject"));
    await vi.waitFor(() => expect(postedEvents()).toContainEqual(expect.objectContaining({
      event_id: `flow-override-1:${result.entry_digest}`,
      kind: "guard_transition",
      run_id: "flow-override-1",
      outcome: "deviation",
      resolved_by: "human",
      rationale: expect.stringContaining(rationale),
      rules_evaluated: [],
    })));
    expect(postedEvents().find((event) => event.event_id === `flow-override-1:${result.entry_digest}`))
      .not.toHaveProperty("resolved_by_user_id");
  });
});
