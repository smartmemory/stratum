import type { DataClient, GateResolution, PendingGate, RunDetail, RunSummary } from "../src/data-client";

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
  };
}
