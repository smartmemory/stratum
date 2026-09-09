export const STEP_ID_PATTERN = /^[a-z][a-z0-9_-]*$/;
export const PATH_FIELD_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
// A step reference is ALWAYS `<id>.output` followed by end-of-source, `.` or `[`, so only
// that exact first segment is reserved (R2-6): `${wave.outputValue}` and `${wave.outputs}`
// stay carry references, `${wave.output.tasks}` does not.
const STEP_OUTPUT_SEGMENT = /^\.output(?:$|\.|\[)/;

export type PathSegment = string | number;

export type Reference =
  | { kind: "input"; path: PathSegment[] }
  | { kind: "step"; stepId: string; path: PathSegment[] }
  | { kind: "carry"; name: string; path: PathSegment[] }
  | { kind: "item" }
  | { kind: "prev" };

export interface ExtractedReference {
  raw: string;
  reference: Reference;
  fullValue: boolean;
}

export interface ReferenceEdge {
  from: string;
  to: string;
}

function parsePath(source: string): PathSegment[] | undefined {
  if (source.length === 0) return [];
  const path: PathSegment[] = [];
  let rest = source;
  while (rest.length > 0) {
    if (rest.startsWith(".")) {
      const match = /^\.([a-zA-Z_][a-zA-Z0-9_]*)/.exec(rest);
      if (!match?.[1]) return undefined;
      path.push(match[1]);
      rest = rest.slice(match[0].length);
      continue;
    }
    if (rest.startsWith("[")) {
      const match = /^\[([0-9]+)\]/.exec(rest);
      if (!match?.[1]) return undefined;
      path.push(Number(match[1]));
      rest = rest.slice(match[0].length);
      continue;
    }
    return undefined;
  }
  return path;
}

/** Parses the complete contents of one `${...}` reference. */
export function parseReference(source: string): Reference | undefined {
  if (source === "item") return { kind: "item" };
  if (source === "prev") return { kind: "prev" };

  if (source.startsWith("input.")) {
    const path = parsePath(source.slice("input".length));
    return path && path.length > 0 ? { kind: "input", path } : undefined;
  }

  // A carry variable is a bare flow-value name with an optional path. Same charset as
  // STEP_ID_PATTERN (R3-2). Declined only when the remainder is exactly the reserved
  // `.output` segment, which is claimed by the step-reference branch below.
  const carry = /^([a-z][a-z0-9_-]*)(.*)$/.exec(source);
  if (carry?.[1] !== undefined && !STEP_OUTPUT_SEGMENT.test(carry[2] ?? "")) {
    const path = parsePath(carry[2] ?? "");
    return path === undefined ? undefined : { kind: "carry", name: carry[1], path };
  }

  const match = /^([a-z][a-z0-9_-]*)\.output(.*)$/.exec(source);
  if (!match?.[1]) return undefined;
  const path = parsePath(match[2] ?? "");
  return path === undefined ? undefined : { kind: "step", stepId: match[1], path };
}

/** Finds every reference in a string and records interpolation versus typed reference use. */
export function extractReferences(value: string): ExtractedReference[] | undefined {
  const references: ExtractedReference[] = [];
  const matcher = /\$\{([^}]*)\}/g;
  let match: RegExpExecArray | null;
  while ((match = matcher.exec(value)) !== null) {
    const raw = match[0];
    const content = match[1] ?? "";
    const reference = parseReference(content);
    if (!reference) return undefined;
    references.push({ raw, reference, fullValue: raw === value });
  }
  // A dangling opening token is never a literal reference spelling.
  if (value.includes("${") && references.length === 0) return undefined;
  if (value.lastIndexOf("${") > value.lastIndexOf("}")) return undefined;
  return references;
}

/** Converts only step-output references into their data-dependency edges. */
export function referenceEdges(to: string, references: readonly ExtractedReference[]): ReferenceEdge[] {
  return references.flatMap(({ reference }) =>
    reference.kind === "step" ? [{ from: reference.stepId, to }] : [],
  );
}
