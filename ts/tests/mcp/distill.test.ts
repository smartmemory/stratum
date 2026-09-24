import { isolatedStateRoot } from "../helpers/state-root.js";
import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { expect, it } from "vitest";
import { distillTool } from "../../src/distill/runner.js";
import { verifyCandidateIdentity } from "../../src/distill/candidate.js";
import { createMcpServer, createToolDispatcher } from "../../src/mcp/server.js";
import { assertToolResponse } from "../../src/mcp/contracts.js";
import { corpus, scratch } from "../distill/fixtures.js";

it("dispatcher uses the stateless adapter, with preview and default staging", async () => {
  const { root, project } = await corpus(); const dispatcher = createToolDispatcher();
  const request = { workspace_root: root, project_dir: project };
  const preview = await dispatcher.call("stratum_distill", { ...request, write: false });
  expect(preview).toMatchObject({ status: "ok", written: 0, evaluated: 3, applied: false });
  expect(await dispatcher.call("stratum_distill", request)).toMatchObject({ status: "ok", written: 3 });
  expect(await dispatcher.call("stratum_distill", request)).toMatchObject({ status: "ok", written: 0, reason: "already staged" });
});
it("SDK lists and calls the tool against the real surface contract", async () => {
  const root = await scratch(); const server = await createMcpServer({ flowStateRoot: isolatedStateRoot() }); const client = new Client({ name: "distill-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport); await client.connect(clientTransport);
  try {
    const tool = (await client.listTools()).tools.find(t => t.name === "stratum_distill")!;
    expect(tool.inputSchema.required).toEqual(["workspace_root"]);
    for (const min_count of [2, 0]) {
      const result = await client.callTool({ name: "stratum_distill", arguments: { workspace_root: root, project_dir: join(root, "missing"), min_count } });
      expect(result.isError).not.toBe(true);
      const text = (result.content as Array<{ type: string; text: string }>).find(c => c.type === "text")!.text;
      expect(JSON.parse(text).status).toBe(min_count ? "ok" : "error");
    }
  } finally { await client.close(); await server.close(); }
});
it("strict nested shapes and domain identity checks reject malformed/tampered candidates", async () => {
  const { root, project } = await corpus(); const result = await distillTool({ workspace_root: root, project_dir: project, write: false });
  expect(result.status).toBe("ok"); await assertToolResponse("stratum_distill", result);
  const candidates = result.candidates as Array<Record<string, unknown>>;
  const malformed = structuredClone(result); ((malformed.candidates as typeof candidates)[0]!.evidence as Array<Record<string, unknown>>)[0]!.extra = true;
  await expect(assertToolResponse("stratum_distill", malformed)).rejects.toThrow();
  const changed = structuredClone(candidates[0]!); changed.confidence = 1;
  expect(verifyCandidateIdentity(changed)).toBe(false);
});
it("rejects missing root, wrong wire types and undeclared apply/output/input fields", async () => {
  const root = await scratch();
  for (const request of [{}, { workspace_root: 1 }, { workspace_root: root, apply: false }, { workspace_root: root, out: "anything" }, { workspace_root: root, write: "true" }, { workspace_root: root, candidates: [] }]) {
    await expect(distillTool(request)).rejects.toThrow("shape");
    await expect(createToolDispatcher().call("stratum_distill", request)).rejects.toThrow();
  }
});
it("maps domain, source and staging failures to exact error categories", async () => {
  const { root, project } = await corpus();
  for (const request of [{ workspace_root: "relative" }, { workspace_root: "" }, { workspace_root: root, min_count: 1.5 }, { workspace_root: root, window_days: -1 }]) expect(await distillTool(request)).toMatchObject({ status: "error", error_type: "invalid_options" });
  const file = join(root, "file"); await writeFile(file, "x");
  expect(await distillTool({ workspace_root: root, project_dir: file })).toMatchObject({ status: "error", error_type: "source_read_error" });
  await mkdir(join(root, ".stratum")); await symlink(await scratch(), join(root, ".stratum", "distill"));
  expect(await distillTool({ workspace_root: root, project_dir: project })).toMatchObject({ status: "error", error_type: "staging_error" });
});
