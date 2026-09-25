import { afterEach, expect, it, vi } from "vitest";
import * as cp from "node:child_process";
import { readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { startBackgroundRun, resolveCodexBackgroundStrategy, pollBackgroundRun, cancelBackgroundRun } from "../../src/connectors/background.js";
import { processGroupId, procStartTime } from "../../src/connectors/proc_identity.js";
import { applyHeadlessShellEnv, withSandboxPreamble } from "../../src/connectors/codex.js";
import { appServerFixture, isolatedAppServer } from "../helpers/background-appserver-fixture.js";
vi.mock("node:child_process", async importOriginal => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, spawn: vi.fn(original.spawn) };
});
const roots: string[] = [], pids: number[] = [];
afterEach(async () => {
  vi.unstubAllEnvs(); vi.clearAllMocks();
  for (const pid of pids.splice(0)) { try {process.kill(-pid,"SIGKILL");} catch {} }
  await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));
});
it.each([undefined,"exec","app-server"])("AC01 selects %s with explicit replacement environment", value => {
  vi.stubEnv("STRATUM_CODEX_BG_STRATEGY","app-server");
  expect(resolveCodexBackgroundStrategy({env:value === undefined ? {} : {STRATUM_CODEX_BG_STRATEGY:value}})).toBe(value ?? "exec");
  expect(resolveCodexBackgroundStrategy({})).toBe("app-server");
});
it("AC01 defaults to exec and ignores foreground transport; command forces exec", () => {
  vi.stubEnv("STRATUM_CODEX_BG_STRATEGY",undefined);
  expect(resolveCodexBackgroundStrategy({})).toBe("exec");
  expect(resolveCodexBackgroundStrategy({env:{STRATUM_CODEX_TRANSPORT:"sdk"}})).toBe("exec");
  for (const value of ["app-server","invalid"]) expect(resolveCodexBackgroundStrategy({env:{STRATUM_CODEX_BG_STRATEGY:value},command:["true"],approvalPolicy:"on-failure"})).toBe("exec");
});
it.each(["invalid", ""])("AC01 invalid selector %j rejects before run directory or spawn", async value => {
  const f=await appServerFixture(); roots.push(f.root); const spawn=vi.mocked(cp.spawn);
  const before=await readdir(f.root);
  await expect(startBackgroundRun({...f.options,env:{...f.options.env,STRATUM_CODEX_BG_STRATEGY:value}})).rejects.toThrow("STRATUM_CODEX_BG_STRATEGY");
  expect(spawn).not.toHaveBeenCalled(); expect(await readdir(f.root)).toEqual(before);
});
it("AC04 on-failure rejects before run directory or spawn", async () => {
  const f=await appServerFixture(); roots.push(f.root); const spawn=vi.mocked(cp.spawn); const before=await readdir(f.root);
  await expect(startBackgroundRun({...f.options,approvalPolicy:"on-failure"})).rejects.toThrow("on-failure");
  expect(spawn).not.toHaveBeenCalled(); expect(await readdir(f.root)).toEqual(before);
});
it.each(["disabled","failure"])("AC01/AC14 registration %s preserves strict poll, prompt, audit and environment", async mode => {
  const f=await appServerFixture(); roots.push(f.root);
  const run=await startBackgroundRun({...f.options,peerLabel:"review",sandboxMode:"workspace-write",networkAccess:true,
    env:{...f.options.env,STRATUM_PEER_REGISTER:mode==="disabled"?"0":"1",ANTHROPIC_API_KEY:"secret",CLAUDE_API_KEY:"secret",CLAUDECODE:"secret",SHELL:"/chosen/shell",PUPPETEER_EXECUTABLE_PATH:"/chosen/headless"},
    sessionsDir: mode==="failure" ? join(f.root,"missing") : f.options.sessionsDir});
  expect(run.peerName).toBeUndefined();
  await vi.waitFor(async()=>expect(await pollBackgroundRun(run.runId,{registryRoot:f.root})).toMatchObject({status:"complete",text:"fixture complete"}),{timeout:6000});
  const meta=JSON.parse(await readFile(join(dirname(run.streamPath),"meta.json"),"utf8"));
  expect(meta.outputContract).toBeUndefined(); expect(meta.childPid).toBe(run.pid); expect(meta.sandboxAudit).toBeDefined();
  expect((await stat(join(dirname(run.streamPath),"driver-config.json"))).mode & 0o777).toBe(0o600);
  expect((await stat(dirname(run.streamPath))).mode & 0o777).toBe(0o700);
  const server=JSON.parse(await readFile(f.marker,"utf8"));
  expect(server.env).not.toHaveProperty("ANTHROPIC_API_KEY"); expect(server.env).not.toHaveProperty("CLAUDE_API_KEY"); expect(server.env).not.toHaveProperty("CLAUDECODE"); expect(server.env.SHELL).toBe("/chosen/shell"); expect(server.env.PUPPETEER_EXECUTABLE_PATH).toBe("/chosen/headless");
  const turn=JSON.parse(await readFile(join(f.root,"turn.json"),"utf8"));
  expect(turn.input[0].text).toBe(withSandboxPreamble(f.options.prompt,"workspace-write"));
});
it("AC14 persists driver group leader identity; cancellation reaps driver and server", async () => {
  const f=await appServerFixture(true); roots.push(f.root);
  const run=await startBackgroundRun(f.options); pids.push(run.pid!);
  await vi.waitFor(async()=>expect(JSON.parse(await readFile(f.marker,"utf8")).pid).toBeTypeOf("number"));
  const server=JSON.parse(await readFile(f.marker,"utf8"));
  const meta=JSON.parse(await readFile(join(dirname(run.streamPath),"meta.json"),"utf8"));
  expect(meta.procStartTime).toBe(await procStartTime(run.pid!)); expect(meta.procStartTime).toBeTruthy();
  expect(await processGroupId(run.pid!)).toBe(run.pid); expect(await processGroupId(server.pid)).toBe(run.pid);
  expect(await cancelBackgroundRun(run.runId,{registryRoot:f.root})).toMatchObject({status:"cancelled"});
  await vi.waitFor(()=>{expect(()=>process.kill(run.pid!,0)).toThrow(); expect(()=>process.kill(server.pid,0)).toThrow();},{timeout:7000});
  expect(await pollBackgroundRun(run.runId,{registryRoot:f.root})).toMatchObject({status:"error",reason:"child_died_without_sentinel"});
});
it("AC01/AC14 successful registration proves label and independent sidecar group", async () => {
  const f=await appServerFixture(true); roots.push(f.root);
  // This tests successful registration, not the production startup deadline.
  const pkg=await isolatedAppServer(f.root, 15000);
  const {startBackgroundRun: start}=await import(pathToFileURL(join(pkg,"dist/connectors/background.js")).href) as typeof import("../../src/connectors/background.js");
  const run=await start({...f.options,peerLabel:"review",env:{...f.options.env,STRATUM_PEER_REGISTER:"1"}}); pids.push(run.pid!);
  expect(run.peerName, await readFile(`${run.streamPath}.peer.err`,"utf8").catch(()=>"no sidecar stderr")).toContain("review");
  const peer=JSON.parse(await readFile(join(dirname(run.streamPath),"peer.json"),"utf8")); pids.push(peer.pid);
  expect(peer.name).toBe(run.peerName); expect(await processGroupId(peer.pid)).toBe(peer.pid); expect(peer.pid).not.toBe(run.pid);
  await writeFile(f.release,"");
  await vi.waitFor(async()=>expect((await pollBackgroundRun(run.runId,{registryRoot:f.root})).status).toBe("complete"),{timeout:6000});
  await vi.waitFor(()=>expect(()=>process.kill(peer.pid,0)).toThrow(),{timeout:6000});
},25000);
it("AC04 injected command keeps exec on-failure behavior", async()=>{
  const f=await appServerFixture();roots.push(f.root);
  const run=await startBackgroundRun({...f.options,approvalPolicy:"on-failure",env:{...f.options.env,PATH:`${f.options.env.PATH}:/usr/bin:/bin`},command:[process.execPath,"-e","console.log('fixture')"]});
  await vi.waitFor(async()=>expect((await pollBackgroundRun(run.runId,{registryRoot:f.root})).status).toBe("complete"));
  const meta=JSON.parse(await readFile(join(dirname(run.streamPath),"meta.json"),"utf8"));expect(meta.outputContract).toBe("opaque");
});
it("AC01 ambient environment keeps headless-shell defaults and scrubbing",async()=>{
  const f=await appServerFixture();roots.push(f.root);
  for(const [key,value] of Object.entries(f.options.env))vi.stubEnv(key,value);
  vi.stubEnv("PUPPETEER_EXECUTABLE_PATH",undefined);vi.stubEnv("CLAUDECODE","private");vi.stubEnv("ANTHROPIC_API_KEY","private");
  const {env,...options}=f.options;const run=await startBackgroundRun(options);
  await vi.waitFor(async()=>expect((await pollBackgroundRun(run.runId,{registryRoot:f.root})).status).toBe("complete"),{timeout:6000});
  const server=JSON.parse(await readFile(f.marker,"utf8"));const expected: NodeJS.ProcessEnv={};applyHeadlessShellEnv(expected);expect(server.env.PUPPETEER_EXECUTABLE_PATH).toBe(expected.PUPPETEER_EXECUTABLE_PATH);expect(server.env).not.toHaveProperty("CLAUDECODE");expect(server.env).not.toHaveProperty("ANTHROPIC_API_KEY");
});
