import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createEvaluateRunner } from "../../src/engine/evaluate.js";

const run = createEvaluateRunner();
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("createEvaluateRunner (default spawn-based runner)", () => {
  it("parses JSON stdout from a zero-exit command into an ok result", async () => {
    const out = await run({ command: `printf '{"status":"closed","children":[],"reason":"ok"}'`, input: undefined, timeoutMs: 5000 }, {});
    expect(out).toEqual({ ok: true, result: { status: "closed", children: [], reason: "ok" } });
  });

  it("feeds the input to the command on stdin as JSON", async () => {
    const out = await run({ command: "cat", input: { goal: "prove P", n: 2 }, timeoutMs: 5000 }, {});
    expect(out).toEqual({ ok: true, result: { goal: "prove P", n: 2 } });
  });

  it("reports a non-zero exit as a typed exit failure", async () => {
    const out = await run({ command: "exit 3", input: undefined, timeoutMs: 5000 }, {});
    expect(out).toMatchObject({ ok: false, kind: "exit" });
  });

  it("reports unparseable stdout as a typed parse failure", async () => {
    const out = await run({ command: `printf 'not json at all'`, input: undefined, timeoutMs: 5000 }, {});
    expect(out).toMatchObject({ ok: false, kind: "parse" });
  });

  it("reports a command that outruns its timeout as a typed timeout failure", async () => {
    const out = await run({ command: "sleep 2", input: undefined, timeoutMs: 100 }, {});
    expect(out).toMatchObject({ ok: false, kind: "timeout" });
  });

  it("kills backgrounded grandchildren when the command times out", async () => {
    const dir = await mkdtemp(join(tmpdir(), "stratum-eval-leak-"));
    roots.push(dir);
    const marker = join(dir, "leaked");
    // A grandchild backgrounded by the shell would touch the marker at 400ms and,
    // if only the shell were killed, survive reparenting. A process-group kill at
    // the 100ms timeout must take it down first, so the marker never appears.
    const out = await run({ command: `(sleep 0.4 && touch ${marker}) & sleep 5`, input: undefined, timeoutMs: 100 }, {});
    expect(out).toMatchObject({ ok: false, kind: "timeout" });
    await wait(700);
    expect(existsSync(marker)).toBe(false);
  });

  it("does not crash when input is supplied to a command that never reads stdin", async () => {
    // printf emits its JSON and exits without draining stdin; writing the input
    // to a closed pipe must not surface an unhandled EPIPE.
    const out = await run({ command: `printf '{"status":"closed","children":[],"reason":"ok"}'`, input: { goal: "prove P" }, timeoutMs: 5000 }, {});
    expect(out).toEqual({ ok: true, result: { status: "closed", children: [], reason: "ok" } });
  });
});
