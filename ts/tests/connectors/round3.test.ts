import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { processTermination } from '../../src/connectors/cancellation.js';
import { createToolDispatcher } from '../../src/mcp/server.js';

it('rejects teardown when the leader closes but the group survives the reap bound', async () => {
  const child = Object.assign(new EventEmitter(), { pid: 123456 }) as ChildProcess;
  const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
  try {
    const termination = processTermination(child, true, 0, 20);
    const result = termination.terminate('SIGKILL');
    child.emit('close', 0);
    await expect(result).rejects.toMatchObject({ code: 'CANCELLATION_TEARDOWN_TIMEOUT' });
  } finally { kill.mockRestore(); }
});

it('waits until ESRCH instead of treating leader close as group completion', async () => {
  const child = Object.assign(new EventEmitter(), { pid: 123456 }) as ChildProcess;
  let probes = 0;
  const kill = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
    if (signal === 0 && ++probes >= 4) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    return true;
  });
  try {
    const termination = processTermination(child, true, 0, 100);
    const result = termination.terminate('SIGKILL');
    child.emit('close', 0);
    await result;
    expect(probes).toBe(4);
  } finally { kill.mockRestore(); }
});

it('never acknowledges a failed teardown, including repeated cancel requests', async () => {
  let began!: () => void;
  const started = new Promise<void>(resolve => { began = resolve; });
  const dispatcher = createToolDispatcher({ runAgent: async ({ signal }) => {
    began();
    await new Promise<void>(resolve => signal!.addEventListener('abort', () => resolve(), { once: true }));
    throw Object.assign(new Error('group survived'), { code: 'CANCELLATION_TEARDOWN_TIMEOUT' });
  } });
  const id = randomUUID();
  const run = dispatcher.call('stratum_agent_run', { agent: 'claude', prompt: 'p', cwd: process.cwd(), cancellationId: id }).catch(error => error);
  await started;
  await expect(dispatcher.call('stratum_cancel_agent_run', { runId: id })).rejects.toMatchObject({ data: { code: 'CANCELLATION_TEARDOWN_TIMEOUT' } });
  expect(await run).toMatchObject({ data: { code: 'CANCELLATION_TEARDOWN_TIMEOUT' } });
  await expect(dispatcher.call('stratum_cancel_agent_run', { runId: id })).rejects.toMatchObject({ data: { code: 'CANCELLATION_TEARDOWN_TIMEOUT' } });
});

it('an emergency SIGKILL escalates an already-running graceful teardown immediately', async () => {
  const signals: unknown[] = [];
  const child = Object.assign(new EventEmitter(), { pid: 123456 }) as ChildProcess;
  let alive = true;
  const kill = vi.spyOn(process, 'kill').mockImplementation((_pid, signal) => {
    signals.push(signal);
    if (signal === 'SIGKILL') { alive = false; queueMicrotask(() => child.emit('close', 1)); }
    if (signal === 0 && !alive) throw Object.assign(new Error('gone'), { code: 'ESRCH' });
    return true;
  });
  const termination = processTermination(child, true, 100);
  const result = termination.terminate();
  try {
    expect(termination.terminate('SIGKILL')).toBe(result);
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(signals).toContain('SIGKILL');
  } finally { await result; kill.mockRestore(); }
});
