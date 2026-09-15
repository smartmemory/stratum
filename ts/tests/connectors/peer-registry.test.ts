import { afterEach, expect, it } from "vitest";
import { mkdtemp, symlink, lstat, readFile, readdir, readlink, rm, writeFile } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import * as registry from "../../src/connectors/peer-registry.js";
const roots: string[] = [];
async function root(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "sp-")); roots.push(dir); return dir;
}
afterEach(async () => { await Promise.all(roots.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
it("derives safe deterministic peer names", () => {
  for (const [model, short] of [["gpt-6-astra/medium", "astra"], ["gpt-5.3-codex-spark", "spark"], ["gpt-5.6-terra/high", "terra"], ["!!!/high", "codex"]]) {
    expect(registry.peerName(model!, "4c165babcdef")).toBe(`codex-${short}-4c165b`);
  }
});
it("resolves sessions directory overrides", () => {
  expect(registry.resolveSessionsDir({})).toBe(join(homedir(), ".claude", "sessions"));
  expect(registry.resolveSessionsDir({ CLAUDE_CONFIG_DIR: "/tmp/sp-config" })).toBe("/tmp/sp-config/sessions");
  expect(registry.resolveSessionsDir({ STRATUM_PEER_SESSIONS_DIR: "/tmp/sp-own", CLAUDE_CONFIG_DIR: "/ignored" })).toBe("/tmp/sp-own");
});

it("resolves socket directory overrides", () => {
  expect(registry.resolveSockDir({})).toBe("/tmp/cc-socks");
  expect(registry.resolveSockDir({ STRATUM_PEER_SOCK_DIR: "/tmp/sp-own" })).toBe("/tmp/sp-own");
});

it("reads real UTC ps start text", async () => {
  expect(await registry.claudeProcStart(process.pid)).toMatch(/^[A-Z][a-z]{2} [A-Z][a-z]{2} [ \d]\d \d\d:\d\d:\d\d \d{4}$/);
  expect(await registry.claudeProcStart(2147483647)).toBeUndefined();
});

it("reproduces the platform pid domain", async () => {
  const expected = process.platform === "darwin" ? "darwin" : process.platform === "linux"
    ? `darwin:${(await readFile("/etc/machine-id", "utf8")).trim()}:${await readlink("/proc/self/ns/pid")}` : undefined;
  expect(await registry.pidDomain()).toBe(expected);
});

it("hashes the resolved socket path for the key filename", () => {
  expect(registry.keyFileName(123, "/tmp/cc-socks/123.sock")).toBe("123.9ee26395991efea12d8a28d06a57aee4e3fe08fe48316aa831e1cdb0a9a4bed4.key");
  expect(registry.keyFileName(123, "/tmp/cc-socks/../cc-socks/123.sock")).toBe(registry.keyFileName(123, "/tmp/cc-socks/123.sock"));
});

it.each([
  ["uds:/tmp/sp-own/123.sock", true], ["uds:/tmp/cc-socks/123.sock", true],
  ["uds:/private/tmp/cc-socks-2/123.sock", true], ["uds:/tmp/cc-socks-7/1.sock", true],
  ["uds:/run/user/501/cc-socks/123.sock", true], ["uds:/etc/x.sock", false],
  ["tcp:/tmp/sp-own/123.sock", false], ["uds:relative/123.sock", false],
  ["uds:/tmp/sp-own/../sp-own/123.sock", false], ["uds:/tmp/sp-own/a.sock", false],
  ["uds:/tmp/cc-socks-abc/123.sock", false], ["uds:/tmp/sp-other/123.sock", false],
])("validates callback %s", (from, allowed) => {
  expect(registry.isAllowedCallback(from as string, "/tmp/sp-own")).toBe(allowed ? (from as string).slice(4) : undefined);
});

it("reads only bounded valid callback tokens by socket hash", async () => {
  const dir = await root(); const sock = "/tmp/sp-own/123.sock";
  expect(await registry.readPeerToken(dir, sock)).toBeUndefined();
  const key = join(dir, registry.keyFileName(123, sock));
  for (const data of ["broken", JSON.stringify({peerToken:"bad"}), JSON.stringify({peerToken:"a".repeat(32), padding:"x".repeat(4096)})]) {
    await writeFile(key, data); expect(await registry.readPeerToken(dir, sock)).toBeUndefined();
  }
  await writeFile(key, JSON.stringify({peerToken:"a".repeat(32)}));
  expect(await registry.readPeerToken(dir, sock)).toBe("a".repeat(32));
  expect(await registry.readPeerToken(dir, "/tmp/sp-own/124.sock")).toBeUndefined();
});

it("gates registration on kill switch, directory and live protocol", async () => {
  const dir = await root();
  expect((await registry.shouldRegister(dir, { STRATUM_PEER_REGISTER:"0" })).ok).toBe(false);
  expect((await registry.shouldRegister(join(dir,"missing"), {})).ok).toBe(false);
  expect(await registry.shouldRegister(dir, {})).toEqual({ok:true});
  await writeFile(join(dir,"2147483647.json"), JSON.stringify({peerProtocol:2}));
  await writeFile(join(dir,"bad.json"), "invalid");
  expect(await registry.shouldRegister(dir, {})).toEqual({ok:true});
  await writeFile(join(dir,`${process.pid}.json`), JSON.stringify({pid:2147483647,peerProtocol:2}));
  expect((await registry.shouldRegister(dir, {})).ok).toBe(false);
});

it("sweeps only the recorded endpoint and matching key, preserving regular files", async () => {
  const dir = await root(); const socks = await root();
  const pid = 2147483647; const endpoint = join(socks,`${pid}.sock`);
  await writeFile(join(dir,`${pid}.json`),JSON.stringify({entrypoint:"stratum-peer",messagingSocketPath:endpoint}));
  const key = registry.keyFileName(pid,endpoint);
  await writeFile(join(dir,key),"owned"); await writeFile(join(dir,`${pid}.other.key`),"foreign");
  await writeFile(endpoint,"regular file");
  expect(await registry.sweepDeadStratumPeers(dir,socks)).toBe(1);
  expect(await readdir(dir)).toEqual([`${pid}.other.key`]);
  expect(await readFile(endpoint,"utf8")).toBe("regular file");
});
it("sweeps a recorded socket in directory A without touching directory B", async () => {
  const dir = await root(); const a = await mkdtemp("/tmp/sp-"); roots.push(a);
  const b = await root(); const pid = 2147483647; const endpoint = join(a,`${pid}.sock`);
  const made = spawnSync(process.execPath,["--input-type=module","-e",`import {createServer} from 'node:net'; createServer().listen(${JSON.stringify(endpoint)},()=>process.exit(0));`]);
  expect(made.status).toBe(0); expect((await lstat(endpoint)).isSocket()).toBe(true);
  await writeFile(join(dir,`${pid}.json`),JSON.stringify({entrypoint:"stratum-peer",messagingSocketPath:endpoint}));
  await writeFile(join(dir,registry.keyFileName(pid,endpoint)),"owned");
  const foreignKey = registry.keyFileName(pid,join(b,`${pid}.sock`));
  await writeFile(join(dir,foreignKey),"foreign"); await writeFile(join(b,`${pid}.sock`),"foreign");
  expect(await registry.sweepDeadStratumPeers(dir,b)).toBe(1);
  await expect(lstat(endpoint)).rejects.toMatchObject({code:"ENOENT"});
  expect(await readdir(dir)).toEqual([foreignKey]);
  expect(await readFile(join(b,`${pid}.sock`),"utf8")).toBe("foreign");
});

it("round trips the sidecar env contract and rejects invalid required values", async () => {
  const dir = await root();
  const config = {runDir:dir,streamPath:join(dir,"stream.jsonl"),childPid:process.pid,childProcStartTime:"123",name:"codex-astra-abcdef",cwd:dir,sessionsDir:dir,sockDir:dir,lingerMs:500,firstLineDeadlineMs:300};
  expect(registry.configFromEnv(registry.sidecarEnv(config))).toEqual(config);
  expect(() => registry.configFromEnv({})).toThrow();
  const env = registry.sidecarEnv(config);
  delete env.STRATUM_PEER_FIRST_LINE_MS; delete env.STRATUM_PEER_LINGER_MS; delete env.STRATUM_PEER_CHILD_START;
  expect(registry.configFromEnv(env)).toEqual({...config,lingerMs:15000,firstLineDeadlineMs:30000,childProcStartTime:undefined});
  expect(() => registry.configFromEnv({...env,STRATUM_PEER_CHILD_PID:"0"})).toThrow();
  for (const value of ["-1", "NaN", "1.5", "Infinity"]) {
    expect(() => registry.configFromEnv({...env,STRATUM_PEER_FIRST_LINE_MS:value})).toThrow();
  }
  const {firstLineDeadlineMs, ...defaultConfig} = config;
  expect(registry.sidecarEnv(defaultConfig).STRATUM_PEER_FIRST_LINE_MS).toBe("30000");
});

const hasMkfifo = !spawnSync("mkfifo", []).error;
it.skipIf(!hasMkfifo)("ignores a numeric FIFO promptly without a writer", async () => {
  const dir = await root();
  await promisify(execFile)("mkfifo", [join(dir, "123.json")]);
  const module = new URL("../../src/connectors/peer-registry.ts", import.meta.url).href;
  const { stdout } = await promisify(execFile)(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e",
    `const {shouldRegister} = await import(${JSON.stringify(module)}); console.log(JSON.stringify(await shouldRegister(${JSON.stringify(dir)}, {})));`], { timeout: 1000 });
  expect(JSON.parse(stdout)).toEqual({ok:true});
});
it("ignores oversized numeric records including a live protocol guard", async () => {
  const dir = await root();
  const record = JSON.stringify({peerProtocol:2, padding:"x".repeat(262144)});
  await writeFile(join(dir,"456.json"), record);
  await writeFile(join(dir,`${process.pid}.json`), record);
  expect(await registry.shouldRegister(dir, {})).toEqual({ok:true});
});
it("never follows or removes numeric record symlinks during sweep", async () => {
  const dir = await root(); const socks = await root();
  const target = join(dir,"target"); const record = JSON.stringify({entrypoint:"stratum-peer"});
  await writeFile(target,record);
  await symlink(target,join(dir,"789.json"));
  await symlink(target,join(dir,"2147483647.json"));
  expect(await registry.sweepDeadStratumPeers(dir,socks)).toBe(0);
  expect((await lstat(join(dir,"789.json"))).isSymbolicLink()).toBe(true);
  expect((await lstat(join(dir,"2147483647.json"))).isSymbolicLink()).toBe(true);
  expect(await readFile(target,"utf8")).toBe(record);
});
it("ignores symlinked callback keys", async () => {
  const dir = await root(); const sock = "/tmp/sp-own/123.sock";
  const target = join(dir,"target");
  await writeFile(target,JSON.stringify({peerToken:"a".repeat(32)}));
  await symlink(target,join(dir,registry.keyFileName(123,sock)));
  expect(await registry.readPeerToken(dir,sock)).toBeUndefined();
});

it("preserves live and foreign records and never unlinks a recorded symlink", async () => {
  const dir = await root(); const socks = await root();
  for (const [pid,entrypoint] of [[process.pid,"stratum-peer"],[2147483646,"foreign"]] as const) {
    const endpoint = join(socks,`${pid}.sock`);
    await writeFile(join(dir,`${pid}.json`),JSON.stringify({entrypoint,messagingSocketPath:endpoint}));
    await writeFile(join(dir,registry.keyFileName(pid,endpoint)),"foreign");
    await writeFile(endpoint,"foreign");
  }
  const before = await readdir(dir);
  const endpoint = join(socks,"2147483647.sock"); const target = join(socks,"target");
  await writeFile(target,"foreign"); await symlink(target,endpoint);
  await writeFile(join(dir,"2147483647.json"),JSON.stringify({entrypoint:"stratum-peer",messagingSocketPath:endpoint}));
  expect(await registry.sweepDeadStratumPeers(dir,socks)).toBe(1);
  expect(await readdir(dir)).toEqual(before);
  expect((await lstat(endpoint)).isSymbolicLink()).toBe(true);
  expect(await readFile(target,"utf8")).toBe("foreign");
});
