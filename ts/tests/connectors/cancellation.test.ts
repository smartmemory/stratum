import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
import { ClaudeConnector, type QueryFunction } from "../../src/connectors/claude.js";
import { CodexConnector, type SpawnProcess } from "../../src/connectors/codex.js";
import { runAgent } from "../../src/connectors/runner.js";
import type { SpawnOptions as ClaudeSpawnOptions } from "@anthropic-ai/claude-agent-sdk";

function writerScript(path: string): string {
  const child = `const fs = require('node:fs'); process.on('SIGTERM',()=>{}); setInterval(()=>fs.appendFileSync(${JSON.stringify(path)}, 'child\\n'), 10)`;
  return `const {spawn}=require('node:child_process'); const fs=require('node:fs'); process.on('SIGTERM',()=>{}); spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'inherit'}); setInterval(()=>fs.appendFileSync(${JSON.stringify(path)},'parent\\n'),10)`;
}
async function waitForDescendant(path: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if ((await readFile(path, "utf8").catch(() => "")).includes("child")) return;
    await delay(10);
  }
  throw new Error("descendant writer never started");
}

describe("foreground cancellation at the real OS process boundary", () => {
  for (const provider of ["codex", "claude"] as const) {
    it(`${provider} kills descendant writers before settling cancellation`, async () => {
      const root = await mkdtemp(join(tmpdir(), "stratum-cancel-"));
      const path = join(root, "writes");
      const controller = new AbortController();
      const script = writerScript(path);
      let run: Promise<unknown> | undefined;
      try {
        if (provider === "codex") {
          const boundary: SpawnProcess = (_command, _args, options) => spawn(process.execPath, ["-e", script], options);
          run = new CodexConnector({ cwd: root, signal: controller.signal, ownProcessGroup: true, cancellationGraceMs: 60, spawn: boundary }).run("fixture");
        } else {
          const query: QueryFunction = async function* ({ options }) {
            const control = options!.abortController as AbortController;
            const childSpawn = options!.spawnClaudeCodeProcess as (options: ClaudeSpawnOptions) => unknown;
            childSpawn({ command: process.execPath, args: ["-e", script], cwd: root, env: process.env, signal: new AbortController().signal });
            await new Promise<void>((resolve) => control.signal.addEventListener("abort", () => resolve(), { once: true }));
            control.signal.throwIfAborted();
          };
          run = new ClaudeConnector({ cwd: root, signal: controller.signal, ownProcessGroup: true, cancellationGraceMs: 60, query }).run("fixture");
        }
        const outcome = run.catch((error: unknown) => error);
        await waitForDescendant(path);
        controller.abort(new Error("test cancellation"));
        expect(await outcome).toBeInstanceOf(Error);
        const stopped = await readFile(path, "utf8");
        await delay(120);
        expect(await readFile(path, "utf8")).toBe(stopped);
      } finally {
        controller.abort();
        await run?.catch(() => {});
        await rm(root, { recursive: true, force: true });
      }
    });
  }

  it("rejects pre-aborted execution without spawning any provider", async () => {
    const controller = new AbortController();
    controller.abort(new Error("already cancelled"));
    const query = vi.fn<QueryFunction>();
    await expect(runAgent({ agent: "claude", prompt: "p", signal: controller.signal }, { claudeQuery: query })).rejects.toThrow("already cancelled");
    expect(query).not.toHaveBeenCalled();
  });

  it("propagates cancellation to an injected Codex SDK and awaits its cleanup", async () => {
    const controller = new AbortController();
    let cleaned = false;
    let began!: () => void;
    const started = new Promise<void>((resolve) => { began = resolve; });
    const run = new CodexConnector({ signal: controller.signal, sdkFactory: () => ({ startThread: () => ({
      runStreamed: async (_prompt, options) => ({ events: (async function* () {
        began();
        await new Promise<void>((resolve) => options!.signal!.addEventListener("abort", () => resolve(), { once: true }));
        await delay(20);
        cleaned = true;
        options!.signal!.throwIfAborted();
      })() }),
    }) }) }).run("p");
    const outcome = run.catch((error: unknown) => error);
    await started;
    controller.abort(new Error("cancel"));
    await outcome;
    expect(cleaned).toBe(true);
  });
});


it("resolves a real pinned CLI for cancellable SDK-default runs without a paid call", () => {
  // Native Node checks package export resolution; Vite replaces import.meta.
  const moduleUrl = new URL("../../src/connectors/codex.ts", import.meta.url).href;
  const hooks = fileURLToPath(new URL("../../src/connectors/claude-bg-worker-hooks.mjs", import.meta.url));
  const version = spawnSync(process.execPath, ["--import", hooks, "--input-type=module", "-e",
    `import {bundledCodexCommand} from ${JSON.stringify(moduleUrl)}; import {spawnSync} from 'node:child_process'; const c=bundledCodexCommand(); const r=spawnSync(c.command,[...c.prefix,'--version'],{encoding:'utf8'}); process.stdout.write(r.stdout || ''); process.stderr.write(r.stderr || ''); process.exit(r.status ?? 1);`,
  ], { encoding: "utf8" });
  expect(version.status, version.stderr).toBe(0);
  expect(version.stdout).toMatch(/codex-cli/);
});


it("waits for an in-flight event callback after the Codex child closes on abort", async () => {
  const controller = new AbortController();
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let entered!: () => void;
  const callbackStarted = new Promise<void>((resolve) => { entered = resolve; });
  let exited!: () => void;
  const childClosed = new Promise<void>((resolve) => { exited = resolve; });
  const boundary: SpawnProcess = (_command, _args, options) => {
    const child = spawn(process.execPath, ["-e", `console.log(JSON.stringify({type:'thread.started',thread_id:'fixture'})); setInterval(()=>{},1000)`], options);
    child.once("close", () => exited());
    return child;
  };
  let settled = false;
  let callbackFinished = false;
  const run = new CodexConnector({ signal: controller.signal, ownProcessGroup: true, cancellationGraceMs: 60, spawn: boundary, onEvent: async () => {
    entered(); await held; callbackFinished = true;
  } }).run("fixture").catch((error: unknown) => error).finally(() => { settled = true; });
  try {
    await callbackStarted;
    controller.abort(new Error("cancel after callback starts"));
    await childClosed;
    await delay(0);
    expect(settled).toBe(false);
    release();
    expect(await run).toBeInstanceOf(Error);
    expect(callbackFinished).toBe(true);
  } finally { release(); controller.abort(); await run; }
});

it("contains rejected event callbacks and terminates the active Codex child", async () => {
  const controller = new AbortController();
  const fallback = setTimeout(() => controller.abort(new Error("cleanup deadline")), 2_000);
  const boundary: SpawnProcess = (_command, _args, options) => spawn(process.execPath, ["-e",
    `console.log(JSON.stringify({type:'thread.started',thread_id:'fixture'})); setInterval(()=>{},1000)`,
  ], options);
  const callbackError = new Error("event ledger failed");
  try {
    await expect(new CodexConnector({ signal: controller.signal, ownProcessGroup: true, cancellationGraceMs: 60, spawn: boundary, onEvent: async () => { throw callbackError; } }).run("fixture"))
      .rejects.toBe(callbackError);
  } finally { clearTimeout(fallback); controller.abort(); }
});

it('missing bundled package does not break construction, falls back to PATH, and fails clearly only at run time', () => {
  const moduleUrl = new URL('../../src/connectors/codex.ts', import.meta.url).href;
  const hooks = fileURLToPath(new URL('../../src/connectors/claude-bg-worker-hooks.mjs', import.meta.url));
  const probe = spawnSync(process.execPath, ['--import', hooks, '--input-type=module', '-e', `
    import Module from 'node:module';
    import assert from 'node:assert/strict';
    import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
    import {tmpdir} from 'node:os';import {join} from 'node:path';
    import {CodexConnector,bundledCodexCommand} from ${JSON.stringify(moduleUrl)};
    const original=Module._resolveFilename;
    Module._resolveFilename=function(name,...args){if(name==='@openai/codex/package.json')throw new Error('missing optional CLI');return original.call(this,name,...args)};
    const root=mkdtempSync(join(tmpdir(),'missing-codex-'));
    try {
      const connector=new CodexConnector({ownProcessGroup:true,env:{PATH:root}});
      await assert.rejects(connector.run('never dispatched'),/Codex CLI unavailable.*PATH.*bundled CLI/);
      const cli=join(root,'codex');writeFileSync(cli,'fixture',{mode:0o755});
      assert.equal(bundledCodexCommand({PATH:root}).command,cli);
      console.log('lazy resolver verified');
    } finally {Module._resolveFilename=original;rmSync(root,{recursive:true,force:true})}
  `], { encoding: 'utf8' });
  expect(probe.status, probe.stderr).toBe(0);
  expect(probe.stdout).toContain('lazy resolver verified');
});
