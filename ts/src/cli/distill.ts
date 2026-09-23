import { applyAssetCandidate, revertAssetApply, reconcileAssetApplies, type AssetApplyOptions } from "../distill/apply.js";
import { LEGACY_DISTILL_2_0_LABEL, readCandidates } from "../distill/candidate.js";
import { compare } from "../distill/harvest.js";
import { access, realpath, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { resolve } from "node:path";
import { DistillError, inspectWorkflows, resolveDistillRequest, runDistill } from "../distill/runner.js";
import type { DistillOptions } from "../distill/runner.js";
export async function distillCommand(args: string[]): Promise<number> {
  if (args.length === 1 && args[0] === "--help") { process.stdout.write(HELP); return 0; }
  if (["list", "apply", "revert", "reconcile"].includes(args[0] ?? "")) return assetCommand(args[0]!, args.slice(1));
  try {
    const [action, ...flags] = args;
    if (!["extract", "top", "stats"].includes(action ?? "")) throw new DistillError("invalid_options", "expected extract, top or stats");
    const options: DistillOptions = {};
    let json = false, n = 50;
    const seen = new Set<string>();
    for (let i = 0; i < flags.length; i++) {
      const flag = flags[i]!;
      if (seen.has(flag)) throw new DistillError("invalid_options", "duplicate option");
      seen.add(flag);
      if (flag === "--json") { json = true; continue; }
      if (flag === "--all") { options.all = true; continue; }
      if (!["--root", "--project", "--projects-root", "--min-count", "--window-days", "--n"].includes(flag) || flag === "--n" && action !== "top") throw new DistillError("invalid_options", "unsupported option");
      const value = flags[++i];
      if (!value || value.startsWith("--")) throw new DistillError("invalid_options", "missing option value");
      if (flag === "--root") options.workspaceRoot = value;
      else if (flag === "--project") options.projectDir = value;
      else if (flag === "--projects-root") options.projectsRoot = value;
      else {
        if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new DistillError("invalid_options", "expected integer option");
        if (flag === "--min-count") options.minCount = Number(value);
        else if (flag === "--window-days") options.windowDays = Number(value);
        else { n = Number(value); if (n < 1) throw new DistillError("invalid_options", "--n must be positive"); }
      }
    }
    const request = await resolveDistillRequest(options);
    let output: Record<string, unknown>;
    if (action === "extract") output = { ...await runDistill(request, { write: true }), root_source: request.rootSource };
    else {
      const { workflows, ...inspection } = await inspectWorkflows(request);
      output = { status: "ok", ...inspection, root_source: request.rootSource, evaluated: workflows.length, applied: false,
        ...(action === "top" ? { workflows: workflows.slice(0, n) } : { singletons: workflows.filter(w => w.workflow.kind === "single").length, sequences: workflows.filter(w => w.workflow.kind === "sequence").length }) };
    }
    process.stdout.write(json ? `${JSON.stringify(output)}\n` : `Workspace: ${request.workspaceRoot} (${request.rootSource})\nSources: ${request.projectDirs.join(", ")}\nOutput: ${request.outPath}\n${JSON.stringify(output, null, 2)}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`stratum distill: ${error instanceof DistillError ? error.message : "operation failed"}\n`);
    return error instanceof DistillError && error.errorType === "invalid_options" ? 2 : 1;
  }
}

const HELP = `Usage:
  stratum distill extract [--root <dir>] [--project <dir> | --all --projects-root <dir>] [--min-count <n>] [--window-days <n>] [--json]
  stratum distill top [--root <dir>] [--project <dir> | --all --projects-root <dir>] [--min-count <n>] [--window-days <n>] [--n <n>] [--json]
  stratum distill stats [--root <dir>] [--project <dir> | --all --projects-root <dir>] [--min-count <n>] [--window-days <n>] [--json]
  stratum distill list
  stratum distill apply <revision-id> [--root <dir>] [--trust-source]
  stratum distill revert <apply-id>
  stratum distill reconcile

Asset apply is disabled unless STRATUM_DISTILL_APPLY_ENABLED=1.
--trust-source is required for explicit-project and projects-root revisions.
Agent harnesses can deny Bash(stratum distill apply*) in Claude Code settings.
`;
interface AssetArgs { root?: string; id?: string; trustSource?: true }
function parseAssetArgs(action: string, args: string[]): AssetArgs {
  const parsed: AssetArgs = {}, positional: string[] = [], seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("-")) { positional.push(arg); continue; }
    if (action !== "apply" || !["--root", "--trust-source"].includes(arg)) throw new Error("unsupported option");
    if (seen.has(arg)) throw new Error("duplicate option");
    seen.add(arg);
    if (arg === "--trust-source") parsed.trustSource = true;
    else {
      const value = args[++i];
      if (!value || value.startsWith("-")) throw new Error("missing option value");
      parsed.root = value;
    }
  }
  if (action === "apply" || action === "revert") {
    const pattern = action === "apply" ? /^[0-9a-f]{1,64}$/ : /^[0-9a-f]{32}$/;
    if (positional.length !== 1 || !pattern.test(positional[0]!)) throw new Error(`expected one ${action === "apply" ? "lowercase hexadecimal revision selector (1–64 characters)" : "32-character lowercase hexadecimal apply id"}`);
    parsed.id = positional[0]!;
  } else if (positional.length) throw new Error("unexpected positional argument");
  return parsed;
}
async function assetCommand(action: string, args: string[]): Promise<number> {
  let parsed: AssetArgs;
  try { parsed = parseAssetArgs(action, args); }
  catch (error) { process.stderr.write(`stratum distill: ${(error as Error).message}\n${HELP}`); return 2; }
  try {
    const applyRoot = await realpath(resolve(parsed.root ?? process.cwd()));
    if (!(await stat(applyRoot)).isDirectory()) throw new Error("apply root must be an existing directory");
    await access(applyRoot, constants.R_OK | constants.X_OK);
    if (action === "list" || action === "apply") {
      const { candidates, legacyRows } = await readCandidates(applyRoot);
      const rows = [...candidates, ...legacyRows].sort((a, b) => compare(a.revisionId, b.revisionId));
      if (action === "list") {
        if (!rows.length) process.stdout.write("no staged candidates (run: stratum distill extract)\n");
        for (const row of rows) process.stdout.write(`${row.revisionId.slice(0, 12)}  ${row.targetKind}  ${row.assetName}  ${row.schemaVersion === "distill-2.0" ? LEGACY_DISTILL_2_0_LABEL : row.schemaVersion}\n`);
        return 0;
      }
      const matches = rows.filter(row => row.revisionId.startsWith(parsed.id!));
      if (!matches.length) throw new Error(`no staged revision matching ${parsed.id}`);
      if (matches.length > 1) {
        process.stderr.write(`ambiguous revision ${parsed.id} matches ${matches.length} candidates: ${matches.map(row => row.revisionId.slice(0, 12)).join(", ")}\n`);
        return 2;
      }
      const candidate = matches[0]!;
      if (candidate.schemaVersion === "distill-2.0") throw new Error(`revision ${candidate.revisionId} is schema distill-2.0; not apply-eligible, re-run extract`);
      const options: AssetApplyOptions = { applyRoot, ...(parsed.trustSource ? { trustSource: true } : {}) };
      const result = await applyAssetCandidate(candidate, options);
      process.stdout.write(`applied ${result.applyId} -> ${result.targetPath}\n`);
    } else if (action === "revert") {
      await revertAssetApply(parsed.id!, applyRoot, {});
      process.stdout.write(`reverted ${parsed.id}\ndescendants: 0\n`);
    } else {
      const report = await reconcileAssetApplies(applyRoot, {});
      process.stdout.write(`completed ${report.completed}, rolled back ${report.rolledBack}, reverted ${report.reverted}, diverged ${report.diverged}\n`);
      return report.diverged > 0 ? 1 : 0;
    }
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
