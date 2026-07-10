export const STEP_ID_PATTERN = /^[a-z][a-z0-9_-]*$/;
export const PATH_FIELD_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export type PathSegment = string | number;

export type Reference =
  | { kind: "input"; path: PathSegment[] }
  | { kind: "step"; stepId: string; path: PathSegment[] }
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
