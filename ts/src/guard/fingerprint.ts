/** Byte-compatible guard policy checksum. */

import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical.js";
import type { EdgePredicates, GuardGraph } from "./store.js";

export function guardChecksum(
  graph: GuardGraph,
  edgePredicates: EdgePredicates,
  terminal: string[],
  stakes: Record<string, string>,
): string {
  const policy = {
    graph: Object.fromEntries(Object.entries(graph).map(([key, targets]) => [key, [...targets]])),
    edge_predicates: edgePredicates,
    terminal: [...terminal].sort(),
    stakes,
  };
  return createHash("sha256").update(canonicalJson(policy), "utf8").digest("hex");
}
