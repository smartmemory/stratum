import { join } from "node:path";
import { canonicalizeRecordRoots, canonicalWorkspace } from "../learn/workspace.js";
import { resolveLearnConfig } from "../config/learn.js";
import { unreviewedLessons, type UnreviewedLesson } from "../learn/unreviewed.js";
import { lessonReviews } from "../learn/outcomes.js";
import { appendLifecycle, LifecycleError, type LifecycleKind, type LifecycleRow, type ReviewKind } from "../learn/lifecycle.js";
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
  "       stratum learn list --unreviewed [--json] [--if-enabled] [--root <dir>]\n" +
  "       stratum learn list --reviews [--json] [--if-enabled] [--flows <dir>] [--root <dir>]\n" +
  "       stratum learn retire <clusterId> --reason <text> (--fix-ref <sha> | --withdrawn) [--root <dir>]\n" +
  "       stratum learn <dismiss|reactivate> <clusterId> --reason <text> [--root <dir>]\n" +
  "       stratum learn ack <clusterId> --reason <text> [--kind <review>] [--root <dir>]\n" +
  "       stratum learn egress <drain [--run <id>]|verify --run <id>|retry-dead --run <id>>";

function flag(args: string[], name: string): boolean {
  return args.includes(`--${name}`);
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

function rootOf(args: string[]): Promise<string> {
  return canonicalWorkspace(option(args, "root") ?? process.cwd());
}

/** `--flows`, else the store the engine and MCP server use (STRATUM_STATE_ROOT, then the default). */
function flowsDirOf(args: string[]): string {
  return option(args, "flows") ?? (process.env.STRATUM_STATE_ROOT || new StateStore().root);
}

function sidecarDir(root: string): string {
  return join(root, ".stratum", "learn");
}

export async function learnCommand(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;
  switch (subcommand) {
    case "retire":
    case "dismiss":
    case "reactivate":
    case "ack":
      return lifecycleCommand(subcommand, rest);
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
  const root = await rootOf(args);
  const flowsDir = flowsDirOf(args);
  const { records, skipped, droppedEvents } = await harvest(flowsDir);
  await canonicalizeRecordRoots(records);
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
  const staged = flag(args, "stage") ? await appendCandidates(root, candidates) : 0;

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
  const root = await rootOf(args);
  if (flag(args, "unreviewed")) return listUnreviewed(root, args);
  if (flag(args, "reviews")) return listReviews(root, args);
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

/**
 * INLINE-TS-1 §A5. `--if-enabled` prints nothing when `[learn] inline` is OFF for this root
 * (Compose calls it at every build exit); without it, the question is always answered.
 */
async function listUnreviewed(root: string, args: string[]): Promise<number> {
  const config = resolveLearnConfig({ projectRoot: root });
  if (flag(args, "if-enabled") && !config.inline) return 0;
  let lessons: UnreviewedLesson[];
  try {
    lessons = await unreviewedLessons(root);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
  if (flag(args, "json")) {
    process.stdout.write(JSON.stringify(lessons, null, 2) + "\n");
    return 0;
  }
  const { layer, source } = config.provenance.inline;
  process.stdout.write(`inline: ${config.inline ? "on" : "off"} (${layer}${layer === "default" ? "" : `: ${source}`})\n`);
  if (lessons.length === 0) {
    process.stdout.write("no unreviewed lessons\n");
    return 0;
  }
  for (const lesson of lessons) {
    process.stdout.write(`${lesson.revisionId.slice(0, 12)}  ${lesson.claim}${lesson.guidance === undefined ? "  (note only)" : ""}\n`);
  }
  process.stdout.write("\napply: stratum learn apply <revision>   dismiss: stratum learn dismiss <clusterId> --reason <text>\n");
  return 0;
}

/**
 * DELIVER-1 D6. Recomputed over the flow store (`--flows`, default the user store) on every
 * call. `--if-enabled` prints nothing when both `[learn] deliver` and `inline` are OFF.
 */
async function listReviews(root: string, args: string[]): Promise<number> {
  const config = resolveLearnConfig({ projectRoot: root });
  if (flag(args, "if-enabled") && !config.deliver && !config.inline) return 0;
  const reviews = await lessonReviews(flowsDirOf(args), root, { retireReviewAfter: config.retireReviewAfter });
  if (flag(args, "json")) {
    process.stdout.write(JSON.stringify(reviews, null, 2) + "\n");
    return 0;
  }
  if (reviews.length === 0) {
    process.stdout.write("no open lesson reviews\n");
    return 0;
  }
  for (const review of reviews) {
    process.stdout.write(`${review.kind.padEnd(26)} ${review.clusterId.slice(0, 12)}  ${review.detail}\n`);
  }
  process.stdout.write("\nclose: stratum learn <retire|dismiss|ack> <clusterId> --reason <text> [--kind <review>]\n");
  return 0;
}

async function applyCommandLine(args: string[]): Promise<number> {
  const root = await rootOf(args);
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
  const root = await rootOf(args);
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
    const report = await reconcile(await rootOf(args), {});
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

async function lifecycleCommand(kind: LifecycleKind, args: string[]): Promise<number> {
  try {
    const values = new Map<string, string>();
    let clusterId: string | undefined;
    let withdrawn = false;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i]!;
      if (arg === "--withdrawn" && kind === "retire" && !withdrawn) {
        withdrawn = true;
      } else if (["--root", "--reason", ...(kind === "retire" ? ["--fix-ref"] : []),
        ...(kind === "ack" ? ["--kind"] : [])].includes(arg)) {
        const value = args[++i];
        if (values.has(arg) || value === undefined || value.startsWith("--")) {
          throw new LifecycleError(`${arg} requires one value`);
        }
        values.set(arg, value);
      } else if (!arg.startsWith("--") && clusterId === undefined) {
        clusterId = arg;
      } else {
        throw new LifecycleError(`unexpected argument: ${arg}`);
      }
    }
    const input: Omit<LifecycleRow, "at"> = { clusterId: clusterId ?? "", kind, reason: values.get("--reason") ?? "" };
    if (values.has("--fix-ref")) input.fixRef = values.get("--fix-ref")!;
    if (withdrawn) input.withdrawn = true;
    if (values.has("--kind")) input.ackKinds = [values.get("--kind") as ReviewKind];
    const root = await canonicalWorkspace(values.get("--root") ?? process.cwd());
    const row = await appendLifecycle(root, input);
    process.stdout.write(JSON.stringify(row) + "\n");
    return 0;
  } catch (error) {
    process.stderr.write(`stratum learn ${kind}: ${error instanceof Error ? error.message : String(error)}\n`);
    return error instanceof LifecycleError ? 2 : 1;
  }
}
