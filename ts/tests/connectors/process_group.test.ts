import { spawn, execFileSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";
import { killGroup, psGroupStates, type GroupDeps } from "../../src/connectors/process_group.js";

const errno = (code: string) => Object.assign(new Error(`kill ${code}`), { code });

// One row per errno/state. `kill` is what the OS answers for kill(-pgid, sig); `states` is ps.
const rows: Array<{ name: string; kill?: string; states?: string[] | undefined; outcome: "ok" | "ESRCH" | "EPERM" }> = [
  { name: "success", outcome: "ok" },
  { name: "ESRCH", kill: "ESRCH", outcome: "ESRCH" },
  { name: "EPERM, group only zombies", kill: "EPERM", states: ["Z", "Z+"], outcome: "ESRCH" },
  { name: "EPERM, group empty by the time ps ran", kill: "EPERM", states: [], outcome: "ESRCH" },
  { name: "EPERM, live member beside a zombie", kill: "EPERM", states: ["Z", "S"], outcome: "EPERM" },
  { name: "EPERM, live member", kill: "EPERM", states: ["R+"], outcome: "EPERM" },
  { name: "EPERM, ps unreadable (fails closed)", kill: "EPERM", states: undefined, outcome: "EPERM" },
  { name: "other errno is untouched", kill: "EINVAL", outcome: "EPERM" },
];

describe("killGroup errno handling (STRAT-CANCEL-EPERM-1)", () => {
  for (const row of rows) {
    it(row.name, () => {
      const deps: GroupDeps = {
        kill: () => { if (row.kill) throw errno(row.kill); },
        groupStates: () => row.states,
      };
      if (row.outcome === "ok") return expect(() => killGroup(1234, "SIGTERM", deps)).not.toThrow();
      let caught: NodeJS.ErrnoException | undefined;
      try { killGroup(1234, "SIGTERM", deps); } catch (error) { caught = error as NodeJS.ErrnoException; }
      expect(caught).toBeDefined();
      // "EPERM" for the live rows means the original error is rethrown unchanged (code preserved).
      expect(caught!.code).toBe(row.outcome === "EPERM" ? row.kill : "ESRCH");
    });
  }

  it.runIf(process.platform === "darwin")("real zombie-only group: raw kill is EPERM, killGroup says ESRCH", async () => {
    const child = spawn("sleep", ["100"], { detached: true, stdio: "ignore" });
    const pid = child.pid!;
    process.kill(-pid, "SIGKILL");
    // Block the event loop so Node cannot reap the child, leaving a zombie.
    const until = Date.now() + 300; while (Date.now() < until) { /* spin */ }
    try {
      expect(execFileSync("ps", ["-o", "stat=", "-p", String(pid)], { encoding: "utf8" }).trim()).toMatch(/^Z/);
      expect(psGroupStates(pid)!.every((s) => s.startsWith("Z"))).toBe(true);
      expect(() => process.kill(-pid, 0)).toThrow(/EPERM/);
      expect(() => killGroup(pid, 0)).toThrow(/ESRCH/);
      expect(() => killGroup(pid, "SIGTERM")).toThrow(/ESRCH/);
    } finally { await delay(50); }
  });

  it("a live group is signalable and a live non-zombie probe succeeds", async () => {
    const child = spawn("sleep", ["100"], { detached: true, stdio: "ignore" });
    try {
      expect(() => killGroup(child.pid!, 0)).not.toThrow();
      expect(psGroupStates(child.pid!)!.some((s) => !s.startsWith("Z"))).toBe(true);
    } finally { process.kill(-child.pid!, "SIGKILL"); await new Promise((r) => child.once("close", r)); }
  });
});
