import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { expect, it } from "vitest";
import { bundleIdForRules } from "../../src/policy/bundle.js";

const execFileAsync = promisify(execFile);
const loader = fileURLToPath(new URL("../helpers/source-loader.mjs", import.meta.url));
const guardIsolation = fileURLToPath(new URL("../helpers/isolated-guard.mjs", import.meta.url));
const main = fileURLToPath(new URL("../../src/mcp/main.ts", import.meta.url));
const cli = fileURLToPath(new URL("../../src/cli/stratum.ts", import.meta.url));

it("plans through real stdio with clean JSON-RPC, rejects bad inputs without files, and exposes the run to the native CLI", async () => {
  const root = await mkdtemp(join(tmpdir(), "stratum-stdio-plan-"));
  const stateRoot = join(root, "state");
  await mkdir(stateRoot);
  // No inherited credentials or live state; all work remains client-driven.
  const env = { PATH: process.env.PATH ?? "", STRATUM_STATE_ROOT: stateRoot, STRATUM_TEST_GUARD_ROOT: join(root, "guard"), SMARTMEMORY_API_URL: "", SMARTMEMORY_API_KEY: "", SMARTMEMORY_WORKSPACE_ID: "", STRATUM_LEARN: "0" };
  const transport = new StdioClientTransport({ command: process.execPath, args: ["--import", loader, "--import", guardIsolation, main], env, stderr: "pipe", cwd: root });
  const client = new Client({ name: "stdio-planning-regression", version: "1" });
  const errors: Error[] = [];
  client.onerror = (error) => errors.push(error);
  let stderr = "";
  transport.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  const spec = { version: 1, contracts: { Result: { value: "string" } }, flows: { entry: "main", main: {
    input: { name: "string" }, output: { from: "${finish.output}", contract: "Result" },
    steps: [{ id: "finish", do: "Handle ${input.name}", out: "Result" }],
  } } };
  const rules = [{ rule_id: "stdio#0", source: { record_id: "stdio", memory_type: "decision" as const, version: 1, content_hash: "a".repeat(64), chain_hash: "b".repeat(64), workspace_id: "fixture" }, bind: { kind: "ensure" as const, step_selector: "finish" }, predicate: { expr: "result.value == input.name" }, on_fail: "refuse" as const }];
  const policy_bundle = { bundle_id: bundleIdForRules(rules), workspace_id: "fixture", compiled_at: "2026-09-05T00:00:00.000Z", selector: { status: ["active"] }, rules };
  try {
    await client.connect(transport);
    for (const input of [{ name: 123 }, {}, { name: "Ada", extra: true }]) {
      await expect(client.callTool({ name: "stratum_plan", arguments: { spec, input } })).rejects.toMatchObject({
        code: -32602, data: { code: "input_validation_failed", errors: [{ code: "INPUT_CONTRACT_INVALID" }] },
      });
      expect(await readdir(stateRoot)).toEqual([]);
    }
    const result = await client.callTool({ name: "stratum_plan", arguments: { spec, input: { name: "Ada" }, policy_bundle } });
    expect(result.structuredContent).toMatchObject({ status: "ready", ready: [{ do: "Handle Ada" }] });
    const runId = (result.structuredContent as { runId: string }).runId;
    const persisted = JSON.parse(await readFile(join(stateRoot, `${runId}.json`), "utf8"));
    expect(persisted.input).toEqual({ name: "Ada" });
    expect(persisted.bundle_id).toBe(policy_bundle.bundle_id);
    expect(persisted.spec.flows.main.steps[0].ensure).toEqual([rules[0]!.predicate]);
    // The real reader must see exactly the run the MCP writer persisted.
    const query = await execFileAsync(process.execPath, ["--import", loader, cli, "query", "flows"], { env, cwd: root });
    expect(JSON.parse(query.stdout)).toMatchObject([{ flow_id: runId, flow_name: "main", status: "running", current_step_id: "finish" }]);
    const specPath = join(root, "flow.json");
    await writeFile(specPath, JSON.stringify(spec));
    const validation = await execFileAsync(process.execPath, ["--import", loader, cli, "validate", specPath], { env, cwd: root });
    expect(JSON.parse(validation.stdout)).toEqual({ valid: true });
    expect(stderr).toContain(`policy bundle ${policy_bundle.bundle_id}: 1 rules bound to 1 step-predicate pairs`);
    const registration = {
      resource_id: "stdio-backfill", graph: { draft: ["done"], done: [] },
      edge_predicates: { "draft->done": [] }, initial: "draft", terminal: ["done"], workspace_root: root,
    };
    const registered = await client.callTool({ name: "stratum_guard_register", arguments: registration });
    expect(registered.structuredContent, JSON.stringify(registered.structuredContent)).toMatchObject({ status: "registered" });
    const emptyPolicy = { ...policy_bundle, bundle_id: bundleIdForRules([]), rules: [] };
    const backfill = await client.callTool({ name: "stratum_guard_register", arguments: { ...registration, policy_bundle: emptyPolicy } });
    expect(backfill.structuredContent).toMatchObject({ status: "exists" });
    expect(stderr).toContain(`guard stdio-backfill: refreshed bundle_id from <unset> to ${emptyPolicy.bundle_id}`);
    expect(errors).toEqual([]);
  } finally {
    await client.close();
    await rm(root, { recursive: true, force: true });
  }
}, 20_000);
