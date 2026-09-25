import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
export const serverMethods = ['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'execCommandApproval', 'applyPatchApproval', 'item/permissions/requestApproval', 'mcpServer/elicitation/request', 'item/tool/requestUserInput', 'account/chatgptAuthTokens/refresh', 'attestation/generate', 'item/tool/call', 'unknown'];
export function expectedReply(method) {
  if (serverMethods.slice(0, 2).includes(method)) return { result: { decision: 'decline' } };
  if (serverMethods.slice(2, 4).includes(method)) return { result: { decision: { denied: { rejection: 'unattended Stratum run: approvals are declined' } } } };
  if (method === serverMethods[4]) return { result: { permissions: {}, scope: 'turn' } };
  if (method === serverMethods[5]) return { result: { action: 'decline', content: null, _meta: null } };
  return { error: { code: -32601, message: 'unsupported by unattended driver' } };
}
export function serveScenario(scenario = {}) {
  const send = frame => process.stdout.write(JSON.stringify(frame) + '\n');
  const notify = (method, params = {}) => send({ method, params: { threadId: 't', turnId: 'u', ...params } });
  const complete = () => notify('turn/completed', { turn: { id: 'u', status: scenario.status ?? 'completed', error: { message: 'fixture failed' } } });
  let initialized = false, started = false, requestIndex = 0;
  const nextRequest = () => {
    const method = scenario.requests?.[requestIndex];
    if (method) send({ id: `server-${requestIndex}`, method, params: {} });
    else if (!scenario.hold) complete();
  };
  if (scenario.ignoreTerm) process.on('SIGTERM', () => {});
  const lines = createInterface({ input: process.stdin });
  lines.on('line', line => {
    try {
      const frame = JSON.parse(line);
      if (frame.method === 'initialize') {
        assert.equal(started, false);
        if (scenario.reject === frame.method) return send({ id: frame.id, error: { message: 'fixture rejection' } });
        return send({ id: frame.id, result: { userAgent: scenario.identity ?? `stratum/0.155.1 (fixture) (${frame.params.clientInfo.name}; ${frame.params.clientInfo.version})` } });
      }
      if (frame.method === 'initialized') { initialized = true; return; }
      if (frame.method === 'thread/start') {
        assert.equal(initialized, true);
        if (scenario.reject === frame.method) return send({ id: frame.id, error: { message: 'fixture rejection' } });
        notify('thread/started', { thread: { id: 't' } });
        return send({ id: frame.id, result: { thread: { id: 't' } } });
      }
      if (frame.method === 'turn/start') {
        assert.equal(frame.params.threadId, 't'); started = true;
        if (scenario.reject === frame.method) return send({ id: frame.id, error: { message: 'fixture rejection' } });
        send({ id: frame.id, result: { turn: { id: 'u' } } });
        if (scenario.noStart) return;
        notify('turn/started', { turn: { id: 'u' } });
        for (const event of scenario.events ?? []) {
          if (typeof event === 'string') process.stdout.write(event + '\n');
          else notify(event.method, event.params);
        }
        if (scenario.truncated) { process.stdout.write('{"method":'); process.exit(0); }
        if (scenario.inheritedPipes) {
          const grandchild = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { stdio: ['ignore', process.stdout, process.stderr] });
          process.stderr.write(`grandchild:${grandchild.pid}\n`); grandchild.unref(); process.exit(1);
        }
        if (scenario.exit) process.exit(0);
        nextRequest(); return;
      }
      if (frame.method === 'turn/steer') {
        assert.equal(frame.params.expectedTurnId, 'u');
        if (scenario.steerReject) send({ id: frame.id, error: { message: 'stale turn' } });
        else send({ id: frame.id, result: { turnId: 'u' } });
        return;
      }
      assert.equal(frame.id, `server-${requestIndex}`);
      assert.deepEqual(frame, { id: frame.id, ...expectedReply(scenario.requests[requestIndex]) });
      process.stderr.write(`accepted:${scenario.requests[requestIndex]}\n`);
      requestIndex++; nextRequest();
    } catch (error) { console.error(error); process.exit(42); }
  });
  lines.on('close', () => {
    if (scenario.interruptOnEOF) complete();
    if (scenario.ignoreEOF) { setInterval(() => {}, 1000); process.stderr.write('barrier:eof\n'); }
  });
}
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) serveScenario(JSON.parse(process.argv[2] ?? '{}'));
