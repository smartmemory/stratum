import { appendFile, mkdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { resolveLearnConfig } from "../config/learn.js";
import type { ConfigProvenance } from "../config/types.js";
import { authorCandidate, stageCandidates, type PatchCandidate } from "./candidate.js";
import { classify } from "./classify.js";
import { harvest } from "./harvest.js";
import { isSuppressed, lessonLifecycle } from "./lifecycle.js";
import { canonicalizeRecordRoots, canonicalWorkspace } from "./workspace.js";

/**
 * STRAT-LEARN-INLINE-TS-1 §A2–§A4: after every terminal run, harvest the engine's own
 * store and stage durable lessons for every workspace whose `[learn] inline` switch is on.
 * Staging only — never applies. Fail-open: nothing here can reach the flow.
 */

/** One row per pass in `<dirname(storeRoot)>/learn-inline/triggers.jsonl` (§A5). Diagnostics only. */
export interface InlinePassRow {
  at: string;
  storeRoot: string;
  /** Runs whose terminal transition requested this pass (coalesced). */
  triggeredBy: string[];
  /** Distinct canonical workspaces among the durable clusters. */
  roots: string[];
  records: number;
  /** Run files and failure-shaped events that harvest could not use. */
  skipped: number;
  droppedEvents: number;
  clusters: number;
  durable: number;
  /** Per enabled root, the winning layer of its switch. */
  enabled: Record<string, ConfigProvenance>;
  staged: Record<string, string[]>;
  /** Per root, cluster ids not staged because a retire/dismiss predates all their evidence. */
  suppressed: Record<string, string[]>;
  /** Runs carrying failure evidence but no workspaceRoot: nowhere to stage it. */
  skippedUnattributed: string[];
  /** Per-root and per-cluster problems; the pass carried on past each. */
  problems: string[];
  error?: string;
}

export function inlineLogPath(storeRoot: string): string {
  return join(dirname(storeRoot), "learn-inline", "triggers.jsonl");
}

const warnedDiagnostics = new Set<string>();

const message = (error: unknown): string => error instanceof Error ? error.message : String(error);

async function isDirectory(path: string): Promise<boolean> {
  try { return (await stat(path)).isDirectory(); } catch { return false; }
}

/** One full reconcile of the store (§A3). Never throws. */
export async function runInlinePass(storeRoot: string, triggeredBy: string[], env?: NodeJS.ProcessEnv): Promise<InlinePassRow> {
  const row: InlinePassRow = {
    at: new Date().toISOString(), storeRoot, triggeredBy, roots: [], records: 0, skipped: 0, droppedEvents: 0, clusters: 0, durable: 0,
    enabled: {}, staged: {}, suppressed: {}, skippedUnattributed: [], problems: [],
  };
  try {
    const { records, skipped, droppedEvents } = await harvest(storeRoot);
    row.skipped = skipped;
    row.droppedEvents = droppedEvents;
    row.records = records.length;
    row.skippedUnattributed = [...new Set(records.filter((r) => r.workspaceRoot === undefined).map((r) => r.runId))];
    await canonicalizeRecordRoots(records);
    const clusters = classify(records);
    row.clusters = clusters.length;
    const durable = clusters.filter((c) => c.class === "durable");
    row.durable = durable.length;
    row.roots = [...new Set(durable.flatMap((c) => c.scope.workspaceRoot === null ? [] : [c.scope.workspaceRoot]))].sort();

    for (const root of row.roots) {
      try {
        // A root that is not an existing directory is never created.
        if (!await isDirectory(root)) continue;
        const config = resolveLearnConfig({ projectRoot: root, ...(env !== undefined ? { env } : {}) });
        row.problems.push(...config.diagnostics);
        if (!config.inline) continue;
        row.enabled[root] = config.provenance.inline;
        const candidates: PatchCandidate[] = [];
        for (const cluster of durable) {
          if (cluster.scope.workspaceRoot !== root || !cluster.applyEligible) continue;
          try {
            const candidate = authorCandidate(cluster);
            // Fail closed on announcing: an unreadable lifecycle stages nothing for that cluster.
            if (isSuppressed(await lessonLifecycle(root, candidate.clusterId), cluster.evidence)) {
              (row.suppressed[root] ??= []).push(candidate.clusterId);
              continue;
            }
            candidates.push(candidate);
          } catch (error) {
            row.problems.push(`${root}: cluster ${cluster.key.slice(0, 80)}: ${message(error)}`);
          }
        }
        row.staged[root] = await stageCandidates(root, candidates);
      } catch (error) {
        row.problems.push(`${root}: ${message(error)}`);
      }
    }
  } catch (error) {
    row.error = message(error);
  }
  await writeRow(storeRoot, row);
  return row;
}

async function writeRow(storeRoot: string, row: InlinePassRow): Promise<void> {
  try {
    const path = inlineLogPath(storeRoot);
    await mkdir(dirname(path), { recursive: true });
    await appendFile(path, JSON.stringify(row) + "\n", "utf8");
  } catch (error) {
    console.warn(`learn inline: diagnostic log write failed: ${message(error)}`);
  }
}

/**
 * Per-engine trigger (§A2, §A4). `trigger()` returns synchronously; the switch is resolved
 * off the response path (OFF: that config read is the only I/O). Triggers arriving during a
 * pass set a dirty bit and get exactly one follow-up pass — safe because every pass stages
 * for every enabled root, not only the triggering one.
 */
export class LearnInline {
  readonly #storeRoot: string;
  readonly #env: NodeJS.ProcessEnv | undefined;
  readonly #beforePass: ((queuedRunIds: readonly string[]) => Promise<void>) | undefined;
  readonly #checks = new Set<Promise<void>>();
  #running: Promise<void> | undefined;
  #dirty = false;
  #triggeredBy: string[] = [];

  constructor(storeRoot: string, env?: NodeJS.ProcessEnv, beforePass?: (queuedRunIds: readonly string[]) => Promise<void>) {
    this.#storeRoot = storeRoot;
    this.#env = env;
    this.#beforePass = beforePass;
  }

  trigger(run: { id: string; workspaceRoot?: string }): void {
    const check: Promise<void> = this.#check(run)
      .catch((error: unknown) => { console.warn(`learn inline: trigger failed for run ${run.id}: ${message(error)}`); })
      .finally(() => { this.#checks.delete(check); });
    this.#checks.add(check);
  }

  /** Resolves once no switch check or pass is in flight (tests; no shutdown drain by design). */
  async idle(): Promise<void> {
    while (this.#checks.size > 0 || this.#running !== undefined) {
      await Promise.allSettled([...this.#checks, ...(this.#running ? [this.#running] : [])]);
    }
  }

  async #check(run: { id: string; workspaceRoot?: string }): Promise<void> {
    // No workspace: only the user and env layers can turn it on; the pass then logs the run
    // as unattributed evidence rather than staging it anywhere.
    const root = run.workspaceRoot === undefined ? undefined : await canonicalWorkspace(run.workspaceRoot);
    const config = resolveLearnConfig({
      ...(root !== undefined ? { projectRoot: root } : {}),
      ...(this.#env !== undefined ? { env: this.#env } : {}),
    });
    for (const diagnostic of config.diagnostics) {
      if (warnedDiagnostics.has(diagnostic)) continue;
      warnedDiagnostics.add(diagnostic);
      console.warn(`learn inline: ${diagnostic}`);
    }
    if (!config.inline) return;
    this.#triggeredBy.push(run.id);
    this.#schedule();
  }

  #schedule(): void {
    if (this.#running !== undefined) { this.#dirty = true; return; }
    this.#running = this.#loop()
      .catch((error: unknown) => { console.warn(`learn inline: pass failed: ${message(error)}`); })
      .finally(() => {
        this.#running = undefined;
        // A trigger that landed after the loop's last dirty check but before this settled.
        if (this.#dirty) this.#schedule();
      });
  }

  async #loop(): Promise<void> {
    do {
      this.#dirty = false;
      // Test seam: lets a test hold the pass open until every trigger is queued.
      // The array is live — a trigger landing while it is held is still coalesced.
      await this.#beforePass?.(this.#triggeredBy);
      await runInlinePass(this.#storeRoot, this.#triggeredBy.splice(0), this.#env);
    } while (this.#dirty);
  }
}
