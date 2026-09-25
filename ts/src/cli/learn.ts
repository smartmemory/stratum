import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { harvest } from "../learn/harvest.js";
import { classify } from "../learn/classify.js";
import {
  appendCandidates,
  authorCandidate,
  latestPerCluster,
  readCandidates,
  type PatchCandidate,
} from "../learn/candidate.js";
import { applyCandidate, reconcile, revertApply } from "../learn/apply.js";
import { LearnEgress } from "../learn/smartmemory_egress.js";
import { StateStore } from "../engine/state.js";
import { lockedSave, lockedRead } from "../engine/run_lock.js";

const USAGE =
  "Usage: stratum learn <harvest|list|apply|revert|reconcile|egress> [--root <dir>] [--stage] [--json]\n" +
  "       stratum learn egress <drain [--run <id>]|verify --run <id>|retry-dead --run <id>>";

function flag(args: string[], name: string): boolean {
  return args.includes(`--${name}`);
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

function rootOf(args: string[]): string {
  return resolve(option(args, "root") ?? process.cwd());
}

function sidecarDir(root: string): string {
  return join(root, ".stratum", "learn");
}

export async function learnCommand(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case "harvest":
      return harvestCommand(rest);
    case "list":
      return listCommand(rest);
    case "apply":
      return applyCommandLine(rest);
    case "revert":
      return revertCommand(rest);
    case "reconcile":
      return reconcileCommand(rest);
    case "egress":
      return egressCommand(rest);
    default:
      process.stderr.write(`${USAGE}\n`);
      return 2;
  }
}

async function harvestCommand(args: string[]): Promise<number> {
  const root = rootOf(args);
  const flowsDir = option(args, "flows") ?? join(homedir(), ".stratum", "ts", "flows");
  const { records, skipped, droppedEvents } = await harvest(flowsDir);
  const clusters = classify(records);

  const candidates: PatchCandidate[] = [];
  const problems: string[] = [];
  for (const cluster of clusters) {
    if (cluster.class !== "durable" || !cluster.applyEligible) continue;
    if (cluster.scope.workspaceRoot !== root) continue;
    try {
      candidates.push(authorCandidate(cluster));
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }

  // Staging writes a file, so it is opt-in: a plain harvest only reports.
  const staged = flag(args, "stage") ? await appendCandidates(sidecarDir(root), candidates) : 0;

  if (flag(args, "json")) {
    process.stdout.write(
      JSON.stringify({ records: records.length, skipped, droppedEvents, clusters: clusters.length, candidates, staged }, null, 2) + "\n",
    );
    return 0;
  }

  const durable = clusters.filter((c) => c.class === "durable").length;
  process.stdout.write(
    `${records.length} failure records (${skipped} runs skipped, ${droppedEvents} events dropped)\n` +
      `${clusters.length} clusters, ${durable} durable, ${candidates.length} for this project\n`,
  );
  for (const candidate of candidates) {
    process.stdout.write(`\n${candidate.rendered.content}\n`);
    if (candidate.requiresHumanAction) {
      process.stdout.write("  (needs a human: the fix target is a spec, which this never edits)\n");
    }
  }
  if (problems.length > 0) process.stdout.write(`\nskipped ${problems.length} cluster(s): ${problems.join("; ")}\n`);
  if (flag(args, "stage")) process.stdout.write(`\nstaged ${staged} new candidate(s)\n`);
  else if (candidates.length > 0) process.stdout.write("\nre-run with --stage to record these\n");
  return 0;
}

async function listCommand(args: string[]): Promise<number> {
  const root = rootOf(args);
  const rows = latestPerCluster(await readCandidates(sidecarDir(root)));
  if (flag(args, "json")) {
    process.stdout.write(JSON.stringify(rows, null, 2) + "\n");
    return 0;
  }
  if (rows.length === 0) {
    process.stdout.write("no staged candidates (run: stratum learn harvest --stage)\n");
    return 0;
  }
  for (const row of rows) {
    process.stdout.write(`${row.revisionId.slice(0, 12)}  ${row.claim}${row.rendered.guidance === undefined ? "  (note only)" : ""}\n`);
  }
  return 0;
}

async function applyCommandLine(args: string[]): Promise<number> {
  const root = rootOf(args);
  const revision = args.find((arg) => !arg.startsWith("--") && arg !== option(args, "root"));
  if (revision === undefined) {
    process.stderr.write("Usage: stratum learn apply <revision-id> [--root <dir>]\n");
    return 2;
  }
  const matches = (await readCandidates(sidecarDir(root))).filter((row) =>
    row.revisionId.startsWith(revision),
  );
  if (matches.length === 0) {
    process.stderr.write(`no staged candidate matching ${revision}\n`);
    return 1;
  }
  if (matches.length > 1) {
    // Applying "one of them" is how the wrong lesson gets written.
    process.stderr.write(
      `ambiguous revision ${revision} matches ${matches.length} candidates: ` +
        `${matches.map((m) => m.revisionId.slice(0, 12)).join(", ")}\n`,
    );
    return 2;
  }
  const candidate = matches[0]!;
  try {
    const applied = await applyCandidate(candidate, {});
    process.stdout.write(`applied ${applied.applyId} -> ${applied.targetPath}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function revertCommand(args: string[]): Promise<number> {
  const root = rootOf(args);
  const applyId = args.find((arg) => !arg.startsWith("--") && arg !== option(args, "root"));
  if (applyId === undefined) {
    process.stderr.write("Usage: stratum learn revert <apply-id> [--root <dir>]\n");
    return 2;
  }
  try {
    await revertApply(applyId, root, {});
    process.stdout.write(`reverted ${applyId}\n`);
    return 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function reconcileCommand(args: string[]): Promise<number> {
  try {
    const report = await reconcile(rootOf(args), {});
    process.stdout.write(
      `completed ${report.completed}, rolled back ${report.rolledBack}, diverged ${report.diverged}\n`,
    );
    return report.diverged > 0 ? 1 : 0;
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

async function egressCommand(args: string[]): Promise<number> {
  const [action, ...rest] = args;
  const runId = option(rest, "run");
  const store = new StateStore(process.env.STRATUM_STATE_ROOT || undefined);
  // R3-3c: this used to be a private Map-of-promises lock, local to one CLI invocation, so
  // `stratum learn egress` mutating a run record excluded nothing — not another
  // `stratum learn`, and certainly not a running engine. It takes the real cross-process lock.
  const egress = new LearnEgress({
    store,
    // F3: `lockedSave` is now lease-aware and refuses a cancelled run, so a CLI egress can no
    // longer revert a live driver's receipts or rewrite a settled record. Reads go through
    // `lockedRead`, which takes the same lock and saves nothing.
    withReceiptUpdate: (id, update) => lockedSave(store, id, update),
    withReceiptRead: (id, read) => lockedRead(store, id, read),
  });

  try {
    switch (action) {
      case "drain":
        if (runId === undefined) {
          await egress.drainAll();
          process.stdout.write("SmartMemory egress drain complete\n");
        } else {
          await egress.drainRun(runId);
          process.stdout.write(`SmartMemory egress drain complete for ${runId}\n`);
        }
        return 0;
      case "verify": {
        if (runId === undefined) return egressUsage("verify requires --run <id>");
        const report = await egress.verifyRun(runId);
        process.stdout.write(
          `${runId}: missing ${report.missingCount}, duplicates ${report.duplicateCount}, wrong-type ${report.wrongTypeCount}, dead ${report.deadCount}\n`,
        );
        return report.missingCount > 0 ? 1 : 0;
      }
      case "retry-dead": {
        if (runId === undefined) return egressUsage("retry-dead requires --run <id>");
        const retried = await egress.retryDead(runId);
        process.stdout.write(`${runId}: retried ${retried} dead receipt(s)\n`);
        return 0;
      }
      default:
        return egressUsage();
    }
  } catch (error) {
    process.stderr.write(`stratum learn egress: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  } finally {
    await egress.close();
  }
}

function egressUsage(problem?: string): number {
  if (problem !== undefined) process.stderr.write(`stratum learn egress: ${problem}\n`);
  process.stderr.write("Usage: stratum learn egress <drain [--run <id>]|verify --run <id>|retry-dead --run <id>>\n");
  return 2;
}
