import dagre from "@dagrejs/dagre";
import type { StepSpec } from "../data-client";

/**
 * Edge derivation, mirroring the engine:
 *  - `after`: the step's declared `after` list;
 *  - `data`: a `${<id>.output...}` reference in any string the engine scans for dependencies
 *    (`ts/src/engine/engine.ts` dependencies() + stringLeaves(); reference grammar
 *    `ts/src/ir/refs.ts`). Drawn only when the target is a step of this flow and is not
 *    already an `after` edge;
 *  - routing (dormant until routed, `engine.ts` isActivated): `on_fail` ("fail"), gate
 *    `on_approve` ("approve"), `on_kill` ("kill"), and `on_revise` ("revise"), which is a
 *    back-edge and is NOT part of the DAG (`ir/validate.ts:482-488`).
 */
export type EdgeKind = "after" | "data" | "approve" | "kill" | "revise" | "fail";

export interface Edge {
  id: string;
  from: string;
  to: string;
  kind: EdgeKind;
}

/** `${id.output}` with `.output` followed by end, `.`, `[` (refs.ts STEP_OUTPUT_SEGMENT). */
const STEP_REF = /\$\{([a-z][a-z0-9_-]*)\.output(?:[.[][^}]*)?\}/g;

function collectStrings(value: unknown, out: string[]): void {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((entry) => collectStrings(entry, out));
  else if (typeof value === "object" && value !== null) Object.values(value).forEach((entry) => collectStrings(entry, out));
}

/** The same fields `stringLeaves` (engine.ts) scans. */
export function stepStrings(step: StepSpec): string[] {
  const out: string[] = [];
  const s = step as Record<string, any>;
  collectStrings(s.do, out);
  collectStrings(s.when, out);
  collectStrings(s.set, out);
  collectStrings(s.iterate?.until, out);
  for (const predicate of Array.isArray(s.ensure) ? s.ensure : []) {
    if (predicate && typeof predicate === "object" && "expr" in predicate) collectStrings(predicate.expr, out);
  }
  collectStrings(s.with, out);
  collectStrings(s.evaluate?.in, out);
  if (s.fanout) {
    collectStrings(s.fanout.over, out);
    for (const stage of Array.isArray(s.fanout.steps) ? s.fanout.steps : []) {
      collectStrings(stage?.do, out);
      collectStrings(stage?.when, out);
      for (const predicate of Array.isArray(stage?.ensure) ? stage.ensure : []) {
        if (predicate && typeof predicate === "object" && "expr" in predicate) collectStrings(predicate.expr, out);
      }
    }
  }
  return out;
}

export function dataRefs(step: StepSpec): string[] {
  const refs = new Set<string>();
  for (const text of stepStrings(step)) {
    for (const match of text.matchAll(STEP_REF)) refs.add(match[1]!);
  }
  return [...refs];
}

export function deriveEdges(steps: StepSpec[]): Edge[] {
  const ids = new Set(steps.map((step) => step.id));
  const edges: Edge[] = [];
  const seen = new Set<string>();
  const add = (from: string | null | undefined, to: string, kind: EdgeKind) => {
    if (!from || !ids.has(from) || from === to) return;
    const id = `${kind}:${from}->${to}`;
    if (seen.has(id)) return;
    seen.add(id);
    edges.push({ id, from, to, kind });
  };
  for (const step of steps) {
    const after = new Set(step.after ?? []);
    for (const dep of after) add(dep, step.id, "after");
    for (const dep of dataRefs(step)) if (!after.has(dep)) add(dep, step.id, "data");
    if (step.on_fail) add(step.id, step.on_fail, "fail");
    if (step.gate) {
      // Routing edges point FROM the gate TO its target.
      if (step.gate.on_approve) add(step.id, step.gate.on_approve, "approve");
      if (step.gate.on_kill) add(step.id, step.gate.on_kill, "kill");
      if (step.gate.on_revise) add(step.id, step.gate.on_revise, "revise");
    }
  }
  return edges;
}

export const NODE_W = 216;
export const NODE_H = 76;

export interface Point { x: number; y: number }
export interface LaidOutEdge extends Edge { points: Point[] }
export interface Layout {
  /** Top-left corner per step id. */
  nodes: Record<string, Point>;
  edges: LaidOutEdge[];
  width: number;
  height: number;
}

/** Left-to-right layered layout (dagre). Back-edges (`revise`) do not influence ranks. `size` lets the builder lay out its larger nodes. */
export function layoutGraph(steps: StepSpec[], edges: Edge[], size: { w: number; h: number; ranksep?: number } = { w: NODE_W, h: NODE_H }): Layout {
  const NODE_W = size.w;
  const NODE_H = size.h;
  const g = new dagre.graphlib.Graph({ multigraph: true });
  g.setGraph({ rankdir: "LR", nodesep: 28, ranksep: size.ranksep ?? 64, marginx: 24, marginy: 24 });
  g.setDefaultEdgeLabel(() => ({}));
  for (const step of steps) g.setNode(step.id, { width: NODE_W, height: NODE_H });
  for (const edge of edges) if (edge.kind !== "revise") g.setEdge(edge.from, edge.to, {}, edge.id);
  dagre.layout(g);

  const nodes: Record<string, Point> = {};
  let width = 0;
  let height = 0;
  for (const step of steps) {
    const node = g.node(step.id);
    nodes[step.id] = { x: node.x - NODE_W / 2, y: node.y - NODE_H / 2 };
    width = Math.max(width, node.x + NODE_W / 2);
    height = Math.max(height, node.y + NODE_H / 2);
  }
  const laid = edges.map((edge): LaidOutEdge => {
    const from = nodes[edge.from]!;
    const to = nodes[edge.to]!;
    if (edge.kind === "revise") {
      // Arc above both nodes, from the gate's top back to the target's top.
      const x1 = from.x + NODE_W / 2;
      const x2 = to.x + NODE_W / 2;
      const top = Math.min(from.y, to.y) - 34;
      return { ...edge, points: [{ x: x1, y: from.y }, { x: (x1 + x2) / 2, y: top }, { x: x2, y: to.y }] };
    }
    const dagreEdge = g.edge({ v: edge.from, w: edge.to, name: edge.id }) as { points?: Point[] } | undefined;
    const points = dagreEdge?.points?.length
      ? dagreEdge.points
      : [{ x: from.x + NODE_W, y: from.y + NODE_H / 2 }, { x: to.x, y: to.y + NODE_H / 2 }];
    return { ...edge, points };
  });
  return { nodes, edges: laid, width: width + 24, height: height + 40 };
}

/** Smooth SVG path through the points (quadratic midpoints). */
export function edgePath(points: Point[]): string {
  if (points.length === 0) return "";
  if (points.length === 2) return `M ${points[0]!.x} ${points[0]!.y} L ${points[1]!.x} ${points[1]!.y}`;
  let d = `M ${points[0]!.x} ${points[0]!.y}`;
  for (let i = 1; i < points.length - 1; i += 1) {
    const p = points[i]!;
    const next = points[i + 1]!;
    const mid = i === points.length - 2 ? next : { x: (p.x + next.x) / 2, y: (p.y + next.y) / 2 };
    d += ` Q ${p.x} ${p.y} ${mid.x} ${mid.y}`;
  }
  return d;
}
