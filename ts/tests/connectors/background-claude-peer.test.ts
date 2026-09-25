import {afterEach, expect, it, vi} from "vitest";
import {existsSync} from "node:fs";
import {mkdir, mkdtemp, readFile, readdir, rm, writeFile} from "node:fs/promises";
import {join} from "node:path";
import {createConnection, createServer, type Server} from "node:net";
import {once} from "node:events";
import {spawn, type ChildProcess} from "node:child_process";
import {startBackgroundRun, pollBackgroundRun, cancelBackgroundRun, claudeWorkerRegistry} from "../../src/connectors/background.js";
import {keyFileName} from "../../src/connectors/peer-registry.js";
const roots: string[] = [], servers: Server[] = [], hosts: ChildProcess[] = [];
const saved = process.env.STRATUM_TEST_WORKER;
afterEach(async () => {
  if (saved === undefined) delete process.env.STRATUM_TEST_WORKER; else process.env.STRATUM_TEST_WORKER = saved;
  for (const host of hosts.splice(0)) if (host.exitCode === null && host.signalCode === null) {host.kill("SIGKILL"); await once(host,"exit");}
  await Promise.all([...claudeWorkerRegistry.values()].map(entry => entry.worker.terminate()));
  await vi.waitFor(() => expect(claudeWorkerRegistry.size).toBe(0));
  for (const dir of roots) {
    for (const name of await readdir(join(dir,"sessions")).catch(() => [])) {
      if (!/^\d+\.json$/.test(name)) continue;
      const record = JSON.parse(await readFile(join(dir,"sessions",name),"utf8"));
      if (record.entrypoint !== "stratum-peer") continue;
      try {process.kill(Number(name.slice(0,-5)),"SIGTERM");} catch { /* exited */ }
    }
  }
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  // Wait for sidecars to unlink before deleting their run metadata.
  for (const dir of roots) await vi.waitFor(async () => expect((await readdir(join(dir,"sessions")).catch(() => [])).filter(n => /^\d+\.json$/.test(n))).toEqual([]), {timeout:7000});
  await Promise.all(roots.splice(0).map(dir => rm(dir,{recursive:true,force:true})));
});
async function fixture() {
  const dir = await mkdtemp("/tmp/sp-"); roots.push(dir);
  const sessionsDir = join(dir,"sessions"), sockDir = join(dir,"s");
  await mkdir(sessionsDir); await mkdir(sockDir);
  process.env.STRATUM_TEST_WORKER = "controlled";
  return {dir, options:{agent:"claude" as const,prompt:"fixture",cwd:dir,registryRoot:dir,sessionsDir,sockDir,lingerMs:700,env:{STRATUM_PEER_REGISTER:"1"}}};
}
async function discovery(streamPath: string) {
  const path = join(streamPath,"..","peer.json");
  await vi.waitFor(() => expect(existsSync(path)).toBe(true),{timeout:6000});
  return JSON.parse(await readFile(path,"utf8")) as {pid:number;sock:string;name:string};
}
async function requester(sessionsDir: string, sockDir: string) {
  const sock = join(sockDir,"987654.sock"), frames: Record<string,unknown>[] = [];
  const server = createServer(socket => {
    let pending = "";
    socket.on("data", data => {pending += data; let end;
      while ((end = pending.indexOf("\n")) >= 0) {frames.push(JSON.parse(pending.slice(0,end))); pending = pending.slice(end+1);}
    });
  }); servers.push(server); server.listen(sock); await once(server,"listening");
  await writeFile(join(sessionsDir,keyFileName(987654,sock)),JSON.stringify({peerToken:"b".repeat(32)}));
  return {sock,frames};
}
async function subscribe(to: string, from: string, id: string) {
  const socket = createConnection(to); await once(socket,"connect");
  socket.end(JSON.stringify({type:"control",action:"notify_when_idle",from:`uds:${from}`,from_mode:"plan",msg_id:id})+"\n");
  await once(socket,"close");
}
it.each([false,true])("two real workers have independent peers and completion (cancel A=%s)", async cancelA => {
  const {dir,options} = await fixture();
  const a = await startBackgroundRun({...options,peerLabel:"Schema Review",workerTestReleasePath:join(dir,"a")});
  const b = await startBackgroundRun({...options,peerLabel:"Schema Review",workerTestReleasePath:join(dir,"b")});
  expect(a).not.toHaveProperty("pid"); expect(a.peerName).not.toBe(b.peerName);
  const pa = await discovery(a.streamPath), pb = await discovery(b.streamPath);
  expect(pa.pid).not.toBe(pb.pid); expect(pa.pid).not.toBe(process.pid);
  expect(pa.name).toBe(a.peerName);
  expect(JSON.parse(await readFile(join(dir,a.runId,"meta.json"),"utf8")).peerLabel).toBe("schema-review");
  const req = await requester(options.sessionsDir,options.sockDir);
  await subscribe(pa.sock,req.sock,"a"); await subscribe(pb.sock,req.sock,"b");
  if (cancelA) expect((await cancelBackgroundRun(a.runId,{registryRoot:dir})).status).toBe("cancelled");
  else await writeFile(join(dir,"a"),"");
  await vi.waitFor(() => expect(req.frames.filter(f => f.action === "peer_idle_notice")).toMatchObject([{orig_msg_id:"a",state:"idle",from_mode:"plan",...(cancelA ? {detail:"rc=130"} : {})}]),{timeout:6000});
  expect((await pollBackgroundRun(b.runId,{registryRoot:dir})).status).toBe("running");
  expect(JSON.parse(await readFile(join(options.sessionsDir,`${pb.pid}.json`),"utf8")).status).toBe("busy");
  await writeFile(join(dir,"b"),"");
  await vi.waitFor(() => expect(req.frames.filter(f => f.action === "peer_idle_notice")).toHaveLength(2),{timeout:6000});
  expect(req.frames.filter(f => f.type === "auth")).toEqual([{type:"auth",token:"b".repeat(32)},{type:"auth",token:"b".repeat(32)}]);
  await vi.waitFor(() => expect(existsSync(pa.sock) || existsSync(pb.sock)).toBe(false),{timeout:6000});
  expect(await pollBackgroundRun(b.runId,{registryRoot:dir})).toMatchObject({status:"complete",text:"stub response",peer:{registered:true,name:b.peerName}});
},15000);
it("owner process death gives unavailable while durable poll reports missing sentinel", async () => {
  const {dir,options} = await fixture();
  const module = new URL("../../src/connectors/background.ts",import.meta.url).href;
  const hooks = new URL("../../src/connectors/claude-bg-worker-hooks.mjs",import.meta.url).pathname;
  const host = spawn(process.execPath,["--import",hooks,"--input-type=module","-e",`const {startBackgroundRun}=await import(${JSON.stringify(module)}); const run=await startBackgroundRun(${JSON.stringify({...options,workerTestReleasePath:join(dir,"release")})}); process.send(run);`],{stdio:["ignore","ignore","pipe","ipc"],env:process.env});
  hosts.push(host);
  const [run] = await once(host,"message") as [{runId:string;streamPath:string}];
  const peer = await discovery(run.streamPath), req = await requester(options.sessionsDir,options.sockDir);
  await subscribe(peer.sock,req.sock,"lost"); host.kill("SIGKILL"); await once(host,"exit");
  await vi.waitFor(() => expect(req.frames.find(f => f.action === "peer_idle_notice")).toMatchObject({state:"unavailable",detail:"worker_owner_channel_lost"}),{timeout:6000});
  expect(await pollBackgroundRun(run.runId,{registryRoot:dir})).toMatchObject({status:"error",reason:"child_died_without_sentinel"});
},15000);
it.each(["disabled","missing","protocol"])("registration %s does not affect worker result or label fallback", async mode => {
  const {dir,options} = await fixture();
  if (mode === "disabled") options.env.STRATUM_PEER_REGISTER = "0";
  if (mode === "missing") options.sessionsDir = join(dir,"absent");
  if (mode === "protocol") await writeFile(join(options.sessionsDir,`${process.pid}.json`),JSON.stringify({peerProtocol:2}));
  const run = await startBackgroundRun({...options,peerLabel:"Review",workerTestReleasePath:join(dir,"release")});
  expect(run).not.toHaveProperty("peerName"); await writeFile(join(dir,"release"),"");
  await vi.waitFor(async () => expect(await pollBackgroundRun(run.runId,{registryRoot:dir})).toMatchObject({status:"complete",peer:{registered:false,name:expect.stringContaining("-review")}}),{timeout:6000});
  if (mode === "protocol") await rm(join(options.sessionsDir,`${process.pid}.json`));
});
it("invalid labels fail before creating a run directory", async () => {
  const {dir,options} = await fixture(); const before = await readdir(dir);
  await expect(startBackgroundRun({...options,peerLabel:"!!!"})).rejects.toThrow(/peerLabel/);
  expect(await readdir(dir)).toEqual(before);
});

it.each([false,true])("emitted JS worker runs with no sibling sources or loader hooks (peer=%s)", async enabled => {
  const {transpileModule,ModuleKind,ScriptTarget} = await import("typescript");
  const {symlink} = await import("node:fs/promises");
  const {pathToFileURL} = await import("node:url");
  const {dir,options} = await fixture();
  options.env.STRATUM_PEER_REGISTER = enabled ? "1" : "0";
  const emitted = join(dir,"dist");
  await mkdir(join(emitted,"connectors"),{recursive:true});
  await mkdir(join(emitted,"config")); await mkdir(join(emitted,"judge"));
  await writeFile(join(dir,"package.json"),await readFile(new URL("../../package.json",import.meta.url)));
  await symlink(new URL("../../node_modules",import.meta.url).pathname,join(dir,"node_modules"));
  for (const name of ["connectors/codex-appserver-launch","connectors/background","connectors/claude-bg-worker","connectors/peer-worker-lifecycle","connectors/peer-sidecar","connectors/peer-registry","connectors/codex-appserver-ipc","connectors/base","connectors/proc_identity","connectors/claude","connectors/codex","connectors/codex-policy","connectors/cancellation","config/index","config/types","judge/pricing"]) {
    const source = await readFile(new URL(`../../src/${name}.ts`,import.meta.url),"utf8");
    await writeFile(join(emitted,`${name}.js`),transpileModule(source,{compilerOptions:{module:ModuleKind.ESNext,target:ScriptTarget.ES2022}}).outputText);
  }
  const module = await import(pathToFileURL(join(emitted,"connectors/background.js")).href) as typeof import("../../src/connectors/background.js");
  try {
    const run = await module.startBackgroundRun({...options,workerTestReleasePath:join(dir,"release")});
    if (enabled) expect((await discovery(run.streamPath)).name).toBe(run.peerName);
    await writeFile(join(dir,"release"),"");
    await vi.waitFor(async () => expect(await module.pollBackgroundRun(run.runId,{registryRoot:dir})).toMatchObject({status:"complete",text:"stub response"}),{timeout:6000});
  } finally {
    await Promise.all([...module.claudeWorkerRegistry.values()].map(entry => entry.worker.terminate()));
    await vi.waitFor(() => expect(module.claudeWorkerRegistry.size).toBe(0));
  }
},12000);

it("old or malformed optional peer metadata does not change durable results", async () => {
  const {dir,options} = await fixture(); options.env.STRATUM_PEER_REGISTER = "0";
  const run = await startBackgroundRun({...options,workerTestReleasePath:join(dir,"release")});
  await writeFile(join(dir,"release"),"");
  await vi.waitFor(async () => expect((await pollBackgroundRun(run.runId,{registryRoot:dir})).status).toBe("complete"));
  const metaPath = join(dir,run.runId,"meta.json"), peerPath = join(dir,run.runId,"peer.json");
  const meta = JSON.parse(await readFile(metaPath,"utf8"));
  for (const peerLabel of [undefined,42,"!!!"]) {
    await writeFile(metaPath,JSON.stringify({...meta,peerLabel}));
    for (const value of ["bad",JSON.stringify({pid:-1,name:"wrong"}),"x".repeat(65537)]) {
      await writeFile(peerPath,value);
      expect(await pollBackgroundRun(run.runId,{registryRoot:dir})).toMatchObject({status:"complete",peer:{registered:false,name:`claude-sonnet-5-${run.runId}`}});
    }
  }
  await rm(peerPath); await mkdir(peerPath);
  expect(await pollBackgroundRun(run.runId,{registryRoot:dir})).toMatchObject({status:"complete",peer:{registered:false}});
});
