import { cp, mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export async function appServerFixture(hold = false) {
  const root = await mkdtemp("/tmp/p3s4-");
  const bin = join(root, "bin"); await mkdir(bin);
  const sessionsDir = join(root, "sessions"), sockDir = join(root, "s");
  await mkdir(sessionsDir); await mkdir(sockDir);
  const marker = join(root, "server.json"), release = join(root, "release");
  await writeFile(join(bin, "codex"), `#!${process.execPath}
import {writeFileSync, existsSync} from 'node:fs';
import {serveScenario} from ${JSON.stringify(pathToFileURL(resolve("tests/helpers/fake-app-server.mjs")).href)};
writeFileSync(${JSON.stringify(marker)}, JSON.stringify({pid:process.pid,argv:process.argv,env:process.env}));
import {createInterface} from 'node:readline';
createInterface({input:process.stdin}).on('line',line=>{const f=JSON.parse(line);if(f.method==='turn/start')writeFileSync(${JSON.stringify(join(root,"turn.json"))},JSON.stringify(f.params));});
serveScenario({hold:${hold},events:[{method:'item/completed',params:{item:{id:'a',type:'agentMessage',text:'fixture complete'}}}]});
${hold ? `const timer=setInterval(()=>{if(existsSync(${JSON.stringify(release)})){clearInterval(timer);process.stdout.write(JSON.stringify({method:'turn/completed',params:{threadId:'t',turn:{id:'u',status:'completed'}}})+'\\n');}},20); process.stdin.on('end',()=>clearInterval(timer));` : ""}
`, { mode: 0o700 });
  // Extensionless executable needs an ESM package boundary.
  await writeFile(join(bin,"package.json"), '{"type":"module"}');
  const env = { PATH: bin, STRATUM_CODEX_BG_STRATEGY: "app-server", STRATUM_PEER_REGISTER: "0" };
  return { root, marker, release, options: {agent:"codex" as const, prompt:"private task",cwd:root,registryRoot:root,sessionsDir,sockDir,lingerMs:100,env} };
}

/** Patch only a disposable emitted package; production has no test budget knob. */
export async function isolatedAppServer(root: string, registrationBudgetMs?: number) {
  const pkg = join(root, "pkg"); await mkdir(pkg);
  await cp(resolve("dist"), join(pkg, "dist"), {recursive:true});
  await cp(resolve("package.json"), join(pkg, "package.json"));
  await symlink(resolve("node_modules"), join(pkg, "node_modules"));
  if (registrationBudgetMs !== undefined) {
    const file = join(pkg, "dist/connectors/codex-appserver-launch.js");
    const source = await readFile(file, "utf8");
    const deadline = "const deadline = Date.now() + 2000;";
    const timer = "const timer = setTimeout(finish, 2000);";
    if (!source.includes(deadline) || !source.includes(timer)) throw new Error("Registration budget seam changed");
    await writeFile(file, source.replace(deadline, `const deadline = Date.now() + ${registrationBudgetMs};`)
      .replace(timer, `const timer = setTimeout(finish, ${registrationBudgetMs});`));
  }
  return pkg;
}
