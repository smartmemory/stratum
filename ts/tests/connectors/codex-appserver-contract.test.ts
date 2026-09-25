import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertAppServerIdentity, SUPPORTED_APP_SERVER_VERSIONS } from "../../src/connectors/codex-appserver-contract.js";
import { PINNED_MANIFEST_SHA256 } from "../../src/connectors/codex-appserver-protocol/pinned-version.js";
import type { InitializeResponse } from "../../src/connectors/codex-appserver-protocol/InitializeResponse.js";
import type { CommandExecutionRequestApprovalResponse } from "../../src/connectors/codex-appserver-protocol/v2/CommandExecutionRequestApprovalResponse.js";
import type { FileChangeRequestApprovalResponse } from "../../src/connectors/codex-appserver-protocol/v2/FileChangeRequestApprovalResponse.js";
import type { ExecCommandApprovalResponse } from "../../src/connectors/codex-appserver-protocol/ExecCommandApprovalResponse.js";
import type { ApplyPatchApprovalResponse } from "../../src/connectors/codex-appserver-protocol/ApplyPatchApprovalResponse.js";
import type { PermissionsRequestApprovalResponse } from "../../src/connectors/codex-appserver-protocol/v2/PermissionsRequestApprovalResponse.js";
import type { McpServerElicitationRequestResponse } from "../../src/connectors/codex-appserver-protocol/v2/McpServerElicitationRequestResponse.js";
import type { UserInput } from "../../src/connectors/codex-appserver-protocol/v2/UserInput.js";
import type { ServerRequest } from "../../src/connectors/codex-appserver-protocol/ServerRequest.js";

const adapterUrl = new URL("../../scripts/pin-codex-appserver.mjs", import.meta.url).href;
const adapter = await import(adapterUrl) as {
  fixtureDir: string;
  checkGenerated(generated: string, raw?: string): Promise<number>;
  sha256(value: string): string;
  checkContract(raw?: string, adapted?: string): Promise<{version: string; rawFiles: number; adaptedFiles: number}>;
};
const identity = {
  userAgent:"stratum-peer3-probe/0.155.1 (Mac OS 26.7.0; arm64) iTerm.app/3.6.11 (stratum-peer3-probe; 0.1.0)",
  codexHome:"/home/example/.codex",platformFamily:"unix",platformOs:"macos",
} satisfies InitializeResponse;

describe("pinned app-server contract", () => {
  it("verifies every raw hash and exact import-only adaptation", async () => {
    expect(await adapter.checkContract()).toMatchObject({version:"0.155.1"});
    const rawManifest = await readFile(join(adapter.fixtureDir,"manifest.json"),"utf8");
    expect(SUPPORTED_APP_SERVER_VERSIONS).toEqual([JSON.parse(rawManifest).version]);
    expect(PINNED_MANIFEST_SHA256).toBe(adapter.sha256(rawManifest));
  });
  it("detects raw-byte and adapted-byte mutations", async () => {
    const dir = await mkdtemp(join(tmpdir(),"peer3-contract-"));
    try {
      const raw = join(dir,"raw"), adapted = join(dir,"adapted");
      await cp(adapter.fixtureDir,raw,{recursive:true});
      await cp(new URL("../../src/connectors/codex-appserver-protocol",import.meta.url),adapted,{recursive:true});
      const rawPath = join(raw,"InitializeResponse.ts"), original = await readFile(rawPath,"utf8");
      await writeFile(rawPath,original+"\n");
      await expect(adapter.checkContract(raw,adapted)).rejects.toThrow(/hash mismatch/);
      await writeFile(rawPath,original);
      await writeFile(join(adapted,"InitializeResponse.ts"),original);
      await expect(adapter.checkContract(raw,adapted)).rejects.toThrow(/beyond import normalization/);
    } finally { await rm(dir,{recursive:true,force:true}); }
  });
  it("checks full generation hashes and inventory, including files outside the closure", async () => {
    const dir = await mkdtemp(join(tmpdir(), "peer3-full-generation-"));
    try {
      const generated = join(dir, "generated"), raw = join(dir, "raw");
      await mkdir(generated); await mkdir(raw);
      const files = {"root.ts":"export type Root = string;", "unused.ts":"export type Unused = number;"};
      await writeFile(join(raw, "manifest.json"), JSON.stringify({entrypoints:["root.ts"], sha256:Object.fromEntries(Object.entries(files).map(([name, source]) => [name, adapter.sha256(source)]))}));
      for (const [name, source] of Object.entries(files)) await writeFile(join(generated, name), source);
      expect(await adapter.checkGenerated(generated, raw)).toBe(2);
      await writeFile(join(generated, "unused.ts"), "changed");
      await expect(adapter.checkGenerated(generated, raw)).rejects.toThrow(/Generated hash mismatch: unused.ts/);
      await writeFile(join(generated, "unused.ts"), files["unused.ts"]);
      await writeFile(join(generated, "extra.ts"), "");
      await expect(adapter.checkGenerated(generated, raw)).rejects.toThrow(/Generated inventory mismatch/);
      await rm(join(generated, "extra.ts"));
      await rm(join(generated, "unused.ts"));
      await expect(adapter.checkGenerated(generated, raw)).rejects.toThrow(/Generated inventory mismatch/);
    } finally { await rm(dir, {recursive:true, force:true}); }
  });
  it.each([identity.userAgent, identity.userAgent.replace(" iTerm.app/3.6.11", "")])("accepts the observed identity: %s", userAgent => {
    expect(assertAppServerIdentity(userAgent, {name:"stratum-peer3-probe",version:"0.1.0"})).toBe("0.155.1");
  });
  it("uses the CLI version, not the sent client version", () => {
    expect(assertAppServerIdentity("client/0.155.1 (Linux; x86_64) (client; 9.9.9)", {name:"client",version:"9.9.9"})).toBe("0.155.1");
  });
  it.each([
    "", "0.155.1", "client/0.155.1", "client/0.155.1 (garbage)",
    "client/0.155.1 (x) trailing junk",
    "client/0.155.1 (Mac OS; arm64) (different-client; 9.9.9)",
    "client/0.155.1 (Mac OS; arm64) (client; 9.9.9)",
    "other/0.155.1 (Mac OS; arm64) (client; 0.1.0)",
    "client/0.156.0 (Mac OS; arm64) (client; 0.1.0)",
    "client/0.155.1-preview (Mac OS; arm64) (client; 0.1.0)",
    "client/0.155.1 (Mac OS; arm64) (client; 0.1.0) junk",
    ...Array.from({length:65}, (_, i) => `client/0.155.1 (Mac${String.fromCharCode(i < 32 ? i : i + 95)} OS; arm64) (client; 0.1.0)`),
  ])("fails closed on malformed identity: %j", value => {
    expect(() => assertAppServerIdentity(value, {name:"client",version:"0.1.0"})).toThrow(/Unsupported.*identity/);
  });
});

const rejection = "unattended Stratum run: approvals are declined";
const responses = {
  "item/commandExecution/requestApproval": {decision:"decline"} satisfies CommandExecutionRequestApprovalResponse,
  "item/fileChange/requestApproval": {decision:"decline"} satisfies FileChangeRequestApprovalResponse,
  execCommandApproval: {decision:{denied:{rejection}}} satisfies ExecCommandApprovalResponse,
  applyPatchApproval: {decision:{denied:{rejection}}} satisfies ApplyPatchApprovalResponse,
  "item/permissions/requestApproval": {permissions:{},scope:"turn"} satisfies PermissionsRequestApprovalResponse,
  "mcpServer/elicitation/request": {action:"decline",content:null,_meta:null} satisfies McpServerElicitationRequestResponse,
} satisfies Partial<Record<ServerRequest["method"],unknown>>;
describe("section 4 typed unattended response fixtures", () => {
  it.each(Object.entries(responses))("pins the generated success shape for %s", (method,result) => {
    const expected: Record<string,unknown> = {
      "item/commandExecution/requestApproval":{decision:"decline"},
      "item/fileChange/requestApproval":{decision:"decline"},
      execCommandApproval:{decision:{denied:{rejection:"unattended Stratum run: approvals are declined"}}},
      applyPatchApproval:{decision:{denied:{rejection:"unattended Stratum run: approvals are declined"}}},
      "item/permissions/requestApproval":{permissions:{},scope:"turn"},
      "mcpServer/elicitation/request":{action:"decline",content:null,_meta:null},
    };
    expect(result).toEqual(expected[method]);
  });
  it("requires text_elements for a generated text input", () => {
    const input = {type:"text",text:"task",text_elements:[]} satisfies UserInput;
    expect(input).toEqual({type:"text",text:"task",text_elements:[]});
  });
});

// Exercise only reusable helpers with local Node children, never a probe mode/model turn.
const probeUrl = new URL("../../scripts/peer3-probe.mjs", import.meta.url).href;
const probe = await import(probeUrl) as {
  runBounded(command: string, args: string[], options?: { input?: string; timeoutMs?: number; maxBytes?: number }):
    Promise<{code: number | null; reason: string | null; stdout: string; stderr: string; pid: number}>;
};
describe("probe evidence and timeout helpers (no model turns)", () => {
  it("records stdout, stderr and a failed exit without losing evidence", async () => {
    const result = await probe.runBounded(process.execPath,["-e","process.stdout.write('out'); process.stderr.write('err'); process.exitCode=7"]);
    expect(result).toMatchObject({code:7,reason:null,stdout:"out",stderr:"err"});
  });
  it("bounds a stalled child and reaps its PID", async () => {
    const result = await probe.runBounded(process.execPath,["-e","setInterval(()=>{},1000)"],{timeoutMs:100});
    expect(result.reason).toBe("timeout");
    expect(() => process.kill(result.pid,0)).toThrow();
  });
  it("bounds excess output", async () => {
    const result = await probe.runBounded(process.execPath,["-e","process.stdout.write('x'.repeat(10000)); setInterval(()=>{},1000)"],{maxBytes:128});
    expect(result.reason).toBe("output-limit");
    expect(result.stdout.length).toBeLessThanOrEqual(128);
    expect(() => process.kill(result.pid,0)).toThrow();
  });
});
