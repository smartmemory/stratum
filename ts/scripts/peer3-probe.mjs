#!/usr/bin/env node
import { isDeepStrictEqual } from 'node:util';
/** Opt-in live evidence. Importing this module never starts a model turn. */
import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, copyFile, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
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
  if (!['sandbox-baseline', 'server-requests'].includes(mode)) throw new Error('Usage: peer3-probe.mjs sandbox-baseline --model MODEL/EFFORT --out NEW_DIRECTORY');
  const parsed = {};
  for (let i = 0; i < options.length; i += 2) {
    const key = options[i];
    if (!['--model', '--out'].includes(key) || !options[i + 1] || parsed[key.slice(2)]) throw new Error('Invalid or duplicate probe option');
    parsed[key.slice(2)] = options[i + 1];
  }
  if (mode === 'server-requests') await serverRequests(parsed);
  else await sandboxBaseline(parsed);
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
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
export function assessServerRequests(runs, replyFor) {
  const proven = new Map();
  for (const run of runs) {
    const traffic = run.transcript;
    for (let index = 0; index < traffic.length; index++) {
      const request = traffic[index];
      if (request.direction !== 'server' || typeof request.frame?.method !== 'string' || request.frame.id === undefined) continue;
      const { method, id } = request.frame;
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
    }
  }
  return requiredServerMethods.map(method => {
    if (proven.has(method)) return { method, status: 'proven', evidence: proven.get(method) };
    const triggers = runs.filter(run => run.trigger?.methods.includes(method)).map(run => ({ file: run.file, ...run.trigger }));
    if (!triggers.length) throw new Error(`${method}: no recorded trigger attempt`);
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
