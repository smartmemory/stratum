import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { guardCommand, setGuardJudgeForTests } from "../../src/cli/guard.js";
import { GUARDS_DIR, ResourceLockManager, setGuardsDir } from "../../src/guard/store.js";
import { setGuardLockingForTests, type GuardJudge } from "../../src/guard/transition.js";

const originalGuardsDir = GUARDS_DIR;
const roots: string[] = [];
let resetJudge: (() => void) | undefined;
let resetLocking: (() => void) | undefined;

beforeEach(async () => {
  const root = await mkdtemp(join(tmpdir(), "stratum-guard-cli-"));
  roots.push(root);
  setGuardsDir(root);
  const locks = new ResourceLockManager({ processIdentity: async (pid) => ({ alive: true, startTime: `test-${pid}` }) });
  resetLocking = setGuardLockingForTests(
    (resourceId, action, options) => locks.resourceLock(resourceId, action, options),
    (resourceId, token) => locks.assertStillHeld(resourceId, token),
  );
});

afterEach(async () => {
  resetJudge?.();
  resetJudge = undefined;
  resetLocking?.();
  resetLocking = undefined;
  setGuardsDir(originalGuardsDir);
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function judge(holds: boolean): GuardJudge {
  return async (predicate) => ({ holds, reason: predicate.statement, stakes: predicate.stakes ?? "default", model: "guard-cli-test", usage: { tokens: 0, usd: 0 } });
}

async function capture(input: string, argv: string[]) {
  let stdout = "";
  let stderr = "";
  const inputDescriptor = Object.getOwnPropertyDescriptor(process, "stdin");
  const out = process.stdout.write;
  const err = process.stderr.write;
  Object.defineProperty(process, "stdin", { configurable: true, value: Readable.from([input]) });
  process.stdout.write = ((chunk: string | Uint8Array) => { stdout += String(chunk); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { stderr += String(chunk); return true; }) as typeof process.stderr.write;
  try {
    const code = await guardCommand(argv);
    return { code, stdout, stderr };
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
    if (inputDescriptor) Object.defineProperty(process, "stdin", inputDescriptor);
    else delete (process as { stdin?: NodeJS.ReadableStream }).stdin;
  }
}

const policy = (resourceId: string) => ({
  resource_id: resourceId,
  graph: { draft: ["shipped"], shipped: [] },
  edge_predicates: { "draft->shipped": [{ id: "judge", type: "judged", statement: "ready" }] },
  initial: "draft",
  terminal: ["shipped"],
});

describe.sequential("guard CLI boundary", () => {
  it("round-trips register, applied transition, and history over one JSON stdin object", async () => {
    resetJudge = setGuardJudgeForTests(judge(true));
    const registered = await capture(JSON.stringify(policy("cli-applied")), ["register"]);
    expect(registered.code).toBe(0);
    expect(JSON.parse(registered.stdout)).toMatchObject({ guard_id: "cli-applied", status: "registered" });

    const transitioned = await capture(JSON.stringify({ resource_id: "cli-applied", from_state: "draft", to_state: "shipped", artifacts: {} }), ["transition"]);
    expect(transitioned.code).toBe(0);
    expect(JSON.parse(transitioned.stdout)).toMatchObject({ status: "applied", current_state: "shipped" });

    const history = await capture(JSON.stringify({ resource_id: "cli-applied" }), ["history"]);
    expect(history.code).toBe(0);
    expect(JSON.parse(history.stdout)).toMatchObject({ resource_id: "cli-applied", current_state: "shipped", ledger: [expect.objectContaining({ outcome: "applied" })] });
  });

  it("treats a judge refusal as a successful CLI result", async () => {
    resetJudge = setGuardJudgeForTests(judge(false));
    await capture(JSON.stringify(policy("cli-refused")), ["register"]);
    const result = await capture(JSON.stringify({ resource_id: "cli-refused", from_state: "draft", to_state: "shipped", artifacts: {} }), ["transition"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "refused", current_state: "draft" });
  });

  it("canonicalizes guard errors and rejects an unknown action", async () => {
    const missing = await capture(JSON.stringify({ resource_id: "missing" }), ["history"]);
    expect(missing.code).toBe(1);
    expect(JSON.parse(missing.stdout)).toMatchObject({ status: "error", error_type: "guard_not_found", message: expect.any(String) });

    const unknown = await capture("", ["nope"]);
    expect(unknown).toMatchObject({ code: 1, stdout: "" });
    expect(unknown.stderr).toContain("Unknown guard action: nope");
  });
});
