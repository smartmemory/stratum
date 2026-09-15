import { afterEach, expect, it } from "vitest";
import { transpileModule, ModuleKind, ScriptTarget } from "typescript";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { appendFile, chmod, mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from "node:fs/promises";
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
    const pids = new Set<number>();
    try { pids.add(Number(await readFile(join(config.runDir,"test-pid"),"utf8"))); } catch { /* spawn may fail */ }
    try { pids.add(Number((await json(join(config.runDir,"peer.json"))).pid)); } catch { /* startup may fail */ }
    for (const name of await readdir(config.sessionsDir).catch(() => [])) {
      if (!/^\d+\.json$/.test(name)) continue;
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
  await waitFor(async () => existsSync(recordPath), value => !value);
  expect(existsSync(registered.sock)).toBe(false);
  expect(existsSync(join(config.sessionsDir,keyFileName(registered.pid,registered.sock)))).toBe(false);
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
  await waitFor(async () => existsSync(registered.sock), value => !value);
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
  await waitFor(async () => existsSync(registered.sock), value => !value);
  expect(existsSync(join(config.sessionsDir,`${registered.pid}.json`))).toBe(false);
  expect(existsSync(join(config.sessionsDir,keyFileName(registered.pid,registered.sock)))).toBe(false);
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
    await waitFor(async () => existsSync(join(config.sessionsDir,`${registered.pid}.json`)), value => !value);
    expect(existsSync(registered.sock)).toBe(false);
    expect(existsSync(join(config.sessionsDir,keyFileName(registered.pid,registered.sock)))).toBe(false);
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
  await waitFor(async () => existsSync(registered.sock), value => !value);
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
  await waitFor(async () => existsSync(join(config.sessionsDir,`${registered.pid}.json`)), value => !value,6000);
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
  expect(started).toMatchObject({peerName:peerName("gpt-6-astra",started.runId),peer:"pending"});
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
  await waitFor(async () => existsSync(recordPath),value => !value);
  expect(existsSync(keyPath)).toBe(false); expect(existsSync(registered.sock)).toBe(false);
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
    const keyPath = join(config.sessionsDir,keyFileName(registered.pid,registered.sock));
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
        await waitFor(async () => existsSync(registered.sock),exists => !exists);
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
        await waitFor(async () => existsSync(registered.sock),exists => !exists);
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
    await waitFor(async () => existsSync(recordPath),exists => !exists);
    expect(existsSync(keyPath)).toBe(false); expect(existsSync(registered.sock)).toBe(false);
    if (scenario !== "cancel") expect(await waitFor(poll,result => result.status === "complete")).toMatchObject({status:"complete"});
  }
  expect(await readFile(metaPath,"utf8")).toBe(meta);
},30000);
