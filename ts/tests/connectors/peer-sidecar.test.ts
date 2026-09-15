import { afterEach, expect, it } from "vitest";
import { transpileModule, ModuleKind, ScriptTarget } from "typescript";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { appendFile, lstat, chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { claudeProcStart, keyFileName, resolveSessionsDir, type PeerRecordFile, type PeerSidecarConfig } from "../../src/connectors/peer-registry.js";
import { procStartTime } from "../../src/connectors/proc_identity.js";
import { startBackgroundRun, pollBackgroundRun, cancelBackgroundRun } from "../../src/connectors/background.js";
import { peerName } from "../../src/connectors/peer-registry.js";
import { assertToolResponse } from "../../src/mcp/contracts.js";
import { spawnPeerSidecar } from "../../src/connectors/peer-sidecar.js";

const roots: string[] = [];
const backgroundPids = new Set<number>();
const configs: PeerSidecarConfig[] = [];
const children: ChildProcess[] = [];
const servers: Server[] = [];
const sockets = new Set<Socket>();
async function waitFor<T>(read: () => Promise<T>, accepts: (value: T) => boolean, timeout = 6000): Promise<T> {
  const deadline = Date.now() + timeout;
  let last: unknown;
  while (Date.now() < deadline) {
    try { const value = await read(); if (accepts(value)) return value; last = value; } catch (error) { last = error; }
    await delay(20);
  }
  throw new Error(`Timed out: ${String(last)}`);
}
async function json(path: string): Promise<Record<string, unknown>> { return JSON.parse(await readFile(path, "utf8")); }
async function fixture(): Promise<PeerSidecarConfig> {
  const runDir = await mkdtemp(join(tmpdir(), "sp-")); roots.push(runDir);
  const sockDir = await mkdtemp("/tmp/sp-"); roots.push(sockDir);
  const sessionsDir = join(runDir, "sessions"); await mkdir(sessionsDir);
  const streamPath = join(runDir,"stream.jsonl"); await writeFile(streamPath, "");
  const config = {runDir,streamPath,childPid:process.pid,childProcStartTime:(await procStartTime(process.pid))!,cwd:runDir,name:"codex-astra-abcdef",sessionsDir,sockDir,lingerMs:500};
  configs.push(config); return config;
}
async function launch(config: PeerSidecarConfig, setup = "", launcher = spawnPeerSidecar): Promise<void> {
  // A real Node preload records even failed startup pids so afterEach can reap them.
  const preload = join(config.runDir, "preload.mjs");
  await writeFile(preload, `import {writeFileSync, mkdirSync} from 'node:fs';\nwriteFileSync(${JSON.stringify(join(config.runDir,"test-pid"))}, String(process.pid));\nprocess.on("exit", code => { try { writeFileSync(${JSON.stringify(join(config.runDir,"test-exit"))}, String(code)); } catch {} });\n${setup}`);
  const previous = process.env.NODE_OPTIONS;
  process.env.NODE_OPTIONS = `${previous ?? ""} --import=${pathToFileURL(preload).href}`;
  try { await launcher(config); } finally {
    if (previous === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = previous;
  }
}
async function peer(config: PeerSidecarConfig): Promise<PeerRecordFile> {
  return await waitFor(() => json(join(config.runDir,"peer.json")), value => typeof value.pid === "number") as PeerRecordFile;
}
async function waitForCleanup(config: PeerSidecarConfig, registered: PeerRecordFile, timeout = 6000): Promise<void> {
  const paths = [join(config.sessionsDir,`${registered.pid}.json`),
    join(config.sessionsDir,keyFileName(registered.pid,registered.sock)),registered.sock];
  await waitFor(async () => paths.every(path => !existsSync(path)), Boolean, timeout);
}
async function send(sock: string, frames: unknown[]): Promise<void> {
  const connection = createConnection(sock); sockets.add(connection);
  connection.on("close", () => sockets.delete(connection));
  await once(connection,"connect");
  connection.end(frames.map(frame => typeof frame === "string" ? frame : JSON.stringify(frame)).join("\n") + "\n");
  await once(connection,"close");
}
async function requester(config: PeerSidecarConfig, pid = 987654): Promise<{sock: string; frames: Record<string, unknown>[]}> {
  const sock = join(config.sockDir,`${pid}.sock`); const frames: Record<string, unknown>[] = [];
  const server = createServer(connection => {
    sockets.add(connection); connection.on("close", () => sockets.delete(connection));
    let pending = "";
    connection.on("data", data => {
      pending += data.toString(); let end: number;
      while ((end = pending.indexOf("\n")) >= 0) {
        frames.push(JSON.parse(pending.slice(0,end))); pending = pending.slice(end+1);
      }
    });
  });
  servers.push(server); server.listen(sock); await once(server,"listening");
  await writeFile(join(config.sessionsDir,keyFileName(pid,sock)),JSON.stringify({peerToken:"a".repeat(32)}));
  return {sock,frames};
}
function subscription(sock: string, id = "subscription-1"): Record<string, unknown> {
  return {type:"control",action:"notify_when_idle",msg_id:id,from:`uds:${sock}`};
}
afterEach(async () => {
  // Stop and reap durable wrappers before deleting files they can still write.
  for (const pid of backgroundPids) {
    try { process.kill(-pid,"SIGTERM"); } catch { continue; }
    await waitFor(async () => { try { process.kill(pid,0); return false; } catch { return true; } },Boolean);
  }
  backgroundPids.clear();
  for (const config of configs.splice(0)) {
    await chmod(config.runDir,0o700).catch(() => undefined);
    await chmod(config.sessionsDir,0o700).catch(() => undefined);
    const pids = new Set<number>();
    try { pids.add(Number(await readFile(join(config.runDir,"test-pid"),"utf8"))); } catch { /* spawn may fail */ }
    try { if ((await lstat(join(config.runDir,"peer.json"))).isFile()) pids.add(Number((await json(join(config.runDir,"peer.json"))).pid)); } catch { /* startup may fail */ }
    for (const name of await readdir(config.sessionsDir).catch(() => [])) {
      if (!/^\d+\.json$/.test(name)) continue;
      if (!(await lstat(join(config.sessionsDir,name)).catch(() => undefined))?.isFile()) continue;
      const record = await json(join(config.sessionsDir,name)).catch(() => null);
      if (record?.entrypoint === "stratum-peer") pids.add(Number(name.slice(0,-5)));
    }
    for (const pid of pids) {
      try { process.kill(pid,"SIGTERM"); } catch { continue; }
      const gone = async (): Promise<boolean> => { try { process.kill(pid,0); return false; } catch { return true; } };
      try { await waitFor(gone, Boolean,7000); }
      catch {
        // Even a broken sidecar under test must not outlive the fixture.
        try { process.kill(pid,"SIGKILL"); } catch { /* already exited */ }
        await waitFor(gone, Boolean);
      }
    }
  }
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exited = once(child,"exit"); try { process.kill(-child.pid!,"SIGTERM"); } catch { child.kill(); } await exited;
    }
  }
  for (const socket of sockets) socket.destroy(); sockets.clear();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  await Promise.all(roots.splice(0).map(dir => rm(dir,{recursive:true,force:true})));
});

it("disables ambient background registration without directory or env overrides", async () => {
  // Fail before spawning if the worker safety default disappears.
  expect(process.env.STRATUM_PEER_REGISTER).toBe("0");
  const sessionsDir = resolveSessionsDir(process.env);
  const before = existsSync(sessionsDir) ? new Set(await readdir(sessionsDir)) : undefined;
  const runDir = await mkdtemp(join(tmpdir(), "sp-")); roots.push(runDir);
  const registryRoot = join(runDir,"runs");
  const started = await startBackgroundRun({agent:"codex",prompt:"x",cwd:runDir,registryRoot,
    command:["sh","-c","sleep 0.1"]});
  backgroundPids.add(started.pid!);
  expect(started).not.toHaveProperty("peerName");
  await waitFor(() => pollBackgroundRun(started.runId,{registryRoot}), result => result.status === "complete");
  if (before) {
    const after = await readdir(sessionsDir);
    const addedPeers: string[] = [];
    for (const name of after) {
      if (before.has(name) || !/^\d+\.json$/.test(name)) continue;
      const record = await json(join(sessionsDir,name));
      if (record.entrypoint === "stratum-peer") addedPeers.push(name);
    }
    expect(addedPeers).toEqual([]);
  }
});

it("launcher resolves when its stderr path cannot be opened", async () => {
  const config = await fixture();
  await expect(spawnPeerSidecar({...config,streamPath:join(config.runDir,"missing","stream.jsonl")})).resolves.toBeUndefined();
});
it("registers a real socket, UTC identity, key and peer metadata from source", async () => {
  const config = await fixture(); await launch(config);
  const registered = await peer(config);
  const record = await json(join(config.sessionsDir,`${registered.pid}.json`));
  expect(record).toMatchObject({pid:registered.pid,kind:"bg",status:"busy",entrypoint:"stratum-peer",name:config.name,peerProtocol:1,peerFeatures:["notify_idle"],messagingSocketPath:registered.sock,procStart:await claudeProcStart(registered.pid)});
  expect(record.version).toBe(JSON.parse(await readFile(new URL("../../package.json",import.meta.url),"utf8")).version);
  expect(registered).toMatchObject({name:config.name,sock:join(config.sockDir,`${registered.pid}.sock`)});
  expect(Number.isNaN(Date.parse(registered.registeredAt))).toBe(false);
  const key = join(config.sessionsDir,keyFileName(registered.pid,registered.sock));
  expect((await stat(key)).mode & 0o777).toBe(0o600);
  expect((await stat(join(config.sessionsDir,`${registered.pid}.json`))).mode & 0o777).toBe(0o644);
  expect(await json(key)).toMatchObject({procStart:record.procStart,pidDomain:record.pidDomain});
  expect((await json(key)).peerToken).toMatch(/^[0-9a-f]{32}$/);
  await send(registered.sock,[]);
  expect(await readFile(config.streamPath,"utf8")).toBe("");
});
it("refuses a foreign own-pid record without overwriting it", async () => {
  const config = await fixture();
  await launch(config, `writeFileSync(${JSON.stringify(config.sessionsDir)} + '/' + process.pid + '.json', JSON.stringify({entrypoint:'foreign'}));`);
  await waitFor(() => readFile(`${config.streamPath}.peer.err`,"utf8"), text => text.includes("foreign"));
  const pid = Number(await readFile(join(config.runDir,"test-pid"),"utf8"));
  expect(await json(join(config.sessionsDir,`${pid}.json`))).toEqual({entrypoint:"foreign"});
  expect(existsSync(join(config.runDir,"peer.json"))).toBe(false);
  expect(existsSync(join(config.sockDir,`${pid}.sock`))).toBe(false);
});
it("tails complete lines, updates busy timestamps, ignores partial and oversized lines, then lingers idle", async () => {
  const config = await fixture(); await launch(config); const registered = await peer(config);
  const recordPath = join(config.sessionsDir,`${registered.pid}.json`);
  const initial = await json(recordPath);
  await appendFile(config.streamPath,'bad\n{"event":"é');
  await delay(600);
  expect((await json(recordPath)).updatedAt).toBe(initial.updatedAt);
  await appendFile(config.streamPath,'"}\n');
  await waitFor(() => json(recordPath), value => Number(value.updatedAt) > Number(initial.updatedAt));
  expect((await json(recordPath)).status).toBe("busy");
  await appendFile(config.streamPath,'x'.repeat(5_100_000)); await delay(600);
  await appendFile(config.streamPath,'{"__t2f5_done__":0}\n'); await delay(600);
  expect((await json(recordPath)).status).toBe("busy");
  await appendFile(config.streamPath,'{"__t2f5_done__":0}'); await delay(600);
  expect((await json(recordPath)).status).toBe("busy");
  await appendFile(config.streamPath,'\n');
  await waitFor(() => json(recordPath), value => value.status === "idle");
  await waitForCleanup(config,registered);
  expect(existsSync(join(config.runDir,"peer.json"))).toBe(true);
},10000);
it("registers an already completed stream idle on its first scan", async () => {
  const config = await fixture(); await writeFile(config.streamPath,'{"__t2f5_done__":7}\n');
  await launch(config); const registered = await peer(config);
  expect((await json(join(config.sessionsDir,`${registered.pid}.json`))).status).toBe("idle");
});
it("detects a killed child group without a sentinel and never acts on unknown identity", async () => {
  const config = await fixture();
  const child = spawn("sh",["-c","while :; do sleep 1; done"],{detached:true,stdio:"ignore"}); children.push(child); await once(child,"spawn");
  config.childPid = child.pid!; config.childProcStartTime = (await procStartTime(child.pid!))!;
  await launch(config); const registered = await peer(config);
  const exited = once(child,"exit"); process.kill(-child.pid!,"SIGTERM"); await exited;
  await waitFor(() => json(join(config.sessionsDir,`${registered.pid}.json`)), value => value.status === "idle");
  const unknown = await fixture(); delete unknown.childProcStartTime;
  await launch(unknown); const other = await peer(unknown); await delay(2300);
  expect((await json(join(unknown.sessionsDir,`${other.pid}.json`))).status).toBe("busy");
},10000);
it("refuses user messages with an authenticated dial-back and ignores malformed frames", async () => {
  const config = await fixture(); const recipient = await requester(config);
  await launch(config); const registered = await peer(config);
  await send(registered.sock,[{type:"auth",token:"stale"},"not-json",{type:"user",msg_id:"user-1",from_mode:"bypass",from:`uds:${recipient.sock}`}]);
  await waitFor(async () => recipient.frames, frames => frames.length === 2);
  expect(recipient.frames).toEqual([{type:"auth",token:"a".repeat(32)},{type:"control",action:"peer_message_status",orig_msg_id:"user-1",status:"expired",status_detail:"refused",from_mode:"bypass",from:`uds:${registered.sock}`}]);
});
it("golden flow delivers exactly one authenticated notice and accepts late subscriptions during linger", async () => {
  const config = await fixture(); const recipient = await requester(config);
  await launch(config); const registered = await peer(config);
  await send(registered.sock,[subscription(recipient.sock,"replaced"),{...subscription(recipient.sock,"keeper"),from_mode:"bypass"}]);
  await appendFile(config.streamPath,'{"__t2f5_done__":0}\n');
  await waitFor(async () => recipient.frames, frames => frames.length === 2);
  expect(recipient.frames[0]).toEqual({type:"auth",token:"a".repeat(32)});
  expect(recipient.frames[1]).toMatchObject({type:"control",action:"peer_idle_notice",orig_msg_id:"keeper",state:"idle",from_mode:"bypass",from:`uds:${registered.sock}`});
  expect(typeof recipient.frames[1]!.finished_at).toBe("number");
  expect((await json(join(config.sessionsDir,`${registered.pid}.json`))).status).toBe("idle");
  await send(registered.sock,[subscription(recipient.sock,"late")]);
  await waitFor(async () => recipient.frames, frames => frames.length === 4);
  expect(recipient.frames[3]).toMatchObject({orig_msg_id:"late",state:"idle",finished_at:recipient.frames[1]!.finished_at});
  await waitForCleanup(config,registered);
  expect(recipient.frames).toHaveLength(4);
  await expect(send(registered.sock,[subscription(recipient.sock,"too-late")])).rejects.toMatchObject({code:expect.stringMatching(/ENOENT|ECONNREFUSED/)});
});
it.each(["SIGTERM","SIGINT"] as const)("drains accepted subscriptions on %s and cleans only owned files", async signal => {
  const config = await fixture(); const recipient = await requester(config);
  await launch(config); const registered = await peer(config);
  await send(registered.sock,[subscription(recipient.sock)]);
  process.kill(registered.pid,signal);
  await waitFor(async () => recipient.frames, frames => frames.length === 2);
  expect(recipient.frames[1]).toMatchObject({orig_msg_id:"subscription-1",state:"exited"});
  await waitForCleanup(config,registered);
  expect(existsSync(recipient.sock)).toBe(true);
  expect(existsSync(join(config.sessionsDir,keyFileName(987654,recipient.sock)))).toBe(true);
  expect(await readFile(config.streamPath,"utf8")).toBe("");
});
it("reclaims only a stale socket for its own pid", async () => {
  const config = await fixture();
  await launch(config, `
    const {spawnSync} = await import('node:child_process');
    const path = ${JSON.stringify(config.sockDir)} + '/' + process.pid + '.sock';
    const made = spawnSync(process.execPath, ['--input-type=module','-e', 'import {createServer} from "node:net"; createServer().listen(' + JSON.stringify(path) + ', () => process.exit(0));'], {env:{...process.env,NODE_OPTIONS:''}});
    if (made.status !== 0) throw new Error('stale socket fixture failed');
  `);
  const registered = await peer(config); await send(registered.sock,[]);
});
it.each(["regular socket file", "live socket", "missing sessions", "key write failure", "peer metadata failure", "read-only run directory"])("error harness: %s", async scenario => {
  const config = await fixture();
  await writeFile(join(config.runDir,"meta.json"),'do not modify');
  let setup = "";
  if (scenario === "regular socket file") setup = `writeFileSync(${JSON.stringify(config.sockDir)} + '/' + process.pid + '.sock', 'foreign file');`;
  if (scenario === "live socket") setup = `const {existsSync} = await import('node:fs'); const {setTimeout:delay} = await import('node:timers/promises'); while (!existsSync(${JSON.stringify(join(config.runDir,"test-ready"))})) await delay(5);`;
  if (scenario === "missing sessions") await rm(config.sessionsDir,{recursive:true});
  if (scenario === "key write failure") setup = `const {createHash} = await import('node:crypto'); const sock = ${JSON.stringify(config.sockDir)} + '/' + process.pid + '.sock'; mkdirSync(${JSON.stringify(config.sessionsDir)} + '/' + process.pid + '.' + createHash('sha256').update(sock).digest('hex') + '.key');`;
  if (scenario === "peer metadata failure") await mkdir(join(config.runDir,"peer.json"));
  await launch(config,setup);
  if (scenario === "live socket") {
    const pid = await waitFor(async () => Number(await readFile(join(config.runDir,"test-pid"),"utf8")), value => value > 0);
    const server = createServer(socket => socket.end()); servers.push(server);
    server.listen(join(config.sockDir,`${pid}.sock`)); await once(server,"listening");
    await writeFile(join(config.runDir,"test-ready"),"");
  }
  if (scenario === "read-only run directory") {
    const registered = await peer(config); await chmod(config.runDir,0o500);
    await appendFile(config.streamPath,'{"__t2f5_done__":0}\n');
    await waitForCleanup(config,registered);
  } else {
    expect(await waitFor(() => readFile(join(config.runDir,"test-exit"),"utf8"), value => value === "2")).toBe("2");
    expect((await readFile(`${config.streamPath}.peer.err`,"utf8")).length).toBeGreaterThan(0);
    const pid = Number(await readFile(join(config.runDir,"test-pid"),"utf8"));
    expect(existsSync(join(config.sessionsDir,`${pid}.json`))).toBe(false);
    const sock = join(config.sockDir,`${pid}.sock`);
    if (scenario === "regular socket file") expect(await readFile(sock,"utf8")).toBe("foreign file");
    else if (scenario === "live socket") expect((await stat(sock)).isSocket()).toBe(true);
    else expect(existsSync(sock)).toBe(false);
    if (scenario !== "key write failure") expect(existsSync(join(config.sessionsDir,keyFileName(pid,sock)))).toBe(false);
    expect((await readdir(config.sessionsDir).catch(() => [])).filter(name => name.endsWith(".tmp"))).toEqual([]);
  }
  expect(await readFile(join(config.runDir,"meta.json"),"utf8")).toBe("do not modify");
});
it("caps subscriptions at 32, rejects invalid callbacks, and omits auth when no key exists", async () => {
  const config = await fixture(); const recipients: Awaited<ReturnType<typeof requester>>[] = [];
  for (let i = 0; i < 33; i++) recipients.push(await requester(config,900000+i));
  const first = recipients[0]!;
  await rm(join(config.sessionsDir,keyFileName(900000,first.sock)));
  await launch(config); const registered = await peer(config);
  await send(registered.sock,[
    subscription(first.sock.replace(config.sockDir,`${config.sockDir}/../${config.sockDir.split("/").pop()}`),"bad-path"),
    {type:"control",action:"notify_when_idle",msg_id:3,from:`uds:${first.sock}`},
    ...recipients.map((recipient,i) => subscription(recipient.sock,`id-${i}`)),
    subscription(first.sock,"full-replacement"),
  ]);
  await appendFile(config.streamPath,'{"__t2f5_done__":9}\n');
  await waitFor(async () => recipients.slice(0,32).every(recipient => recipient.frames.some(frame => frame.action === "peer_idle_notice")), Boolean);
  expect(first.frames).toHaveLength(1);
  expect(first.frames[0]).toMatchObject({orig_msg_id:"id-0",state:"idle",detail:"rc=9"});
  await waitForCleanup(config,registered);
  for (let i = 1; i < 32; i++) expect(recipients[i]!.frames).toHaveLength(2);
  expect(recipients[32]!.frames).toEqual([]);
});
it("reports exited with cancellation detail to a real requester after group death", async () => {
  const config = await fixture(); const recipient = await requester(config);
  const child = spawn("sh",["-c","while :; do sleep 1; done"],{detached:true,stdio:"ignore"}); children.push(child); await once(child,"spawn");
  config.childPid = child.pid!; config.childProcStartTime = (await procStartTime(child.pid!))!;
  await launch(config); const registered = await peer(config);
  await send(registered.sock,[subscription(recipient.sock)]);
  const exited = once(child,"exit"); process.kill(-child.pid!,"SIGTERM"); await exited;
  await waitFor(async () => recipient.frames, frames => frames.length === 2);
  expect(recipient.frames[1]).toMatchObject({state:"exited",detail:"cancelled_or_died",orig_msg_id:"subscription-1"});
});
it("bounds oversized socket input while continuing to serve other connections", async () => {
  const config = await fixture(); config.firstLineDeadlineMs = 300;
  await launch(config); const registered = await peer(config);
  const socket = createConnection(registered.sock); sockets.add(socket); socket.on("error",() => undefined);
  await once(socket,"connect");
  const closed = new Promise<void>(resolve => socket.once("close",() => { sockets.delete(socket); resolve(); }));
  socket.write('x'.repeat(1024 * 1024 + 1));
  await closed;
  await send(registered.sock,[]);
});
it("drains in-flight callbacks for at most five seconds when a requester holds its half open", async () => {
  const config = await fixture(); const sock = join(config.sockDir,"987650.sock");
  let attempts = 0;
  const server = createServer({allowHalfOpen:true}, socket => {
    attempts++; sockets.add(socket); socket.on("close",() => sockets.delete(socket)); socket.on("data",() => {});
  }); servers.push(server); server.listen(sock); await once(server,"listening");
  await launch(config); const registered = await peer(config);
  await send(registered.sock,[subscription(sock)]);
  const start = Date.now(); await appendFile(config.streamPath,'{"__t2f5_done__":0}\n');
  await waitFor(async () => attempts, count => count === 1);
  await delay(800);
  expect(existsSync(join(config.sessionsDir,`${registered.pid}.json`))).toBe(true);
  await waitForCleanup(config,registered,6000);
  expect(Date.now()-start).toBeLessThan(6500);
  expect(attempts).toBe(1);
},10000);
it("writes the specified file modes even under a restrictive inherited umask", async () => {
  const config = await fixture(); await launch(config,"process.umask(0o077);"); const registered = await peer(config);
  expect((await stat(join(config.sessionsDir,`${registered.pid}.json`))).mode & 0o777).toBe(0o644);
  expect((await stat(join(config.sessionsDir,keyFileName(registered.pid,registered.sock)))).mode & 0o777).toBe(0o600);
});
it("closes a connection that never supplies its first line within the configured deadline", async () => {
  const config = await fixture(); config.firstLineDeadlineMs = 300;
  await launch(config); const registered = await peer(config);
  const socket = createConnection(registered.sock); sockets.add(socket); socket.on("error",() => undefined);
  await once(socket,"connect");
  const start = Date.now();
  await new Promise<void>(resolve => socket.once("close",() => { sockets.delete(socket); resolve(); }));
  expect(Date.now()-start).toBeGreaterThanOrEqual(250);
  expect(Date.now()-start).toBeLessThan(1500);
  await send(registered.sock,[]);
},2500);
it("launches the emitted js fallback with no source files present", async () => {
  const config = await fixture(); const emitted = join(config.runDir,"dist","connectors");
  await mkdir(emitted,{recursive:true});
  await writeFile(join(config.runDir,"package.json"),await readFile(new URL("../../package.json",import.meta.url)));
  for (const name of ["base","proc_identity","peer-registry","peer-sidecar"]) {
    const source = await readFile(new URL(`../../src/connectors/${name}.ts`,import.meta.url),"utf8");
    const result = transpileModule(source,{compilerOptions:{module:ModuleKind.ESNext,target:ScriptTarget.ES2022}});
    await writeFile(join(emitted,`${name}.js`),result.outputText);
  }
  const {spawnPeerSidecar: emittedLauncher} = await import(pathToFileURL(join(emitted,"peer-sidecar.js")).href) as {spawnPeerSidecar:typeof spawnPeerSidecar};
  await launch(config,`writeFileSync(${JSON.stringify(join(config.runDir,"test-argv"))}, JSON.stringify({argv:process.argv,args:process.execArgv}));`,emittedLauncher);
  const registered = await peer(config); await send(registered.sock,[]);
  expect(await json(join(config.runDir,"test-argv"))).toMatchObject({argv:[process.execPath,await realpath(join(emitted,"peer-sidecar.js"))],args:[]});
});
it("creates a missing socket directory with mode 0700 and watches a stream created later", async () => {
  const config = await fixture(); await rm(config.sockDir,{recursive:true}); await rm(config.streamPath);
  await launch(config); const registered = await peer(config);
  expect((await stat(config.sockDir)).mode & 0o777).toBe(0o700);
  const recipient = await requester(config); await send(registered.sock,[subscription(recipient.sock)]);
  await writeFile(config.streamPath,'{"__t2f5_done__":0}\n');
  await waitFor(async () => recipient.frames, frames => frames.length === 2);
  expect(recipient.frames[1]).toMatchObject({state:"idle",orig_msg_id:"subscription-1"});
});
it("cleans partial registration when signalled during startup", async () => {
  const config = await fixture();
  await launch(config,`
    const {existsSync} = await import('node:fs');
    const observer = setInterval(() => {
      if (existsSync(${JSON.stringify(config.sockDir)} + '/' + process.pid + '.sock')) {
        clearInterval(observer);
        writeFileSync(${JSON.stringify(join(config.runDir,"test-startup"))}, String(!existsSync(${JSON.stringify(join(config.runDir,"peer.json"))})));
        process.kill(process.pid,'SIGTERM');
      }
    },1); observer.unref();
  `);
  const pid = await waitFor(async () => Number(await readFile(join(config.runDir,"test-pid"),"utf8")), value => value > 0);
  await waitFor(async () => { try { process.kill(pid,0); return false; } catch { return true; } },Boolean);
  expect(existsSync(join(config.sockDir,`${pid}.sock`))).toBe(false);
  expect(existsSync(join(config.sessionsDir,`${pid}.json`))).toBe(false);
  expect((await readdir(config.sessionsDir)).filter(name => name.startsWith(`${pid}.`))).toEqual([]);
  expect(await readFile(join(config.runDir,"test-exit"),"utf8")).toBe("0");
  expect(await readFile(join(config.runDir,"test-startup"),"utf8")).toBe("true");
});

async function backgroundFixture(setup = "", env: NodeJS.ProcessEnv = {}, prepare?: (config: PeerSidecarConfig) => Promise<void>): Promise<{
  config: PeerSidecarConfig; started: Awaited<ReturnType<typeof startBackgroundRun>>; registryRoot: string; release: string;
}> {
  const base = await fixture();
  await prepare?.(base);
  const registryRoot = join(base.runDir,"runs");
  const release = join(base.runDir,"release");
  let started!: Awaited<ReturnType<typeof startBackgroundRun>>;
  await launch(base,setup,async () => {
    started = await startBackgroundRun({agent:"codex",prompt:"x",model:"gpt-6-astra",cwd:base.runDir,
      registryRoot,sessionsDir:base.sessionsDir,sockDir:base.sockDir,lingerMs:500,
      command:["sh","-c",'until [ -e "$RELEASE" ]; do sleep 0.05; done'],
      env:{...process.env,RELEASE:release,STRATUM_PEER_REGISTER:"1",...env}});
    backgroundPids.add(started.pid!);
  });
  const config = {...base,runDir:join(registryRoot,started.runId),streamPath:started.streamPath};
  configs.push(config);
  return {config,started,registryRoot,release};
}
it("background golden flow registers busy, authenticates one notice, retains idle, and cleans up", async () => {
  const {config,started,registryRoot,release} = await backgroundFixture();
  expect(started).toMatchObject({peerName:peerName("gpt-6-astra",started.runId)});
  expect(started).not.toHaveProperty("peer");
  await assertToolResponse("stratum_agent_run",started);
  const metaPath = join(config.runDir,"meta.json");
  const meta = await readFile(metaPath,"utf8");
  const registered = await peer(config);
  const recordPath = join(config.sessionsDir,`${registered.pid}.json`);
  const keyPath = join(config.sessionsDir,keyFileName(registered.pid,registered.sock));
  const record = await json(recordPath);
  const recordStat = await stat(recordPath);
  expect(recordStat.isFile()).toBe(true);
  expect(recordStat.size).toBeLessThanOrEqual(262144);
  expect(recordPath.endsWith(`/${registered.pid}.json`)).toBe(true);
  expect(record).toMatchObject({pid:registered.pid,kind:"bg",status:"busy",entrypoint:"stratum-peer",
    name:started.peerName,procStart:await claudeProcStart(registered.pid),messagingSocketPath:registered.sock});
  expect(record.spare).not.toBe(true); expect(record.parkedJobId).toBeUndefined();
  process.kill(registered.pid,0);
  await send(registered.sock,[]);
  expect((await stat(keyPath)).mode & 0o777).toBe(0o600);
  expect(await json(keyPath)).toMatchObject({procStart:record.procStart,pidDomain:record.pidDomain,peerToken:expect.stringMatching(/^[0-9a-f]{32}$/)});
  const running = await pollBackgroundRun(started.runId,{registryRoot});
  expect(running).toMatchObject({status:"running",peer:{name:started.peerName,registered:true,pid:registered.pid,sock:registered.sock}});
  await assertToolResponse("stratum_agent_poll",running);
  const recipient = await requester(config);
  await send(registered.sock,[{...subscription(recipient.sock),from_mode:"bypass"}]);
  await writeFile(release,"");
  await waitFor(async () => recipient.frames,frames => frames.length === 2);
  expect(recipient.frames[0]).toEqual({type:"auth",token:"a".repeat(32)});
  expect(recipient.frames[1]).toMatchObject({action:"peer_idle_notice",orig_msg_id:"subscription-1",state:"idle",from_mode:"bypass"});
  expect((await json(recordPath)).status).toBe("idle");
  const complete = await pollBackgroundRun(started.runId,{registryRoot});
  expect(complete).toMatchObject({status:"complete",peer:{registered:true}});
  await assertToolResponse("stratum_agent_poll",complete);
  await waitForCleanup(config,registered);
  expect(recipient.frames).toHaveLength(2);
  expect(await readFile(metaPath,"utf8")).toBe(meta);
});

it.each([
  "cancel", "late subscription", "after linger", "user refusal", "malformed frame", "disallowed callback",
  "kill switch", "missing sessions", "foreign record", "occupied socket", "read-only run directory",
  "malformed peer metadata", "protocol gate", "peer metadata write failure",
])("background error harness: %s", async scenario => {
  const setup = scenario === "foreign record"
    ? `writeFileSync(process.env.STRATUM_PEER_SESSIONS_DIR + '/' + process.pid + '.json', JSON.stringify({entrypoint:'foreign'}));`
    : scenario === "occupied socket"
      ? `writeFileSync(process.env.STRATUM_PEER_SOCK_DIR + '/' + process.pid + '.sock', 'foreign file');`
      : scenario === "peer metadata write failure"
        ? `const {chmodSync} = await import("node:fs"); chmodSync(process.env.STRATUM_PEER_RUN_DIR,0o500);` : "";
  const {config,started,registryRoot,release} = await backgroundFixture(setup,
    scenario === "kill switch" ? {STRATUM_PEER_REGISTER:"0"} : {}, async base => {
      if (scenario === "missing sessions") await rm(base.sessionsDir,{recursive:true});
      if (scenario === "protocol gate") await writeFile(join(base.sessionsDir,`${process.pid}.json`),JSON.stringify({peerProtocol:2}));
    });
  const metaPath = join(config.runDir,"meta.json"); const meta = await readFile(metaPath,"utf8");
  const poll = () => pollBackgroundRun(started.runId,{registryRoot});
  if (["kill switch","missing sessions","protocol gate"].includes(scenario)) {
    expect(started).not.toHaveProperty("peerName"); expect(started).not.toHaveProperty("peer");
    expect(existsSync(join(config.runDir,"peer.json"))).toBe(false);
    expect(await readdir(config.sockDir)).toEqual([]);
    expect((await readdir(config.sessionsDir).catch(() => [])).filter(name => name !== `${process.pid}.json`)).toEqual([]);
    await writeFile(release,"");
    expect(await waitFor(poll,result => result.status === "complete")).toMatchObject({peer:{registered:false}});
  } else if (scenario === "foreign record" || scenario === "occupied socket" || scenario === "peer metadata write failure") {
    const fixtureRoot = join(registryRoot,"..");
    expect(await waitFor(() => readFile(join(fixtureRoot,"test-exit"),"utf8"),value => value === "2")).toBe("2");
    expect((await readFile(`${config.streamPath}.peer.err`,"utf8")).length).toBeGreaterThan(0);
    const pid = Number(await readFile(join(fixtureRoot,"test-pid"),"utf8"));
    const recordPath = join(config.sessionsDir,`${pid}.json`);
    if (scenario === "foreign record") expect(await json(recordPath)).toEqual({entrypoint:"foreign"});
    else {
      expect(existsSync(recordPath)).toBe(false);
      if (scenario === "occupied socket") expect(await readFile(join(config.sockDir,`${pid}.sock`),"utf8")).toBe("foreign file");
      else expect(existsSync(join(config.sockDir,`${pid}.sock`))).toBe(false);
    }
    expect(existsSync(join(config.sessionsDir,keyFileName(pid,join(config.sockDir,`${pid}.sock`))))).toBe(false);
    await writeFile(release,"");
    expect(await waitFor(poll,result => result.status === "complete")).toMatchObject({peer:{registered:false}});
  } else {
    const registered = await peer(config);
    const recordPath = join(config.sessionsDir,`${registered.pid}.json`);
    const recipient = await requester(config);
    if (scenario === "cancel") {
      await send(registered.sock,[{...subscription(recipient.sock),from_mode:"bypass"}]);
      expect(await cancelBackgroundRun(started.runId,{registryRoot})).toMatchObject({status:"cancelled"});
      await waitFor(async () => recipient.frames,frames => frames.length === 2);
      expect(recipient.frames[1]).toMatchObject({state:"exited",detail:"cancelled_or_died",from_mode:"bypass"});
      expect(await readFile(config.streamPath,"utf8")).not.toContain("__t2f5_done__");
      const error = await poll();
      expect(error).toMatchObject({status:"error",reason:"child_died_without_sentinel",peer:{registered:true}});
      await assertToolResponse("stratum_agent_poll",error);
    } else if (scenario === "late subscription" || scenario === "after linger") {
      await writeFile(release,"");
      await waitFor(() => json(recordPath),record => record.status === "idle");
      if (scenario === "late subscription") {
        await send(registered.sock,[subscription(recipient.sock)]);
        await waitFor(async () => recipient.frames,frames => frames.length === 2);
        expect(recipient.frames[1]).toMatchObject({state:"idle",orig_msg_id:"subscription-1"});
      } else {
        await waitForCleanup(config,registered);
        await expect(send(registered.sock,[subscription(recipient.sock)])).rejects.toMatchObject({code:expect.stringMatching(/ENOENT|ECONNREFUSED/)});
      }
      expect(await poll()).toMatchObject({status:"complete",peer:{registered:true}});
    } else if (scenario === "malformed peer metadata") {
      for (const value of ["bad", "null", '{}', '{"pid":"bad","name":"x","sock":"y","registeredAt":"z"}']) {
        await writeFile(join(config.runDir,"peer.json"),value);
        expect(await poll()).toMatchObject({status:"running",peer:{registered:false}});
      }
      await writeFile(release,"");
    } else if (scenario === "read-only run directory") {
      await chmod(config.runDir,0o500);
      await writeFile(release,"");
    } else {
      if (scenario === "user refusal") {
        await send(registered.sock,[{type:"user",msg_id:"refusal",from:`uds:${recipient.sock}`,from_mode:"bypass"}]);
        await waitFor(async () => recipient.frames,frames => frames.length === 2);
        expect(recipient.frames).toEqual([{type:"auth",token:"a".repeat(32)},
          {type:"control",action:"peer_message_status",orig_msg_id:"refusal",status:"expired",status_detail:"refused",from:`uds:${registered.sock}`,from_mode:"bypass"}]);
      } else if (scenario === "malformed frame") {
        await send(registered.sock,["{malformed"]);
      } else {
        const otherDir = await mkdtemp("/tmp/sp-"); roots.push(otherDir);
        const forbidden = await requester({...config,sockDir:otherDir},987653);
        await send(registered.sock,[subscription(forbidden.sock)]);
        await waitFor(() => readFile(`${config.streamPath}.peer.err`,"utf8"),text => text.includes("invalid callback"));
        await writeFile(release,"");
        await waitForCleanup(config,registered);
        expect(forbidden.frames).toEqual([]);
      }
      if (scenario !== "disallowed callback") {
        // A valid request after the bad frame proves the socket server is still serving.
        const prior = recipient.frames.length;
        await send(registered.sock,[subscription(recipient.sock)]);
        await writeFile(release,"");
        await waitFor(async () => recipient.frames,frames => frames.length === prior + 2);
        expect(recipient.frames[prior + 1]).toMatchObject({state:"idle",orig_msg_id:"subscription-1"});
      }
    }
    await waitForCleanup(config,registered);
    if (scenario !== "cancel") expect(await waitFor(poll,result => result.status === "complete")).toMatchObject({status:"complete"});
  }
  expect(await readFile(metaPath,"utf8")).toBe(meta);
},30000);

it.skipIf(!!spawnSync("mkfifo", []).error)("returns a background run within 3 s with a numeric FIFO in the registry", async () => {
  const config = await fixture();
  expect(spawnSync("mkfifo", [join(config.sessionsDir,"123.json")]).status).toBe(0);
  const registryRoot = join(config.runDir,"runs");
  const before = performance.now();
  const started = await startBackgroundRun({agent:"codex",prompt:"x",cwd:config.cwd,registryRoot,
    sessionsDir:config.sessionsDir,sockDir:config.sockDir,lingerMs:500,
    env:{STRATUM_PEER_REGISTER:"1"},command:["sh","-c","sleep 10"]});
  backgroundPids.add(started.pid!);
  expect(performance.now() - before).toBeLessThan(3000);
  expect(started.status).toBe("bg_started");
  expect(started.peerName).toBeDefined();
  await waitFor(() => readdir(config.sessionsDir), names => names.some(name => name !== "123.json" && /^\d+\.json$/.test(name)));
});

it.each(["oversized", "symlink"])("refuses an unsafe own-pid %s record without changing it", async kind => {
  const config = await fixture();
  const target = join(config.runDir,"foreign-target");
  const record = JSON.stringify({entrypoint:"stratum-peer", padding:"x".repeat(kind === "oversized" ? 262144 : 0)});
  await writeFile(target,record);
  await launch(config, `import {copyFileSync, symlinkSync} from 'node:fs';
    ${kind === "symlink" ? "symlinkSync" : "copyFileSync"}(${JSON.stringify(target)}, ${JSON.stringify(config.sessionsDir)} + '/' + process.pid + '.json');`);
  await waitFor(() => readFile(`${config.streamPath}.peer.err`,"utf8"), text => text.includes("unsafe file"));
  const pid = Number(await readFile(join(config.runDir,"test-pid"),"utf8"));
  const path = join(config.sessionsDir,`${pid}.json`);
  expect((await lstat(path)).isSymbolicLink()).toBe(kind === "symlink");
  expect(await readFile(path,"utf8")).toBe(record);
  expect(await readFile(target,"utf8")).toBe(record);
  expect(existsSync(join(config.runDir,"peer.json"))).toBe(false);
});

it("reports exited and cleans up a dead background child without a recorded start time", async () => {
  const {config,started} = await backgroundFixture('delete process.env.STRATUM_PEER_CHILD_START;');
  const registered = await peer(config); const recipient = await requester(config);
  await send(registered.sock,[subscription(recipient.sock)]);
  process.kill(-started.pid!,"SIGKILL");
  await waitFor(async () => recipient.frames, frames => frames.some(frame => frame.state === "exited"));
  expect(recipient.frames[1]).toMatchObject({state:"exited",detail:"cancelled_or_died"});
  await waitForCleanup(config,registered);
},10000);
it("reports unavailable on a non-terminal registry rewrite failure", async () => {
  const config = await fixture(); await launch(config); const registered = await peer(config);
  const recipient = await requester(config); await send(registered.sock,[subscription(recipient.sock)]);
  await chmod(config.sessionsDir,0o500);
  await appendFile(config.streamPath,'{"event":"progress"}\n');
  await waitFor(async () => recipient.frames, frames => frames.some(frame => frame.action === "peer_idle_notice"));
  const notice = recipient.frames.find(frame => frame.action === "peer_idle_notice");
  expect(notice).toMatchObject({state:"unavailable",detail:expect.any(String)});
  expect(notice!.detail).not.toBe("");
  process.kill(config.childPid,0);
});
it("forwards the first-line deadline through startBackgroundRun", async () => {
  const {config} = await backgroundFixture("",{STRATUM_PEER_FIRST_LINE_MS:"300"});
  const registered = await peer(config);
  const socket = createConnection(registered.sock); sockets.add(socket); socket.on("error",() => undefined);
  await once(socket,"connect");
  const start = Date.now();
  await waitFor(async () => socket.destroyed, Boolean,1500);
  expect(Date.now()-start).toBeGreaterThanOrEqual(200);
  expect(Date.now()-start).toBeLessThan(1500);
});
it.each(["fifo","symlink","oversized"])("poll rejects unsafe peer metadata: %s", async kind => {
  const {config,started,registryRoot} = await backgroundFixture();
  const registered = await peer(config); const path = join(config.runDir,"peer.json");
  const original = await readFile(path,"utf8"); await rm(path);
  if (kind === "fifo") expect(spawnSync("mkfifo",[path]).status).toBe(0);
  else if (kind === "symlink") {
    const target = join(config.runDir,"target.json"); await writeFile(target,original); await symlink(target,path);
  } else await writeFile(path,JSON.stringify({...JSON.parse(original),padding:"x".repeat(65536)}));
  // A subprocess timeout makes a blocking FIFO regression fail without hanging Vitest.
  const script = join(config.runDir,"poll.mjs");
  await writeFile(script,`import {pollBackgroundRun} from ${JSON.stringify(new URL("../../src/connectors/background.ts",import.meta.url).href)};
    console.log(JSON.stringify(await pollBackgroundRun(${JSON.stringify(started.runId)},{registryRoot:${JSON.stringify(registryRoot)}})));`);
  // background.ts has .js imports; use the repository source loader for source execution.
  const result = spawnSync(process.execPath,["--import",new URL("../helpers/source-loader.mjs",import.meta.url).href,script],{cwd:process.cwd(),timeout:2500,encoding:"utf8",env:{...process.env,NODE_OPTIONS:""}});
  expect(result.error).toBeUndefined(); expect(result.status,result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({status:"running",peer:{registered:false}});
  process.kill(registered.pid,"SIGTERM");
});

it("coalesces stream scans and identity probes while real socket work is pending", async () => {
  const module = await import("../../src/connectors/peer-sidecar.js");
  expect(module).toHaveProperty("PeerWorkQueue");
  const config = await fixture(); const held: Socket[] = [];
  const server = createServer(socket => { held.push(socket); sockets.add(socket); socket.on("close",()=>sockets.delete(socket)); });
  servers.push(server); const path = join(config.sockDir,"987611.sock"); server.listen(path); await once(server,"listening");
  const errors: unknown[] = [];
  const queue = new module.PeerWorkQueue(error => { errors.push(error); });
  let scans = 0; let probes = 0;
  const block = () => {
    const socket = createConnection(path); sockets.add(socket); socket.on("close",()=>sockets.delete(socket));
    return once(socket,"close").then(()=>undefined);
  };
  const scanGate = block(); const probeGate = block();
  await waitFor(async () => held.length, value => value === 2);
  queue.schedule("scan",async () => { scans++; await scanGate; });
  await waitFor(async () => scans, value => value === 1);
  for (let i=0;i<10000;i++) {
    queue.schedule("scan",async () => { scans++; });
    queue.schedule("identity",async () => { probes++; await probeGate; });
  }
  held[0]!.end();
  await waitFor(async () => probes, value => value === 1);
  for (let i=0;i<10000;i++) queue.schedule("identity",async () => { probes++; });
  held[1]!.end(); await queue.drain();
  expect(scans).toBe(1); expect(probes).toBe(1); expect(errors).toEqual([]);
  queue.schedule("scan",async () => { scans++; }); await queue.drain(); expect(scans).toBe(2);
});

async function heldRequester(config: PeerSidecarConfig, pid = 987610): Promise<{sock: string; held: Socket[]; frames: Record<string,unknown>[]}> {
  const sock = join(config.sockDir,`${pid}.sock`); const held: Socket[] = []; const frames: Record<string,unknown>[] = [];
  const server = createServer({allowHalfOpen:true}, socket => {
    held.push(socket); sockets.add(socket); socket.on("close",()=>sockets.delete(socket));
    let pending = ""; socket.on("data",data => {
      pending += data.toString(); let end: number;
      while ((end = pending.indexOf("\n")) >= 0) { frames.push(JSON.parse(pending.slice(0,end))); pending = pending.slice(end+1); }
    });
  });
  servers.push(server); server.listen(sock); await once(server,"listening");
  return {sock,held,frames};
}
it("bounds refusal callbacks to eight active and 32 queued attempts", async () => {
  const config = await fixture(); const recipient = await heldRequester(config);
  await launch(config); const registered = await peer(config);
  await send(registered.sock,Array.from({length:100},(_,i)=>({type:"user",msg_id:`u-${i}`,from:`uds:${recipient.sock}`})));
  await waitFor(async () => recipient.held.length, value => value >= 8); await delay(150);
  expect(recipient.held).toHaveLength(8);
  expect(await readFile(`${config.streamPath}.peer.err`,"utf8")).toContain("callback dropped: full");
  // Release each wave before its real five-second timeout.
  for (let wave=0;wave<5;wave++) {
    for (const socket of recipient.held) socket.end();
    await delay(100);
  }
  expect(recipient.held).toHaveLength(40);
},10000);
it("preserves every idle notice when refusals saturate callbacks", async () => {
  const config = await fixture(); const held = await heldRequester(config);
  const recipients = await Promise.all(Array.from({length:32},(_,i)=>requester(config,910000+i)));
  await launch(config); const registered = await peer(config);
  await send(registered.sock,Array.from({length:100},(_,i)=>({type:"user",msg_id:`u-${i}`,from:`uds:${held.sock}`})));
  await waitFor(async () => held.held.length, value => value >= 8);
  await send(registered.sock,recipients.map((recipient,i)=>subscription(recipient.sock,`n-${i}`)));
  await appendFile(config.streamPath,'{"__t2f5_done__":0}\n');
  await waitFor(()=>json(join(config.sessionsDir,`${registered.pid}.json`)),value=>value.status === "idle");
  for (const socket of held.held) socket.end();
  await waitFor(async () => recipients.every(recipient=>recipient.frames.some(frame=>frame.action === "peer_idle_notice")),Boolean);
  for (let i=0;i<32;i++) expect(recipients[i]!.frames.filter(frame=>frame.action === "peer_idle_notice")).toEqual([
    expect.objectContaining({orig_msg_id:`n-${i}`,state:"idle"}),
  ]);
  expect(held.held.length).toBeLessThanOrEqual(8);
},10000);
it("replaces queued terminal re-subscriptions to one address", async () => {
  const config = await fixture(); config.lingerMs = 2000;
  const recipient = await heldRequester(config); await launch(config); const registered = await peer(config);
  await appendFile(config.streamPath,'{"__t2f5_done__":0}\n');
  await waitFor(()=>json(join(config.sessionsDir,`${registered.pid}.json`)),value=>value.status === "idle");
  await send(registered.sock,[subscription(recipient.sock,"first")]);
  await waitFor(async () => recipient.frames.length,value=>value === 1);
  await send(registered.sock,Array.from({length:100},(_,i)=>subscription(recipient.sock,`replacement-${i}`)));
  await delay(150); expect(recipient.held).toHaveLength(1);
  recipient.held[0]!.end();
  await waitFor(async () => recipient.frames.length,value=>value >= 2);
  expect(recipient.frames.map(frame=>frame.orig_msg_id)).toEqual(["first","replacement-99"]);
  recipient.held[1]!.end();
});

it("attempts all 32 queued idle notices within the shutdown window with held sockets", async () => {
  const config = await fixture(); const refusals = await heldRequester(config);
  const recipients = await Promise.all(Array.from({length:32},(_,i)=>heldRequester(config,920000+i)));
  await launch(config); const registered = await peer(config);
  await send(registered.sock,Array.from({length:40},(_,i)=>({type:"user",msg_id:`u-${i}`,from:`uds:${refusals.sock}`})));
  await waitFor(async () => refusals.held.length,value=>value === 8);
  await send(registered.sock,recipients.map((recipient,i)=>subscription(recipient.sock,`n-${i}`)));
  const start = Date.now(); await appendFile(config.streamPath,'{"__t2f5_done__":0}\n');
  await waitForCleanup(config,registered,6500);
  expect(Date.now()-start).toBeLessThan(6500);
  for (let i=0;i<32;i++) {
    expect(recipients[i]!.held).toHaveLength(1);
    expect(recipients[i]!.frames).toEqual([expect.objectContaining({orig_msg_id:`n-${i}`,state:"idle"})]);
  }
},10000);

it.each(["pid", "sessionId", "key", "socket"])("preserves a foreign %s replacement during linger", async (kind) => {
  const config = await fixture(); config.lingerMs = 1500;
  await launch(config); const registered = await peer(config);
  const recordPath = join(config.sessionsDir,`${registered.pid}.json`);
  const keyPath = join(config.sessionsDir,keyFileName(registered.pid,registered.sock));
  await appendFile(config.streamPath,'{"__t2f5_done__":0}\n');
  await waitFor(() => json(recordPath), value => value.status === "idle");
  const target = kind === "key" ? keyPath : kind === "socket" ? registered.sock : recordPath;
  const foreign = kind === "key" ? {peerToken:"foreign"} : {...await json(recordPath),[kind]:kind === "pid" ? process.pid : "foreign"};
  await rm(target);
  let replacement: Server | undefined;
  if (kind === "socket") {
    replacement = createServer(socket => socket.end()); servers.push(replacement);
    await new Promise<void>(resolve => replacement!.listen(target, resolve));
  } else await writeFile(target,JSON.stringify(foreign));
  await waitFor(async () => { try { process.kill(registered.pid,0); return false; } catch { return true; } }, Boolean);
  expect(await readFile(`${config.streamPath}.peer.err`,"utf8")).toContain("peer cleanup left path alone:");
  if (kind === "socket") expect((await lstat(target)).isSocket()).toBe(true);
  else expect(await json(target)).toEqual(foreign);
  for (const path of [recordPath,keyPath,registered.sock]) if (path !== target) expect(existsSync(path)).toBe(false);
});

it("captures a live child's missing start identity once at startup", async () => {
  const config = await fixture(); delete config.childProcStartTime;
  const expected = await procStartTime(config.childPid); expect(expected).toBeTruthy();
  await launch(config); await peer(config);
  const log = await readFile(`${config.streamPath}.peer.err`,"utf8");
  expect(log).toContain(`peer child identity captured: ${config.childPid} ${expected}`);
});
it("registers an already dead child without a start identity as exited immediately", async () => {
  const config = await fixture(); delete config.childProcStartTime;
  config.childPid = 2147483647; config.lingerMs = 1000;
  await launch(config); const registered = await peer(config);
  expect(await json(join(config.sessionsDir,`${registered.pid}.json`))).toMatchObject({status:"idle"});
  const recipient = await requester(config); await send(registered.sock,[subscription(recipient.sock)]);
  await waitFor(async () => recipient.frames,frames => frames.some(frame => frame.state === "exited"));
  await waitForCleanup(config,registered);
});

it.each([false,true])("bounds slow token lookup and drains queued idle notices (shutdown=%s)", async shutdown => {
  const config = await fixture(); config.lingerMs = shutdown ? 100 : 15000;
  const slow = await Promise.all(Array.from({length:8},(_,i)=>requester(config,930000+i)));
  const fast = await requester(config,940000);
  const gate = join(config.runDir,"key-gate");
  expect(spawnSync("mkfifo",[gate]).status).toBe(0);
  // Process-local fault injection delays production fs.open with real writerless FIFO I/O;
  // it does not mock the token-lookup or socket seams.
  const keys = slow.map((recipient,i)=>join(config.sessionsDir,keyFileName(930000+i,recipient.sock)));
  const previousPool = process.env.UV_THREADPOOL_SIZE; process.env.UV_THREADPOOL_SIZE = "32";
  try {
    await launch(config,`
      import fs from 'node:fs/promises';
      import {syncBuiltinESMExports} from 'node:module';
      const originalOpen = fs.open;
      const slowKeys = new Set(${JSON.stringify(keys)});
      fs.open = async (path,...args) => {
        if (slowKeys.has(String(path))) {
          console.error('test slow key lookup');
          const gate = await originalOpen(${JSON.stringify(gate)},'r'); await gate.close();
        }
        return originalOpen(path,...args);
      };
      syncBuiltinESMExports();
    `);
  } finally {
    if (previousPool === undefined) delete process.env.UV_THREADPOOL_SIZE; else process.env.UV_THREADPOOL_SIZE = previousPool;
  }
  const registered = await peer(config);
  await send(registered.sock,[...slow.map((recipient,i)=>subscription(recipient.sock,`slow-${i}`)),subscription(fast.sock,"fast")]);
  const start = Date.now(); await appendFile(config.streamPath,'{"__t2f5_done__":0}\n');
  await waitFor(()=>readFile(`${config.streamPath}.peer.err`,"utf8"),log=>log.split("test slow key lookup").length === 9);
  await waitFor(async () => fast.frames,frames=>frames.some(frame=>frame.orig_msg_id === "fast"),5500);
  expect(Date.now()-start).toBeLessThan(5500);
  expect(fast.frames.filter(frame=>frame.action === "peer_idle_notice")).toEqual([expect.objectContaining({orig_msg_id:"fast",state:"idle"})]);
  // Release the real blocked I/O even during shutdown so Node can reap its worker threads.
  const writer = spawn("sh",["-c",'printf x > "$1"',"sh",gate],{stdio:"ignore"}); children.push(writer);
  await once(writer,"exit"); await delay(150);
  expect(slow.every(recipient=>recipient.frames.length === 0)).toBe(true);
  if (!shutdown) process.kill(registered.pid,"SIGTERM");
  await waitForCleanup(config,registered);
},12000);

it("poll survives peer metadata replaced by a FIFO at file acquisition", async () => {
  const {config,started,registryRoot} = await backgroundFixture(); await peer(config);
  const path = join(config.runDir,"peer.json"); const script = join(config.runDir,"race-poll.mjs");
  await writeFile(script,`
    import fs from 'node:fs/promises';
    import {unlinkSync} from 'node:fs';
    import {spawnSync} from 'node:child_process';
    import {syncBuiltinESMExports} from 'node:module';
    const path = ${JSON.stringify(path)};
    let swapped = false;
    function swap(target) {
      if (String(target) !== path || swapped) return;
      swapped = true; unlinkSync(path);
      if (spawnSync('mkfifo',[path]).status !== 0) throw new Error('mkfifo failed');
    }
    const originalLstat = fs.lstat, originalOpen = fs.open;
    fs.lstat = async (target,...args) => { const info = await originalLstat(target,...args); swap(target); return info; };
    fs.open = async (target,...args) => { swap(target); return originalOpen(target,...args); };
    syncBuiltinESMExports();
    const {pollBackgroundRun} = await import(${JSON.stringify(new URL("../../src/connectors/background.ts",import.meta.url).href)});
    const result = await pollBackgroundRun(${JSON.stringify(started.runId)},{registryRoot:${JSON.stringify(registryRoot)}});
    console.log(JSON.stringify({swapped,result}));
  `);
  const result = spawnSync(process.execPath,["--import",new URL("../helpers/source-loader.mjs",import.meta.url).href,script],{timeout:2500,encoding:"utf8",env:{...process.env,NODE_OPTIONS:""}});
  expect(result.error).toBeUndefined(); expect(result.status,result.stderr).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({swapped:true,result:{status:"running",peer:{registered:false}}});
});
