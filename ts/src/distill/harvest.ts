import { createHash } from "node:crypto";
import { readdir, readFile, realpath, lstat, stat } from "node:fs/promises";
import { join } from "node:path";

export interface TranscriptHandle { projectDir: string; sessionId: string; transcriptFile: string; lineNo: number; blockIndex: number }
export interface ToolObservation { toolName: string; input: Record<string, unknown>; lineNo: number; blockIndex: number; toolUseId: string | null; cwd: string | null; lineDigest: string }
export interface TranscriptSession { projectDir: string; sessionId: string; transcriptFile: string; observedCwds: string[]; observations: ToolObservation[] }
export interface HarvestDiagnostics { sessions: number; skippedFiles: number; droppedLines: number; droppedEvents: number; mtimeFailures: number }
export const compare = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
export const digest = (bytes: string | Buffer): string => createHash("sha256").update(bytes).digest("hex");
export const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
export const missing = (error: unknown): boolean => (error as NodeJS.ErrnoException).code === "ENOENT";
export function integer(value: number, minimum: number): boolean { return Number.isSafeInteger(value) && value >= minimum; }

/** Narrow, read-only Claude reader. Digests bind original line bytes, excluding the LF or CRLF terminator. */
export async function loadSessions(projectDir: string, options: { windowDays?: number; nowMs?: number } = {}): Promise<{ sessions: TranscriptSession[]; diagnostics: HarvestDiagnostics }> {
  const windowDays = options.windowDays ?? 30;
  if (!integer(windowDays, 0) || !Number.isFinite(options.nowMs ?? Date.now())) throw new Error("invalid transcript window");
  const diagnostics: HarvestDiagnostics = { sessions: 0, skippedFiles: 0, droppedLines: 0, droppedEvents: 0, mtimeFailures: 0 };
  const sessions: TranscriptSession[] = [];
  let names: string[];
  try { projectDir = await realpath(projectDir); names = await readdir(projectDir); }
  catch (error) { if (missing(error)) return { sessions, diagnostics }; throw new Error("cannot enumerate transcript source"); }
  for (const name of names.sort(compare).filter(name => name.endsWith(".jsonl"))) {
    const path = join(projectDir, name);
    let bytes: Buffer;
    try {
      const entry = await lstat(path);
      if (!entry.isFile() || entry.isSymbolicLink()) { diagnostics.skippedFiles++; continue; }
      if (await realpath(path) !== path) { diagnostics.skippedFiles++; continue; }
      if (windowDays) {
        try { if ((await stat(path)).mtimeMs < (options.nowMs ?? Date.now()) - windowDays * 86_400_000) continue; }
        catch { diagnostics.mtimeFailures++; }
      }
      bytes = await readFile(path);
    } catch { diagnostics.skippedFiles++; continue; }
    const observations: ToolObservation[] = [];
    let start = 0;
    let lineNo = 0;
    for (let end = 0; end <= bytes.length; end++) {
      if (end !== bytes.length && bytes[end] !== 10) continue;
      const raw = bytes.subarray(start, end > start && bytes[end - 1] === 13 && bytes[end] === 10 ? end - 1 : end);
      start = end + 1; lineNo++;
      if (!raw.toString("utf8").trim()) continue;
      let row: unknown;
      try { row = JSON.parse(raw.toString("utf8")); } catch { diagnostics.droppedLines++; continue; }
      if (!isRecord(row)) { diagnostics.droppedLines++; continue; }
      if (row.isSidechain || row.type !== "assistant") continue;
      if (!isRecord(row.message) || !Array.isArray(row.message.content)) { diagnostics.droppedLines++; continue; }
      for (const [blockIndex, block] of row.message.content.entries()) {
        if (!isRecord(block) || block.type !== "tool_use") continue;
        if (typeof block.name !== "string" || !/^[A-Za-z][A-Za-z0-9_.:-]*$/.test(block.name)) { diagnostics.droppedEvents++; continue; }
        if (!isRecord(block.input)) diagnostics.droppedEvents++;
        observations.push({ toolName: block.name, input: isRecord(block.input) ? block.input : {}, lineNo, blockIndex,
          toolUseId: typeof block.id === "string" ? block.id : null, cwd: typeof row.cwd === "string" && row.cwd ? row.cwd : null, lineDigest: digest(raw) });
      }
    }
    sessions.push({ projectDir, sessionId: name.slice(0, -6), transcriptFile: name,
      observedCwds: [...new Set(observations.flatMap(o => o.cwd === null ? [] : [o.cwd]))].sort(compare), observations });
  }
  diagnostics.sessions = sessions.length;
  return { sessions, diagnostics };
}
