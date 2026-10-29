// HTTP handler for the standalone shell's DataClient. Read-only over run files; gate
// decisions go through the existing `stratum gate` CLI (no new engine write path).
//
//   GET  /api/runs                         → RunSummary[] (newest first)
//   GET  /api/runs/:runId                  → RunDetail | 404
//   GET  /api/gates                        → PendingGate[]   (`stratum query gates` + run file)
//   GET  /api/runs/:runId/live             → text/event-stream, `data: RunDetail | null` on every change
//   POST /api/gates/:runId/:stepId/:action → GateResolution  (`stratum gate <action> ... --token`)
//   POST /api/validate  {spec}             → SpecValidation  (engine validateSpec, `engine.mjs`)
//   POST /api/plan      {spec, input}      → PlanResult      (DRY engine.plan in a throwaway dir)
//
// A plain (req, res) function, so Compose can mount it under Express if it wants to.
import { execFile } from "node:child_process";
import { readdir, readFile, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import { createRunWatcher } from "./watch.mjs";
import { detail, gateResolution, isRun, pendingGate, summarize } from "./project.mjs";
import { createEngineBridge, engineFromDist } from "./engine.mjs";

const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const STEP_ID = /^[a-z][a-z0-9_-]{0,127}$/;
const ACTIONS = new Set(["approve", "reject", "revise"]);
const MAX_BODY = 16 * 1024;
/** Builder routes carry a whole spec (the largest real one in ~/.stratum/ts/flows is ~60 KB). */
const MAX_SPEC_BODY = 2 * 1024 * 1024;
const QUERY_TIMEOUT_MS = 15_000;
const MUTATION_TIMEOUT_MS = 30_000;
const MIME = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".ico": "image/x-icon" };

/**
 * @param {{ flowsDir: string, stratumBin: string, staticDir?: string, allowedHosts?: string[], watchIntervalMs?: number, engineDist?: string, loadEngine?: () => Promise<object>, planScratch?: string }} options
 *   allowedHosts: Host header values accepted (DNS-rebinding guard), e.g. ["127.0.0.1:19123"].
 *   engineDist: the built engine (`ts/dist`) for /api/validate and /api/plan; absent = those routes 501.
 *   loadEngine: instead of engineDist, a loader returning `engineModules(...)` (tests, or a host bundling the engine).
 *   planScratch: parent dir for the dry plan's throwaway state (default os.tmpdir()).
 */
export function createHandler({ flowsDir, stratumBin, staticDir, allowedHosts, watchIntervalMs, engineDist, loadEngine, planScratch }) {
  const engineLoader = loadEngine ?? (engineDist ? engineFromDist(engineDist) : undefined);
  const engine = engineLoader ? createEngineBridge(engineLoader, { planScratch }) : undefined;
  /** mtime cache: file name → { mtimeMs, size, summary } */
  const cache = new Map();

  async function loadRun(runId) {
    try {
      const run = JSON.parse(await readFile(join(flowsDir, `${runId}.json`), "utf8"));
      return isRun(run) ? run : undefined;
    } catch (error) {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    }
  }

  const watcher = createRunWatcher({
    flowsDir,
    loadDetail: async (runId) => {
      const run = await loadRun(runId); // throws on a half-written file, so the watcher retries
      return run ? detail(run) : null;
    },
    intervalMs: watchIntervalMs,
  });
  /** SSE streams are long-lived: cap them so a runaway client cannot hold unbounded sockets. */
  const MAX_STREAMS = 32;

  async function listRuns() {
    let names;
    try {
      names = (await readdir(flowsDir)).filter((name) => name.endsWith(".json"));
    } catch (error) {
      if (error?.code === "ENOENT") return [];
      throw error;
    }
    const live = new Set(names);
    for (const name of cache.keys()) if (!live.has(name)) cache.delete(name);
    const rows = await Promise.all(names.map(async (name) => {
      try {
        const info = await stat(join(flowsDir, name));
        const hit = cache.get(name);
        if (hit && hit.mtimeMs === info.mtimeMs && hit.size === info.size) return hit.summary;
        const run = JSON.parse(await readFile(join(flowsDir, name), "utf8"));
        const summary = isRun(run) ? summarize(run) : null;
        cache.set(name, { mtimeMs: info.mtimeMs, size: info.size, summary });
        return summary;
      } catch {
        return null; // unreadable or half-written file: skip, like `stratum query flows`
      }
    }));
    return rows.filter(Boolean).sort((a, b) => String(b.startedAt ?? "").localeCompare(String(a.startedAt ?? "")));
  }

  function runCli(args, timeout) {
    const isJs = /\.(c|m)?js$/.test(stratumBin);
    const file = isJs ? process.execPath : stratumBin;
    const argv = isJs ? [stratumBin, ...args] : args;
    return new Promise((done) => {
      execFile(file, argv, { timeout, maxBuffer: 16 * 1024 * 1024, env: { ...process.env, STRATUM_STATE_ROOT: flowsDir } }, (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : -1) : 0;
        if (code !== 0 && stderr) process.stderr.write(`[stratum-ui] stratum ${args[0]} ${args[1] ?? ""} exit ${code}: ${String(stderr).slice(0, 400)}\n`);
        done({ code, stdout: String(stdout) });
      });
    });
  }

  async function listGates() {
    const { code, stdout } = await runCli(["query", "gates"], QUERY_TIMEOUT_MS);
    if (code !== 0) throw Object.assign(new Error(`stratum query gates exited ${code}`), { status: 502 });
    const rows = JSON.parse(stdout);
    return Promise.all(rows.map(async (row) => pendingGate(row, RUN_ID.test(row.flow_id) ? await loadRun(row.flow_id) : undefined)));
  }

  async function resolveGate(runId, stepId, action, body) {
    const token = typeof body?.gateToken === "string" ? body.gateToken : "";
    if (!token || token.length > 512) return [400, { ok: false, kind: "error", code: "BAD_REQUEST", message: "gateToken is required" }];
    const note = typeof body?.note === "string" ? body.note.slice(0, 4000) : "";
    const args = ["gate", action, runId, stepId, "--token", token];
    if (note) args.push("--note", note);
    const { code, stdout } = await runCli(args, MUTATION_TIMEOUT_MS);
    const result = gateResolution(code, stdout);
    return [result.ok ? 200 : result.kind === "conflict" ? 409 : 422, result];
  }

  async function serveStatic(pathname, res) {
    if (!staticDir) return false;
    const root = resolve(staticDir);
    let file = normalize(join(root, decodeURIComponent(pathname)));
    if (file !== root && !file.startsWith(root + sep)) return false;
    try {
      if ((await stat(file)).isDirectory()) file = join(file, "index.html");
    } catch {
      file = join(root, "index.html"); // SPA fallback
    }
    try {
      const body = await readFile(file);
      res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream" });
      res.end(body);
      return true;
    } catch {
      return false;
    }
  }

  function stream(runId, req, res) {
    if (watcher.stats().subscribers >= MAX_STREAMS) {
      res.writeHead(503, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(JSON.stringify({ error: { code: "BUSY", message: "too many live streams" } }));
    }
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
    res.write(": live\n\n");
    const off = watcher.subscribe(runId, (value) => {
      if (!res.writableEnded) res.write(`data: ${JSON.stringify(value)}\n\n`);
    });
    res.on("close", off);
  }

  async function handler(req, res) {
    const send = (status, body) => {
      res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    try {
      if (allowedHosts && !allowedHosts.includes(req.headers.host ?? "")) return send(403, { error: { code: "HOST", message: "host not allowed" } });
      const url = new URL(req.url ?? "/", "http://local");
      const parts = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
      if (parts[0] !== "api") {
        if (req.method === "GET" && await serveStatic(url.pathname, res)) return;
        return send(404, { error: { code: "NOT_FOUND", message: "not found" } });
      }
      if (req.method === "GET" && parts.length === 2 && parts[1] === "runs") return send(200, await listRuns());
      if (req.method === "GET" && parts.length === 3 && parts[1] === "runs") {
        if (!RUN_ID.test(parts[2])) return send(400, { error: { code: "BAD_ID", message: "bad run id" } });
        const run = await loadRun(parts[2]);
        return run ? send(200, detail(run)) : send(404, { error: { code: "NOT_FOUND", message: `run ${parts[2]} not found` } });
      }
      if (req.method === "GET" && parts.length === 4 && parts[1] === "runs" && parts[3] === "live") {
        if (!RUN_ID.test(parts[2])) return send(400, { error: { code: "BAD_ID", message: "bad run id" } });
        return stream(parts[2], req, res);
      }
      if (req.method === "GET" && parts.length === 2 && parts[1] === "gates") return send(200, await listGates());
      if (req.method === "POST" && parts.length === 2 && (parts[1] === "validate" || parts[1] === "plan")) {
        if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) return send(415, { error: { code: "CONTENT_TYPE", message: "application/json required" } });
        if (!engine) return send(501, { error: { code: "NO_ENGINE", message: "server started without --engine-dist" } });
        let raw = "";
        for await (const chunk of req) {
          raw += chunk;
          if (raw.length > MAX_SPEC_BODY) return send(413, { error: { code: "TOO_LARGE", message: "body too large" } });
        }
        let body;
        try { body = JSON.parse(raw); } catch { return send(400, { error: { code: "BAD_JSON", message: "invalid JSON" } }); }
        if (!body || typeof body !== "object" || !("spec" in body)) return send(400, { error: { code: "BAD_REQUEST", message: "body needs a spec" } });
        return send(200, parts[1] === "validate" ? await engine.validate(body.spec) : await engine.plan(body.spec, body.input));
      }
      if (req.method === "POST" && parts.length === 5 && parts[1] === "gates") {
        const [, , runId, stepId, action] = parts;
        // JSON-only POST: a cross-site form cannot send it without a CORS preflight we never answer.
        if (!String(req.headers["content-type"] ?? "").startsWith("application/json")) return send(415, { ok: false, kind: "error", code: "CONTENT_TYPE", message: "application/json required" });
        if (!RUN_ID.test(runId) || !STEP_ID.test(stepId) || !ACTIONS.has(action)) return send(400, { ok: false, kind: "error", code: "BAD_REQUEST", message: "bad run id, step id or action" });
        let raw = "";
        for await (const chunk of req) {
          raw += chunk;
          if (raw.length > MAX_BODY) return send(413, { ok: false, kind: "error", code: "TOO_LARGE", message: "body too large" });
        }
        let body;
        try { body = raw ? JSON.parse(raw) : {}; } catch { return send(400, { ok: false, kind: "error", code: "BAD_JSON", message: "invalid JSON" }); }
        const [status, result] = await resolveGate(runId, stepId, action, body);
        return send(status, result);
      }
      return send(404, { error: { code: "NOT_FOUND", message: "no such route" } });
    } catch (error) {
      process.stderr.write(`[stratum-ui] ${req.method} ${req.url}: ${error?.message ?? error}\n`);
      return send(error?.status ?? 500, { error: { code: "INTERNAL", message: String(error?.message ?? error) } });
    }
  }
  handler.watcherStats = () => watcher.stats();
  /** Stop the watcher (and so its timer). Call on server shutdown. */
  handler.close = () => watcher.close();
  return handler;
}
