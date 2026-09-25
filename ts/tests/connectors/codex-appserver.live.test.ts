import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { respondToServerRequest } from "../../src/connectors/codex-appserver-driver.js";
const { assessServerRequests, serverRequestTriggers, requiredServerMethods } = await import(resolve("scripts/peer3-probe.mjs"));
const enabled = process.env.STRATUM_LIVE_PEER3 === "1";
describe.skipIf(!enabled)("server requests real-server evidence", () => {
  it("requires proven transcripts or recorded unreached triggers and rejects answered failures", async () => {
    const root = process.env.STRATUM_PEER3_EVIDENCE;
    if (!root) throw new Error("STRATUM_PEER3_EVIDENCE is required for the explicit live gate");
    const report = JSON.parse(await readFile(join(root, "report.json"), "utf8"));
    expect(report.mode).toBe("server-requests"); expect(report.error).toBeUndefined();
    expect(report.codex.code).toBe(0); expect(report.codex.stdout).toContain("0.155.1");
    const runs = [];
    for (const run of report.runs) {
      const evidence = JSON.parse(await readFile(join(root, run.file), "utf8"));
      expect(evidence.claim).toBe(run.claim);
      expect(evidence.trigger).toEqual(run.trigger);
      expect(serverRequestTriggers).toContainEqual(run.trigger);
      // The transcript must show the advertised configuration and actual prompt.
      const client = evidence.transcript.filter((e: any) => e.direction === "client").map((e: any) => e.frame);
      expect(client.find((f: any) => f.method === "thread/start")?.params.approvalPolicy).toBe(run.trigger.approvalPolicy);
      const turn = client.find((f: any) => f.method === "turn/start");
      expect(turn?.params.sandboxPolicy.type).toBe("readOnly");
      expect(turn?.params.input).toContainEqual({ type: "text", text: run.trigger.prompt, text_elements: [] });
      runs.push({ ...evidence, file: run.file });
    }
    expect(report.methods).toEqual(assessServerRequests(runs, respondToServerRequest));
  });
});

function evidenceRuns() {
  return serverRequestTriggers.map((trigger: any, index: number) => ({ trigger, file: `run-${index}.json`, claim: "completed", transcript: [] as any[] }));
}
it("evidence gate records unreached methods and requires a dedicated patch approval trigger", () => {
  const runs = evidenceRuns();
  const result = assessServerRequests(runs, respondToServerRequest);
  expect(result.map((r: any) => r.method)).toEqual(requiredServerMethods);
  expect(result.every((r: any) => r.status === "unreached" && r.triggers.length)).toBe(true);
  expect(serverRequestTriggers).toContainEqual(expect.objectContaining({
    methods: ["item/fileChange/requestApproval", "applyPatchApproval"], approvalPolicy: "on-request", filesystemMode: "read-only", prompt: expect.stringContaining("apply_patch"),
  }));
  expect(() => assessServerRequests(runs.slice(0, 1), respondToServerRequest)).toThrow("no recorded trigger");
});
it.each(["failed", "cancelled", "missing-terminal", "error-after-reply", "bad-reply", "missing-reply", "completed"])("evidence gate checks every elicited reply: %s", mode => {
  const runs = evidenceRuns(), method = "item/fileChange/requestApproval", run = runs[1];
  run.claim = ["failed", "cancelled"].includes(mode) ? mode : "completed";
  run.transcript = [
    { direction: "server", frame: { id: "approval", method } },
    ...(mode === "missing-reply" ? [] : [{ direction: "client", frame: { id: "approval", ...(mode === "bad-reply" ? { result: {} } : respondToServerRequest(method)) } }]),
    ...(mode === "missing-terminal" ? [] : [{ direction: "server", frame: { method: "turn/completed", params: { turn: { status: "completed" } } } }]),
    ...(mode === "error-after-reply" ? [{ direction: "server", frame: { method: "error", params: { message: "invalid reply" } } }] : []),
  ];
  if (mode !== "completed") expect(() => assessServerRequests(runs, respondToServerRequest)).toThrow();
  else expect(assessServerRequests(runs, respondToServerRequest).find((r: any) => r.method === method)).toEqual({ method, status: "proven", evidence: [{ file: "run-1.json", request: 0, reply: 1, terminal: 2 }] });
});
