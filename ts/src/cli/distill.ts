import { DistillError, inspectWorkflows, resolveDistillRequest, runDistill } from "../distill/runner.js";
import type { DistillOptions } from "../distill/runner.js";
export async function distillCommand(args: string[]): Promise<number> {
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
