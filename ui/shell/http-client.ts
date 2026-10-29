import type { DataClient, GateResolution, PendingGate, PlanResult, RunDetail, RunSummary, SpecValidation } from "../src/data-client";

/**
 * The standalone shell's DataClient: HTTP to ui/server (same origin). This is the only
 * place in ui/ that fetches; components get it through <DataClientProvider>.
 */
export function createHttpClient(base = ""): DataClient {
  async function get<T>(path: string): Promise<T> {
    const response = await fetch(`${base}${path}`, { headers: { accept: "application/json" } });
    if (!response.ok) {
      const body = await response.json().catch(() => undefined);
      throw new Error(body?.error?.message ?? `${path}: HTTP ${response.status}`);
    }
    return response.json() as Promise<T>;
  }
  async function post<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => undefined);
      throw new Error(payload?.error?.message ?? `${path}: HTTP ${response.status}`);
    }
    return response.json() as Promise<T>;
  }

  return {
    listRuns: () => get<RunSummary[]>("/api/runs"),
    async getRun(runId) {
      const response = await fetch(`${base}/api/runs/${encodeURIComponent(runId)}`, { headers: { accept: "application/json" } });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`run ${runId}: HTTP ${response.status}`);
      return response.json() as Promise<RunDetail>;
    },
    listGates: () => get<PendingGate[]>("/api/gates"),
    async resolveGate({ runId, stepId, action, note, gateToken }) {
      const response = await fetch(`${base}/api/gates/${encodeURIComponent(runId)}/${encodeURIComponent(stepId)}/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ gateToken, note }),
      });
      const body = (await response.json().catch(() => undefined)) as GateResolution | undefined;
      return body && "ok" in body ? body : { ok: false, kind: "error", code: `HTTP_${response.status}`, message: "unexpected response" };
    },
    // Server-sent events from /api/runs/:id/live. EventSource reconnects on its own and the server
    // sends a fresh snapshot on every (re)connect, so a dropped stream heals without a reload.
    subscribe(runId, cb) {
      const source = new EventSource(`${base}/api/runs/${encodeURIComponent(runId)}/live`);
      source.onmessage = (event) => {
        try { cb(JSON.parse(event.data) as RunDetail | null); } catch { /* ignore a malformed frame */ }
      };
      return () => source.close();
    },
    validateSpec: (spec) => post<SpecValidation>("/api/validate", { spec }),
    planFlow: (spec, input) => post<PlanResult>("/api/plan", { spec, input }),
  };
}
