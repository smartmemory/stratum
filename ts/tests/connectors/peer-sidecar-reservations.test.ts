import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join, resolve } from "node:path";
import { sidecarEnv, keyFileName, type PeerSidecarConfig } from "../../src/connectors/peer-registry.js";
import { AppServerPeerHandle, type DriverMessage, type SteerRequest } from "../../src/connectors/codex-appserver-ipc.js";

const children: ChildProcess[] = [], roots: string[] = [], servers: Server[] = [], sockets = new Set<Socket>();
const runId = "abcdef012345";
const envelope = '<cross-session-message from-name="peer">\noriginal <text>\n</cross-session-message>';
async function fixture() {
  const root = await mkdtemp("/tmp/p3-"); roots.push(root);
  const sessionsDir = join(root,"sessions"); await mkdir(sessionsDir);
  const streamPath = join(root,"stream"); await writeFile(streamPath, "");
  const config: PeerSidecarConfig & {ownerKind:"codex-appserver"} = {ownerKind:"codex-appserver",runId,
    runDir:root, streamPath, sessionsDir, sockDir:root, name:"test-peer", cwd:root, lingerMs:15000};
  const child = spawn(process.execPath,["--experimental-strip-types",resolve("src/connectors/peer-sidecar.ts")],
    {stdio:["ignore","ignore","pipe","ipc"],env:sidecarEnv(config)});
  children.push(child);
  let errors = ""; child.stderr!.on("data", data => { errors += data; });
  const handle = new AppServerPeerHandle(child, runId), requests: SteerRequest[] = [];
  handle.subscribe(message => { if (message.type === "steer") requests.push(message); });
  let peer!: {pid:number; sock:string};
  await vi.waitFor(async () => {
    if (child.exitCode !== null) throw new Error(errors);
    peer = JSON.parse(await readFile(join(root,"peer.json"),"utf8"));
  }, {timeout:4000});
  const {peerToken} = JSON.parse(await readFile(join(sessionsDir,keyFileName(peer.pid,peer.sock)),"utf8"));
  const state = (turnId: string | null) => handle.send({type:"active-turn-state",runId,threadId:"t",turnId});
  state("u");
  return {config,child,handle,requests,peer,get errors(){return errors;},auth:{type:"auth",token:peerToken},state};
}
async function send(sock:string, frames:unknown[]) {
  const socket = createConnection(sock); sockets.add(socket); socket.on("close",()=>sockets.delete(socket));
  await once(socket,"connect"); socket.end(frames.map(f=>JSON.stringify(f)).join("\n")+"\n"); await once(socket,"close");
}
async function recipient(root:string, id:number, held=false) {
  const sock = join(root,`${id}.sock`), frames: any[] = [], connections: Socket[] = [];
  const server = createServer({allowHalfOpen:held}, socket => {
    sockets.add(socket); connections.push(socket); socket.on("close",()=>sockets.delete(socket));
    let buffer = "";
    socket.on("data", data => { buffer += data; let end:number;
      while ((end=buffer.indexOf("\n"))>=0) { frames.push(JSON.parse(buffer.slice(0,end))); buffer=buffer.slice(end+1); }
    });
  });
  servers.push(server); server.listen(sock); await once(server,"listening");
  return {sock,frames,connections};
}
const user = (sock:string, id="m") => ({type:"user",msg_id:id,from:`uds:${sock}`,from_mode:"bypass",message:{role:"user",content:envelope}});
const status = (frames:any[]) => frames.filter(f=>f.action === "peer_message_status");
afterEach(async () => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) { const exit=once(child,"exit"); child.kill("SIGKILL"); await exit; }
  }
  for (const socket of sockets) socket.destroy(); sockets.clear();
  await Promise.all(servers.splice(0).map(server=>new Promise<void>(r=>server.close(()=>r()))));
  await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));
});
// Restricted local runs must opt in; acceptance/CI must exercise real sockets.
const allowSocketEperm = process.env.STRATUM_TEST_ALLOW_SOCKET_EPERM === "1";
if (allowSocketEperm && process.env.CI) {
  throw new Error("STRATUM_TEST_ALLOW_SOCKET_EPERM=1 is forbidden when CI is set");
}
const socketAvailable = await (async () => {
  const dir=await mkdtemp("/tmp/p3-probe-"), server=createServer();
  try {
    server.listen(join(dir,"s")); await once(server,"listening");
    await new Promise<void>(r=>server.close(()=>r())); return true;
  } catch (error) { if (allowSocketEperm && (error as NodeJS.ErrnoException).code === "EPERM") return false; throw error; }
  finally { await rm(dir,{recursive:true,force:true}); }
})();

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { runAppServerDriver } from "../../src/connectors/codex-appserver-driver.js";
function attachDriver(handle: AppServerPeerHandle, hold: boolean) {
  const child=new EventEmitter() as ChildProcessWithoutNullStreams;
  Object.assign(child,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kill:()=>{child.emit("exit",0);return true;}});
  child.stdin.on("finish",()=>child.emit("exit",0));
  const send=(frame:unknown)=>child.stdout.push(JSON.stringify(frame)+"\n");
  const results: DriverMessage[] = [];
  let input="",steers=0,started=false,ended=false;
  child.stdin.on("data",data=>{input+=data;let end:number;
    while((end=input.indexOf("\n"))>=0) {
      const f=JSON.parse(input.slice(0,end));input=input.slice(end+1);
      if(f.method==="initialize") send({id:f.id,result:{userAgent:`stratum/0.155.1 (fake) (${f.params.clientInfo.name}; ${f.params.clientInfo.version})`}});
      if(f.method==="thread/start") send({id:f.id,result:{thread:{id:"t"}}});
      if(f.method==="turn/start") {started=true;send({id:f.id,result:{turn:{id:"u"}}});send({method:"turn/started",params:{threadId:"t",turn:{id:"u"}}});}
      if(f.method==="turn/steer") {
        expect(f.params.expectedTurnId).toBe("u"); steers++;
        if(!hold) send({id:f.id,...(steers===4 ? {error:{message:"stale expectedTurnId"}} : {result:{turnId:steers===5 ? "different-turn" : "u"}})});
      }
    }
  });
  const done=runAppServerDriver({runId,model:"gpt-6-luna/low",cwd:process.cwd(),prompt:"task",
    policy:{filesystemMode:"read-only",writableRoots:[],networkAccess:false,approvalPolicy:"never"}},
    {spawn:()=>child,peer:{subscribe:fn=>handle.subscribe(fn),send(message){
      if(message.type === "steer-result") results.push(message);
      return handle.send(message);
    },close(){}},signals:new EventEmitter(),log:()=>{},writer:{async write(){},async flush(){}}});
  void done.then(()=>{ended=true;});
  return {done,results,get started(){return started;},get ended(){return ended;},get steers(){return steers;},
    complete:()=>send({method:"turn/completed",params:{threadId:"t",turn:{id:"u",status:"completed"}}})};
}

describe.skipIf(!socketAvailable)("reserved result saturation", () => {
  it.each(["results","pending"])("AC11 queued %s survive best-effort saturation with one attempt per admission and 32 notices", async mode => {
    const f=await fixture(), blockers=await recipient(f.config.sockDir,9000,true);
    const admitted=await recipient(f.config.sockDir,9001), busy=await recipient(f.config.sockDir,9002);
    // Unauthenticated traffic occupies all workers without reserving admission slots.
    await send(f.peer.sock,Array.from({length:8},(_,i)=>user(blockers.sock,`block${i}`)));
    await vi.waitFor(()=>expect(status(blockers.frames)).toHaveLength(8));
    expect(blockers.connections).toHaveLength(8);
    expect(status(blockers.frames).every(frame=>frame.status === "denied")).toBe(true);
    const driver=attachDriver(f.handle,mode === "pending");
    try {
      await vi.waitFor(()=>expect(driver.started).toBe(true));
      await send(f.peer.sock,[f.auth,...Array.from({length:8},(_,i)=>user(admitted.sock,`m${i}`))]);
      await vi.waitFor(()=>expect(f.requests).toHaveLength(8));
      await vi.waitFor(()=>expect(driver.steers).toBe(8));
      if (mode === "results") {
        await vi.waitFor(()=>expect(driver.results).toHaveLength(8));
        expect(driver.results).toContainEqual({type:"steer-result",reqId:f.requests[3]!.reqId,outcome:"expired",detail:"refused"});
        expect(driver.results).toContainEqual({type:"steer-result",reqId:f.requests[4]!.reqId,outcome:"dropped",detail:"unknown"});
      }
      // Overflow proves the best-effort queue has filled while callbacks are held.
      await send(f.peer.sock,[f.auth,...Array.from({length:40},(_,i)=>user(busy.sock,`busy${i}`))]);
      await vi.waitFor(()=>expect(f.errors).toContain("peer callback dropped: full"));
      const notices=[];
      for (let i=0;i<32;i++) {
        const r=await recipient(f.config.sockDir,9100+i); notices.push(r);
        await send(f.peer.sock,[{type:"control",action:"notify_when_idle",msg_id:`s${i}`,from:`uds:${r.sock}`,from_mode:"bypass"}]);
      }
      expect(blockers.connections.every(socket=>!socket.destroyed)).toBe(true);
      expect(admitted.connections).toHaveLength(0);
      expect(busy.connections).toHaveLength(0);
      const began=Date.now(), exit=once(f.child,"exit"); f.child.kill("SIGTERM"); await exit;
      expect(Date.now()-began).toBeLessThan(5500);
      expect(admitted.connections).toHaveLength(8);
      for (let i=0;i<8;i++) {
        const frames=status(admitted.frames).filter(frame=>frame.orig_msg_id === `m${i}`);
        expect(frames).toHaveLength(1);
        expect(frames[0]).toMatchObject(mode === "pending" || i===4
          ? {status:"dropped",status_detail:"unknown"} : i===3
          ? {status:"expired",status_detail:"refused"} : {status:"delivered"});
      }
      for (const [i,r] of notices.entries()) {
        expect(r.connections).toHaveLength(1);
        expect(r.frames.filter(x=>x.action === "peer_idle_notice")).toEqual([
          expect.objectContaining({orig_msg_id:`s${i}`}),
        ]);
      }
      expect(f.requests).toHaveLength(8); expect(driver.ended).toBe(false);
    } finally { driver.complete(); expect(await driver.done).toBe("completed"); }
  },15000);
  it.each([
    {name:"delivered",outcome:"delivered",detail:null},
    {name:"refused",outcome:"expired",detail:"refused"},
    {name:"unknown",outcome:"dropped",detail:"unknown"},
  ] as const)("AC11 $name callbacks release all eight slots and ignore late duplicate results", async ({outcome,detail}) => {
    const f=await fixture(), held=await recipient(f.config.sockDir,9001,true), next=await recipient(f.config.sockDir,9002);
    await send(f.peer.sock,[f.auth,...Array.from({length:8},(_,i)=>user(held.sock,`m${i}`))]);
    await vi.waitFor(()=>expect(f.requests).toHaveLength(8));
    const first=f.requests.slice();
    for (const request of first) f.handle.send({type:"steer-result",reqId:request.reqId,outcome,detail});
    await vi.waitFor(()=>expect(status(held.frames)).toHaveLength(8));
    expect(held.connections).toHaveLength(8);
    for (let i=0;i<8;i++) expect(status(held.frames).filter(frame=>frame.orig_msg_id === `m${i}`)).toEqual([
      expect.objectContaining({status:outcome,...(detail ? {status_detail:detail} : {})}),
    ]);
    // Completion of each physical callback, not steer settlement, releases its slot.
    await Promise.all(held.connections.map(async socket=>{const closed=once(socket,"close");socket.end();await closed;}));
    await vi.waitFor(async()=>{
      await send(f.peer.sock,[f.auth,...Array.from({length:8},(_,i)=>user(next.sock,`next${i}`))]);
      expect(f.requests).toHaveLength(16);
    });
    expect(new Set(f.requests.slice(8).map(request=>request.msgId)).size).toBe(8);
    for (const request of first) f.handle.send({type:"steer-result",reqId:request.reqId,outcome,detail});
    await send(f.peer.sock,[f.auth,user(next.sock,"ninth")]);
    await vi.waitFor(()=>expect(status(next.frames).filter(frame=>frame.orig_msg_id === "ninth")).toEqual([
      expect.objectContaining({status:"expired",status_detail:"busy"}),
    ]));
    expect(f.requests).toHaveLength(16);
    const exit=once(f.child,"exit"); f.child.kill("SIGTERM"); await exit;
    expect(held.connections).toHaveLength(8);
    expect(status(held.frames)).toHaveLength(8);
    for (let i=0;i<8;i++) expect(status(next.frames).filter(frame=>frame.orig_msg_id === `next${i}` && frame.status === "dropped")).toHaveLength(1);
  },15000);
  it("AC11 failed callback releases exactly one reservation for a later admission", async () => {
    const f=await fixture(), r=await recipient(f.config.sockDir,9001);
    const absent=join(f.config.sockDir,"9999.sock");
    await send(f.peer.sock,[f.auth,user(absent)]);
    await vi.waitFor(()=>expect(f.requests).toHaveLength(1));
    f.handle.send({type:"steer-result",reqId:f.requests[0]!.reqId,outcome:"delivered",detail:null});
    // Retry only pre-admission busy replies; pending duplicates cannot consume a slot.
    await vi.waitFor(async()=>{
      await send(f.peer.sock,[f.auth,...Array.from({length:8},(_,i)=>user(r.sock,`next${i}`))]);
      expect(f.requests).toHaveLength(9);
    });
  });
});
