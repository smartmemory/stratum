// @vitest-environment node
/// <reference types="vite/client" />
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
// @ts-expect-error untyped .mjs
import { createHandler } from "../server/handler.mjs";
// @ts-expect-error untyped .mjs
import { engineModules } from "../server/engine.mjs";

// serve.mjs loads the BUILT engine (`engineFromDist`, exercised by the live walk). Here the same
// three modules come from ts/src through vite, which cannot import an outside path at runtime.
// import.meta.glob keeps tsc out of the engine sources (ts/ type-checks them under its own tsconfig).
const ENGINE_SRC = import.meta.glob(["../../ts/src/ir/validate.ts", "../../ts/src/engine/engine.ts", "../../ts/src/eval/expr.ts"]);
const loadEngine = async () => engineModules(
  await ENGINE_SRC["../../ts/src/ir/validate.ts"]!(),
  await ENGINE_SRC["../../ts/src/engine/engine.ts"]!(),
  await ENGINE_SRC["../../ts/src/eval/expr.ts"]!(),
);
const spec = (name: string) => JSON.parse(readFileSync(join(__dirname, "fixtures", "specs", name), "utf8"));
const GATE = spec("gate-5dc37b92-dd13-4486-91ca-636021d5ac9d.json");
const FANOUT = spec("fanout-59a1d992-672b-469f-b0ac-8d48a6dbd930.json");
const broken = () => {
  const copy = JSON.parse(JSON.stringify(GATE));
  copy.flows.new.steps[2].gate.on_approve = "nowhere";
  return copy;
};

describe("builder routes: /api/validate and dry /api/plan", () => {
  let flowsDir: string;
  let planScratch: string;
  let server: Server;
  let base: string;
  beforeAll(async () => {
    flowsDir = mkdtempSync(join(tmpdir(), "stratum-ui-builder-flows-"));
    planScratch = mkdtempSync(join(tmpdir(), "stratum-ui-builder-plan-"));
    const handler = createHandler({ flowsDir, stratumBin: join(flowsDir, "missing-stratum.js"), loadEngine, planScratch });
    server = createServer((req, res) => void handler(req, res));
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(async () => {
    await new Promise((done) => server.close(done));
    rmSync(flowsDir, { recursive: true, force: true });
    rmSync(planScratch, { recursive: true, force: true });
  });

  const post = (route: string, body: unknown, type = "application/json") =>
    fetch(`${base}${route}`, { method: "POST", headers: { "content-type": type }, body: typeof body === "string" ? body : JSON.stringify(body) });

  const ROWS: Array<{ name: string; route: string; body: unknown; type?: string; status: number; expect: Record<string, unknown> }> = [
    { name: "validate a real spec", route: "/api/validate", body: { spec: GATE }, status: 200, expect: { status: "valid" } },
    { name: "validate a broken route", route: "/api/validate", body: { spec: broken() }, status: 200, expect: { status: "invalid", errors: [{ code: "ROUTING_UNKNOWN_TARGET", path: "flows.new.steps[2].gate.on_approve" }] } },
    { name: "dry plan a real gate spec", route: "/api/plan", body: { spec: GATE, input: { projectName: "p", intent: "i" } }, status: 200, expect: { status: "planned" } },
    { name: "dry plan a real fanout spec", route: "/api/plan", body: { spec: FANOUT, input: { featureCode: "X-1", gateCommands: [] } }, status: 200, expect: { status: "planned" } },
    { name: "dry plan refuses bad entry input", route: "/api/plan", body: { spec: GATE, input: {} }, status: 200, expect: { status: "invalid" } },
    { name: "dry plan refuses an invalid spec", route: "/api/plan", body: { spec: broken(), input: {} }, status: 200, expect: { status: "invalid" } },
    { name: "non-JSON post", route: "/api/validate", body: "spec=1", type: "text/plain", status: 415, expect: {} },
    { name: "no spec in body", route: "/api/plan", body: { input: {} }, status: 400, expect: {} },
  ];
  it.each(ROWS)("$name", async ({ route, body, type, status, expect: want }) => {
    const response = await post(route, body, type);
    expect(response.status).toBe(status);
    const payload = await response.json();
    expect(payload).toMatchObject(want);
    // dry: no run file appears in the flows dir and every throwaway plan dir is gone
    expect(readdirSync(flowsDir)).toEqual([]);
    expect(readdirSync(planScratch)).toEqual([]);
  });

  it("a planned response names the first step and no agent was dispatched", async () => {
    const payload = await (await post("/api/plan", { spec: GATE, input: { projectName: "p", intent: "i" } })).json();
    const text = JSON.stringify(payload.response);
    expect(text).toContain("research");
    expect(text).not.toContain("agent dispatch is disabled");
  });
});

it("without an engine dist the builder routes answer 501, visibly", async () => {
  const dir = mkdtempSync(join(tmpdir(), "stratum-ui-builder-noengine-"));
  const handler = createHandler({ flowsDir: dir, stratumBin: join(dir, "missing.js") });
  const server = createServer((req, res) => void handler(req, res));
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/validate`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ spec: GATE }) });
    expect(response.status).toBe(501);
  } finally {
    await new Promise((done) => server.close(done));
    rmSync(dir, { recursive: true, force: true });
  }
});
