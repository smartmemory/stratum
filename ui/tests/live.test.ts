import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error untyped .mjs
import { createHandler } from "../server/handler.mjs";
import type { RunDetail } from "../src/data-client";
import { persistedRun } from "./fixtures";

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));
const stepStatus = (run: RunDetail | null, id: string) => run?.stepStates[id]?.status;

/** Write like the engine does for a status change: whole file, atomically, so a reader never sees half. */
function writeRun(dir: string, status: string) {
  const run = persistedRun({ steps: { ...persistedRun().steps, critique: { status, attempts: [] } } });
  const tmp = join(dir, "run-live0001.json.tmp");
  writeFileSync(tmp, JSON.stringify({ ...run, id: "run-live0001" }));
  renameSync(tmp, join(dir, "run-live0001.json"));
}

describe("live run updates (server/watch.mjs over SSE)", () => {
  let dir: string;
  let server: Server;
  let base: string;
  let handler: ((req: unknown, res: unknown) => Promise<void>) & { watcherStats(): { timers: number; started: number; subscribers: number }; close(): void };
  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "stratum-ui-live-"));
    writeRun(dir, "running");
    handler = createHandler({ flowsDir: dir, stratumBin: join(dir, "none.js") });
    server = createServer((req, res) => void handler(req, res));
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(async () => {
    handler.close();
    server.closeAllConnections();
    await new Promise((done) => server.close(done));
    rmSync(dir, { recursive: true, force: true });
  });

  /** Open the SSE stream, collect decoded frames; returns { frames, stop }. */
  function openStream(runId: string) {
    const frames: Array<{ at: number; run: RunDetail | null }> = [];
    const abort = new AbortController();
    const done = (async () => {
      const response = await fetch(`${base}/api/runs/${runId}/live`, { signal: abort.signal });
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      for (;;) {
        const { value, done: finished } = await reader.read();
        if (finished) return;
        buffer += decoder.decode(value);
        for (let cut = buffer.indexOf("\n\n"); cut >= 0; cut = buffer.indexOf("\n\n")) {
          const frame = buffer.slice(0, cut);
          buffer = buffer.slice(cut + 2);
          if (frame.startsWith("data: ")) frames.push({ at: Date.now(), run: JSON.parse(frame.slice(6)) });
        }
      }
    })().catch(() => undefined);
    return { frames, stop: async () => { abort.abort(); await done; } };
  }
  const until = async (test: () => boolean, ms: number) => {
    const end = Date.now() + ms;
    while (!test() && Date.now() < end) await sleep(20);
    return test();
  };

  it("pushes a step status change to a subscriber within 2 s of the file write", async () => {
    const stream = openStream("run-live0001");
    expect(await until(() => stream.frames.length >= 1, 2000)).toBe(true);
    expect(stepStatus(stream.frames[0].run, "critique")).toBe("running"); // the snapshot on subscribe
    const wrote = Date.now();
    writeRun(dir, "succeeded");
    expect(await until(() => stepStatus(stream.frames.at(-1)?.run ?? null, "critique") === "succeeded", 2000)).toBe(true);
    expect(stream.frames.at(-1)!.at - wrote).toBeLessThan(2000);
    await stream.stop();
  });

  it("keeps exactly one watcher timer across 3 subscribe/unsubscribe cycles and drops to none on close", async () => {
    const keeper = openStream("run-live0001");
    await until(() => keeper.frames.length >= 1, 2000);
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const extra = openStream("run-live0001");
      await until(() => extra.frames.length >= 1, 2000);
      expect(handler.watcherStats().timers).toBe(1);
      await extra.stop();
    }
    expect(await until(() => handler.watcherStats().subscribers === 1, 2000)).toBe(true);
    expect(handler.watcherStats()).toMatchObject({ timers: 1, started: 1, subscribers: 1 });
    await keeper.stop();
    await until(() => handler.watcherStats().subscribers === 0, 2000);
    expect(handler.watcherStats()).toMatchObject({ timers: 1, started: 1, subscribers: 0 });
    handler.close();
    expect(handler.watcherStats().timers).toBe(0);
  });

  it("answers 400 for a bad run id and sends null for a run that does not exist", async () => {
    // handler.close() above stopped the watcher, so use a fresh handler for this one.
    const fresh = createHandler({ flowsDir: dir, stratumBin: join(dir, "none.js") });
    const other = createServer((req, res) => void fresh(req, res));
    await new Promise<void>((done) => other.listen(0, "127.0.0.1", done));
    const url = `http://127.0.0.1:${(other.address() as { port: number }).port}`;
    expect((await fetch(`${url}/api/runs/..%2Fetc/live`)).status).toBe(400);
    const abort = new AbortController();
    const response = await fetch(`${url}/api/runs/run-nothere/live`, { signal: abort.signal });
    const reader = response.body!.getReader();
    let text = "";
    const end = Date.now() + 2000;
    while (!text.includes("data: ") && Date.now() < end) text += new TextDecoder().decode((await reader.read()).value);
    expect(text).toContain("data: null");
    abort.abort();
    fresh.close();
    other.closeAllConnections();
    await new Promise((done) => other.close(done));
  });
});
