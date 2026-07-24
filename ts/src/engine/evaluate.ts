import { spawn } from "node:child_process";
import type { EvaluateRunner } from "./engine.js";

/**
 * Default `EvaluateRunner`: runs the declared command through `/bin/sh -c`,
 * hands the bound input to it as JSON on stdin, and reads a JSON verdict from
 * stdout. It only classifies the *transport* outcome — exit / timeout / parse.
 * The engine owns the trust schema, so this never fabricates a verdict.
 */
export function createEvaluateRunner(): EvaluateRunner {
  return ({ command, input, timeoutMs }, context) =>
    new Promise((resolve) => {
      // `detached` makes the shell its own process-group leader, so a timeout
      // can SIGKILL the whole tree (`-pid`) — killing only the shell would
      // orphan grandchildren it backgrounded, leaking work and stdio handles.
      const child = spawn("/bin/sh", ["-c", command], {
        ...(context.workspaceRoot !== undefined ? { cwd: context.workspaceRoot } : {}),
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
      });

      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (result: Awaited<ReturnType<EvaluateRunner>>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(result);
      };

      const timer = setTimeout(() => {
        // Kill the process group, not just the shell, so backgrounded children die too.
        try { if (child.pid !== undefined) process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ }
        finish({ ok: false, kind: "timeout", reason: `command exceeded ${timeoutMs}ms` });
      }, timeoutMs);

      child.stdout.on("data", (chunk) => { stdout += String(chunk); });
      child.stderr.on("data", (chunk) => { stderr += String(chunk); });
      child.on("error", (error) => finish({ ok: false, kind: "exit", reason: error.message }));
      child.on("close", (code) => {
        if (code !== 0) {
          finish({ ok: false, kind: "exit", reason: `exit code ${String(code)}${stderr ? `: ${stderr.trim()}` : ""}` });
          return;
        }
        try {
          finish({ ok: true, result: JSON.parse(stdout) });
        } catch (error) {
          finish({ ok: false, kind: "parse", reason: error instanceof Error ? error.message : String(error) });
        }
      });

      // A command that never reads stdin (and has already exited) turns this
      // write into an EPIPE on the pipe; swallow it — the close/error handlers
      // above carry the real outcome. Left unhandled it crashes the process.
      child.stdin.on("error", () => {});
      if (input !== undefined) child.stdin.write(JSON.stringify(input));
      child.stdin.end();
    });
}
