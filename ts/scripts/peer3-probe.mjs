#!/usr/bin/env node
import { isDeepStrictEqual } from 'node:util';
import { createRequire } from 'node:module';
/** Opt-in live evidence. Importing this module never starts a model turn. */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { access, copyFile, chmod, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir, platform, release, arch } from 'node:os';
import { join, resolve, dirname, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

export async function writeEvidence(path, value) {
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}

/** Own one process group, bound output and lifetime, escalate, and reap the child.
 * Callers receive evidence on nonzero exit/timeout too. Never record the environment. */
export function runBounded(command, args, { cwd, env = process.env, input = '', timeoutMs = 180_000, maxBytes = 8 * 1024 * 1024 } = {}) {
  if (process.platform === 'win32') throw new Error('Process-group cleanup requires Unix');
  return new Promise((resolveResult, reject) => {
    const child = spawn(command, args, { cwd, env, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', bytes = 0, reason = null, escalation;
    const started = Date.now();
    function killGroup(signal) {
      if (!child.pid) return;
      try { process.kill(-child.pid, signal); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    }
    function stop(why) {
      if (reason) return;
      reason = why;
      killGroup('SIGTERM');
      escalation = setTimeout(() => killGroup('SIGKILL'), 1000);
    }
    const onTerm = () => stop('SIGTERM'), onInt = () => stop('SIGINT');
    process.on('SIGTERM', onTerm); process.on('SIGINT', onInt);
    const timer = setTimeout(() => stop('timeout'), timeoutMs);
    function cleanup() {
      clearTimeout(timer); clearTimeout(escalation);
      process.off('SIGTERM', onTerm); process.off('SIGINT', onInt);
    }
    function collect(data, stream) {
      const available = Math.max(0, maxBytes - bytes);
      const text = data.subarray(0, available).toString('utf8');
      if (stream === 'stdout') stdout += text; else stderr += text;
      bytes += data.length;
      if (bytes > maxBytes) stop('output-limit');
    }
    child.stdout.on('data', data => collect(data, 'stdout'));
    child.stderr.on('data', data => collect(data, 'stderr'));
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') stop(`stdin: ${error.message}`); });
    child.on('error', error => { cleanup(); reject(error); });
    child.on('close', (code, signal) => {
      // Reap same-group descendants even if the CLI exited first.
      try { killGroup('SIGKILL'); } catch (error) { cleanup(); reject(error); return; }
      cleanup();
      resolveResult({ command, args, pid: child.pid, code, signal, reason, elapsedMs: Date.now() - started, stdout, stderr });
    });
    child.stdin.end(input);
  });
}

async function copyPrivateIfPresent(source, destination) {
  try { await copyFile(source, destination, constants.COPYFILE_EXCL); await chmod(destination, 0o600); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
}
async function exists(path) {
  try { await access(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}

/** Paid model turns: explicitly invoked only. No real config is modified.
 * Compare built-in defaults, a disposable copy of ordinary config, and a profile
 * that excludes both temp roots. Marker results corroborate actual tool records. */
export async function sandboxBaseline({ model, out }) {
  if (!model || !out) throw new Error('sandbox-baseline requires --model and --out');
  const output = resolve(out);
  await mkdir(output, { mode: 0o700 }); // Refuse to overwrite previous evidence.
  const root = await mkdtemp(join(tmpdir(), 'peer3-baseline-'));
  const slashTmp = await mkdtemp('/tmp/peer3-slash-tmp-');
  const report = { mode: 'sandbox-baseline', model, node: process.version, runs: [],
    note: 'Ordinary config/auth copied into a disposable CODEX_HOME. Absolute config references remain unchanged; relative references may resolve differently. No network denial claim is made by this probe.' };
  try {
    const codexHome = join(root, 'codex-home'), cwd = join(root, 'workspace');
    const tempEnv = join(root, 'env-tmp'), writableRoot = join(root, 'extra-root');
    for (const dir of [codexHome, cwd, tempEnv, writableRoot]) await mkdir(dir, { mode: 0o700 });
    const realHome = process.env.CODEX_HOME ?? join(homedir(), '.codex');
    await copyPrivateIfPresent(join(realHome, 'config.toml'), join(codexHome, 'config.toml'));
    await copyPrivateIfPresent(join(realHome, 'auth.json'), join(codexHome, 'auth.json'));
    // Dedicated profile overlays the copied ordinary config without editing either.
    await writeFile(join(codexHome, 'peer3-temp-override.config.toml'),
      '[sandbox_workspace_write]\nexclude_tmpdir_env_var = true\nexclude_slash_tmp = true\n', { mode: 0o600 });
    report.codex = await runBounded('codex', ['--version'], { timeoutMs: 5000 });
    if (report.codex.code !== 0 || report.codex.reason) throw new Error('codex --version failed');
    const slash = model.lastIndexOf('/'), suffix = model.slice(slash + 1);
    const effort = ['minimal', 'low', 'medium', 'high', 'xhigh'].includes(suffix) ? suffix : undefined;
    const modelName = effort ? model.slice(0, slash) : model;
    for (const mode of ['built-in', 'ordinary', 'override']) {
      const targets = { workspace: join(cwd, `${mode}.marker`), writableRoot: join(writableRoot, `${mode}.marker`),
        TMPDIR: join(tempEnv, `${mode}.marker`), slashTmp: join(slashTmp, `${mode}.marker`) };
      const toolPath = join(cwd, `probe-${mode}.cjs`);
      await writeFile(toolPath, `const fs = require('node:fs');\nconst results = {};\nfor (const [name,path] of Object.entries(${JSON.stringify(targets)})) {\n  try { fs.writeFileSync(path, 'peer3'); results[name] = {writable:true}; }\n  catch (e) { results[name] = {writable:false,code:e.code}; }\n}\nconsole.log('PEER3_TOOL_RESULTS=' + JSON.stringify(results));\n`);
      const args = ['exec', '--json', '--skip-git-repo-check', '--sandbox', 'workspace-write',
        '-c', 'sandbox_workspace_write.network_access=false',
        '-c', `sandbox_workspace_write.writable_roots=${JSON.stringify([writableRoot])}`,
        '-c', 'approval_policy="never"', '-m', modelName, '-C', cwd];
      if (effort) args.push('-c', `model_reasoning_effort="${effort}"`);
      if (mode === 'built-in') args.push('--ignore-user-config');
      if (mode === 'override') args.push('--profile', 'peer3-temp-override');
      args.push('-');
      const quote = text => "'" + text.replaceAll("'", "'\\''") + "'";
      const input = `Run exactly this shell command once: ${quote(process.execPath)} ${quote(toolPath)}\nDo not request escalated permissions or change files yourself. Report its stdout verbatim even if some writes fail.\n`;
      const run = await runBounded('codex', args, { cwd, env: { ...process.env, CODEX_HOME: codexHome, TMPDIR: tempEnv }, input });
      await writeEvidence(join(output, `${mode}.json`), run);
      if (run.code !== 0 || run.reason) throw new Error(`${mode} exec failed: exit=${run.code}, reason=${run.reason}`);
      const records = run.stdout.split('\n').filter(Boolean).map(line => JSON.parse(line));
      const toolRecords = records.filter(record => record.type === 'item.completed' && record.item?.type === 'command_execution');
      const markerRecords = toolRecords.filter(record => record.item.aggregated_output?.includes('PEER3_TOOL_RESULTS='));
      if (markerRecords.length !== 1 || !records.some(record => record.type === 'turn.completed')) {
        throw new Error(`${mode}: missing unique completed tool evidence or turn completion`);
      }
      const markerLine = markerRecords[0].item.aggregated_output.split('\n').find(line => line.startsWith('PEER3_TOOL_RESULTS='));
      if (!markerLine) throw new Error(`${mode}: malformed tool evidence`);
      const results = JSON.parse(markerLine.slice('PEER3_TOOL_RESULTS='.length));
      const observed = {};
      for (const [name, path] of Object.entries(targets)) {
        observed[name] = await exists(path);
        if (typeof results[name]?.writable !== 'boolean' || observed[name] !== results[name].writable) {
          throw new Error(`${mode}: tool/host marker disagreement for ${name}`);
        }
      }
      report.runs.push({ mode, targets, results, observed, toolRecords });
    }
    const [builtIn, ordinary, override] = report.runs;
    report.comparison = Object.fromEntries(['TMPDIR', 'slashTmp'].map(key => [key, {
      builtIn: builtIn.observed[key], ordinary: ordinary.observed[key], override: override.observed[key],
      ordinaryMatchesBuiltIn: ordinary.observed[key] === builtIn.observed[key],
      overrideChangesOrdinary: ordinary.observed[key] !== override.observed[key],
    }]));
    report.parityPrerequisite = report.runs.every(run => run.observed.workspace && run.observed.writableRoot)
      && ['TMPDIR', 'slashTmp'].every(key => builtIn.observed[key] && ordinary.observed[key] && !override.observed[key]);
    if (!report.parityPrerequisite) throw new Error('Temp-default/override parity unresolved; inspect evidence before enabling app-server');
  } catch (error) {
    report.error = error.message;
    throw error;
  } finally {
    try { await writeEvidence(join(output, 'report.json'), report); }
    finally { await Promise.all([rm(root, { recursive: true, force: true }), rm(slashTmp, { recursive: true, force: true })]); }
  }
  return report;
}

export async function main(args) {
  const [mode, ...options] = args;
  const action = mode === 'golden' ? options.shift() : undefined;
  if (!['sandbox-baseline', 'server-requests', 'preflight', 'sandbox', 'process-tree', 'golden', 'verify-evidence'].includes(mode)) throw new Error('Usage: peer3-probe.mjs preflight|sandbox|process-tree|sandbox-baseline|server-requests|golden start|golden collect|verify-evidence --out DIRECTORY [--model MODEL/EFFORT] [--transcript PATH]');
  const parsed = {};
  for (let i = 0; i < options.length; i += 2) {
    const key = options[i];
    if (!['--model', '--out', '--case', '--transcript'].includes(key) || !options[i + 1] || parsed[key.slice(2)]) throw new Error('Invalid or duplicate probe option');
    parsed[key.slice(2)] = options[i + 1];
  }
  if (parsed.transcript && !(mode === 'golden' && action === 'collect')) throw new Error('--transcript is only supported for golden collect');
  if (parsed.case && mode !== 'process-tree') throw new Error('--case is only supported for process-tree');
  if (mode === 'golden') {
    if (action === 'start') await goldenStart(parsed);
    else if (action === 'collect') await goldenCollect(parsed);
    else throw new Error('golden requires start or collect');
  } else if (mode === 'verify-evidence') {
    const report = await verifyEvidence(parsed);
    console.table(report.rows);
    console.log(JSON.stringify(report.methods, null, 2));
    if (!report.passed) throw new Error('Evidence gate incomplete: see per-AC table');
  } else if (mode === 'preflight') await preflight(parsed);
  else if (mode === 'sandbox') await sandboxProbe(parsed);
  else if (mode === 'process-tree') await processTree(parsed);
  else if (mode === 'server-requests') await serverRequests(parsed);
  else await sandboxBaseline(parsed);
}



export const requiredServerMethods = [
  'item/commandExecution/requestApproval', 'item/fileChange/requestApproval',
  'execCommandApproval', 'applyPatchApproval', 'item/permissions/requestApproval',
  'mcpServer/elicitation/request', 'item/tool/requestUserInput',
  'account/chatgptAuthTokens/refresh', 'attestation/generate', 'item/tool/call', 'unknown',
];

// Each method is attached to a concrete attempted run, including methods the
// installed CLI cannot expose. This records attempts, never synthetic requests.
export const serverRequestTriggers = [
  { methods: ['item/commandExecution/requestApproval', 'execCommandApproval', 'item/permissions/requestApproval'],
    approvalPolicy: 'on-request', filesystemMode: 'read-only',
    prompt: 'Request approval to run a shell command outside the sandbox, then request permission to write a file outside the workspace. Respect any refusal; report it and finish.' },
  { methods: ['item/fileChange/requestApproval', 'applyPatchApproval'],
    approvalPolicy: 'on-request', filesystemMode: 'read-only',
    prompt: 'Use your apply_patch (patch) tool to create peer3-file-approval.txt in the current working directory containing exactly peer3. The sandbox is read-only: request file-change approval if required. Do not use a shell to write the file. Respect refusal and finish.' },
  { methods: ['mcpServer/elicitation/request', 'item/tool/requestUserInput', 'item/tool/call', 'unknown', 'account/chatgptAuthTokens/refresh', 'attestation/generate'],
    approvalPolicy: 'untrusted', filesystemMode: 'read-only',
    prompt: 'Call the peer3_probe ask MCP tool once. Then use request_user_input to ask a question. If available, invoke a dynamic client tool, refresh authentication, and request attestation through supported tools. Do not invent tools or credentials. Respect refusal or unavailable capabilities and finish.' },
];

/** Recompute acceptance from transcripts, including requests outside the table.
 * Conservatively reject every answered run that fails or never completes; an
 * unrelated model error can be retried, but must not mask a rejected reply. */
export function assessServerRequests(runs, replyFor, { report = false } = {}) {
  const proven = new Map(), failed = new Map();
  for (const run of runs) {
    const traffic = Array.isArray(run.transcript) ? run.transcript : [];
    if (!Array.isArray(run.transcript)) {
      if (!report) throw new Error('Server request missing transcript');
      for (const method of requiredServerMethods.filter(m => run.trigger?.methods?.includes(m))) failed.set(method, 'Server request missing transcript');
    }
    for (let index = 0; index < traffic.length; index++) {
      const request = traffic[index];
      if (request.direction !== 'server' || typeof request.frame?.method !== 'string' || request.frame.id === undefined) continue;
      const { method, id } = request.frame;
      try {
        if (run.validationError) throw new Error(run.validationError);
        const reply = traffic.findIndex((entry, i) => i > index && entry.direction === 'client' && entry.frame?.id === id && !entry.frame.method);
        if (reply < 0) throw new Error(`${method}: elicited request has no reply`);
        const expected = { id, ...replyFor(method) };
        if (!isDeepStrictEqual(traffic[reply].frame, expected)) throw new Error(`${method}: incorrect reply`);
        const terminal = traffic.findIndex((entry, i) => i > reply && entry.direction === 'server' && entry.frame?.method === 'turn/completed' && entry.frame.params?.turn?.status === 'completed');
        const failure = traffic.slice(reply + 1).some(entry => entry.direction === 'server' &&
          ((entry.frame?.method === 'error' && entry.frame.params?.willRetry !== true) ||
           (entry.frame?.method === 'turn/completed' && entry.frame.params?.turn?.status !== 'completed') || entry.frame?.error));
        if (run.claim !== 'completed' || terminal < 0 || failure) throw new Error(`${method}: answered request followed by failed or hung run`);
        const evidence = proven.get(method) ?? [];
        evidence.push({ file: run.file, request: index, reply, terminal }); proven.set(method, evidence);
      } catch (error) {
        if (!report) throw error;
        failed.set(method, error.message);
      }
    }
  }
  return [...new Set([...requiredServerMethods, ...failed.keys(), ...proven.keys()])].map(method => {
    if (failed.has(method)) return { method, status: 'failed', reason: failed.get(method) };
    if (proven.has(method)) return { method, status: 'proven', evidence: proven.get(method) };
    const triggers = runs.filter(run => run.trigger?.methods?.includes(method)).map(run => ({ file: run.file, ...run.trigger }));
    if (!triggers.length) {
      if (report) return { method, status: 'failed', reason: `${method}: no recorded trigger attempt` };
      throw new Error(`${method}: no recorded trigger attempt`);
    }
    return { method, status: 'unreached', triggers };
  });
}

/** Explicitly paid. Capture actual duplex traffic, never synthesize acceptance.
 * Unreached methods retain their attempted trigger; only duplex evidence proves acceptance. */
export async function serverRequests({ model, out }) {
  if (!model || !out) throw new Error('server-requests requires --model and --out');
  const output = resolve(out);
  await mkdir(output, { mode: 0o700 });
  const root = await mkdtemp(join(tmpdir(), 'peer3-requests-'));
  const report = { mode: 'server-requests', model, node: process.version, runs: [], methods: [] };
  try {
    await recordIdentity(output);
    const { runAppServerDriver } = await import(new URL('../src/connectors/codex-appserver-driver.ts', import.meta.url));
    const home = join(root, 'home'), cwd = join(root, 'workspace');
    await mkdir(home, { mode: 0o700 }); await mkdir(cwd, { mode: 0o700 });
    await copyPrivateIfPresent(join(process.env.CODEX_HOME ?? join(homedir(), '.codex'), 'auth.json'), join(home, 'auth.json'));
    const tool = join(root, 'elicitation.mjs');
    // Disposable MCP server elicits input while a real model tool call is pending.
    await writeFile(tool, elicitationToolSource(), { mode: 0o600 });
    await writeFile(join(home, 'config.toml'), `[mcp_servers.peer3_probe]\ncommand = ${JSON.stringify(process.execPath)}\nargs = [${JSON.stringify(tool)}]\n`, { mode: 0o600 });
    report.codex = await runBounded('codex', ['--version'], { timeoutMs: 5000 });
    if (report.codex.code !== 0 || report.codex.reason) throw new Error('codex --version failed');
    const triggers = serverRequestTriggers;
    for (const [index, trigger] of triggers.entries()) {
      const { prompt, approvalPolicy, filesystemMode } = trigger;
      const transcript = [], records = [], diagnostics = [];
      const controller = new (await import('node:events')).EventEmitter();
      const timeout = setTimeout(() => controller.emit('SIGTERM'), 180_000);
      let child;
      const termination = () => controller.emit('SIGTERM');
      process.on('SIGTERM', termination); process.on('SIGINT', termination);
      try {
        const claim = await runAppServerDriver({ runId: `probe-${index}`, model, cwd, prompt,
          policy: { filesystemMode, writableRoots: [], networkAccess: false, approvalPolicy },
        }, {
          signals: controller,
          writer: { async write(line) { records.push(JSON.parse(line)); }, async flush() {} },
          log: line => { if (diagnostics.length < 1000) diagnostics.push(line.slice(0, 8192)); },
          spawn() {
            child = spawn('codex', ['app-server'], { cwd, env: { ...process.env, CODEX_HOME: home }, stdio: ['pipe','pipe','pipe'] });
            const capture = (direction, stream) => {
              let buffer = '';
              stream.on('data', data => { if (transcript.length >= 20_000) { controller.emit('SIGTERM'); return; } buffer += data.toString(); let n;
                while ((n=buffer.indexOf('\n'))>=0) { const line=buffer.slice(0,n); buffer=buffer.slice(n+1);
                  try { transcript.push({ direction, frame: JSON.parse(line) }); } catch { transcript.push({ direction, malformed: true }); }
                }
                if (buffer.length > 1024*1024 || transcript.length > 20_000) controller.emit('SIGTERM');
              });
            };
            capture('server', child.stdout);
            const write = child.stdin.write.bind(child.stdin);
            child.stdin.write = function(chunk, ...args) { transcript.push({ direction:'client', frame:JSON.parse(String(chunk)) }); return write(chunk, ...args); };
            return child;
          },
        });
        const run = { claim, transcript, records, diagnostics, trigger };
        await writeEvidence(join(output, `run-${index}.json`), run);
        report.runs.push({ file: `run-${index}.json`, claim, trigger });
      } finally { clearTimeout(timeout); process.off('SIGTERM', termination); process.off('SIGINT', termination); }
    }
    const evidence = await Promise.all(report.runs.map(async run => ({ ...JSON.parse(await readFile(join(output, run.file), 'utf8')), file: run.file })));
    const { respondToServerRequest } = await import(new URL('../src/connectors/codex-appserver-driver.ts', import.meta.url));
    report.methods = assessServerRequests(evidence, respondToServerRequest);
  } catch(error) { report.error=error.message; throw error; }
  finally {
    try {
      await writeEvidence(join(output,'report.json'),report);
      await writeFile(join(output, 'report.md'), '# Server-request evidence\n\n' +
        (report.methods.length ? report.methods.map(entry => `- ${entry.method}: **${entry.status}** — ${entry.status === 'proven' ? JSON.stringify(entry.evidence) : 'not reachable in supported configurations tried; trigger: ' + JSON.stringify(entry.triggers)}`).join('\n') : 'Probe incomplete; no acceptance claimed.') +
        (report.error ? `\n\nFAILED: ${report.error}` : '') + '\n');
    }
    finally { await rm(root,{recursive:true,force:true}); }
  }
  return report;
}

export function elicitationToolSource() {
  return `import { createInterface } from 'node:readline';
const send = x => process.stdout.write(JSON.stringify({jsonrpc:'2.0', ...x})+'\\n');
let pending;
createInterface({input:process.stdin}).on('line', line => {
 const f=JSON.parse(line);
 if(f.method==='initialize') send({id:f.id,result:{protocolVersion:f.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'peer3-probe',version:'1'}}});
 if(f.method==='tools/list') send({id:f.id,result:{tools:[{name:'ask',description:'Ask for an approval via elicitation',inputSchema:{type:'object',properties:{}}}]}});
 if(f.method==='tools/call') { pending=f.id; send({id:'elicit',method:'elicitation/create',params:{mode:'form',message:'Approve probe?',requestedSchema:{type:'object',properties:{approved:{type:'boolean'}}}}}); }
 if(f.id==='elicit') send({id:pending,result:{content:[{type:'text',text:JSON.stringify(f.result??f.error)}]}});
});
`;
}

// S5a uses the built production package, including its unmodified launch/driver.
const production = name => import(new URL(`../dist/connectors/${name}.js`, import.meta.url));
let probeInterrupted = false;
const delay = ms => new Promise(r => setTimeout(r, ms));
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
async function json(path) { return JSON.parse(await readFile(path, 'utf8')); }
async function waitFor(check, ms = 180_000, cleaning = false) {
  const end = Date.now() + ms;
  do { if (probeInterrupted && !cleaning) throw new Error('probe interrupted'); const value = await check(); if (value) return value; await delay(50); } while (Date.now() < end);
  throw new Error('deadline exceeded');
}
export const requiredCases = {
  preflight: ['codex-version', 'login', 'node', 'os', 'git-head', 'claude-version'],
  sandbox: ['read-only', 'workspace-write', 'network-on', 'network-off', 'temp-built-in', 'temp-ordinary', 'temp-override'],
  'process-tree': ['cancel-initialize', 'cancel-active', 'cancel-pending-steer', 'sigterm-ignore', 'parent-death', 'driver-sigkill', 'completion-wins', 'cancellation-wins'],
};
export function assessPreflight(name, data, pinned) {
  if (data.code !== 0 || data.reason) return false;
  if (name === 'codex-version') return data.stdout.trim() === `codex-cli ${pinned}`;
  if (name === 'login') return data.authenticated === true;
  return typeof data.stdout === 'string' && data.stdout.trim().length > 0;
}
/** No failed/unreached/skipped case can satisfy a gate. Paths are bundle-relative. */
export function assessSummary(summary, mode, selectedCase) {
  if (summary.mode !== mode || summary.error || !Array.isArray(summary.cases)) throw new Error(`${mode}: invalid summary`);
  const cases = selectedCase ? [selectedCase] : requiredCases[mode];
  if (selectedCase && !requiredCases[mode].includes(selectedCase)) throw new Error('Unknown selected case');
  if (summary.cases.length !== cases.length) throw new Error(`${mode}: incomplete cases`);
  for (const name of cases) {
    const matches = summary.cases.filter(c => c.case === name), c = matches[0];
    if (matches.length !== 1 || c.outcome !== 'passed' || c.exitCode !== 0 || !Number.isFinite(c.timings?.elapsedMs) || c.timings.elapsedMs < 0
      || !Array.isArray(c.evidence) || !c.evidence.length || c.evidence.some(p => typeof p !== 'string' || isAbsolute(p) || p.split(/[\\/]/).includes('..'))) {
      throw new Error(`${mode}/${name}: not passed or invalid evidence`);
    }
  }
  return true;
}
async function modeRunner(mode, { out, model, case: selectedCase }, body) {
  if (selectedCase && (mode !== 'process-tree' || !requiredCases[mode].includes(selectedCase))) throw new Error('Invalid --case');
  const cases = selectedCase ? [selectedCase] : requiredCases[mode];
  if (!out || (mode !== 'preflight' && !model)) throw new Error(`${mode} requires --out${mode === 'preflight' ? '' : ' and --model'}`);
  const base = resolve(out); await mkdir(base, { recursive: true, mode: 0o700 }); await chmod(base, 0o700);
  const output = join(base, mode); await mkdir(output, { mode: 0o700 });
  probeInterrupted = false;
  const interrupt = () => { probeInterrupted = true; };
  process.on('SIGTERM', interrupt); process.on('SIGINT', interrupt);
  const summary = { mode, model, ...(selectedCase ? {selectedCase} : {}), startedAt: new Date().toISOString(), cases: [] };
  const runCase = async (name, fn) => {
    if (probeInterrupted) throw new Error('probe interrupted');
    const startedAt = new Date().toISOString(), start = Date.now();
    const data = {}; let error;
    try { await fn(data); } catch (e) { error = e.message; }
    if (error) data.error = error;
    await writeEvidence(join(output, `${name}.json`), data);
    summary.cases.push({ case: name, outcome: error ? (data.reached === false ? 'unreached' : 'failed') : 'passed',
      evidence: [`${name}.json`, ...(data.artifacts ?? [])], exitCode: error ? 1 : 0, timings: { startedAt, elapsedMs: Date.now() - start } });
  };
  try { await recordIdentity(output); await body({ output, summary, runCase }); } catch (e) { summary.error = e.message; }
  finally {
    for (const name of cases) if (!summary.cases.some(c => c.case === name)) summary.cases.push({ case: name, outcome: 'unreached', evidence: ['summary.json'], exitCode: null, timings: { elapsedMs: 0 } });
    try { await writeEvidence(join(output, 'summary.json'), summary); }
    finally { process.off('SIGTERM', interrupt); process.off('SIGINT', interrupt); }
  }
  assessSummary(summary, mode, selectedCase); return summary;
}
export async function preflight(options) {
  return modeRunner('preflight', options, async ({ output, runCase }) => {
    const root = await mkdtemp(join(output, '.private-'));
    try {
    const home = await privateHome(root);
    const { PINNED_APP_SERVER_VERSION: pinned } = await import(new URL('../src/connectors/codex-appserver-protocol/pinned-version.ts', import.meta.url));
    const commands = { 'codex-version': ['codex', ['--version']], login: ['codex', ['login', 'status']], node: [process.execPath, ['--version']],
      'git-head': ['git', ['rev-parse', 'HEAD']], 'claude-version': ['claude', ['--version']] };
    for (const name of requiredCases.preflight) await runCase(name, async data => {
      let result = name === 'os' ? { code: 0, stdout: `${platform()} ${release()} ${arch()}` } : await runBounded(...commands[name], { timeoutMs: 10_000, env: { ...process.env, CODEX_HOME: home } });
      if (name === 'login') {
        // Login status may contain an account/API key suffix. Persist only classification.
        result = { code: result.code, reason: result.reason, elapsedMs: result.elapsedMs,
          authenticated: result.code === 0 && /logged in/i.test(result.stdout + result.stderr) && !/not logged in/i.test(result.stdout + result.stderr) };
      }
      Object.assign(data, result, { pinned });
      if (!assessPreflight(name, data, pinned)) throw new Error(`${name}: prerequisite failed`);
    });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}
async function privateHome(root, ordinary = false) {
  const home = join(root, 'home'); await mkdir(home, { mode: 0o700 });
  const source = process.env.CODEX_HOME ?? join(homedir(), '.codex');
  await copyPrivateIfPresent(join(source, 'auth.json'), join(home, 'auth.json'));
  if (ordinary) await copyPrivateIfPresent(join(source, 'config.toml'), join(home, 'config.toml'));
  return home;
}
async function pinCheck() {
  const { PINNED_APP_SERVER_VERSION } = await import(new URL('../src/connectors/codex-appserver-protocol/pinned-version.ts', import.meta.url));
  const version = await runBounded('codex', ['--version'], { timeoutMs: 5000 });
  if (!assessPreflight('codex-version', version, PINNED_APP_SERVER_VERSION)) throw new Error('Pinned Codex version required');
  return version;
}
async function capturePid(pid, role) {
  const { procStartTime, processGroupId } = await production('proc_identity');
  const start = await procStartTime(pid);
  if (!start) throw new Error(`Cannot capture ${role} PID identity ${pid}`);
  return { pid, role, start, pgid: await processGroupId(pid) };
}
async function pidState(identity) { return (await production('proc_identity')).processIdentity(identity.pid, identity.start); }
async function signalPid(identity, signal) {
  if (await pidState(identity) === 'alive') process.kill(identity.pid, signal);
}
async function reapCaptured(pids) {
  for (const p of [...pids].reverse()) await signalPid(p, 'SIGKILL');
  await waitFor(async () => (await Promise.all(pids.map(pidState))).every(s => s === 'dead'), 10_000, true);
}
async function snapshot(path, owned = []) {
  const result = await runBounded('ps', ['-axo', 'pid,ppid,pgid,stat,command'], { timeoutMs: 5000 });
  if (result.code !== 0 || result.reason) throw new Error('ps snapshot unavailable');
  // Keep tree columns for every process, but redact unrelated command lines (which can contain secrets).
  const safe = result.stdout.split('\n').map(line => owned.some(p => p.pid === Number(line.trim().split(/\s+/)[0])) ? line : line.replace(/^(\s*\d+\s+\d+\s+\d+\s+\S+).*/, '$1 [unrelated command redacted]')).join('\n');
  await writeFile(path, safe, { mode: 0o600 });
}
async function recordsAt(path) {
  try { return (await readFile(path, 'utf8')).split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }); }
  catch (e) { if (e.code === 'ENOENT') return []; throw e; }
}
async function finishRun(run, registryRoot) {
  const { pollBackgroundRun } = await production('background');
  return waitFor(async () => { const poll = await pollBackgroundRun(run.runId, { registryRoot }); return poll.status !== 'running' && poll; });
}
export function assessTool(records, nonce) {
  const tools = records.filter(r => r.type === 'item.completed' && r.item?.type === 'command_execution' && r.item.aggregated_output?.includes(`${nonce}=`));
  if (tools.length !== 1 || tools[0].item.exit_code !== 0) throw new Error('Missing unique successful tool execution');
  const lines = tools[0].item.aggregated_output.split('\n').filter(s => s.startsWith(`${nonce}=`));
  if (lines.length !== 1) throw new Error('Ambiguous tool result');
  return JSON.parse(lines[0].slice(nonce.length + 1));
}
/** Reconstruct the baseline from retained CLI output, never from report claims. */
export function assessExecBaseline(report, artifacts) {
  if (report.error !== undefined) throw new Error('Baseline report error'); // r1: baseline-error
  if (report.mode !== 'sandbox-baseline' || !isDeepStrictEqual(report.runs?.map(r => r.mode), ['built-in', 'ordinary', 'override'])) throw new Error('Baseline modes'); // r1: baseline-modes
  const observed = {};
  for (const run of report.runs) {
    const raw = artifacts[run.mode];
    if (raw.code !== 0) throw new Error('Baseline exit'); // r1: baseline-exit
    if (raw.reason != null) throw new Error('Baseline reason'); // r1: baseline-reason
    if (raw.signal != null || raw.error !== undefined) throw new Error('Baseline raw error/signal'); // r1: baseline-signal
    const records = raw.stdout.split('\n').filter(Boolean).map(line => JSON.parse(line));
    if (!records.some(r => r.type === 'turn.completed')) throw new Error('Baseline turn completion'); // r1: baseline-completion
    if (records.some(r => ['error', 'turn.failed'].includes(r.type))) throw new Error('Baseline failed record'); // r1: baseline-failed-record
    const results = assessTool(records, 'PEER3_TOOL_RESULTS');
    const tools = records.filter(r => r.type === 'item.completed' && r.item?.type === 'command_execution');
    if (tools.some(r => r.item.status !== 'completed')) throw new Error('Baseline tool status'); // r1: baseline-tool-status
    if (!isDeepStrictEqual(run.toolRecords, tools)) throw new Error('Baseline tool metadata'); // r1: baseline-tool-metadata
    if (!isDeepStrictEqual(run.results, results)) throw new Error('Baseline result metadata'); // r1: baseline-result-metadata
    observed[run.mode] = {};
    for (const key of ['workspace', 'writableRoot', 'TMPDIR', 'slashTmp']) {
      if (typeof results[key]?.writable !== 'boolean') throw new Error('Baseline boolean observation'); // r1: baseline-boolean
      observed[run.mode][key] = results[key]?.writable;
    }
    if (!isDeepStrictEqual(run.observed, observed[run.mode])) throw new Error('Baseline host observation mismatch'); // r1: baseline-observed
  }
  const comparison = Object.fromEntries(['TMPDIR', 'slashTmp'].map(key => [key, {
    builtIn: observed['built-in'][key], ordinary: observed.ordinary[key], override: observed.override[key],
    ordinaryMatchesBuiltIn: observed.ordinary[key] === observed['built-in'][key],
    overrideChangesOrdinary: observed.override[key] !== observed.ordinary[key],
  }]));
  if (!isDeepStrictEqual(report.comparison, comparison)) throw new Error('Baseline comparison metadata'); // r1: baseline-comparison
  const parity = Object.values(observed).every(o => o.workspace && o.writableRoot)
    && ['TMPDIR', 'slashTmp'].every(k => observed['built-in'][k] && observed.ordinary[k] && !observed.override[k]);
  if (report.parityPrerequisite !== parity || !parity) throw new Error('Baseline parity metadata'); // r1: baseline-parity
  return observed;
}

export function sandboxExpectations(name, execObserved) {
  const expected = Object.fromEntries(['workspace', 'writableRoot', 'outside', 'TMPDIR', 'slashTmp']
    .map(key => [key, name !== 'read-only' && key !== 'outside']));
  if (name.startsWith('temp-')) for (const key of ['TMPDIR', 'slashTmp']) {
    if (typeof execObserved?.[key] !== 'boolean') throw new Error(`Missing exec temp baseline: ${key}`);
    expected[key] = execObserved[key];
  }
  return expected;
}
export function assessSandboxCase(name, data) {
  if (data.poll?.status !== 'complete') throw new Error('Run did not complete');
  if (data.policy?.filesystemMode !== (name === 'read-only' ? 'read-only' : 'workspace-write') || data.policy?.networkAccess !== (name === 'network-on') || data.policy?.approvalPolicy !== 'never') throw new Error('Wrong production sandbox policy');
  const result = assessTool(data.records, data.nonce);
  if (name.startsWith('network-')) {
    if (typeof result.fetched !== 'boolean' || result.fetched !== (name === 'network-on') || (name === 'network-off' && !result.error)) throw new Error('Network control/denial not proven');
  } else {
    if (!data.osWritableOutside) throw new Error('Missing OS-writable outside control');
    const expectations = sandboxExpectations(name, Object.fromEntries(
      Object.entries(data.tempComparison ?? {}).map(([key, value]) => [key, value.exec])));
    for (const key of ['workspace', 'writableRoot', 'outside', 'TMPDIR', 'slashTmp']) {
      const expected = expectations[key];
      if (result[key]?.writable !== expected || data.observed[key] !== expected || (!expected && !['EPERM', 'EACCES', 'EROFS'].includes(result[key]?.code))) throw new Error(`Write enforcement mismatch: ${key}`);
    }
  }
  return result;
}
export async function sandboxProbe(options) {
  return modeRunner('sandbox', options, async ({ output, runCase, summary }) => {
    summary.codex = await pinCheck();
    // Same executable/configurations and a fresh exec baseline for this invocation.
    const baselineDir = join(output, 'exec-baseline');
    await sandboxBaseline({ ...options, out: baselineDir });
    const baseline = await json(join(baselineDir, 'report.json'));
    const execObserved = assessExecBaseline(baseline, Object.fromEntries(await Promise.all(['built-in', 'ordinary', 'override'].map(async mode => [mode, await json(join(baselineDir, `${mode}.json`))]))));
    // Must be outside /tmp, TMPDIR, cwd, and selected roots; prove OS writeability first.
    const outside = await mkdtemp(join(homedir(), '.peer3-outside-')); await chmod(outside, 0o700);
    try {
      for (const name of requiredCases.sandbox) await runCase(name, async data => {
        const root = await mkdtemp(join(output, '.private-')), pids = [];
        try {
          const home = await privateHome(root, name === 'temp-ordinary' || name === 'temp-override');
          const cwd = join(root, 'workspace'), extra = join(root, 'writable'), temp = join(root, 'tmp');
          for (const p of [cwd, extra, temp]) await mkdir(p, { mode: 0o700 });
          if (name === 'temp-override') {
            // Explicit known ambient exclusions; app-server policy must not silently hide the difference.
            const { parse, stringify } = createRequire(new URL('../package.json', import.meta.url))('smol-toml');
            const configPath = join(home, 'config.toml');
            const config = await exists(configPath) ? parse(await readFile(configPath, 'utf8')) : {};
            config.sandbox_workspace_write = { ...config.sandbox_workspace_write, exclude_tmpdir_env_var: true, exclude_slash_tmp: true };
            await writeFile(configPath, stringify(config), { mode: 0o600 });
          }
          data.nonce = `PEER3_${name.replaceAll('-', '_')}_${Date.now()}`;
          const slash = await mkdtemp('/tmp/peer3-s5a-');
          try {
            const targets = { workspace: join(cwd, 'marker'), writableRoot: join(extra, 'marker'), outside: join(outside, name), TMPDIR: join(temp, 'marker'), slashTmp: join(slash, 'marker') };
            await writeFile(targets.outside, 'OS control', { mode: 0o600 }); await rm(targets.outside);
            data.osWritableOutside = true;
            const network = name.startsWith('network-');
            const script = join(cwd, 'tool.cjs');
            const source = network ? `(async()=>{let r;try{const v=await fetch('https://example.com/',{signal:AbortSignal.timeout(15000)});r={fetched:v.ok,status:v.status};}catch(e){r={fetched:false,error:String(e),cause:e.cause?.code};}console.log(${JSON.stringify(data.nonce + '=')}+JSON.stringify(r));})();` :
              `const fs=require('node:fs'),r={};for(const [k,p] of Object.entries(${JSON.stringify(targets)})){try{fs.writeFileSync(p,'peer3');r[k]={writable:true};}catch(e){r[k]={writable:false,code:e.code};}}console.log(${JSON.stringify(data.nonce + '=')}+JSON.stringify(r));`;
            await writeFile(script, source, { mode: 0o600 });
            const { startBackgroundRun } = await production('background');
            const registryRoot = join(root, 'runs');
            const run = await startBackgroundRun({ agent: 'codex', model: options.model, cwd, registryRoot,
              sandboxMode: name === 'read-only' ? 'read-only' : 'workspace-write', networkAccess: name === 'network-on', writableRoots: [extra], approvalPolicy: 'never',
              prompt: `Execute exactly once: ${quote(process.execPath)} ${quote(script)}. Do not edit the script, use other write/fetch tools, or escalate. Return done after the command.`,
              env: { ...process.env, CODEX_HOME: home, TMPDIR: temp, STRATUM_CODEX_BG_STRATEGY: 'app-server', STRATUM_PEER_REGISTER: '0' } });
            pids.push(await capturePid(run.pid, 'driver'));
            // Discover only direct children of our captured driver, before waiting for the model.
            await captureChildren(pids, run.pid);
            data.poll = await finishRun(run, registryRoot); data.records = await recordsAt(run.streamPath);
            data.observed = Object.fromEntries(await Promise.all(Object.entries(targets).map(async ([k, p]) => [k, await exists(p)])));
            const exec = execObserved[name.slice(5)];
            data.expected = sandboxExpectations(name, exec);
            data.policy = (await json(join(dirname(run.streamPath), 'driver-config.json'))).policy;
            if (name.startsWith('temp-')) {
              const config = name.slice(5);
              data.execBaseline = `exec-baseline/${config}.json`; data.artifacts = [data.execBaseline];
              data.tempComparison = Object.fromEntries(['TMPDIR', 'slashTmp'].map(k => [k, { exec: exec[k], appServer: data.observed[k] }]));
              if (Object.values(data.tempComparison).some(v => v.exec !== v.appServer)) throw new Error('Ambient temp exclusion differs from exec; design resolution required, permissions were not adjusted');
            }
            assessSandboxCase(name, data);
          } finally { await rm(slash, { recursive: true, force: true }); }
        } finally { try { await reapCaptured(pids); } finally { await rm(root, { recursive: true, force: true }); } }
      });
    } finally { await rm(outside, { recursive: true, force: true }); }
  });
}
async function captureChildren(pids, parent) {
  await waitFor(async () => {
    const ps = await runBounded('ps', ['-axo', 'pid,ppid'], { timeoutMs: 5000 });
    if (ps.code !== 0) throw new Error('Cannot discover app-server');
    const children = ps.stdout.split('\n').map(s => s.trim().split(/\s+/).map(Number)).filter(([, ppid]) => ppid === parent);
    for (const [pid] of children) if (!pids.some(p => p.pid === pid)) pids.push(await capturePid(pid, 'app-server'));
    return children.length;
  }, 10_000);
}

/** Transparent protocol relay for explicitly labelled fault cases only. Never saves payloads.
 * Native cases exec the binary directly and retain its PID (no extra pipe owner).
 * Held responses are genuine responses from the real binary, never fabricated frames. */
export function signalShimSource() { return String.raw`#!/usr/bin/env python3
import os,sys,json,subprocess,threading,signal,time
mode=os.environ['PEER3_CASE']; events=os.environ['PEER3_EVENTS']; real=os.environ['PEER3_REAL_CODEX']
def event(kind,**kw):
 with open(events,'a') as f: f.write(json.dumps(dict(event=kind,time=time.time(),**kw))+'\n')
event('wrapper',pid=os.getpid())
if mode in ['cancel-active','parent-death','driver-sigkill']:
 os.execv(real,[real]+sys.argv[1:])
p=subprocess.Popen([real]+sys.argv[1:],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=sys.stderr)
event('real-server',pid=p.pid)
requests={}
def term(sig,frame):
 event('ignored-sigterm' if mode=='sigterm-ignore' else 'shim-sigterm')
 if mode!='sigterm-ignore':
  try: p.stdin.close()
  except: pass
  sys.exit(0)
signal.signal(signal.SIGTERM,term)
def client():
 for line in sys.stdin.buffer:
  f=json.loads(line); method=f.get('method'); requests[f.get('id')]=method
  event('client',method=method)
  p.stdin.write(line); p.stdin.flush()
 event('driver-eof')
 if mode not in ['sigterm-ignore','completion-wins']:
  p.stdin.close()
threading.Thread(target=client,daemon=True).start()
for line in p.stdout:
 f=json.loads(line); method=f.get('method'); request=requests.get(f.get('id'))
 if mode=='cancel-initialize' and request=='initialize':
  event('held-initialize-response')
  while True: time.sleep(1)
 if mode=='cancel-pending-steer' and request=='turn/steer':
  event('held-steer-response')
  continue
 if mode=='cancellation-wins' and method=='turn/completed':
  event('held-completion')
  while True: time.sleep(1)
 event('server',method=method)
 sys.stdout.buffer.write(line); sys.stdout.buffer.flush()
p.wait()
event('real-exit',code=p.returncode)
`; }
export function assessProcessCase(name, data) {
  const native = ['cancel-active', 'parent-death', 'driver-sigkill'].includes(name);
  if (data.signalMode !== (native ? 'native-signal' : 'controlled-shim')) throw new Error('Wrong signal label'); // r1: process-label
  if (name !== 'sigterm-ignore') {
    const kind = name === 'parent-death' ? 'parent-sigkill' : name === 'driver-sigkill' ? 'driver-sigkill' : 'cancel';
    if (data.action?.kind !== kind || !Number.isFinite(data.action?.time) || !Array.isArray(data.action?.records)) throw new Error('Missing recorded action boundary'); // r1: process-action
    const before = data.action?.records ?? [];
    if (!isDeepStrictEqual(before, data.records.slice(0, before.length))) throw new Error('Action records disagree with retained prefix'); // r1: process-prefix
    if (name !== 'cancel-initialize' && !before.some(r => r.type === 'turn.started')) throw new Error('Missing active turn before action'); // r1: process-active
    if (name !== 'completion-wins' && before.some(r => r.type === 'turn.completed')) throw new Error('Turn completed before action'); // r1: process-no-completion
    if (name === 'completion-wins' && !before.some(r => r.type === 'turn.completed')) throw new Error('Missing completion before cancel'); // r1: process-completion
  }
  const completed = ['parent-death', 'completion-wins', 'sigterm-ignore'].includes(name);
  const sentinels = data.records.filter(r => Object.hasOwn(r, '__t2f5_done__'));
  if (completed ? sentinels.length !== 1 || sentinels[0].__t2f5_done__ !== 0 || data.poll.status !== 'complete'
    : sentinels.length !== 0 || data.poll.status !== 'error' || data.poll.reason !== 'child_died_without_sentinel') throw new Error('Wrong terminal outcome/sentinel count');
  const driver = data.pids.find(p => p.role === 'driver');
  if (!driver || driver.pgid !== driver.pid || data.pids.some(p => ['app-server', 'shim'].includes(p.role) && p.pgid !== driver.pid)) throw new Error('Unexpected production process groups');
  if (!data.pids.some(p => p.role === 'driver') || !data.pids.some(p => p.role === 'app-server') || data.pids.some(p => !p.start || p.after !== 'dead')) throw new Error('Captured driver/server not proven gone');
  const barrier = { 'cancel-initialize': 'held-initialize-response', 'cancel-pending-steer': 'held-steer-response', 'cancellation-wins': 'held-completion', 'sigterm-ignore': 'ignored-sigterm' }[name];
  if (barrier && !data.events.some(e => e.event === barrier)) throw new Error(`Missing ${barrier}`);
  if (['cancel-active', 'driver-sigkill', 'parent-death', 'cancel-pending-steer'].includes(name) && !data.activeBeforeAction) throw new Error('Active turn not established');
  if (name === 'parent-death' && (!data.parentGone || !data.driverAliveAfterParentDeath)) throw new Error('Parent death durability not proven');
  if (name === 'completion-wins' && (!data.completedBeforeCancel || data.sentinelBeforeCancel)) throw new Error('Completion/cancel race not established');
  if (name.startsWith('cancel-') || name === 'cancellation-wins' || name === 'completion-wins') {
    if (data.cancel?.status !== 'cancelled') throw new Error('Cancellation did not signal live run');
  }
  if (name === 'cancel-pending-steer') {
    const sent = data.sentFrame;
    if (sent?.type !== 'user' || typeof sent.msg_id !== 'string' || !sent.msg_id) throw new Error('Missing sent message'); // r1: steer-sent
    const ipc = data.ipc ?? [];
    const requestIndex = ipc.findIndex(e => e.direction === 'sidecar-to-driver' && e.message.type === 'steer');
    const request = ipc[requestIndex];
    if (!request) throw new Error('Missing steer request'); // r1: steer-request
    const msg = request?.message ?? {};
    if (msg.msgId !== sent?.msg_id) throw new Error('Steer message mismatch'); // r1: steer-msg
    const activeRecord = ipc.slice(0, requestIndex).findLast(e => e.direction === 'driver-to-sidecar' && e.message.type === 'active-turn-state');
    const active = activeRecord?.message;
    if (!active?.turnId || msg.expectedTurnId !== active.turnId) throw new Error('Steer active turn mismatch'); // r1: steer-active
    if (!data.records.some(r => r.type === 'thread.started' && r.thread_id === active?.threadId)) throw new Error('Steer thread mismatch'); // r1: steer-thread
    if (msg.runId !== data.poll.runId || active?.runId !== data.poll.runId) throw new Error('Steer run mismatch'); // r1: steer-run
    const result = ipc.find(e => e.direction === 'driver-to-sidecar' && e.message.type === 'steer-result' && e.message.reqId === msg.reqId);
    if (!msg.reqId || !result) throw new Error('Missing correlated steer result'); // r1: steer-result
    if (result?.message.outcome !== 'dropped' || result?.message.detail !== 'unknown') throw new Error('Wrong steer result'); // r1: steer-outcome
    if (!(ipc.indexOf(result) > requestIndex && activeRecord?.time <= request?.time)) throw new Error('Wrong steer IPC ordering'); // r1: steer-ipc-order
    const client = data.events.find(e => e.event === 'client' && e.method === 'turn/steer');
    const held = data.events.find(e => e.event === 'held-steer-response');
    if (!(request?.time <= client?.time * 1000 && client?.time <= held?.time && held?.time * 1000 <= data.action?.time && data.action?.time <= result?.time)) throw new Error('Wrong steer action ordering'); // r1: steer-order
    const frames = data.callbackFrames ?? [];
    if (frames[0]?.type !== 'auth' || frames[0]?.authenticated !== true) throw new Error('Unauthenticated callback'); // r1: steer-auth
    if (!frames.slice(1).some(f => f.type === 'control' && f.action === 'peer_message_status' && f.orig_msg_id === sent?.msg_id && f.status === 'dropped' && f.status_detail === 'unknown')) throw new Error('Missing correlated dropped callback'); // r1: steer-callback
  }
  return true;
}
// Probe-only preload: observe sidecar IPC without changing production modules or payloads.
export function ipcTraceSource() { return String.raw`
import { appendFileSync } from 'node:fs';
if (process.env.STRATUM_PEER_OWNER_KIND === 'codex-appserver') {
  const record = (direction, message) => appendFileSync(process.env.PEER3_IPC,
    JSON.stringify({time: Date.now(), pid: process.pid, direction, message}) + '\n', {mode: 0o600});
  process.on('message', message => record('driver-to-sidecar', message));
  const send = process.send;
  process.send = function(message, ...args) {
    record('sidecar-to-driver', message);
    return send.call(this, message, ...args);
  };
}
`; }

/** Same auth/user framing and PID callback convention as Claude SendMessage. */
export async function probePeerSender({ root, sessionsDir, data }) {
  const { createServer, createConnection } = await import('node:net');
  const { once } = await import('node:events');
  const { randomBytes } = await import('node:crypto');
  const { keyFileName } = await production('peer-registry');
  const sock = join(root, `${process.pid}.sock`), sockets = new Set();
  const token = randomBytes(16).toString('hex');
  data.callbackFrames = []; data.senderReplies = [];
  const collect = (socket, frames) => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    socket.on('error', error => { data.callbackError = error.message; });
    let buffer = '';
    socket.on('data', chunk => {
      buffer += chunk;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        try {
          const frame = JSON.parse(line);
          frames.push(frame.type === 'auth' ? {type: 'auth', authenticated: frame.token === token} : frame);
        } catch { data.callbackError = 'Malformed sidecar reply'; }
      }
    });
  };
  const server = createServer(socket => collect(socket, data.callbackFrames));
  server.listen(sock); await once(server, 'listening');
  const keyPath = join(sessionsDir, keyFileName(process.pid, sock));
  try { await writeEvidence(keyPath, {peerToken: token}); }
  catch (error) { await new Promise(r => server.close(r)); throw error; }
  return {
    async send(peerSock, peerToken, msgId = 's5a-pending') {
      const frame = {type: 'user', msg_id: msgId, from: `uds:${sock}`, from_mode: 'bypass',
        message: {role: 'user', content: '<cross-session-message from-name="probe">Keep waiting.</cross-session-message>'}};
      data.sentFrame = frame;
      await new Promise((resolveSend, reject) => {
        const socket = createConnection(peerSock); collect(socket, data.senderReplies);
        socket.setTimeout(2000, () => socket.destroy(new Error('steer socket deadline')));
        socket.on('error', reject);
        socket.on('connect', () => socket.end(JSON.stringify({type: 'auth', token: peerToken}) + '\n' + JSON.stringify(frame) + '\n'));
        socket.on('close', () => resolveSend());
      });
    },
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise(r => server.close(r));
      await rm(keyPath, {force: true});
    },
  };
}
export function assertPendingSteerReply(data) {
  if (data.callbackError) throw new Error(data.callbackError);
  const reply = data.callbackFrames?.find(f => f.action === 'peer_message_status');
  if (reply) throw new Error(`Sidecar settled before pending-steer barrier: ${JSON.stringify(reply)}`);
}
export async function processTree(options) {
  return modeRunner('process-tree', options, async ({ output, runCase, summary }) => {
    summary.codex = await pinCheck();
    summary.limitations = 'Sidecars may linger. Tool descendants in separate groups are outside driver/app-server reap scope; ps retains their tree columns. No process-name killing.';
    const which = await runBounded('/bin/sh', ['-c', 'command -v codex'], { timeoutMs: 5000 });
    const real = which.stdout.trim(); if (which.code !== 0 || !isAbsolute(real)) throw new Error('Cannot resolve real codex executable');
    summary.executable = real;
    for (const name of options.case ? [options.case] : requiredCases['process-tree']) await runCase(name, async data => {
      const root = await mkdtemp('/tmp/p3-life-'), pids = [];
      let run, parent, sender;
      data.reached = false; data.pids = pids;
      data.signalMode = ['cancel-active', 'parent-death', 'driver-sigkill'].includes(name) ? 'native-signal' : 'controlled-shim';
      const eventsPath = join(root, 'events.jsonl');
      const before = `${name}.before.ps`, after = `${name}.after.ps`;
      data.artifacts = [before, after];
      try {
        const home = await privateHome(root), cwd = join(root, 'workspace'), bin = join(root, 'bin'), sessionsDir = join(root, 'sessions');
        for (const dir of [cwd, bin, sessionsDir]) await mkdir(dir, { mode: 0o700 });
        await writeFile(join(bin, 'codex'), signalShimSource(), { mode: 0o700 });
        const registryRoot = join(root, 'runs');
        const tracePath = join(root, 'ipc-trace.mjs');
        if (name === 'cancel-pending-steer') await writeFile(tracePath, ipcTraceSource(), {mode: 0o600});
        const config = { agent: 'codex', model: options.model, cwd, registryRoot, sessionsDir, sockDir: root, lingerMs: 200,
          sandboxMode: 'read-only', approvalPolicy: 'never',
          prompt: ['completion-wins', 'cancellation-wins', 'sigterm-ignore'].includes(name) ? 'Reply with exactly: peer3 complete. Do not use tools.' :
            'Run the shell command sleep 20 once, then reply with exactly: peer3 complete. Do not modify files.',
          env: { ...process.env, CODEX_HOME: home, PATH: `${bin}:${process.env.PATH}`, STRATUM_CODEX_BG_STRATEGY: 'app-server',
            ...(name === 'cancel-pending-steer' ? {NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${tracePath}`, PEER3_IPC: join(root, 'ipc.jsonl')} : {}),
            STRATUM_PEER_REGISTER: name === 'cancel-pending-steer' ? '1' : '0', PEER3_CASE: name, PEER3_EVENTS: eventsPath, PEER3_REAL_CODEX: real } };
        const { startBackgroundRun, cancelBackgroundRun } = await production('background');
        if (name === 'parent-death') {
          // Actual separate MCP-equivalent launcher. Its death cannot own the detached driver.
          const configPath = join(root, 'options.json'), resultPath = join(root, 'run.json'), host = join(root, 'host.mjs');
          await writeEvidence(configPath, config);
          await writeFile(host, `import {readFile,writeFile} from 'node:fs/promises';
const {startBackgroundRun}=await import(${JSON.stringify(new URL('../dist/connectors/background.js', import.meta.url).href)});
const run=await startBackgroundRun(JSON.parse(await readFile(${JSON.stringify(configPath)},'utf8')));
await writeFile(${JSON.stringify(resultPath)},JSON.stringify(run),{mode:0o600});setInterval(()=>{},1000);`, { mode: 0o600 });
          parent = spawn(process.execPath, [host], { stdio: 'ignore' });
          const parentIdentity = await capturePid(parent.pid, 'launcher'); pids.push(parentIdentity);
          run = await waitFor(async () => await exists(resultPath) && json(resultPath), 15_000);
        } else run = await startBackgroundRun(config);
        const driver = await capturePid(run.pid, 'driver'); pids.push(driver);
        await waitFor(async () => (await recordsAt(eventsPath)).some(e => e.event === 'wrapper'), 10_000);
        const events = await recordsAt(eventsPath);
        for (const e of events.filter(e => ['wrapper', 'real-server'].includes(e.event))) pids.push(await capturePid(e.pid, e.event === 'wrapper' && data.signalMode === 'controlled-shim' ? 'shim' : 'app-server'));
        if (!pids.some(p => p.role === 'app-server')) {
          await waitFor(async () => (await recordsAt(eventsPath)).some(e => e.event === 'real-server'), 5000);
          const e = (await recordsAt(eventsPath)).find(e => e.event === 'real-server'); pids.push(await capturePid(e.pid, 'app-server'));
        }
        const barrier = async event => waitFor(async () => (await recordsAt(eventsPath)).some(e => e.event === event), 60_000);
        const active = async () => waitFor(async () => (await recordsAt(run.streamPath)).some(r => r.type === 'turn.started'), 60_000);
        if (name === 'cancel-initialize') await barrier('held-initialize-response');
        else if (name === 'cancellation-wins') await barrier('held-completion');
        else if (name === 'completion-wins') {
          await waitFor(async () => (await recordsAt(run.streamPath)).some(r => r.type === 'turn.completed'));
          data.completedBeforeCancel = true;
          data.sentinelBeforeCancel = (await recordsAt(run.streamPath)).some(r => Object.hasOwn(r, '__t2f5_done__'));
        } else if (name !== 'sigterm-ignore') { await active(); data.activeBeforeAction = true; }
        if (name === 'cancel-pending-steer') {
          const peerPath = join(dirname(run.streamPath), 'peer.json');
          await waitFor(() => exists(peerPath), 5000);
          const peer = await json(peerPath);
          const { keyFileName } = await production('peer-registry');
          const { peerToken } = await json(join(sessionsDir, keyFileName(peer.pid, peer.sock)));
          // Admission failures are failed attempts, never an unexplained "unreached".
          data.reached = true;
          sender = await probePeerSender({root, sessionsDir, data});
          await sender.send(peer.sock, peerToken);
          await waitFor(async () => {
            assertPendingSteerReply(data);
            return (await recordsAt(eventsPath)).some(e => e.event === 'held-steer-response');
          }, 60_000);
        }
        await snapshot(join(output, before), pids); data.reached = true;
        if (name !== 'sigterm-ignore') {
          const records = await recordsAt(run.streamPath);
          data.action = { kind: name === 'parent-death' ? 'parent-sigkill' : name === 'driver-sigkill' ? 'driver-sigkill' : 'cancel', records, time: Date.now() };
        }
        if (name === 'parent-death') {
          const exited = new Promise(r => parent.once('exit', r)); await signalPid(pids.find(p => p.role === 'launcher'), 'SIGKILL'); await exited;
          data.parentGone = await pidState(pids[0]) === 'dead'; data.driverAliveAfterParentDeath = await pidState(driver) === 'alive';
        } else if (name === 'driver-sigkill') await signalPid(driver, 'SIGKILL');
        else if (name !== 'sigterm-ignore') data.cancel = await cancelBackgroundRun(run.runId, { registryRoot });
        data.poll = await finishRun(run, registryRoot);
        await waitFor(async () => (await Promise.all(pids.map(pidState))).every(s => s === 'dead'), 15_000);
        if (sender) {
          await waitFor(() => data.callbackFrames.some(f => f.action === 'peer_message_status'), 5000);
          data.ipc = await recordsAt(join(root, 'ipc.jsonl'));
        }
        data.records = await recordsAt(run.streamPath); data.events = await recordsAt(eventsPath);
        for (const p of pids) p.after = await pidState(p);
        await snapshot(join(output, after), pids);
        assessProcessCase(name, data);
      } finally {
        // Capture observations BEFORE emergency cleanup, so cleanup cannot turn leaks into passes.
        data.events ??= await recordsAt(eventsPath);
        if (run) {
          data.records ??= await recordsAt(run.streamPath);
          for (const suffix of ['.err', '.peer.err']) {
            const path = join(output, name + suffix);
            const content = await readFile(run.streamPath + suffix, 'utf8').catch(error => {
              if (error.code === 'ENOENT') return '[no stderr file]\n'; throw error;
            });
            await writeFile(path, content || '[empty]\n', {mode: 0o600}); data.artifacts.push(name + suffix);
          }
        }
        if (sender) {
          data.ipc = await recordsAt(join(root, 'ipc.jsonl'));
          await sender.close();
        }
        for (const p of pids) p.after ??= await pidState(p);
        await snapshot(join(output, after), pids).catch(() => {});
        try { await reapCaptured(pids); } finally { await rm(root, { recursive: true, force: true }); }
      }
    });
  });
}


// S5b: all verdicts below are reconstructed from retained observations, never summaries.
async function recordIdentity(output) {
  const identity = {};
  for (const [key, command, args] of [['codex', 'codex', ['--version']], ['claude', 'claude', ['--version']], ['head', 'git', ['rev-parse', 'HEAD']]]) {
    identity[key] = await runBounded(command, args, { timeoutMs: 10_000 });
  }
  await writeEvidence(join(output, 'identity.json'), identity);
  assessIdentities([identity]);
  return identity;
}
export function assessIdentities(identities) {
  for (const value of identities) for (const key of ['codex', 'claude', 'head']) {
    const raw = value?.[key];
    if (!raw || raw.code !== 0 || raw.reason || raw.signal || !raw.stdout?.trim()) throw new Error('Identity command failed'); // S5B:identity-command
    if (raw.stdout.trim() !== identities[0][key].stdout.trim()) throw new Error('Identity version/HEAD mismatch'); // S5B:identity-match
  }
  return true;
}

/** Retain content blocks only: never their surrounding conversation messages.
 * Structured JSON callback payloads may occur directly or in text blocks. Unknown
 * transcript representations fail closed rather than matching words in prose. */
function payloads(block) {
  if (!block || typeof block !== 'object') return [];
  if (block.action || block.status || typeof block.success === 'boolean') return [block];
  const content = block.content ?? block.text;
  if (Array.isArray(content)) return content.flatMap(payloads);
  if (typeof content === 'object') return payloads(content);
  if (typeof content !== 'string') return [];
  try { return payloads(JSON.parse(content)); } catch { return []; }
}
function deliveryNotice(b, state) {
  return b.type === 'text' && b.role === 'user' && b.text?.startsWith('[Cross-session delivery notice]') &&
    b.text.match(/\(recipient: ([^)]+)\)/)?.[1] === `uds:${state.peer.sock}`;
}
function idleNotice(b, state) {
  return b.type === 'text' && b.role === 'user' &&
    b.text?.startsWith(`[Cross-session idle notice] "${state.peerName}", which you asked to be notified about, is idle now`);
}
export function extractController(records, state) {
  // Preserve only role/time provenance, never surrounding conversation content.
  const blocks = records.filter(r => r.type !== 'queue-operation').flatMap(r => {
    const content = Array.isArray(r.message?.content) ? r.message.content : typeof r.message?.content === 'string' ? [{type: 'text', text: r.message.content}] : [];
    return content.map(b => ({...b, role: r.message.role, time: Date.parse(r.timestamp)}));
  });
  const uses = blocks.filter(b => b.type === 'tool_use' && b.name === 'SendMessage' && [state.peerName, state.peer.sock, `uds:${state.peer.sock}`].includes(b.input?.to));
  const ids = new Set(uses.map(b => b.id));
  return blocks.filter(b => uses.includes(b) || (b.type === 'tool_result' && ids.has(b.tool_use_id)) ||
    deliveryNotice(b, state) || idleNotice(b, state));
}
export function assessGolden(data) {
  const { state: s, prompt, records, rollout, controller, poll, ipc, wire, second, before, after } = data;
  if (!s?.marker || s.marker.length < 32 || !s.runId || s.peerName !== s.peer?.name || !s.label || !Number.isFinite(s.startedAt)) throw new Error('Golden state identity'); // S5B:state
  if (typeof prompt !== 'string' || prompt.includes(s.marker)) throw new Error('Marker in original prompt'); // S5B:prompt
  if (poll?.status !== 'complete' || poll.runId !== s.runId || poll.exitCode !== 0) throw new Error('Golden poll incomplete'); // S5B:poll
  const text = records.filter(r => r.type === 'item.completed' && r.item?.type === 'agent_message').map(r => r.item.text).join('');
  if (!text.includes(s.marker) || poll.text !== text) throw new Error('Golden concatenated output/marker'); // S5B:text
  const commands = records.filter(r => r.type === 'item.completed' && r.item?.type === 'command_execution');
  if (commands.length !== 1 || commands[0].item.exit_code !== 0 || !/\bsleep\s+150\b/.test(commands[0].item.command ?? '')) throw new Error('Golden bounded tool command'); // S5B:tool
  const turns = records.filter(r => r.type === 'turn.completed');
  if (records.filter(r => r.type === 'turn.started').length !== 1 || turns.length !== 1 || records.filter(r => Object.hasOwn(r, '__t2f5_done__')).length !== 1 || records.find(r => Object.hasOwn(r, '__t2f5_done__'))?.__t2f5_done__ !== 0 || records.some(r => ['turn.failed', 'error'].includes(r.type))) throw new Error('Golden requires exactly one successful turn'); // S5B:turns
  const usage = turns[0].usage;
  if (!(Number.isFinite(usage?.input_tokens) && Number.isFinite(usage?.output_tokens) && usage.input_tokens > 0 && usage.output_tokens > 0) || poll.split?.input !== usage.input_tokens || poll.split?.output !== usage.output_tokens || poll.usage?.tokens !== usage.input_tokens + usage.output_tokens || !(Number.isFinite(poll.usage?.usd) && poll.usage.usd > 0) || poll.usdSource !== 'estimated') throw new Error('Golden nonzero accounting'); // S5B:usage
  const thread = records.filter(r => r.type === 'thread.started');
  if (thread.length !== 1 || !thread[0].thread_id || rollout.filter(r => r.type === 'session_meta' && r.payload?.id === thread[0].thread_id).length !== 1) throw new Error('Golden rollout thread'); // S5B:thread
  const userMessages = rollout.filter(r => r.type === 'response_item' && r.payload?.type === 'message' && r.payload.role === 'user');
  const visible = r => (r.payload.content ?? []).filter(c => c.type === 'input_text').map(c => c.text).join('');
  if (rollout.filter(r => r.type === 'event_msg' && r.payload?.type === 'task_started').length !== 1) throw new Error('Golden rollout second turn'); // S5B:rollout-turn
  const requests = ipc.filter(e => e.direction === 'sidecar-to-driver' && e.message?.type === 'steer' && e.message.text?.includes(s.marker));
  if (requests.length !== 1 || requests[0].message.runId !== s.runId) throw new Error('Golden steer request'); // S5B:steer
  const request = requests[0], active = ipc.slice(0, ipc.indexOf(request)).findLast(e => e.direction === 'driver-to-sidecar' && e.message?.type === 'active-turn-state');
  const result = ipc.find(e => e.direction === 'driver-to-sidecar' && e.message?.type === 'steer-result' && e.message.reqId === request.message.reqId);
  if (!active?.message.turnId || active.message.turnId !== request.message.expectedTurnId || active.message.threadId !== thread[0].thread_id || active.message.runId !== s.runId || active.time > request.time || !result || ipc.indexOf(result) < ipc.indexOf(request) || result.time < request.time || result.message.outcome !== 'delivered') throw new Error('Golden active steer result'); // S5B:active
  // The retained rollout identifies task input separately from startup context.
  const tasks = userMessages.filter(r => r.payload.internal_chat_message_metadata_passthrough?.content_item_kinds?.includes('user.text'));
  const start = rollout.find(r => r.type === 'event_msg' && r.payload?.type === 'task_started');
  const ends = rollout.filter(r => r.type === 'event_msg' && r.payload?.type === 'task_complete');
  const injected = userMessages.filter(r => visible(r) === request.message.text);
  const original = tasks[0], steer = injected[0], end = ends[0];
  if (!original || visible(original) !== prompt || injected.length !== 1 || tasks.length !== 2 || tasks[1] !== steer ||
      start?.payload.turn_id !== request.message.expectedTurnId || ends.length !== 1 || end.payload.turn_id !== request.message.expectedTurnId ||
      [original, steer].some(r => r.payload.internal_chat_message_metadata_passthrough?.turn_id !== request.message.expectedTurnId) ||
      !(rollout.indexOf(start) < rollout.indexOf(original) && rollout.indexOf(original) < rollout.indexOf(steer) && rollout.indexOf(steer) < rollout.indexOf(end)) ||
      !Number.isFinite(Date.parse(steer?.timestamp)) || Date.parse(steer.timestamp) < request.time || Date.parse(steer.timestamp) > Date.parse(end?.timestamp) ||
      rollout.slice(0, rollout.indexOf(steer)).some(r => r.type === 'response_item' && JSON.stringify(r.payload).includes(s.marker))) throw new Error('Golden model-visible rollout marker'); // S5B:rollout
  const uses = controller.filter(b => b.type === 'tool_use' && b.name === 'SendMessage' && [s.peerName, s.peer.sock, `uds:${s.peer.sock}`].includes(b.input?.to));
  const markerUses = uses.filter(b => typeof b.input.message === 'string' && b.input.message.includes(s.marker));
  if (markerUses.length !== 1 || uses.length !== 1) throw new Error('Golden controller marker tool'); // S5B:controller
  const replies = controller.filter(b => b.type === 'tool_result' && b.tool_use_id === markerUses[0].id && !b.is_error);
  const reply = replies.flatMap(payloads);
  const sent = wire.filter(e => e.direction === 'in' && e.frame.type === 'user' && e.frame.msg_id === request.message.msgId);
  const delivered = wire.filter(e => e.direction === 'out' && e.frame.action === 'peer_message_status' && e.frame.orig_msg_id === request.message.msgId && e.frame.from === `uds:${s.peer.sock}` && e.frame.status === 'delivered' && e.frame.status_detail === undefined);
  const receipt = reply.find(p => p.msg_id === request.message.msgId && p.success === true);
  if (sent.length !== 1 || sent[0].frame.from !== request.message.senderFrom || !sent[0].frame.message?.content?.includes(s.marker) || delivered.length !== 1 || !receipt) throw new Error('Golden delivered callback, not ack'); // S5B:delivered
  const delivery = controller.filter(b => deliveryNotice(b, s));
  if (delivery.length !== 1 || !delivery[0].text.includes('approved and released') || /\b(refused|held|expired)\b/i.test(delivery[0].text)) throw new Error('Golden controller delivery notice'); // S5B:delivery-notice
  if (replies.length !== 1 || controller.indexOf(delivery[0]) <= controller.indexOf(replies[0]) || !Number.isFinite(replies[0].time) || !Number.isFinite(delivery[0].time) || delivery[0].time < replies[0].time) throw new Error('Golden controller delivery ordering'); // S5B:delivery-order
  if (wire.some(e => e.direction === 'out' && e.frame.action === 'peer_message_status' && e.frame.orig_msg_id === request.message.msgId && /^(held|refused|expired)$/.test(e.frame.status))) throw new Error('Golden conflicting delivery status'); // S5B:delivery-conflict
  const subscriptions = uses.filter(b => b.input.notify_when_idle === true);
  const subscribed = wire.filter(e => e.direction === 'in' && e.frame.action === 'notify_when_idle');
  const notices = wire.filter(e => e.direction === 'out' && e.frame.action === 'peer_idle_notice').map(e => e.frame);
  const admitted = controller.filter(b => idleNotice(b, s));
  if (subscriptions.length !== 1 || subscribed.length !== 1 || notices.length !== 1 || admitted.length !== 1 || notices[0].state !== 'idle' || notices[0].finished_at < s.startedAt) throw new Error('Golden exactly one idle notice'); // S5B:idle
  if (!Number.isFinite(admitted[0].time) || admitted[0].time < notices[0].finished_at || notices[0].from !== `uds:${s.peer.sock}`) throw new Error('Golden controller idle completion'); // S5B:idle-completion
  // Recipient-only renderer notices are attributable only in a single-message run.
  const runUsers = wire.filter(e => e.direction === 'in' && e.frame.type === 'user' && e.time <= admitted[0].time);
  const runDeliveries = wire.filter(e => e.direction === 'out' && e.frame.action === 'peer_message_status' && e.frame.status === 'delivered' && e.time <= admitted[0].time);
  if (runUsers.length !== 1 || runUsers[0] !== sent[0] || runDeliveries.length !== 1 || runDeliveries[0] !== delivered[0]) throw new Error('Golden ambiguous delivery window'); // S5B:window
  const subscriptionReply = controller.filter(b => b.type === 'tool_result' && b.tool_use_id === subscriptions[0].id && !b.is_error).flatMap(payloads);
  if (!subscriptionReply.some(p => p.success === true || (p.msg_id ?? p.orig_msg_id) === notices[0].orig_msg_id) || subscribed[0].frame.msg_id !== notices[0].orig_msg_id || subscribed[0].frame.from !== sent[0].frame.from) throw new Error('Golden idle correlation'); // S5B:idle-id
  if (![active.time, request.time, result.time, sent[0].time, delivered[0].time, notices[0].finished_at].every(Number.isFinite) || delivered[0].time < result.time || sent[0].time > request.time || request.time < s.startedAt || result.time > notices[0].finished_at) throw new Error('Golden lifecycle ordering'); // S5B:order
  const wrapperMode = sent[0].frame.message.content.match(/^<cross-session-message\b[^>]*\sfrom-mode="([^"]+)"/)?.[1];
  if (!wrapperMode || typeof subscribed[0].frame.from_mode !== 'string' || !subscribed[0].frame.from_mode || wrapperMode !== subscribed[0].frame.from_mode || notices[0].from_mode !== subscribed[0].frame.from_mode) throw new Error('Golden from_mode echo'); // S5B:mode
  const secondIn = wire.filter(e => e.direction === 'in' && e.frame.type === 'user' && e.frame.msg_id === second?.sentFrame?.msg_id);
  const secondOut = wire.filter(e => e.direction === 'out' && (e.time >= second?.sentAt || e.frame.orig_msg_id === second?.sentFrame?.msg_id));
  const refusal = p => p?.action === 'peer_message_status' && p.orig_msg_id === second.sentFrame?.msg_id && p.status === 'expired' && p.status_detail === 'refused' && p.from === `uds:${s.peer.sock}` && p.from_mode === second.sentFrame.from_mode;
  if (!Number.isFinite(second?.sentAt) || !Number.isFinite(s.lingerMs) || s.lingerMs <= 0 ||
      !second.sentFrame?.msg_id || second.sentFrame.msg_id === request.message.msgId || second.sentFrame.type !== 'user' ||
      second.callbackFrames?.length !== 2 || second.callbackFrames[0].type !== 'auth' || second.callbackFrames[0].authenticated !== true || !refusal(second.callbackFrames[1]) ||
      !Array.isArray(second.senderReplies) || second.senderReplies.length !== 0 ||
      secondIn.length !== 1 || !isDeepStrictEqual(secondIn[0].frame, second.sentFrame) ||
      secondOut.length !== 1 || !refusal(secondOut[0].frame) || !isDeepStrictEqual(secondOut[0].frame, second.callbackFrames[1]) ||
      !Number.isFinite(secondIn[0].time) || !Number.isFinite(secondOut[0].time) || secondIn[0].time < second.sentAt || secondOut[0].time < secondIn[0].time ||
      second.sentAt < admitted[0].time || second.sentAt < notices[0].finished_at || second.sentAt > notices[0].finished_at + s.lingerMs ||
      ipc.some(e => e.time >= second.sentAt && (e.message?.type === 'steer' || (e.message?.type === 'active-turn-state' && e.message.turnId))) ||
      rollout.some(r => r.type === 'event_msg' && r.payload?.type === 'task_started' && Date.parse(r.timestamp) >= second.sentAt)) throw new Error('Golden post-completion refusal'); // S5B:refusal
  const pids = s.pids.filter(p => ['driver', 'app-server'].includes(p.role));
  if (!pids.some(p => p.role === 'driver') || !pids.some(p => p.role === 'app-server') || pids.some(p => !p.start || !Number.isInteger(p.pid) || !before.split('\n').some(l => Number(l.trim().split(/\s+/)[0]) === p.pid) || after.split('\n').some(l => Number(l.trim().split(/\s+/)[0]) === p.pid) || data.identitiesAfter?.find(a => a.pid === p.pid && a.start === p.start)?.state !== 'dead')) throw new Error('Golden process exit evidence'); // S5B:pids
  return true;
}

/** Probe-only observer in the sidecar process; never logs authentication frames.
 * Captures actual incoming modes and outgoing callbacks, since Claude renders idle
 * notices as prose and omits wire fields from its SendMessage tool result. */
export function goldenTraceSource() { return ipcTraceSource() + String.raw`
import { Socket } from 'node:net';
if (process.env.STRATUM_PEER_OWNER_KIND === 'codex-appserver') {
  const buffers = new WeakMap();
  const capture = (socket, direction, chunk) => {
    if (typeof chunk !== 'string' && !Buffer.isBuffer(chunk)) return;
    const parts = buffers.get(socket) ?? {in: '', out: ''};
    parts[direction] += chunk.toString();
    let end;
    while ((end = parts[direction].indexOf('\n')) >= 0) {
      const line = parts[direction].slice(0, end); parts[direction] = parts[direction].slice(end + 1);
      try {
        const frame = JSON.parse(line);
        if (frame.type === 'user' || (frame.type === 'control' && ['notify_when_idle', 'peer_message_status', 'peer_idle_notice'].includes(frame.action)))
          appendFileSync(process.env.PEER3_IPC + '.wire', JSON.stringify({time: Date.now(), direction, frame}) + '\n', {mode: 0o600});
      } catch { /* Non-JSON is not evidence. */ }
    }
    if (parts[direction].length > 1024 * 1024) parts[direction] = '';
    buffers.set(socket, parts);
  };
  const emit = Socket.prototype.emit, end = Socket.prototype.end;
  Socket.prototype.emit = function(event, ...args) { if (event === 'data') capture(this, 'in', args[0]); return emit.call(this, event, ...args); };
  Socket.prototype.end = function(chunk, ...args) { capture(this, 'out', chunk); return end.call(this, chunk, ...args); };
}
`; }

export async function goldenStart({ model, out }) {
  if (!model || !out) throw new Error('golden start requires --model and --out');
  const output = join(resolve(out), 'golden');
  await mkdir(resolve(out), { recursive: true, mode: 0o700 });
  await mkdir(output, { mode: 0o700 });
  const root = await mkdtemp('/tmp/p3-gold-'), pids = [];
  let run;
  try {
    await recordIdentity(output); await pinCheck();
    const home = await privateHome(root), cwd = join(root, 'workspace'), registryRoot = join(root, 'runs');
    await mkdir(cwd, { mode: 0o700 });
    const { resolveSessionsDir } = await production('peer-registry');
    const sessionsDir = resolveSessionsDir(process.env); // Resolve BEFORE replacing CODEX_HOME. Real Claude registry.
    const trace = join(root, 'trace.mjs'); await writeFile(trace, goldenTraceSource(), { mode: 0o600 });
    const label = `golden-${randomBytes(6).toString('hex')}`, marker = randomBytes(24).toString('hex'), startedAt = Date.now(), lingerMs = 120_000;
    const prompt = 'Run exactly one bounded shell tool command: sleep 150. Wait for that command to finish. Then give a final answer including verbatim any marker received in a peer message during this turn. Do not start another command or modify files.';
    const { startBackgroundRun } = await production('background');
    run = await startBackgroundRun({ agent: 'codex', model, prompt, cwd, registryRoot, sessionsDir, peerLabel: label, lingerMs,
      sandboxMode: 'read-only', approvalPolicy: 'never', env: { ...process.env, CODEX_HOME: home, STRATUM_CODEX_BG_STRATEGY: 'app-server', STRATUM_PEER_REGISTER: '1',
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${trace}`, PEER3_IPC: join(root, 'ipc.jsonl') } });
    pids.push(await capturePid(run.pid, 'driver'));
    const peerPath = join(dirname(run.streamPath), 'peer.json');
    await waitFor(async () => await exists(peerPath) && (await recordsAt(run.streamPath)).some(r => r.type === 'turn.started'), 60_000);
    const peer = await json(peerPath);
    if (!run.peerName || run.peerName !== peer.name) throw new Error('Real peer registration failed');
    await waitFor(async () => {
      const ps = await runBounded('ps', ['-axo', 'pid,ppid,command'], {timeoutMs: 5000});
      if (ps.code !== 0) throw new Error('Cannot discover app-server');
      const row = ps.stdout.split('\n').find(l => Number(l.trim().split(/\s+/)[1]) === run.pid && /\bcodex\b.*\bapp-server\b/.test(l));
      if (!row) return false;
      pids.push(await capturePid(Number(row.trim().split(/\s+/)[0]), 'app-server')); return true;
    }, 10_000);
    if ((await recordsAt(run.streamPath)).some(r => r.type === 'turn.completed')) throw new Error('Turn already finished');
    await snapshot(join(output, 'before.ps'), pids);
    await writeFile(join(output, 'prompt.txt'), await readFile(`${run.streamPath}.in`), {mode: 0o600});
    const state = { ...run, peerName: peer.name, label, marker, peer, pids, startedAt, lingerMs, root, home, registryRoot, sessionsDir };
    await writeEvidence(join(output, 'state.json'), state);
    console.log(JSON.stringify({peerName: peer.name, marker, runId: run.runId, collectBefore: new Date(startedAt + 270_000).toISOString()}, null, 2));
    return state;
  } catch (error) {
    if (run) await (await production('background')).cancelBackgroundRun(run.runId, {registryRoot: join(root, 'runs')}).catch(() => {});
    await reapCaptured(pids).catch(() => {}); await rm(root, {recursive: true, force: true}); throw error;
  }
}
async function findRollout(home, threadId) {
  async function walk(dir) {
    const found = [];
    for (const entry of await readdir(dir, {withFileTypes: true})) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) found.push(...await walk(path));
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        const records = await strictRecords(path);
        if (records.some(r => r.type === 'session_meta' && r.payload?.id === threadId)) found.push(records);
      }
    }
    return found;
  }
  const matches = await walk(join(home, 'sessions'));
  if (matches.length !== 1) throw new Error('Missing unique Codex thread rollout');
  return matches[0];
}
export async function loadGolden(output) {
  const data = {};
  for (const key of ['state', 'records', 'rollout', 'controller', 'poll', 'ipc', 'wire', 'second', 'identitiesAfter']) data[key] = await json(join(output, `${key}.json`));
  data.prompt = await readFile(join(output, 'prompt.txt'), 'utf8');
  data.before = await readFile(join(output, 'before.ps'), 'utf8');
  data.after = await readFile(join(output, 'after.ps'), 'utf8');
  return data;
}
async function strictRecords(path) {
  return (await readFile(path, 'utf8')).split('\n').filter(line => line.trim()).map(line => JSON.parse(line));
}
export async function goldenCollect({ out, transcript }) {
  if (!out || !transcript) throw new Error('golden collect requires --out and --transcript');
  const output = join(resolve(out), 'golden'), state = await json(join(output, 'state.json'));
  if (await exists(join(output, 'summary.json'))) throw new Error('Golden collection already attempted; use a fresh root');
  let sender, failure;
  const started = Date.now();
  try {
    const poll = await finishRun(state, state.registryRoot);
    await writeEvidence(join(output, 'poll.json'), poll);
    // Wait for the sidecar's actual terminal observation before testing refusal.
    await waitFor(async () => (await recordsAt(join(state.root, 'ipc.jsonl.wire'))).some(e => e.direction === 'out' && e.frame?.action === 'peer_idle_notice'), 10_000);
    // Do this before slower gathering, while the real sidecar is within linger.
    const second = {sentAt: Date.now()};
    sender = await probePeerSender({root: dirname(state.peer.sock), sessionsDir: state.sessionsDir, data: second});
    const { keyFileName } = await production('peer-registry');
    const { peerToken } = await json(join(state.sessionsDir, keyFileName(state.peer.pid, state.peer.sock)));
    try {
      await sender.send(state.peer.sock, peerToken, `s5b-finished-${randomBytes(8).toString('hex')}`);
      await waitFor(() => second.callbackFrames.some(f => f.action === 'peer_message_status'), 10_000);
    } finally { await writeEvidence(join(output, 'second.json'), second); }
    await sender.close(); sender = undefined;
    await waitFor(async () => (await Promise.all(state.pids.map(pidState))).every(s => s === 'dead'), 10_000);
    await snapshot(join(output, 'after.ps'), state.pids);
    await writeEvidence(join(output, 'identitiesAfter.json'), await Promise.all(state.pids.map(async p => ({...p, state: await pidState(p)}))));
    const records = await strictRecords(state.streamPath);
    await writeEvidence(join(output, 'records.json'), records);
    await writeEvidence(join(output, 'ipc.json'), await strictRecords(join(state.root, 'ipc.jsonl')));
    await writeEvidence(join(output, 'wire.json'), await strictRecords(join(state.root, 'ipc.jsonl.wire')));
    await writeEvidence(join(output, 'rollout.json'), await findRollout(state.home, records.find(r => r.type === 'thread.started')?.thread_id));
    // Read repeatedly to allow the controller to persist both user notices. Only
    // selected blocks are ever written to the evidence bundle, including on failure.
    await waitFor(async () => {
      const selected = extractController(await strictRecords(transcript), state);
      await writeEvidence(join(output, 'controller.json'), selected);
      return selected.some(b => idleNotice(b, state)) && selected.some(b => deliveryNotice(b, state));
    }, 15_000);
    assessGolden(await loadGolden(output));
  } catch (error) { failure = error.message; }
  finally {
    if (sender) await sender.close();
    await writeEvidence(join(output, 'summary.json'), {mode: 'golden', outcome: failure ? 'failed' : 'passed', error: failure, elapsedMs: Date.now() - started});
    // Never turn cleanup into evidence of successful natural reaping.
    if (failure) {
      await (await production('background')).cancelBackgroundRun(state.runId, {registryRoot: state.registryRoot}).catch(() => {});
      await reapCaptured(state.pids).catch(() => {});
    }
    await rm(join(state.home, 'auth.json'), {force: true});
    // Leave run files until sidecar linger ends; no credentials or unrelated transcript retained.
  }
  if (failure) throw new Error(failure);
}

// The row accepts the amended AC; individual methods retain their raw verdicts.
export function scoreServerRequests(methods) {
  if (methods.some(m => !['proven', 'unreached'].includes(m.status))) throw new Error('Elicited method not proven'); // S5B:amended-elicited
  if (requiredServerMethods.some(method => !methods.some(m => m.method === method)) || methods.some(m => m.status === 'unreached' && !m.triggers?.length)) throw new Error('Unreached method has no recorded trigger'); // S5B:amended-triggers
  const proven = methods.filter(m => m.status === 'proven').length;
  if (!proven) throw new Error('No proven server request method'); // S5B:amended-proven
  const unreached = methods.filter(m => m.status === 'unreached').length;
  return {status: unreached ? 'passed-amended' : 'passed', reason: `${proven} proven, ${unreached} unreached (recorded with triggers)`};
}

export function assessLiveRows(rows) {
  if (rows.some(r => r.status !== 'passed' && !(r.ac === 'AC05 rerun' && r.status === 'passed-amended'))) throw new Error('Required live gate incomplete'); // S5B:verify-complete
  return true;
}

export async function verifyEvidence({ out }) {
  if (!out) throw new Error('verify-evidence requires --out');
  const root = resolve(out), rows = [], methods = [];
  const check = async (ac, fn) => {
    try { const result = await fn(); rows.push({ac, status: 'passed', reason: '', ...result}); }
    catch (e) { rows.push({ac, status: e.code === 'ENOENT' ? 'unreached' : 'failed', reason: e.message}); }
  };
  await check('preflight', async () => {
    for (const name of requiredCases.preflight) {
      const raw = await json(join(root, 'preflight', `${name}.json`));
      const { PINNED_APP_SERVER_VERSION } = await import(new URL('../src/connectors/codex-appserver-protocol/pinned-version.ts', import.meta.url));
      if (!assessPreflight(name, raw, PINNED_APP_SERVER_VERSION)) throw new Error(`Preflight ${name} failed`); // S5B:verify-preflight
    }
  });
  await check('AC03', async () => {
    const dir = join(root, 'sandbox'), raw = {};
    for (const mode of ['built-in', 'ordinary', 'override']) raw[mode] = await json(join(dir, 'exec-baseline', `${mode}.json`));
    const baseline = assessExecBaseline(await json(join(dir, 'exec-baseline/report.json')), raw);
    for (const name of requiredCases.sandbox) {
      const data = await json(join(dir, `${name}.json`));
      if (data.error) throw new Error(data.error);
      assessSandboxCase(name, data);
      if (name.startsWith('temp-')) for (const key of ['TMPDIR', 'slashTmp']) {
        const value = baseline[name.slice(5)][key];
        if (data.observed[key] !== value || !isDeepStrictEqual(data.tempComparison[key], {exec: value, appServer: value})) throw new Error('Exec/app-server temp mismatch'); // S5B:verify-temp
      }
    }
  });
  await check('AC13', async () => {
    for (const name of requiredCases['process-tree']) {
      const dir = join(root, 'process-tree'), data = await json(join(dir, `${name}.json`));
      if (data.error) throw new Error(data.error);
      assessProcessCase(name, data);
      for (const suffix of ['before', 'after']) {
        const ps = await readFile(join(dir, `${name}.${suffix}.ps`), 'utf8');
        if (!ps.trim() || data.pids.filter(p => ['driver', 'app-server'].includes(p.role)).some(p => ps.split('\n').some(line => Number(line.trim().split(/\s+/)[0]) === p.pid) !== (suffix === 'before'))) throw new Error('Process snapshot PID mismatch'); // S5B:process-ps
      }
    }
  });
  let serverRoot = join(root, 'server-requests');
  if (!await exists(join(serverRoot, 'report.json')) && await exists(join(root, 'report.json'))) serverRoot = root;
  await check('AC05 rerun', async () => {
    const runs = [], errors = [];
    for (const [i, trigger] of serverRequestTriggers.entries()) {
      let run;
      try {
        run = await json(join(serverRoot, `run-${i}.json`));
        if (!isDeepStrictEqual(run.trigger, trigger) || run.claim !== 'completed') throw new Error('Server request trigger/terminal mismatch'); // S5B:verify-trigger
        const client = run.transcript.filter(e => e.direction === 'client').map(e => e.frame);
        const thread = client.find(f => f.method === 'thread/start')?.params, turn = client.find(f => f.method === 'turn/start')?.params;
        if (thread?.approvalPolicy !== trigger.approvalPolicy || thread?.sandbox !== trigger.filesystemMode || turn?.sandboxPolicy || !turn?.input?.some(v => v.type === 'text' && v.text === trigger.prompt)) throw new Error('Server request launch mismatch'); // S5B:verify-launch
        if (!run.transcript.some(e => e.direction === 'server' && e.frame?.method === 'turn/completed' && e.frame.params?.turn?.status === 'completed')) throw new Error('Server request missing terminal'); // S5B:verify-terminal
      } catch (error) {
        errors.push(error);
        if (run) run.validationError = error.message;
      }
      if (run) runs.push({...run, file: `run-${i}.json`});
    }
    methods.push(...assessServerRequests(runs, (await production('codex-appserver-driver')).respondToServerRequest, {report: true}));
    if (errors.length) throw errors[0];
    return scoreServerRequests(methods);
  });
  await check('AC07', async () => { assessGolden(await loadGolden(join(root, 'golden'))); });
  await check('AC16', async () => {
    const identities = await Promise.all(['preflight', 'sandbox', 'process-tree', 'golden'].map(mode => json(join(root, mode, 'identity.json'))));
    identities.push(await json(join(serverRoot, 'identity.json')));
    assessIdentities(identities);
    for (const [key, file] of [['codex', 'codex-version'], ['claude', 'claude-version'], ['head', 'git-head']]) {
      if (identities[0][key].stdout.trim() !== (await json(join(root, 'preflight', `${file}.json`))).stdout.trim()) throw new Error('Preflight identity mismatch'); // S5B:verify-identity
    }
    assessLiveRows(rows);
  });
  return {passed: rows.find(r => r.ac === 'AC16')?.status === 'passed', rows, methods};
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
}
