import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, basename, relative, resolve, sep } from "node:path";
import { appendCandidates, sidecarPath } from "./candidate.js";
import type { AssetCandidate, SourceMode } from "./candidate.js";
import { detect } from "./detector.js";
import type { WorkflowCandidate } from "./detector.js";
import { compare, integer, loadSessions, missing } from "./harvest.js";
import type { HarvestDiagnostics } from "./harvest.js";
import { synthesize } from "./synthesize.js";
export class DistillError extends Error {
  readonly errorType: "invalid_options" | "source_read_error" | "candidate_error" | "staging_error";
  constructor(type: DistillError["errorType"], message: string) { super(message); this.errorType = type; }
}
export interface DistillOptions { workspaceRoot?: string; projectDir?: string; all?: boolean; projectsRoot?: string; minCount?: number; windowDays?: number; cwd?: string }
export interface ResolvedDistillRequest { workspaceRoot: string; projectDirs: string[]; sourceMode: SourceMode; minCount: number; windowDays: number; outPath: string; rootSource: "explicit" | "git" | "cwd" }
export interface DistillDiagnostics extends HarvestDiagnostics { malformedRows: number; unsupportedRows: number; authoringSkipped: number }
export interface DistillInspection { workflows: WorkflowCandidate[]; workspace_root: string; project_dirs: string[]; out_path: string; diagnostics: DistillDiagnostics }
export interface DistillResult extends Omit<DistillInspection, "workflows"> { status: "ok"; candidates: AssetCandidate[]; evaluated: number; written: number; reason: string; applied: false }
const invalid = (message: string): never => { throw new DistillError("invalid_options", message); };
async function sourcePath(path: string): Promise<string> {
  try { return await realpath(path); } catch (error) { if (missing(error)) return resolve(path); throw new DistillError("source_read_error", "cannot resolve transcript source"); }
}
/** Encoded names are only a discovery hint; cwd attribution below resolves collisions. */
async function workspaceProjects(root: string): Promise<string[]> {
  const projectsRoot = join(homedir(), ".claude", "projects");
  const encode = (path: string) => path.replace(/\//g, "-");
  const ancestors = new Set<string>();
  for (let path = dirname(root); ; path = dirname(path)) {
    ancestors.add(encode(path));
    if (dirname(path) === path) break;
  }
  try {
    const entries = await readdir(projectsRoot, { withFileTypes: true });
    const encodedRoot = encode(root);
    return entries.filter(e => e.isDirectory() && !e.isSymbolicLink()
      && (e.name === encodedRoot || e.name.startsWith(`${encodedRoot}-`) || ancestors.has(e.name)))
      .map(e => join(projectsRoot, e.name)).sort(compare);
  } catch (error) {
    if (missing(error)) return [];
    throw new DistillError("source_read_error", "cannot enumerate transcript projects");
  }
}
function cwdInside(root: string, cwd: string): boolean {
  if (!isAbsolute(cwd)) return false;
  const path = relative(root, cwd);
  return path === "" || path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
}
export async function resolveDistillRequest(options: DistillOptions): Promise<ResolvedDistillRequest> {
  const minCount = options.minCount ?? 2, windowDays = options.windowDays ?? 30;
  if (!integer(minCount, 1) || !integer(windowDays, 0)) invalid("minCount must be positive and windowDays nonnegative integers");
  if (options.all && options.projectDir !== undefined || options.projectsRoot !== undefined && !options.all || options.all && !options.projectsRoot) invalid("--all requires --projects-root and excludes --project");
  for (const path of [options.workspaceRoot, options.projectDir, options.projectsRoot]) if (path !== undefined && (typeof path !== "string" || !path.trim())) invalid("paths must be nonempty");
  let root = options.workspaceRoot, rootSource: ResolvedDistillRequest["rootSource"] = "explicit";
  const cwd = options.cwd ?? process.cwd();
  if (root === undefined) {
    try { root = (await promisify(execFile)("git", ["-C", cwd, "rev-parse", "--show-toplevel"])).stdout.trim(); rootSource = "git"; }
    catch { root = cwd; rootSource = "cwd"; }
  }
  try { root = await realpath(resolve(cwd, root)); if (!(await stat(root)).isDirectory()) invalid("workspace root must be an existing directory"); }
  catch { invalid("workspace root must be an existing directory"); }
  let projectDirs: string[];
  let sourceMode: SourceMode;
  if (options.all) {
    sourceMode = "projects-root";
    const projectsRoot = await sourcePath(resolve(cwd, options.projectsRoot!));
    try {
      const entries = await readdir(projectsRoot, { withFileTypes: true });
      projectDirs = entries.filter(e => e.isDirectory() && !e.isSymbolicLink()).map(e => join(projectsRoot, e.name)).sort(compare);
    } catch (error) { if (missing(error)) projectDirs = []; else throw new DistillError("source_read_error", "cannot enumerate transcript projects"); }
  } else if (options.projectDir !== undefined) {
    sourceMode = "explicit-project";
    projectDirs = [await sourcePath(resolve(cwd, options.projectDir))];
  } else {
    sourceMode = "workspace";
    projectDirs = await workspaceProjects(root);
  }
  return { workspaceRoot: root, projectDirs, sourceMode, minCount, windowDays, outPath: sidecarPath(root), rootSource };
}
export async function inspectWorkflows(request: ResolvedDistillRequest): Promise<DistillInspection> {
  const diagnostics: DistillDiagnostics = { sessions: 0, skippedFiles: 0, droppedLines: 0, droppedEvents: 0, mtimeFailures: 0, malformedRows: 0, unsupportedRows: 0, authoringSkipped: 0 };
  const workflows: WorkflowCandidate[] = [];
  const projectDirs: string[] = [], seenSessions = new Set<string>();
  // Prefer the canonical repo source when the same session was copied between projects.
  const canonicalName = request.workspaceRoot.replace(/\//g, "-");
  const sources = [...new Set(request.projectDirs)].sort((a, b) => request.sourceMode === "workspace"
    ? Number(basename(b) === canonicalName) - Number(basename(a) === canonicalName) || compare(a, b)
    : compare(a, b));
  for (const projectDir of sources) {
    try {
      const loaded = await loadSessions(projectDir, { windowDays: request.windowDays });
      for (const key of Object.keys(loaded.diagnostics) as Array<keyof HarvestDiagnostics>) diagnostics[key] += loaded.diagnostics[key];
      const sessions = request.sourceMode === "workspace" ? loaded.sessions.filter(session => {
        if (!session.observedCwds.some(cwd => cwdInside(request.workspaceRoot, cwd)) || seenSessions.has(session.sessionId)) return false;
        seenSessions.add(session.sessionId);
        return true;
      }) : loaded.sessions;
      diagnostics.sessions -= loaded.sessions.length - sessions.length;
      if (request.sourceMode !== "workspace" || sessions.length) projectDirs.push(projectDir);
      workflows.push(...detect(sessions, { minCount: request.minCount }));
    } catch { throw new DistillError("source_read_error", "cannot read transcript source"); }
  }
  return { workflows, workspace_root: request.workspaceRoot, project_dirs: projectDirs.sort(compare), out_path: request.outPath, diagnostics };
}
export async function runDistill(request: ResolvedDistillRequest, options: { write: boolean } = { write: true }): Promise<DistillResult> {
  const { workflows, ...inspection } = await inspectWorkflows(request);
  const candidates: AssetCandidate[] = [];
  try {
    for (const workflow of workflows) {
      const candidate = synthesize(workflow, { workspaceRoot: request.workspaceRoot, sourceMode: request.sourceMode, minCount: request.minCount });
      if (candidate) candidates.push(candidate); else inspection.diagnostics.authoringSkipped++;
    }
  } catch { throw new DistillError("candidate_error", "cannot author distill candidate"); }
  let written = 0;
  if (options.write && candidates.length) {
    try { const result = await appendCandidates(request.workspaceRoot, candidates); written = result.written; inspection.diagnostics.malformedRows = result.malformedRows; inspection.diagnostics.unsupportedRows = result.unsupportedRows; }
    catch { throw new DistillError("staging_error", "cannot stage distill candidates"); }
  }
  const reason = !inspection.diagnostics.sessions ? "nothing to distill: empty corpus" : !workflows.length ? "nothing to distill: no recurrence" : !candidates.length ? "no authorable workflows" : !options.write ? "preview" : written ? "staged drafts requiring review" : "already staged";
  return { status: "ok", ...inspection, candidates, evaluated: workflows.length, written, reason, applied: false };
}
/** Stateless wire adapter; public registration remains contract-driven. */
export async function distillTool(request: Record<string, unknown>): Promise<Record<string, unknown>> {
  const wire: Record<string, string> = { workspace_root: "string", project_dir: "string", min_count: "number", window_days: "number", write: "boolean" };
  if (Object.entries(request).some(([k, v]) => !wire[k] || typeof v !== wire[k]) || typeof request.workspace_root !== "string") throw new Error("invalid stratum_distill request shape");
  try {
    if (!request.workspace_root.trim() || !isAbsolute(request.workspace_root) || request.project_dir !== undefined && (!(request.project_dir as string).trim() || !isAbsolute(request.project_dir as string))) invalid("MCP paths must be nonempty absolute paths");
    const options: DistillOptions = { workspaceRoot: request.workspace_root };
    if (request.project_dir !== undefined) options.projectDir = request.project_dir as string;
    if (request.min_count !== undefined) options.minCount = request.min_count as number;
    if (request.window_days !== undefined) options.windowDays = request.window_days as number;
    return { ...await runDistill(await resolveDistillRequest(options), { write: request.write === undefined ? true : request.write as boolean }) };
  } catch (error) {
    if (error instanceof DistillError) return { status: "error", error_type: error.errorType, message: error.message };
    throw error;
  }
}
