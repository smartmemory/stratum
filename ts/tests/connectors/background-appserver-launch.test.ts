import { afterEach, expect, it, vi } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { launchCodexAppServerDriver, type AppServerLaunchConfig } from "../../src/connectors/codex-appserver-launch.js";
import { startBackgroundRun, pollBackgroundRun } from "../../src/connectors/background.js";
import { appServerFixture, isolatedAppServer } from "../helpers/background-appserver-fixture.js";
const roots: string[] = [], children: ChildProcess[] = [], groups: number[] = [];
afterEach(async()=>{
  for(const pid of groups.splice(0)) { try {process.kill(-pid,"SIGKILL");} catch {} }
  for(const child of children.splice(0)) if(child.exitCode===null && child.signalCode===null) {
    const done=once(child,"exit"); try {process.kill(-child.pid!,"SIGKILL");} catch {child.kill("SIGKILL");} await done;
  }
  await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));
});
async function isolated(root: string) {
  const pkg=join(root,"pkg"); await mkdir(pkg);
  await cp(resolve("dist"),join(pkg,"dist"),{recursive:true});
  await cp(resolve("package.json"),join(pkg,"package.json"));
  await symlink(resolve("node_modules"),join(pkg,"node_modules"));
  expect(existsSync(join(pkg,"src"))).toBe(false);
  return pkg;
}
it.each(["source","dist"])("AC14 %s launch uses private config, no prompt argv, and waits for metadata release", async mode=>{
  const f=await appServerFixture(); roots.push(f.root);
  const runDir=join(f.root,"abcdef012345"); await mkdir(runDir,{mode:0o700});
  const streamPath=join(runDir,"stream.jsonl"); await writeFile(streamPath,"");
  const config: AppServerLaunchConfig={runId:"abcdef012345",model:"gpt-6-luna/low",cwd:f.root,prompt:"private launch prompt",streamPath,
    policy:{filesystemMode:"read-only",networkAccess:false,writableRoots:[],approvalPolicy:"never"},
    peer:{name:"fixture",sessionsDir:f.options.sessionsDir,sockDir:f.options.sockDir,lingerMs:100,firstLineDeadlineMs:1000}};
  const launch=mode==="source" ? launchCodexAppServerDriver : (await import(pathToFileURL(join(await isolated(f.root),"dist/connectors/codex-appserver-launch.js")).href)).launchCodexAppServerDriver as typeof launchCodexAppServerDriver;
  const handle=await launch(config,f.options.env); children.push(handle.child);
  expect(handle.child.spawnargs).not.toContain(config.prompt);
  expect(handle.child.spawnargs).toContain(join(runDir,"driver-config.json"));
  expect(handle.child.spawnargs.some(arg=>arg.endsWith(`codex-appserver-driver.${mode==="source"?"ts":"js"}`))).toBe(true);
  expect(handle.child.spawnargs.includes("--experimental-strip-types")).toBe(mode==="source");
  await new Promise(resolve=>setTimeout(resolve,200)); expect(existsSync(f.marker)).toBe(false);
  await writeFile(join(runDir,"meta.json"),JSON.stringify({childPid:handle.child.pid}));
  await handle.release();
  await vi.waitFor(async()=>expect(await readFile(streamPath,"utf8")).toContain('"__t2f5_done__":0'),{timeout:6000});
  expect(handle.child.connected).toBe(false);
});
it.each(["source","dist"])("AC14 %s driver survives MCP parent exit and registration failure", async mode=>{
  const f=await appServerFixture(true); roots.push(f.root);
  const pkg=mode==="dist" ? await isolated(f.root) : undefined;
  // A small source bootstrap supplies NodeNext .js -> .ts resolution for background.ts.
  const entry=mode==="dist" ? join(pkg!,"dist/connectors/background.js") : resolve("src/connectors/background.ts");
  const hostPath=join(f.root,"host.mjs"), resultPath=join(f.root,"result.json");
  await writeFile(hostPath, `import {registerHooks} from 'node:module'; import {existsSync,writeFileSync} from 'node:fs';
${mode==="source" ? `registerHooks({resolve(s,c,n){if(s.startsWith('.')&&s.endsWith('.js')&&c.parentURL?.startsWith(${JSON.stringify(pathToFileURL(resolve("src")).href)})){const u=new URL(s.slice(0,-3)+'.ts',c.parentURL);if(existsSync(u))return n(u.href,c);}return n(s,c);}});` : ""}
const {startBackgroundRun}=await import(${JSON.stringify(pathToFileURL(entry).href)});
const run=await startBackgroundRun(${JSON.stringify({...f.options,sessionsDir:join(f.root,"missing"),env:{...f.options.env,STRATUM_PEER_REGISTER:"1"}})});
writeFileSync(${JSON.stringify(resultPath)},JSON.stringify(run));`);
  const host=spawn(process.execPath,["--experimental-strip-types",hostPath],{stdio:["ignore","ignore","pipe"]}); children.push(host);
  let stderr="";host.stderr!.on("data",data=>stderr+=data);
  const [code]=await once(host,"exit"); expect(code,stderr).toBe(0);
  const run=JSON.parse(await readFile(resultPath,"utf8")); groups.push(run.pid);
  expect(run.peerName).toBeUndefined(); expect(()=>process.kill(run.pid,0)).not.toThrow();
  await vi.waitFor(()=>expect(existsSync(f.marker)).toBe(true));
  const server=JSON.parse(await readFile(f.marker,"utf8")); expect(()=>process.kill(server.pid,0)).not.toThrow();
  await writeFile(f.release,"");
  await vi.waitFor(async()=>expect(await pollBackgroundRun(run.runId,{registryRoot:f.root})).toMatchObject({status:"complete",text:"fixture complete"}),{timeout:6000});
  await vi.waitFor(()=>{expect(()=>process.kill(run.pid,0)).toThrow();expect(()=>process.kill(server.pid,0)).toThrow();},{timeout:6000});
},12000);
it("AC14 parent disconnect before release never starts app-server", async()=>{
  const f=await appServerFixture(); roots.push(f.root);
  const runDir=join(f.root,"abcdef012345");await mkdir(runDir);
  const handle=await launchCodexAppServerDriver({runId:"abcdef012345",model:"gpt-6-luna",cwd:f.root,prompt:"private",streamPath:join(runDir,"stream.jsonl"),policy:{filesystemMode:"read-only",networkAccess:false,writableRoots:[],approvalPolicy:"never"},peer:{name:"test",sessionsDir:f.options.sessionsDir,sockDir:f.options.sockDir,lingerMs:0,firstLineDeadlineMs:100}},f.options.env);
  children.push(handle.child); const done=once(handle.child,"exit");handle.child.disconnect(); await done;
  expect(existsSync(f.marker)).toBe(false);
});
it("AC14 driver death leaves no sentinel and app-server exits on stdin EOF", async()=>{
  const f=await appServerFixture(true); roots.push(f.root);
  const run=await startBackgroundRun(f.options); groups.push(run.pid!);
  await vi.waitFor(async()=>expect(JSON.parse(await readFile(f.marker,"utf8")).pid).toBeTypeOf("number"));
  const server=JSON.parse(await readFile(f.marker,"utf8")); process.kill(run.pid!,"SIGKILL");
  await vi.waitFor(()=>expect(()=>process.kill(server.pid,0)).toThrow(),{timeout:6000});
  expect(await pollBackgroundRun(run.runId,{registryRoot:f.root})).toMatchObject({status:"error",reason:"child_died_without_sentinel"});
});
it.each(["gate","sidecar"])("AC14 registration timeout during %s neither blocks completion nor leaks a late endpoint", async stage=>{
  const f=await appServerFixture(true); roots.push(f.root); const pkg=await isolated(f.root);
  const file=join(pkg,`dist/connectors/${stage==="gate"?"peer-registry":"peer-sidecar"}.js`);
  const source=await readFile(file,"utf8");
  const needle=stage==="gate" ? "export async function shouldRegister(sessionsDir, env) {" : "async function main() {";
  expect(source).toContain(needle);
  await writeFile(file,source.replace(needle,`${needle}\n await new Promise(resolve=>setTimeout(resolve,3000));`));
  const {startBackgroundRun: start}=await import(pathToFileURL(join(pkg,"dist/connectors/background.js")).href) as typeof import("../../src/connectors/background.js");
  const before=Date.now();
  const run=await start({...f.options,env:{...f.options.env,STRATUM_PEER_REGISTER:"1"}});groups.push(run.pid!);
  expect(Date.now()-before).toBeLessThan(2700);expect(run.peerName).toBeUndefined();
  await writeFile(f.release,"");
  await vi.waitFor(async()=>expect((await pollBackgroundRun(run.runId,{registryRoot:f.root})).status).toBe("complete"),{timeout:1000});
  await new Promise(resolve=>setTimeout(resolve,1600));
  expect(existsSync(join(f.root,run.runId,"peer.json"))).toBe(false);
  const {readdir}=await import("node:fs/promises");
  expect(await readdir(f.options.sessionsDir)).toEqual([]);expect(await readdir(f.options.sockDir)).toEqual([]);
},10000);

it.each(["wrong PID", "wrong name"])("AC14 rejects registration evidence with %s", async mismatch=>{
  const f=await appServerFixture(true); roots.push(f.root); const pkg=await isolated(f.root);
  const runDir=join(f.root,"abcdef012345"); await mkdir(runDir);
  const streamPath=join(runDir,"stream.jsonl"); await writeFile(streamPath,"");
  const sidecar=join(pkg,"dist/connectors/peer-sidecar.js");
  const source=await readFile(sidecar,"utf8");
  expect(source).toContain("async function main() {");
  // Hold back real registration indefinitely. Use the actual child PID for the
  // wrong-name case, and observe IPC so launcher name filtering cannot hide attachment.
  await writeFile(sidecar,source.replace("async function main() {",`async function main() {
    const injectedConfig = configFromEnv(process.env);
    const {writeFileSync, appendFileSync} = await import('node:fs');
    writeFileSync(${JSON.stringify(join(runDir,"sidecar-pid"))}, String(process.pid));
    process.on('message', value => appendFileSync(${JSON.stringify(join(runDir,"attachment.jsonl"))}, JSON.stringify(value)+'\\n'));
    writeFileSync(${JSON.stringify(join(runDir,"peer.json"))}, JSON.stringify({
      name: ${mismatch==="wrong name" ? "'foreign-peer'" : "injectedConfig.name"},
      pid: ${mismatch==="wrong PID" ? "process.pid + 1" : "process.pid"}
    }));
    await new Promise(() => { setInterval(() => {}, 1000); });
    return;
  `));
  const {launchCodexAppServerDriver: launch}=await import(pathToFileURL(join(pkg,"dist/connectors/codex-appserver-launch.js")).href) as typeof import("../../src/connectors/codex-appserver-launch.js");
  const handle=await launch({runId:"abcdef012345",model:"gpt-6-luna",cwd:f.root,prompt:"private",streamPath,
    policy:{filesystemMode:"read-only",networkAccess:false,writableRoots:[],approvalPolicy:"never"},
    peer:{name:"expected-peer",sessionsDir:f.options.sessionsDir,sockDir:f.options.sockDir,lingerMs:0,firstLineDeadlineMs:1000}},
    {...f.options.env,STRATUM_PEER_REGISTER:"1"}); children.push(handle.child);
  const results: unknown[]=[];handle.child.on("message",value=>results.push(value));
  const before=Date.now();const released=handle.release();
  await vi.waitFor(()=>expect(existsSync(join(runDir,"sidecar-pid"))).toBe(true),{timeout:1500});
  const pid=Number(await readFile(join(runDir,"sidecar-pid"),"utf8"));groups.push(pid);
  expect(await released).toBeUndefined();
  expect(results.every(value=>(value as {peerName?:string}).peerName===undefined)).toBe(true);
  await vi.waitFor(()=>expect(()=>process.kill(pid,0)).toThrow(),{timeout:1000});
  expect(Date.now()-before).toBeLessThan(3200); // 2s registration + bounded abort/reaping
  expect(existsSync(join(runDir,"attachment.jsonl"))).toBe(false);
  const {readdir}=await import("node:fs/promises");
  expect(await readdir(f.options.sessionsDir)).toEqual([]);expect(await readdir(f.options.sockDir)).toEqual([]);
  await writeFile(f.release,"");
  await vi.waitFor(async()=>expect(await readFile(streamPath,"utf8")).toContain('"__t2f5_done__":0'),{timeout:6000});
  const output=await readFile(streamPath,"utf8");
  expect(output).toContain("fixture complete");expect(output.match(/"__t2f5_done__":/g)).toHaveLength(1);
},12000);


it.each([2000,15000])("AC14 delayed sidecar startup with %ims budget", async budget=>{
  const f=await appServerFixture(true);roots.push(f.root);
  const pkg=await isolatedAppServer(f.root,budget===2000 ? undefined : budget);
  const file=join(pkg,"dist/connectors/peer-sidecar.js");const source=await readFile(file,"utf8");
  expect(source).toContain("async function main() {");
  await writeFile(file,source.replace("async function main() {",`async function main() {
    console.error('test: sidecar startup delay begins');
    await new Promise(resolve=>setTimeout(resolve,3000));
    console.error('test: sidecar startup delay ends');
    // Controlled registration fixture isolates the deadline from socket permissions.
    const injectedConfig = configFromEnv(process.env);
    const {writeFileSync} = await import('node:fs');
    writeFileSync(join(injectedConfig.runDir,'peer.json'), JSON.stringify({name:injectedConfig.name,pid:process.pid}));
    process.send({type:'owner-ready',runId:injectedConfig.runId});
    process.on('disconnect',()=>process.exit(0));
    await new Promise(() => { setInterval(() => {}, 1000); });
    return;
  `));
  const {startBackgroundRun: start}=await import(pathToFileURL(join(pkg,"dist/connectors/background.js")).href) as typeof import("../../src/connectors/background.js");
  const run=await start({...f.options,peerLabel:"slow-start",env:{...f.options.env,STRATUM_PEER_REGISTER:"1"}});groups.push(run.pid!);
  const stderr=await readFile(`${run.streamPath}.peer.err`,"utf8");
  expect(stderr).toContain("test: sidecar startup delay begins");
  if(budget===2000) {
    expect(run.peerName).toBeUndefined();expect(stderr).not.toContain("test: sidecar startup delay ends");
    await new Promise(resolve=>setTimeout(resolve,1600));
    expect(existsSync(join(f.root,run.runId,"peer.json"))).toBe(false);
    const {readdir}=await import("node:fs/promises");
    expect(await readdir(f.options.sessionsDir)).toEqual([]);expect(await readdir(f.options.sockDir)).toEqual([]);
  } else {
    expect(stderr).toContain("test: sidecar startup delay ends");expect(run.peerName,stderr).toContain("slow-start");
    const peer=JSON.parse(await readFile(join(f.root,run.runId,"peer.json"),"utf8"));groups.push(peer.pid);
    expect(peer.name).toBe(run.peerName);
  }
  await writeFile(f.release,"");
  await vi.waitFor(async()=>expect(await pollBackgroundRun(run.runId,{registryRoot:f.root})).toMatchObject({status:"complete",text:"fixture complete"}),{timeout:6000});
},25000);
