import { spawn, type ChildProcess } from "node:child_process";
import { open, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DriverOptions } from "./codex-appserver-driver.js";

export interface AppServerLaunchConfig extends DriverOptions {
  streamPath: string;
  peer: { sessionsDir: string; sockDir: string; name: string; lingerMs: number; firstLineDeadlineMs: number };
}

/** The driver cannot start its server until release(), after durable metadata. */
export async function launchCodexAppServerDriver(config: AppServerLaunchConfig, env: NodeJS.ProcessEnv): Promise<{
  child: ChildProcess; release(): Promise<string | undefined>;
}> {
  const configPath = join(config.streamPath, "..", "driver-config.json");
  await writeFile(configPath, JSON.stringify(config), { mode: 0o600, flag: "wx" });
  const source = import.meta.url.endsWith(".ts");
  const entry = fileURLToPath(new URL(`./codex-appserver-driver.${source ? "ts" : "js"}`, import.meta.url));
  const stderr = await open(`${config.streamPath}.err`, "a", 0o600);
  let child: ChildProcess;
  try {
    child = spawn(process.execPath, [...(source ? ["--experimental-strip-types"] : []), entry, configPath], {
      cwd: config.cwd, env, detached: true, stdio: ["ignore", "ignore", stderr.fd, "ipc"],
    });
    await new Promise<void>((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
  } finally { await stderr.close(); }
  // Keep an error sink after bootstrap, including asynchronous IPC failures.
  child.on("error", () => {});
  return { child, release() {
    return new Promise(resolve => {
      let settled = false;
      const finish = (name?: string) => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        child.off("message", message); child.off("exit", exited); child.off("disconnect", exited);
        try { if (child.connected) child.disconnect(); } catch { /* already disconnected */ }
        child.unref(); resolve(name);
      };
      const exited = () => finish();
      const message = (value: any) => {
        if (value?.type === "bootstrap-result" && value.runId === config.runId) {
          finish(value.peerName === config.peer.name ? value.peerName : undefined);
        }
      };
      // The registration deadline starts at release, not at driver module import.
      const deadline = Date.now() + 2000;
      const timer = setTimeout(finish, 2000);
      child.on("message", message); child.once("exit", exited); child.once("disconnect", exited);
      try { child.send({ type: "bootstrap", runId: config.runId, deadline }, error => { if (error) finish(); }); }
      catch { finish(); }
    });
  } };
}
