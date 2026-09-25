import { afterEach, describe, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { join, resolve } from "node:path";
import { sidecarEnv, keyFileName, type PeerSidecarConfig } from "../../src/connectors/peer-registry.js";
import { AppServerPeerHandle, isDriverMessage, isPeerMessage, type SteerRequest } from "../../src/connectors/codex-appserver-ipc.js";

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
  return {config,child,handle,requests,peer,auth:{type:"auth",token:peerToken},state};
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

describe.skipIf(!socketAvailable)("app-server socket/IPC lifecycle", () => {
  it.each(["absent","wrong","late","repair"])("AC09 denies %s first-frame auth", async mode => {
    const f=await fixture(), r=await recipient(f.config.sockDir,9001), frame=user(r.sock);
    const frames = mode === "absent" ? [frame] : mode === "wrong" ? [{type:"auth",token:"wrong"},frame]
      : mode === "late" ? [{type:"ignored"},f.auth,frame] : [{type:"auth",token:"wrong"},f.auth,frame];
    await send(f.peer.sock,frames);
    await vi.waitFor(()=>expect(status(r.frames)).toHaveLength(1));
    expect(status(r.frames)[0]).toMatchObject({status:"denied",orig_msg_id:"m",from_mode:"bypass"}); expect(f.requests).toHaveLength(0);
  });
  it("AC09 valid auth preserves envelope, provenance, correlation and callback auth", async () => {
    const f=await fixture(), r=await recipient(f.config.sockDir,9001);
    await writeFile(join(f.config.sessionsDir,keyFileName(9001,r.sock)),JSON.stringify({peerToken:"a".repeat(32)}));
    await send(f.peer.sock,[f.auth,user(r.sock)]);
    await vi.waitFor(()=>expect(f.requests).toHaveLength(1));
    const request=f.requests[0]!;
    expect(request).toMatchObject({senderFrom:`uds:${r.sock}`,msgId:"m",runId,expectedTurnId:"u",
      text:"Message from a peer Claude session, not the original task author.\n"+envelope});
    expect(status(r.frames)).toHaveLength(0);
    f.handle.send({type:"steer-result",reqId:request.reqId,outcome:"delivered",detail:null});
    await vi.waitFor(()=>expect(status(r.frames)).toHaveLength(1));
    expect(r.frames[0]).toEqual({type:"auth",token:"a".repeat(32)});
    expect(status(r.frames)[0]).toMatchObject({status:"delivered",orig_msg_id:"m",from_mode:"bypass"});
  });
  it.each(["stream","owner-state"])("AC08 refuses completion observed by %s during linger", async via => {
    const f=await fixture(), r=await recipient(f.config.sockDir,9001);
    if (via === "stream") {
      await appendFile(f.config.streamPath,'{"__t2f5_done__":0}\n');
      await vi.waitFor(async()=>expect(JSON.parse(await readFile(join(f.config.sessionsDir,`${f.peer.pid}.json`),"utf8")).status).toBe("idle"));
    } else { f.state(null); await new Promise<void>(r=>f.child.send({type:"active-turn-state",runId,threadId:"t",turnId:null},()=>r())); }
    await send(f.peer.sock,[f.auth,user(r.sock)]);
    await vi.waitFor(()=>expect(status(r.frames)).toHaveLength(1));
    expect(status(r.frames)[0]).toMatchObject({status:"expired",status_detail:"refused"}); expect(f.requests).toHaveLength(0);
  });
  it("AC10 simultaneous senders, duplicate pending IDs and late results settle once", async () => {
    const f=await fixture(), a=await recipient(f.config.sockDir,9001), b=await recipient(f.config.sockDir,9002);
    await Promise.all([send(f.peer.sock,[f.auth,user(a.sock),user(a.sock)]),send(f.peer.sock,[f.auth,user(b.sock)])]);
    await vi.waitFor(()=>expect(f.requests).toHaveLength(2));
    expect(new Set(f.requests.map(r=>r.reqId)).size).toBe(2);
    for (const req of f.requests) f.handle.send({type:"steer-result",reqId:req.reqId,outcome:"expired",detail:"refused"});
    await vi.waitFor(()=>expect(status(a.frames).length+status(b.frames).length).toBe(2));
    for (const req of f.requests) f.handle.send({type:"steer-result",reqId:req.reqId,outcome:"delivered",detail:null});
    // Ordered IPC barrier: a subsequent admission proves duplicate result messages were consumed.
    await send(f.peer.sock,[f.auth,user(a.sock,"barrier")]);
    await vi.waitFor(()=>expect(f.requests).toHaveLength(3));
    expect(status(a.frames)).toHaveLength(1); expect(status(b.frames)).toHaveLength(1);
  });
  it.each(["before","after"])("AC10 IPC disconnect %s admission reports uncertainty correctly", async when => {
    const f=await fixture(), r=await recipient(f.config.sockDir,9001);
    if (when === "after") { await send(f.peer.sock,[f.auth,user(r.sock)]); await vi.waitFor(()=>expect(f.requests).toHaveLength(1)); }
    f.handle.abandon();
    if (when === "before") {
      await vi.waitFor(async()=>expect(JSON.parse(await readFile(join(f.config.sessionsDir,`${f.peer.pid}.json`),"utf8")).status).toBe("idle"));
      await send(f.peer.sock,[f.auth,user(r.sock)]);
    }
    await vi.waitFor(()=>expect(status(r.frames)).toHaveLength(1));
    expect(status(r.frames)[0]).toMatchObject({status:"dropped",status_detail:when === "before" ? "not_sent" : "unknown"});
    expect(f.requests).toHaveLength(when === "before" ? 0 : 1);
  });
  it("AC10 lost result times out without retry", async () => {
    const f=await fixture(), r=await recipient(f.config.sockDir,9001);
    await send(f.peer.sock,[f.auth,user(r.sock)]);
    await vi.waitFor(()=>expect(status(r.frames)).toHaveLength(1),{timeout:12000});
    expect(status(r.frames)[0]).toMatchObject({status:"dropped",status_detail:"unknown"}); expect(f.requests).toHaveLength(1);
  },15000);
  it("AC09 unauthenticated idle subscriptions remain advisory", async () => {
    const f=await fixture(), r=await recipient(f.config.sockDir,9001);
    await send(f.peer.sock,[{type:"control",action:"notify_when_idle",msg_id:"idle",from:`uds:${r.sock}`}]);
    await appendFile(f.config.streamPath,'{"__t2f5_done__":0}\n');
    await vi.waitFor(()=>expect(r.frames.some(x=>x.action === "peer_idle_notice")).toBe(true));
  });
});

it("IPC validators reject malformed and stale messages", () => {
  expect(isPeerMessage({type:"owner-ready",runId:"stale"},runId)).toBe(false);
  expect(isPeerMessage({type:"steer",runId,reqId:"r"},runId)).toBe(false);
  expect(isDriverMessage({type:"active-turn-state",runId,threadId:"t",turnId:42},runId)).toBe(false);
  expect(isDriverMessage({type:"steer-result",reqId:"r",outcome:"delivered",detail:"unknown"},runId)).toBe(false);
});

import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { runAppServerDriver } from "../../src/connectors/codex-appserver-driver.js";
import type { DriverPeerAttachment, DriverMessage, PeerMessage } from "../../src/connectors/codex-appserver-ipc.js";
function driverFixture() {
  const child = new EventEmitter() as ChildProcessWithoutNullStreams;
  Object.assign(child,{stdin:new PassThrough(),stdout:new PassThrough(),stderr:new PassThrough(),kill:()=>{child.emit("exit",0);return true;}});
  child.stdin.on("finish",()=>child.emit("exit",0));
  const send=(frame:unknown)=>child.stdout.push(JSON.stringify(frame)+"\n");
  const sent:any[]=[];
  let input="";
  child.stdin.on("data",data=>{input+=data;let end:number;
    while((end=input.indexOf("\n"))>=0) {
      const f=JSON.parse(input.slice(0,end));input=input.slice(end+1);sent.push(f);
      if(f.method==="initialize") send({id:f.id,result:{userAgent:`stratum/0.155.1 (fake) (${f.params.clientInfo.name}; ${f.params.clientInfo.version})`}});
      if(f.method==="thread/start") send({id:f.id,result:{thread:{id:"t"}}});
      if(f.method==="turn/start") {send({id:f.id,result:{turn:{id:"u"}}});send({method:"turn/started",params:{threadId:"t",turn:{id:"u"}}});}
    }
  });
  const complete=()=>send({method:"turn/completed",params:{threadId:"t",turn:{id:"u",status:"completed"}}});
  const records:any[]=[],messages:DriverMessage[]=[];
  let receive!:(m:PeerMessage)=>void;
  const peer:DriverPeerAttachment={subscribe(fn){receive=fn;return ()=>{};},send(m){messages.push(m);},close(){}};
  const run=(attachPeer?:()=>Promise<DriverPeerAttachment|undefined>)=>runAppServerDriver({runId,model:"gpt-6-luna/low",cwd:process.cwd(),prompt:"task",
    policy:{filesystemMode:"read-only",writableRoots:[],networkAccess:false,approvalPolicy:"never"}},
    {spawn:()=>child,...(attachPeer ? {attachPeer} : {peer}),signals:new EventEmitter(),log:()=>{},timings:{steer:30},
      writer:{async write(line){records.push(JSON.parse(line));},async flush(){}}});
  return {send,sent,complete,records,messages,peer,run,steer:(expectedTurnId="u")=>receive({type:"steer",runId,reqId:"req",senderFrom:"peer",msgId:"msg",text:envelope,expectedTurnId})};
}
it.each(["delivered","mismatched ID","missing ID","server refused","stale expected ID","timeout","completion race"])(
  "AC10 driver %s settles only the message and completes normally", async outcome=>{
    const f=driverFixture(), done=f.run(); let ended=false; void done.then(()=>{ended=true;});
    await vi.waitFor(()=>expect(f.messages.some(m=>m.type==="active-turn-state" && m.turnId==="u")).toBe(true));
    f.steer(outcome==="stale expected ID" ? "old" : "u");
    const request=f.sent.find(m=>m.method==="turn/steer");
    if(outcome==="completion race") f.complete();
    else if(outcome!=="timeout" && outcome!=="stale expected ID") f.send({id:request.id,
      ...(outcome==="server refused" ? {error:{message:"stale expectedTurnId"}} : {result:outcome==="missing ID" ? {} : {turnId:outcome==="mismatched ID" ? "other" : "u"}})});
    await vi.waitFor(()=>expect(f.messages.filter(m=>m.type==="steer-result")).toHaveLength(1));
    const expected=outcome==="delivered" ? {outcome:"delivered",detail:null}
      : outcome==="server refused" || outcome==="stale expected ID" ? {outcome:"expired",detail:"refused"} : {outcome:"dropped",detail:"unknown"};
    expect(f.messages.find(m=>m.type==="steer-result")).toMatchObject(expected);
    expect(f.sent.filter(m=>m.method==="turn/steer")).toHaveLength(outcome==="stale expected ID" ? 0 : 1);
    if(outcome!=="completion race") {expect(ended).toBe(false);expect(f.records.some(r=>"__t2f5_done__" in r)).toBe(false);f.complete();}
    expect(await done).toBe("completed");expect(f.records.filter(r=>"__t2f5_done__" in r)).toEqual([{__t2f5_done__:0}]);
  });
it.each(["registration failure","sidecar crash","late readiness"])("AC10 %s does not affect driver completion",async mode=>{
  const f=driverFixture();
  let attach!:(p:DriverPeerAttachment)=>void;
  const done=f.run(mode==="registration failure" ? async()=>{throw new Error("registration failed");}
    : mode==="late readiness" ? ()=>new Promise(resolve=>{attach=resolve;}) : undefined);
  await vi.waitFor(()=>expect(f.sent.some(m=>m.method==="turn/start")).toBe(true));
  if(mode==="late readiness") {attach(f.peer);await vi.waitFor(()=>expect(f.messages.some(m=>m.type==="active-turn-state" && m.turnId==="u")).toBe(true));}
  if(mode==="sidecar crash") f.peer.send=()=>{throw new Error("IPC gone");};
  f.complete(); expect(await done).toBe("completed");
});
it("persistent handle replays readiness and flushes finalization before disconnect",()=>{
  const child=new EventEmitter() as ChildProcess, callbacks:Array<(error:Error|null)=>void>=[], sent:unknown[]=[];
  const disconnect=vi.fn(); Object.assign(child,{connected:true,disconnect,send:(m:unknown,cb:(error:Error|null)=>void)=>{sent.push(m);callbacks.push(cb);return true;}});
  const handle=new AppServerPeerHandle(child,runId);
  child.emit("message",{type:"owner-ready",runId}); const receive=vi.fn(); handle.subscribe(receive);
  expect(receive).toHaveBeenCalledWith({type:"owner-ready",runId});
  handle.send({type:"active-turn-state",runId,threadId:"t",turnId:"u"});callbacks.shift()!(null);
  expect(disconnect).not.toHaveBeenCalled(); handle.finalize();expect(disconnect).not.toHaveBeenCalled();
  callbacks.shift()!(null); expect(disconnect).toHaveBeenCalledTimes(1);expect(sent).toHaveLength(2);
});
