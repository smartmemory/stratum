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
    async getRunSpec(runId) {
      const response = await fetch(`${base}/api/runs/${encodeURIComponent(runId)}/spec`, { headers: { accept: "application/json" } });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`run ${runId} spec: HTTP ${response.status}`);
      return response.json();
    },
    listGates: () => get<PendingGate[]>("/api/gates"),
    // The standalone server forwards --note, but the v1 CLI discards it.
    supportsRevisionNotes: false,
    async resolveGate({ runId, stepId, action, note, gateToken }) {
      const response = await fetch(`${base}/api/gates/${encodeURIComponent(runId)}/${encodeURIComponent(stepId)}/${action}`, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({ gateToken, note }),
      });
      const body = (await response.json().catch(() => undefined)) as GateResolution | undefined;
      return body && "ok" in body ? body : { ok: false, kind: "error", code: `HTTP_${response.status}`, message: "unexpected response" };
    },
    // Each EventSource connection to /api/runs/:id/live starts with a fresh snapshot.
    subscribe(runId, cb, onError) {
      const source = new EventSource(`${base}/api/runs/${encodeURIComponent(runId)}/live`);
      source.onerror = () => onError?.("Live updates disconnected.");
      source.onmessage = (event) => {
        let run: RunDetail | null;
        try {
          run = JSON.parse(event.data) as RunDetail | null;
        } catch {
          onError?.("Live updates received an invalid snapshot.");
          return;
        }
        cb(run);
      };
      return () => source.close();
    },
    validateSpec: (spec) => post<SpecValidation>("/api/validate", { spec }),
    planFlow: (spec, input) => post<PlanResult>("/api/plan", { spec, input }),
  };
}
