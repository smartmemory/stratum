import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";
import { isolatedStateRoot } from "../helpers/state-root.js";

const execFileAsync = promisify(execFile);

it("Vitest replaces inherited flow roots with an existing isolated store", () => {
  expect(process.env.STRATUM_STATE_ROOT).toMatch(/[/\\]stratum-test-flows-[^/\\]+$/);
  expect(existsSync(process.env.STRATUM_STATE_ROOT!)).toBe(true);
});

it.each([false, true])("missing-run cancellation stays isolated (explicit root: %s)", async explicit => {
  const sandbox = isolatedStateRoot();
  const decoyHome = join(sandbox, "home");
  const inheritedRoot = join(sandbox, "inherited-flows");
  const intendedRoot = explicit ? join(sandbox, "explicit-flows") : inheritedRoot;
  await mkdir(decoyHome);
  expect(existsSync(intendedRoot)).toBe(false);

  // No Vitest preload in this child. If server defaults stop honouring the env,
  // homedir() resolves to the decoy, never the developer's live home.
  const script = `
    import assert from 'node:assert/strict';
    import { Client } from '@modelcontextprotocol/sdk/client/index.js';
    import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
    import { McpError } from '@modelcontextprotocol/sdk/types.js';
    import { createMcpServer } from './src/mcp/server.ts';
    const server = await createMcpServer(${JSON.stringify(explicit ? { flowStateRoot: intendedRoot } : {})});
    const client = new Client({ name: 'store-isolation', version: '0' });
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      await assert.rejects(
        client.callTool({ name: 'stratum_flow_cancel', arguments: { runId: 'no-such-run-isolation' } }),
        error => error instanceof McpError && /ENOENT|no such run|not found/i.test(error.message),
      );
    } finally {
      await client.close();
      await server.close();
    }
  `;
  await execFileAsync(process.execPath, [
    "--import", new URL("../helpers/source-loader.mjs", import.meta.url).href,
    "--input-type=module", "-e", script,
  ], {
    cwd: new URL("../../", import.meta.url),
    env: {
      ...process.env, NODE_OPTIONS: "", HOME: decoyHome, USERPROFILE: decoyHome,
      STRATUM_STATE_ROOT: inheritedRoot, STRATUM_PEER_REGISTER: "0",
      NODE_ENV: "test", STRATUM_JUDGE_BACKEND: "fixture", STRATUM_JUDGE_FIXTURE: "{}",
    },
    timeout: 15_000,
  });

  expect(existsSync(join(decoyHome, ".stratum"))).toBe(false);
  // Acquiring the lock creates the root even for a missing run; release removes
  // the transient lock. This proves the write path was exercised in our root.
  expect(await readdir(intendedRoot)).toEqual([]);
  expect((await readdir(sandbox)).sort()).toEqual([
    explicit ? "explicit-flows" : "inherited-flows", "home",
  ].sort());
});
