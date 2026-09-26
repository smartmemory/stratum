import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { createMcpServer } from "../../src/mcp/server.js";
import * as runner from "../../src/connectors/runner.js";
import type { AuditTrail, FlowPollResponse } from "../../src/engine/engine.js";

// Collection never probes devin: only the gated body may launch an agent,
// and it always supplies the isolated temporary HOME.
const live = process.env.STRATUM_DEVIN_LIVE === "1" && process.platform === "darwin" && !process.env.CI;
function snapshot(path: string) {
  return existsSync(path) ? { bytes: readFileSync(path), mtimeMs: statSync(path).mtimeMs } : undefined;
}
function groupMembers(pid: number): string {
  const result = spawnSync("ps", ["-g", String(pid), "-o", "pid=,pgid=,stat=,command="], { encoding: "utf8" });
  if (result.error || (result.status !== 0 && result.status !== 1)) throw result.error ?? new Error(result.stderr);
  return result.stdout.trim();
}
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe.skipIf(!live)("live devin flow", () => {
  it("golden 2: engine worktree edit, project writableRoots, symlink boundary, MCP equality and audit", async () => {
    const ownerHome = process.env.HOME || homedir();
    const ownerConfig = join(ownerHome, ".config/devin/config.json");
    const configBefore = snapshot(ownerConfig);
    const root = realpathSync(mkdtempSync(join(tmpdir(), "stratum-devin-g2-")));
    const repo = join(root, "repo"), extra = join(root, "extra"), outside = join(root, "outside"), target = join(root, "symlink-target");
    const home = join(root, "home"), stateRoot = join(root, "flows");
    const fgRoot = join(home, ".stratum/ts/devin_fg");
    const pids = new Set<number>();
    const abort = new AbortController();
    const inflight = new Set<ReturnType<typeof runner.runAgent>>();
    const dispatches: runner.AgentRunOptions[] = [];
    let client: Client | undefined;
    let server: Awaited<ReturnType<typeof createMcpServer>> | undefined;
    let runId: string | undefined;
    let override: { mockRestore(): void } | undefined;
    const git = (...args: string[]) => {
      const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
      if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
      return result.stdout;
    };
    async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
      const response = await client!.callTool({ name, arguments: args }, undefined, { timeout: 290_000 });
      expect(response.isError, JSON.stringify(response)).not.toBe(true);
      const content = response.content as Array<{ type: string; text?: string }>;
      return JSON.parse(content[0]?.text ?? "") as T;
    }
    try {
      for (const dir of [repo, extra, outside, target, stateRoot, join(home, ".config/devin"), join(home, ".local/share/devin")]) mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (configBefore) writeFileSync(join(root, "config.json.backup"), configBefore.bytes, { mode: 0o600 });
      // Read the owner's credentials/config; all writes, including devin_fg,
      // remain beneath this golden's temporary HOME. Never restore over owner files.
      writeFileSync(join(home, ".local/share/devin/credentials.toml"), readFileSync(join(ownerHome, ".local/share/devin/credentials.toml")), { mode: 0o600 });
      const mcpSource = join(ownerHome, ".config/devin/mcp_config.json");
      let serverNames: string[] = [];
      if (existsSync(mcpSource)) {
        copyFileSync(mcpSource, join(home, ".config/devin/mcp_config.json"));
        const config = JSON.parse(readFileSync(mcpSource, "utf8")) as { mcpServers?: Record<string, unknown> };
        serverNames = Object.keys(config.mcpServers ?? {});
      }
      git("init", "-q"); git("config", "user.name", "stratum-g2"); git("config", "user.email", "stratum-g2@localhost");
      writeFileSync(join(repo, "target.txt"), "before\n");
      writeFileSync(join(repo, "stratum.toml"), `[sandbox]\nwritableRoots = [${JSON.stringify(extra)}]\n`);
      symlinkSync(target, join(repo, "link-out"));
      git("add", "target.txt", "stratum.toml", "link-out"); git("commit", "-qm", "golden 2 base");

      // Flow IR deliberately has no model knob. This pass-through selects the
      // mandated live model and isolated HOME only; defaultConnector still owns
      // sandbox forwarding, and the REAL runner resolves the worktree config,
      // constructs DevinConnector, spawns devin and returns its real result.
      const realRunAgent = runner.runAgent;
      override = vi.spyOn(runner, "runAgent").mockImplementation((options, boundaries) => {
        dispatches.push(options);
        const pending = realRunAgent({ ...options, model: "swe-2-medium",
          env: { ...process.env, HOME: home, STRATUM_PEER_REGISTER: "0" },
          ownProcessGroup: true, signal: abort.signal, onSpawn: pid => { pids.add(pid); },
        }, boundaries);
        inflight.add(pending);
        void pending.then(() => inflight.delete(pending), () => inflight.delete(pending));
        return pending;
      });
      server = await createMcpServer({ flowStateRoot: stateRoot, foregroundRegistryRoot: join(root, "registry") });
      client = new Client({ name: "devin-golden-2", version: "0" });
      const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const prompt = [
        "You are the implementer for an OS sandbox boundary test. Attempt EVERY step exactly once, even after a denial.",
        "Do not work around denials, use sudo, change permissions, or choose alternative targets. Do not commit or stage changes.",
        "Work in your current worktree, using relative paths for target.txt and link-out.",
        "1. Use your file edit tool (NOT shell redirection or sed) to replace target.txt with exactly STRATUM_DEVIN_G2_EDIT followed by a newline. Report G2_EDIT_TOOL OK or FAIL.",
        `2. Use your shell tool to run printf G2_OUTSIDE > ${JSON.stringify(join(outside, "probe.txt"))}. Report G2_OUTSIDE OK or FAIL with the error.`,
        `3. Write G2_EXTRA to ${JSON.stringify(join(extra, "probe.txt"))}. Report G2_EXTRA OK or FAIL.`,
        "4. Use your shell tool to run printf G2_SYMLINK_SHELL > link-out/probe.txt. Report G2_SYMLINK_SHELL OK or FAIL with the error. Separately, use your file edit tool to attempt to write G2_SYMLINK_TOOL through link-out/probe.txt. Report G2_SYMLINK_TOOL OK or FAIL with the error. Attempt both writes exactly once, even after a denial.",
        "5. Call mcp_list_servers. Include its result verbatim in your final message, along with every G2_* report and STRATUM_DEVIN_G2_OK.",
      ].join("\n");
      const planned = await call<{ runId: string }>("stratum_plan", {
        workspaceRoot: repo, input: { items: ["target.txt"] },
        spec: { version: 1, contracts: { Result: { value: "string" } }, flows: { entry: "main", main: {
          input: { items: "string[]" }, output: { from: "${finish.output}", contract: "Result" },
          steps: [
            { id: "fan", fanout: { over: "${input.items}", concurrency: 1, require: "all", merge: "sequential",
              isolation: "worktree", dispatch: "engine", steps: [{ agent: "devin", do: prompt }] } },
            { id: "finish", after: ["fan"], set: { value: '"done"' }, out: "Result" },
          ],
        } } },
      });
      runId = planned.runId;
      const deadline = Date.now() + 260_000;
      let poll = await call<FlowPollResponse>("stratum_flow_poll", { runId, cursor: 0 });
      while (poll.status === "running" && Date.now() < deadline) {
        await delay(100);
        poll = await call<FlowPollResponse>("stratum_flow_poll", { runId, cursor: 0 });
      }
      expect(poll).toMatchObject({ status: "completed" });
      expect(dispatches).toHaveLength(1);
      expect(dispatches[0]).toMatchObject({ agent: "devin", sandboxMode: "workspace-write" });
      expect(dispatches[0]!.cwd).not.toBe(repo);
      // Assert the edit AFTER sequential merge in the original workspace.
      expect(readFileSync(join(repo, "target.txt"), "utf8")).toBe("STRATUM_DEVIN_G2_EDIT\n");
      expect(existsSync(join(outside, "probe.txt"))).toBe(false);
      expect(readFileSync(join(extra, "probe.txt"), "utf8")).toContain("G2_EXTRA");
      expect(readdirSync(target)).toEqual([]);
      const audit = await call<AuditTrail>("stratum_audit", { runId });
      const finalMessage = audit.steps.fan?.fanout?.items[0]?.output;
      expect(typeof finalMessage).toBe("string");
      console.info(`golden 2 devin report:\n${finalMessage as string}`);
      expect(finalMessage).toContain("STRATUM_DEVIN_G2_OK");
      expect(finalMessage).toMatch(/[*`]*G2_EDIT_TOOL[*`]*:?\s*OK/i);
      expect(finalMessage).toMatch(/[*`]*G2_OUTSIDE[*`]*:?\s*FAIL/i);
      expect(finalMessage).toMatch(/[*`]*G2_EXTRA[*`]*:?\s*OK/i);
      expect(finalMessage).toMatch(/[*`]*G2_SYMLINK_SHELL[*`]*:?\s*FAIL/i);
      expect(finalMessage).toMatch(/[*`]*G2_SYMLINK_TOOL[*`]*:?\s*FAIL/i);
      if (serverNames.length) expect(serverNames.some(name => (finalMessage as string).includes(name))).toBe(true);
      else console.info("golden 2: owner mcp_config.json lists no servers; skipping only the server-name assertion");
      expect(audit.events).toEqual(expect.arrayContaining([expect.objectContaining({
        type: "sandbox_policy", stepId: "fan", detail: expect.objectContaining({ itemIndex: 0, stage: 0,
          policy: expect.objectContaining({ filesystemMode: "workspace-write", networkAccess: true, writableRoots: [extra] }),
          provenance: expect.objectContaining({ networkAccess: expect.objectContaining({ layer: "enforced" }),
            writableRoots: expect.objectContaining({ layer: "project" }) }),
        }),
      })]));
      expect(JSON.stringify(audit.steps.fan)).toContain("swe-2-medium");
      expect(git("worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
      expect(readdirSync(fgRoot)).toEqual([]); // Includes every per-run credentials copy.
      expect(pids.size).toBeGreaterThan(0);
      for (const pid of pids) expect(groupMembers(pid)).toBe("");
    } finally {
      try {
        abort.abort();
        // Reap only this golden's groups, including descendants on a failed run.
        for (const pid of pids) {
          if (groupMembers(pid)) { try { process.kill(-pid, "SIGKILL"); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; } }
        }
        await Promise.allSettled([...inflight]);
        if (runId && client) await call("stratum_flow_cancel", { runId });
        const deadline = Date.now() + 5000;
        while ([...pids].some(pid => groupMembers(pid)) && Date.now() < deadline) await delay(50);
        for (const pid of pids) expect(groupMembers(pid)).toBe("");
      } finally {
        try { await client?.close(); } finally {
          try { await server?.close(); } finally {
            override?.mockRestore();
            // The entire run home is ours, including devin_fg, credentials and
            // any peer state. Peer registration is disabled for this foreground golden.
            rmSync(root, { recursive: true, force: true });
            expect(snapshot(ownerConfig)).toEqual(configBefore);
          }
        }
      }
    }
  }, 300_000);
});
