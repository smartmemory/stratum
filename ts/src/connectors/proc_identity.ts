import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

interface LinuxStat {
  startTime: string;
  processGroupId: number;
}

const DARWIN_PROC_INFO = String.raw`
import ctypes,json,sys
class I(ctypes.Structure):
 _fields_=[('pbi_flags',ctypes.c_uint32),('pbi_status',ctypes.c_uint32),('pbi_xstatus',ctypes.c_uint32),('pbi_pid',ctypes.c_uint32),('pbi_ppid',ctypes.c_uint32),('pbi_uid',ctypes.c_uint32),('pbi_gid',ctypes.c_uint32),('pbi_ruid',ctypes.c_uint32),('pbi_rgid',ctypes.c_uint32),('pbi_svuid',ctypes.c_uint32),('pbi_svgid',ctypes.c_uint32),('rfu_1',ctypes.c_uint32),('pbi_comm',ctypes.c_char*16),('pbi_name',ctypes.c_char*32),('pbi_nfiles',ctypes.c_uint32),('pbi_pgid',ctypes.c_uint32),('pbi_pjobc',ctypes.c_uint32),('e_tdev',ctypes.c_uint32),('e_tpgid',ctypes.c_int32),('pbi_nice',ctypes.c_int32),('pbi_start_tvsec',ctypes.c_uint64),('pbi_start_tvusec',ctypes.c_uint64)]
i=I(); r=ctypes.CDLL('libproc.dylib').proc_pidinfo(int(sys.argv[1]),3,0,ctypes.byref(i),ctypes.sizeof(i))
print(json.dumps({'start':f'{i.pbi_start_tvsec}.{i.pbi_start_tvusec}','pgid':i.pbi_pgid}) if r==ctypes.sizeof(i) and i.pbi_start_tvsec else '')
`;

async function darwinStat(pid: number): Promise<LinuxStat | undefined> {
  try {
    // Node has no libproc binding. This is the exact PROC_PIDTBSDINFO query used
    // by the Python source contract; /usr/bin/python3 is present on supported
    // development Macs. ps remains a compatibility fallback below.
    const { stdout } = await execFileAsync("/usr/bin/python3", ["-c", DARWIN_PROC_INFO, String(pid)], { timeout: 5_000 });
    const value: unknown = JSON.parse(stdout.trim());
    if (typeof value !== "object" || value === null) return undefined;
    const { start, pgid } = value as { start?: unknown; pgid?: unknown };
    return typeof start === "string" && start && Number.isSafeInteger(pgid) && Number(pgid) > 0
      ? { startTime: start, processGroupId: Number(pgid) }
      : undefined;
  } catch {
    return undefined;
  }
}

async function linuxStat(pid: number): Promise<LinuxStat | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  let value: string;
  try { value = await readFile(`/proc/${pid}/stat`, "utf8"); } catch { return undefined; }
  const close = value.lastIndexOf(")");
  if (close < 0) return undefined;
  const fields = value.slice(close + 2).trim().split(/\s+/);
  const processGroupId = Number(fields[2]); // rest[0] is field 3; pgrp is field 5.
  const startTime = fields[19]; // starttime is field 22.
  if (!startTime || !Number.isSafeInteger(processGroupId) || processGroupId <= 0) return undefined;
  return { startTime, processGroupId };
}

export async function procStartTime(pid: number): Promise<string | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  if (process.platform === "linux") return (await linuxStat(pid))?.startTime;
  if (process.platform === "darwin") {
    // Fail closed like the Python reference: `ps -o lstart` has only second
    // precision, too coarse to gate a killpg — no fallback when libproc is
    // unreachable; the run is then treated as dead and never signalled.
    return (await darwinStat(pid))?.startTime;
  }
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "lstart=", "-p", String(pid)], { timeout: 5_000 });
    return stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function processGroupId(pid: number): Promise<number | undefined> {
  if (!Number.isSafeInteger(pid) || pid <= 0) return undefined;
  if (process.platform === "linux") return (await linuxStat(pid))?.processGroupId;
  if (process.platform === "darwin") return (await darwinStat(pid))?.processGroupId;
  try {
    const { stdout } = await execFileAsync("ps", ["-o", "pgid=", "-p", String(pid)], { timeout: 5_000 });
    const value = Number(stdout.trim());
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function processIdentityMatches(pid: number, expectedStartTime: string | undefined): Promise<boolean> {
  if (!expectedStartTime) return false;
  return (await procStartTime(pid)) === expectedStartTime;
}
