import { expect, it } from "vitest";
import { assertToolRequest, assertToolResponse } from "../src/mcp/contracts.js";

const peer = {name:"codex-astra-abcdef",registered:true,pid:123,sock:"/tmp/sp-example/123.sock"};
const started = {status:"bg_started",runId:"abcdef123456",streamPath:"/tmp/stream.jsonl"};
it("accepts old and peer-bearing background responses while rejecting undeclared keys", async () => {
  for (const response of [started, {...started,peerName:peer.name}]) {
    await expect(assertToolResponse("stratum_agent_run",response)).resolves.toBeUndefined();
  }
  const variants = [
    {status:"running",runId:started.runId,textTail:"",eventsSeen:0,streamPath:started.streamPath},
    {status:"complete",runId:started.runId,text:"",usage:{},exitCode:0,telemetry:{durationMs:1,model:"gpt-6-astra"}},
    {status:"error",runId:started.runId,textTail:"",stderrTail:""},
  ];
  for (const response of variants) {
    await expect(assertToolResponse("stratum_agent_poll",response)).resolves.toBeUndefined();
    await expect(assertToolResponse("stratum_agent_poll",{...response,peer})).resolves.toBeUndefined();
    await expect(assertToolResponse("stratum_agent_poll",{...response,peer:{name:peer.name,registered:false}})).resolves.toBeUndefined();
    await expect(assertToolResponse("stratum_agent_poll",{...response,peer:{...peer,undeclared:true}})).rejects.toThrow();
    await expect(assertToolResponse("stratum_agent_poll",{...response,peer,undeclared:true})).rejects.toThrow();
  }
  await expect(assertToolResponse("stratum_agent_run",{...started,peerName:peer.name,undeclared:true})).rejects.toThrow();
});

it("rejects the removed peer field on background start responses", async () => {
  for (const peer of ["pending", "failed", {registered:false}]) {
    await expect(assertToolResponse("stratum_agent_run", {...started,peerName:"codex-astra-abcdef",peer})).rejects.toThrow();
  }
});


it("accepts optional labels for Claude and Codex and rejects wrong types and unknown keys", async () => {
  for (const agent of ["claude", "codex"]) {
    const request = { agent, prompt: "review", cwd: "/tmp", background: true };
    await expect(assertToolRequest("stratum_agent_run", request)).resolves.toBeUndefined();
    await expect(assertToolRequest("stratum_agent_run", { ...request, peerLabel: "review" })).resolves.toBeUndefined();
    for (const peerLabel of [42, false, null, [], {}]) {
      await expect(assertToolRequest("stratum_agent_run", { ...request, peerLabel })).rejects.toThrow();
    }
    await expect(assertToolRequest("stratum_agent_run", { ...request, peerLabel: "review", undeclared: true })).rejects.toThrow();
  }
});

it("accepts Claude start and poll envelopes with completion guidance and historical registration", async () => {
  const peer = { name: "claude-sonnet-5-abcdef123456-review", registered: true, pid: 456, sock: "/tmp/sp-example/456.sock" };
  for (const extra of [{}, { peerName: peer.name, completionInstructions: "Subscribe, then poll for the report." }]) {
    await expect(assertToolResponse("stratum_agent_run", { ...started, ...extra })).resolves.toBeUndefined();
  }
  for (const response of [
    { status: "running", runId: started.runId, textTail: "", eventsSeen: 0, streamPath: started.streamPath },
    { status: "complete", runId: started.runId, text: "done", usage: {}, exitCode: 0, telemetry: { durationMs: 1, model: "claude-sonnet-5" } },
    { status: "error", runId: started.runId, textTail: "", stderrTail: "failed" },
  ]) {
    for (const extra of [{}, { peer }, { peer: { name: peer.name, registered: false } }]) {
      await expect(assertToolResponse("stratum_agent_poll", { ...response, ...extra })).resolves.toBeUndefined();
    }
    await expect(assertToolResponse("stratum_agent_poll", { ...response, peer: "pending" })).rejects.toThrow();
  }
  await expect(assertToolResponse("stratum_agent_run", { ...started, peerName: peer.name, peer: "pending" })).rejects.toThrow();
});
