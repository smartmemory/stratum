import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { guardCommand } from "../../src/cli/guard.js";
import { GUARDS_DIR, ResourceLockManager, setGuardsDir } from "../../src/guard/store.js";
import { setGuardLockingForTests } from "../../src/guard/transition.js";

const resourceId = "compose:acceptance:STRAT-TS-GUARD-E2";
const originalGuardsDir = GUARDS_DIR;
const originalOverrideToken = process.env.STRATUM_GUARD_OVERRIDE_TOKEN;
let guardsRoot = "";
let resetLocking: (() => void) | undefined;

type CliResult = { code: number; stdout: string; stderr: string; json: Record<string, unknown> };

async function run(action: string, kwargs: Record<string, unknown>): Promise<CliResult> {
  let stdout = "";
  let stderr = "";
  const inputDescriptor = Object.getOwnPropertyDescriptor(process, "stdin");
  const out = process.stdout.write;
  const err = process.stderr.write;
  Object.defineProperty(process, "stdin", { configurable: true, value: Readable.from([JSON.stringify(kwargs)]) });
  process.stdout.write = ((chunk: string | Uint8Array) => { stdout += String(chunk); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { stderr += String(chunk); return true; }) as typeof process.stderr.write;
  try {
    const code = await guardCommand([action]);
    return { code, stdout, stderr, json: JSON.parse(stdout) as Record<string, unknown> };
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
    if (inputDescriptor) Object.defineProperty(process, "stdin", inputDescriptor);
    else delete (process as { stdin?: NodeJS.ReadableStream }).stdin;
  }
}

beforeAll(async () => {
  guardsRoot = await mkdtemp(join(tmpdir(), "stratum-compose-guard-wire-"));
  setGuardsDir(guardsRoot);
  process.env.STRATUM_GUARD_OVERRIDE_TOKEN = "compose-acceptance-token";
  const locks = new ResourceLockManager({ processIdentity: async (pid) => ({ alive: true, startTime: `compose-wire-${pid}` }) });
  resetLocking = setGuardLockingForTests(
    (guardResourceId, action, options) => locks.resourceLock(guardResourceId, action, options),
    (guardResourceId, token) => locks.assertStillHeld(guardResourceId, token),
  );
});

afterAll(async () => {
  resetLocking?.();
  setGuardsDir(originalGuardsDir);
  if (originalOverrideToken === undefined) delete process.env.STRATUM_GUARD_OVERRIDE_TOKEN;
  else process.env.STRATUM_GUARD_OVERRIDE_TOKEN = originalOverrideToken;
  await rm(guardsRoot, { recursive: true, force: true });
});

describe.sequential("Compose guard adapter wire shapes against the real TS CLI", () => {
  it("accepts guardRegister's compact snake_case kwargs and returns Compose's registered shape", async () => {
    const result = await run("register", {
      resource_id: resourceId,
      graph: { draft: ["review"], review: ["done"], done: [] },
      edge_predicates: { "review->done": [{ id: "approval", type: "judged", statement: "approved" }] },
      initial: "draft",
      terminal: ["done"],
      stakes: { "review->done": "high" },
      workspace_root: guardsRoot,
    });

    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.json).toMatchObject({ guard_id: resourceId, checksum: expect.any(String), status: "registered" });
  });

  it("accepts guardTransition's full kwargs shape and stores a verdict", async () => {
    const result = await run("transition", {
      resource_id: resourceId,
      from_state: "draft",
      to_state: "review",
      artifacts: { commit_sha: "deadbeef" },
      modified_files: ["server/lifecycle-guard.js"],
      idempotency_key: "compose-transition-1",
      resolved_by: "agent",
    });

    expect(result.code).toBe(0);
    expect(result.json).toMatchObject({ status: "applied", current_state: "review", ledger_ref: expect.any(String), verdict: expect.any(Object) });
  });

  it("keeps a guard refusal on exit 0 with state unchanged", async () => {
    const result = await run("transition", {
      resource_id: resourceId,
      from_state: "review",
      to_state: "done",
      artifacts: {},
      modified_files: [],
      idempotency_key: "compose-refusal-1",
      resolved_by: "agent",
    });

    expect(result.code).toBe(0);
    expect(result.json).toMatchObject({ status: "refused", current_state: "review", ledger_ref: expect.any(String), verdict: { met: false } });
  });

  it("accepts guardOverride's kwargs and guardHistory's minimal request", async () => {
    const overridden = await run("override", {
      resource_id: resourceId,
      from_state: "review",
      to_state: "done",
      override_token: "compose-acceptance-token",
      rationale: "acceptance validation",
      resolved_by: "human",
    });
    expect(overridden).toMatchObject({ code: 0, json: { status: "deviation", current_state: "done", ledger_ref: expect.any(String) } });

    const history = await run("history", { resource_id: resourceId });
    expect(history.code).toBe(0);
    expect(history.json).toMatchObject({ resource_id: resourceId, current_state: "done", ledger: expect.any(Array) });
    expect(history.json.ledger).toHaveLength(3);
  });

  it("returns Compose's canonical JSON error envelope on exit 1", async () => {
    const result = await run("history", { resource_id: "compose:acceptance:missing" });

    expect(result.code).toBe(1);
    expect(result.json).toMatchObject({ status: "error", error_type: "guard_not_found", message: expect.any(String) });
  });
});
