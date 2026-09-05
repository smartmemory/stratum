import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { it, expect, vi } from 'vitest';
import { codexCommand, CodexConnector, resolveCodexCommand } from '../../src/connectors/codex.js';
import { ClaudeConnector, type QueryFunction } from '../../src/connectors/claude.js';
import { cancellationGraceMs, requireProcessGroups } from '../../src/connectors/cancellation.js';
import { runAgent, validateAgentSettings } from '../../src/connectors/runner.js';
import { createToolDispatcher } from '../../src/mcp/server.js';
import type { SpawnOptions } from '@anthropic-ai/claude-agent-sdk';

/** Runs `body` with process.platform reporting `platform`, then restores it. */
async function onPlatform<T>(platform: string, body: () => Promise<T>): Promise<T> {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { ...original, value: platform });
  try { return await body(); } finally { Object.defineProperty(process, 'platform', original); }
}

it('signal presence preserves SDK transport; explicit ownership selects exec and detached only there', async () => {
  let sdkCalls = 0;
  await new CodexConnector({ signal: new AbortController().signal, env: { STRATUM_CODEX_TRANSPORT: 'sdk' },
    sdkFactory: () => ({ startThread: () => ({ runStreamed: async () => ({ events: (async function* () { sdkCalls++; })() }) }) }),
  }).run('fixture');
  expect(sdkCalls).toBe(1);
  for (const ownProcessGroup of [false, true]) {
    let detached: boolean | undefined;
    await new CodexConnector({ ownProcessGroup, signal: new AbortController().signal, spawn: (_command, _args, options) => {
      detached = options.detached;
      return spawn(process.execPath, ['-e', 'process.stdin.resume()'], options);
    } }).run('fixture');
    expect(detached).toBe(ownProcessGroup);
  }
});

it('resolves the PATH CLI at execution time, including when installed after construction', async () => {
  const root = await mkdtemp(join(tmpdir(), 'codex-path-'));
  try {
    const connector = new CodexConnector({ cwd: root, ownProcessGroup: true, env: { PATH: root } });
    await writeFile(join(root, 'codex'), `#!${process.execPath}\nprocess.stdin.resume(); console.log(JSON.stringify({type:'item.completed',item:{type:'agent_message',text:'path-cli'}}));`, { mode: 0o755 });
    expect(resolveCodexCommand({ PATH: root }).command).toBe(join(root, 'codex'));
    expect((await connector.run('fixture')).text).toBe('path-cli');
    let sdkBinary: string | undefined;
    await new CodexConnector({ env: { PATH: root, STRATUM_CODEX_TRANSPORT: 'sdk' }, signal: new AbortController().signal,
      sdkFactory: options => { sdkBinary = options.codexPathOverride; return { startThread: () => ({ runStreamed: async () => ({ events: (async function* () {})() }) }) }; },
    }).run('fixture');
    expect(sdkBinary).toBe(join(root, 'codex'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('defaults to five seconds and refuses unsupported Windows tree cancellation before spawn', () => {
  expect(cancellationGraceMs({})).toBe(5000);
  expect(() => requireProcessGroups('win32')).toThrow(/Windows tree cancellation is unsupported/);
});

for (const provider of ['codex', 'claude'] as const) {
  it(`${provider} sends TERM first and allows cleanup before close`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'grace-'));
    const control = new AbortController();
    let child!: ReturnType<typeof spawn>;
    const script = `const fs=require('fs'); process.on('SIGTERM',()=>{fs.writeFileSync('term','clean');setTimeout(()=>process.exit(0),30)});fs.writeFileSync('ready','yes');setInterval(()=>{},100)`;
    let run: Promise<unknown>;
    if (provider === 'codex') run = new CodexConnector({ cwd: root, ownProcessGroup: true, signal: control.signal, cancellationGraceMs: 500,
      spawn: (_command, _args, options) => child = spawn(process.execPath, ['-e', script], options),
    }).run('fixture');
    else run = new ClaudeConnector({ cwd: root, signal: control.signal, ownProcessGroup: true, cancellationGraceMs: 500, query: async function* ({ options }) {
      const handle = (options!.spawnClaudeCodeProcess as (o: SpawnOptions) => ReturnType<typeof spawn>)({command: process.execPath,args:['-e',script],cwd:root,env:process.env,signal:control.signal});
      await new Promise<void>(resolve => handle.once('close', () => resolve()));
      control.signal.throwIfAborted();
    } }).run('fixture');
    const outcome = run.catch(error => error);
    try {
      for (let i = 0; i < 200; i++) { if (await readFile(join(root, 'ready')).catch(() => null)) break; await delay(10); }
      expect(await readFile(join(root, 'ready'), 'utf8')).toBe('yes');
      control.abort(new Error('stop'));
      expect(await outcome).toBeInstanceOf(Error);
      expect(await readFile(join(root, 'term'), 'utf8')).toBe('clean');
      if (child) expect(child.exitCode).toBe(0);
    } finally { control.abort(); await outcome; await rm(root, { recursive: true, force: true }); }
  });
}

it('Claude failure retains bounded child stderr, split, and provider cost', async () => {
  const control = new AbortController();
  const connector = new ClaudeConnector({ signal: control.signal, ownProcessGroup: true, query: async function* ({ options }) {
    const child = (options!.spawnClaudeCodeProcess as (o: SpawnOptions) => ReturnType<typeof spawn>)({command:process.execPath,args:['-e',`process.stderr.write('x'.repeat(20000)+'fatal diagnostic')`],cwd:process.cwd(),env:process.env,signal:control.signal});
    await new Promise<void>(resolve => child.once('close', () => resolve()));
    yield { type: 'result', subtype: 'error_during_execution', errors: ['provider failed'], total_cost_usd: 0.3, duration_ms: 12,
      usage: { input_tokens: 7, output_tokens: 4, cache_read_input_tokens: 3, cache_creation_input_tokens: 2 } };
  } });
  const error = await connector.run('fixture').catch(error => error);
  expect(error.message).toBe('provider failed');
  expect(error.usage).toEqual({ tokens: 11, usd: 0.3, ms: 12 });
  expect(error.split).toEqual({ input: 7, output: 4, cacheRead: 3, cacheCreation: 2 });
  expect(error.usdSource).toBe('reported');
  expect(error.stderr.length).toBeLessThanOrEqual(16384);
  expect(error.stderr).toMatch(/fatal diagnostic$/);
});

for (const transport of ['sdk', 'exec'] as const) {
  it(`Codex ${transport} failure preserves accumulated tokens and reported cost`, async () => {
    const events = [
      { type: 'turn.completed', usage: { input_tokens: 9, output_tokens: 3, cached_input_tokens: 2, total_cost_usd: 0.2 } },
      { type: 'turn.failed', error: { message: 'provider failed' } },
    ];
    const connector = new CodexConnector(transport === 'sdk' ? { sdkFactory: () => ({ startThread: () => ({
      runStreamed: async () => ({ events: (async function* () { yield* events as any; })() }),
    }) }) } : { spawn: (_command, _args, options) => spawn(process.execPath, ['-e', `process.stdin.resume();${events.map(e => `console.log(${JSON.stringify(JSON.stringify(e))})`).join(';')}`], options) });
    const error = await connector.run('fixture').catch(error => error);
    expect(error.message).toBe('provider failed');
    expect(error.usage).toMatchObject({ tokens: 12, usd: 0.2 });
    expect(error.split).toEqual({ input: 9, output: 3, cacheRead: 2 });
    expect(error.usdSource).toBe('reported');
  });
}

// S1: MCP always supplies a request-scoped extra.signal, so a signal alone must not
// demand POSIX process groups. Gating on the signal made EVERY MCP Claude dispatch
// throw CANCELLATION_UNSUPPORTED_PLATFORM before spawn on Windows.
it('Claude launches on Windows without ownership and refuses only the cancellable path', async () => {
  const hooked: boolean[] = [];
  const query: QueryFunction = async function* ({ options }) {
    hooked.push(typeof options!.spawnClaudeCodeProcess === 'function');
    yield { type: 'result', subtype: 'success', result: 'launched', duration_ms: 1 };
  };
  await onPlatform('win32', async () => {
    // A non-cancellable run still carries a signal; it must launch, with no spawn hook.
    const launched = await runAgent({ agent: 'claude', prompt: 'p', signal: new AbortController().signal }, { claudeQuery: query });
    expect(launched).toMatchObject({ text: 'launched' });
    // Asking for process-group ownership is the only thing Windows cannot honour.
    await expect(runAgent({ agent: 'claude', prompt: 'p', ownProcessGroup: true, signal: new AbortController().signal }, { claudeQuery: query }))
      .rejects.toMatchObject({ code: 'CANCELLATION_UNSUPPORTED_PLATFORM' });
  });
  // Ownership installs the custom spawn hook; a bare signal does not.
  await runAgent({ agent: 'claude', prompt: 'p', ownProcessGroup: true, signal: new AbortController().signal }, { claudeQuery: query });
  expect(hooked).toEqual([false, true]);
});

// S1 (surface): the MCP server may claim ownership only when a cancellationId was
// supplied — the same rule Codex already followed.
it('the MCP surface claims Claude process-group ownership only for cancellable runs', async () => {
  const claimed: Array<boolean | undefined> = [];
  const dispatcher = createToolDispatcher({ runAgent: async options => {
    claimed.push(options.ownProcessGroup);
    return { text: 'ok', usage: {}, telemetry: { model: 'fixture', durationMs: 0 } };
  } });
  const extra = new AbortController().signal;
  await dispatcher.call('stratum_agent_run', { agent: 'claude', prompt: 'p', cwd: process.cwd() }, { signal: extra });
  await dispatcher.call('stratum_agent_run', { agent: 'claude', prompt: 'p', cwd: process.cwd(), cancellationId: randomUUID() }, { signal: extra });
  expect(claimed).toEqual([undefined, true]);
});

// S4: codex exits nonzero on some sandbox denials AFTER emitting a complete
// agent_message. That output is usable and must not be discarded.
it('keeps Codex output when the child emits a complete message and then exits nonzero', async () => {
  const message = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'usable answer' } });
  const withText = `process.stdin.resume(); console.log(${JSON.stringify(message)}); process.stderr.write('sandbox denied'); setTimeout(()=>process.exit(3), 10)`;
  const result = await new CodexConnector({ spawn: (_c, _a, options) => spawn(process.execPath, ['-e', withText], options) }).run('fixture');
  expect(result.text).toBe('usable answer');
  // A nonzero exit that produced no agent text at all is still a failure.
  const noText = `process.stdin.resume(); process.stderr.write('hard failure'); setTimeout(()=>process.exit(3), 10)`;
  await expect(new CodexConnector({ spawn: (_c, _a, options) => spawn(process.execPath, ['-e', noText], options) }).run('fixture'))
    .rejects.toThrow('hard failure');
});

// S8: a child that emits `error` and never emits `close` must not hang the run.
it('settles a Codex run whose child reports an error and never closes', async () => {
  const child = Object.assign(new EventEmitter(), {
    pid: undefined, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: () => true, killed: false, exitCode: null,
  });
  const run = new CodexConnector({ spawn: () => {
    setTimeout(() => child.emit('error', new Error('spawn codex ENOENT')), 0);
    return child as never;
  } }).run('fixture');
  await expect(run).rejects.toThrow('spawn codex ENOENT');
});

// S12: an overrun child is emitting output we can no longer parse, so the grace window
// buys nothing. The group is SIGKILLed at once rather than after cancellationGraceMs.
it('SIGKILLs the Codex group immediately on a stdout overrun', async () => {
  const root = await mkdtemp(join(tmpdir(), 'overrun-'));
  try {
    // The child records SIGTERM, so a graceful teardown would leave the file behind.
    vi.stubEnv('STRATUM_CODEX_STREAM_LIMIT_BYTES', '1'); // floors to 64 KiB
    const script = `const fs=require('fs');process.on('SIGTERM',()=>fs.writeFileSync(${JSON.stringify(join(root, 'term'))},'graceful'));`
      + `process.stdin.resume();console.log('x'.repeat(200000));setInterval(()=>{},50)`;
    const started = Date.now();
    await expect(new CodexConnector({ cwd: root, ownProcessGroup: true, cancellationGraceMs: 5_000,
      spawn: (_c, _a, options) => spawn(process.execPath, ['-e', script], options),
    }).run('fixture')).rejects.toThrow(/exceeded STRATUM_CODEX_STREAM_LIMIT_BYTES/);
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(await readFile(join(root, 'term'), 'utf8').catch(() => null)).toBeNull();
  } finally { vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true }); }
});

// S9: the leader's `close` says nothing about the rest of its group. Cancellation is
// acknowledged only once every member has been reaped.
it('reaps the whole process group before a cancelled run settles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'reap-'));
  const control = new AbortController();
  let pid: number | undefined;
  let run: Promise<unknown> | undefined;
  try {
    const grandchild = `process.on('SIGTERM',()=>{}); setInterval(()=>{},20)`;
    const script = `const {spawn}=require('node:child_process');const fs=require('fs');`
      + `spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'});`
      + `fs.writeFileSync(${JSON.stringify(join(root, 'ready'))},'yes');setInterval(()=>{},20)`;
    run = new CodexConnector({ cwd: root, ownProcessGroup: true, signal: control.signal, cancellationGraceMs: 60,
      spawn: (_c, _a, options) => { const child = spawn(process.execPath, ['-e', script], options); pid = child.pid; return child; },
    }).run('fixture').catch((error: unknown) => error);
    for (let i = 0; i < 300; i++) { if (await readFile(join(root, 'ready'), 'utf8').catch(() => null)) break; await delay(10); }
    control.abort(new Error('stop'));
    expect(await run).toBeInstanceOf(Error);
    // The run has settled, so nothing in the group may still be alive.
    expect(() => process.kill(-pid!, 0)).toThrow(expect.objectContaining({ code: 'ESRCH' }));
  } finally { control.abort(); await run; await rm(root, { recursive: true, force: true }); }
});

// S10: the signal the SDK asks for is the signal that gets sent first, and the handle
// exposes the stderr the connector itself reads. A child that IGNORES SIGTERM proves it:
// downgrading the request to SIGTERM would leave it alive for the whole grace window.
it('passes the SDK-requested kill signal through and exposes child stderr', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sdk-kill-'));
  const control = new AbortController();
  try {
    const script = `const fs=require('fs');process.on('SIGTERM',()=>{});`
      + `process.stderr.write('child diagnostic');fs.writeFileSync(${JSON.stringify(join(root, 'ready'))},'yes');setInterval(()=>{},20)`;
    const result = await new ClaudeConnector({ cwd: root, ownProcessGroup: true, cancellationGraceMs: 30_000, signal: control.signal,
      query: async function* ({ options }) {
        const handle = (options!.spawnClaudeCodeProcess as (o: SpawnOptions) => {
          pid?: number; stderr?: NodeJS.ReadableStream; kill: (signal?: NodeJS.Signals) => boolean;
        })({ command: process.execPath, args: ['-e', script], cwd: root, env: process.env, signal: control.signal });
        expect(handle.stderr).toBeDefined();
        for (let i = 0; i < 300; i++) { if (await readFile(join(root, 'ready'), 'utf8').catch(() => null)) break; await delay(10); }
        handle.kill('SIGKILL');
        // A 30s grace window is never entered, so the group is gone almost at once.
        const gone = await Promise.race([
          (async () => { for (;;) { try { process.kill(-handle.pid!, 0); } catch { return true; } await delay(10); } })(),
          delay(2_000).then(() => false),
        ]);
        expect(gone).toBe(true);
        yield { type: 'result', subtype: 'success', result: 'done', duration_ms: 1 };
      } }).run('fixture');
    expect(result.text).toBe('done');
  } finally { control.abort(); await rm(root, { recursive: true, force: true }); }
});

// S5: validateAgentSettings runs before the background branch, so the D5/BG-WRITE-A
// forwarding of tool filters to a background CODEX run was unreachable. Background codex
// genuinely cannot honour them, so rejection is the consistent behaviour on both paths
// and the spread is now claude-only rather than dead.
it('rejects Claude tool filters for codex on both paths, and its argv carries none', async () => {
  for (const background of [false, true]) {
    await expect(runAgent({ agent: 'codex', prompt: 'p', background, allowedTools: ['Read'] }))
      .rejects.toThrow(/Codex does not support Claude thinking\/tool filters/);
    await expect(runAgent({ agent: 'codex', prompt: 'p', background, thinking: { type: 'enabled' } }))
      .rejects.toThrow(/Codex does not support Claude thinking\/tool filters/);
  }
  // The durable background codex argv has no tool-filter surface at all, which is
  // why forwarding one would have been a guarantee the wrapper could not keep.
  const argv = codexCommand('gpt-5.6-terra/high', process.cwd(), 'read-only').join(' ');
  expect(argv).not.toMatch(/tool/i);
  // Claude keeps the filters: they are rejected for codex, not dropped globally.
  expect(() => validateAgentSettings({ agent: 'claude', allowedTools: ['Read'], disallowedTools: ['Bash'] })).not.toThrow();
});
