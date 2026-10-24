import { execFileSync } from "node:child_process";

/** STRAT-CANCEL-EPERM-1. On macOS, `kill(-pgid, sig)` fails with EPERM (not ESRCH) when every
 *  remaining member of the group is an exited, unreaped zombie, while `kill(pid, 0)` on the same
 *  zombie succeeds. A group like that is already terminated, so EPERM from a group signal or probe
 *  is "gone" only when the group's members are all zombies (or none are left); a genuine EPERM on a
 *  live member stays an error. */
export interface GroupDeps {
  kill: (pid: number, signal: NodeJS.Signals | 0) => void;
  /** `ps` state column of every process in the group; undefined when it cannot be read. */
  groupStates: (pgid: number) => string[] | undefined;
}

export function psGroupStates(pgid: number): string[] | undefined {
  try {
    const out = execFileSync("ps", ["-axo", "pgid=,stat="], { encoding: "utf8", timeout: 2000, stdio: ["ignore", "pipe", "ignore"] });
    const states: string[] = [];
    for (const line of out.split("\n")) {
      const [group, stat] = line.trim().split(/\s+/);
      if (Number(group) === pgid && stat) states.push(stat);
    }
    return states;
  } catch { return undefined; }
}

const REAL: GroupDeps = { kill: (pid, signal) => { process.kill(pid, signal); }, groupStates: psGroupStates };

/** True only for a positively verified zombie-only (or empty) group. An unreadable `ps` is false. */
export function groupIsZombieOnly(pgid: number, deps: Pick<GroupDeps, "groupStates"> = REAL): boolean {
  const states = deps.groupStates(pgid);
  return states !== undefined && states.every((stat) => stat.startsWith("Z"));
}

/** Signal (or probe with 0) a process group. ESRCH, and EPERM on a verified zombie-only group, both
 *  throw an ESRCH-coded error (the "already terminated" answer callers already handle); any other
 *  failure, including EPERM on a live group, is rethrown unchanged. */
export function killGroup(pid: number, signal: NodeJS.Signals | 0, deps: GroupDeps = REAL): void {
  try { deps.kill(-pid, signal); }
  catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "EPERM" && groupIsZombieOnly(pid, deps)) {
      throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH", errno: -3, syscall: "kill" });
    }
    throw error;
  }
}
