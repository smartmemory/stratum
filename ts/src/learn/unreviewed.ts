import { join } from "node:path";
import { ledgerReceipt, readJournal } from "./apply.js";
import { latestPerCluster, readCandidates } from "./candidate.js";
import { lessonLifecycle } from "./lifecycle.js";
import { canonicalWorkspace } from "./workspace.js";

/** INLINE-TS-1 §A5: what the owner still has to act on. */
export interface UnreviewedLesson {
  clusterId: string;
  revisionId: string;
  claim: string;
  /** Absent for note-only lessons (DELIVER-1 D1). */
  guidance?: string;
}

/**
 * Latest staged revision per cluster, minus clusters with a committed (not reverted) apply
 * and clusters the owner retired or dismissed. Recomputed from persisted state on every call
 * ("show until acted on"), so a missed surface cannot lose a lesson. Pure read. Throws when
 * the lifecycle log is unreadable; callers decide whether to fail or omit.
 */
export async function unreviewedLessons(workspaceRoot: string): Promise<UnreviewedLesson[]> {
  const root = await canonicalWorkspace(workspaceRoot);
  const latest = latestPerCluster(await readCandidates(join(root, ".stratum", "learn")));
  if (latest.length === 0) return [];
  const applied = new Set<string>();
  for (const entry of await readJournal(root)) {
    try {
      const receipt = ledgerReceipt(entry, () => { /* surfacing is silent */ });
      if (receipt.kind === "committed" && receipt.state === "applied") applied.add(entry.clusterId);
    } catch {
      // An unreadable receipt proves no apply: the lesson stays visible (fail toward showing).
    }
  }
  const out: UnreviewedLesson[] = [];
  for (const row of latest) {
    if (applied.has(row.clusterId)) continue;
    const { state } = await lessonLifecycle(root, row.clusterId, () => { /* counted by readLifecycle */ });
    if (state === "retired" || state === "dismissed") continue;
    out.push({
      clusterId: row.clusterId, revisionId: row.revisionId, claim: row.claim,
      ...(row.rendered.guidance !== undefined ? { guidance: row.rendered.guidance } : {}),
    });
  }
  return out;
}
