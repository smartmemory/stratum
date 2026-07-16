import { readFile } from "node:fs/promises";

export type Shape = string | ShapeRecord | ArrayShape | OneOfShape;

export interface ShapeRecord { readonly [key: string]: Shape }
export interface ArrayShape { readonly $array: Shape }
export interface OneOfShape { readonly $oneOf: readonly Shape[] }

export interface McpSurface {
  surface: number;
  tools: Record<string, {
    request: Record<string, Shape>;
    responses: Record<string, Record<string, Shape>>;
    discriminator?: Record<string, string>;
  }>;
}

export interface EventContract {
  events: number;
  kinds: Record<string, Record<string, Shape>>;
}

let surfacePromise: Promise<McpSurface> | undefined;
let eventsPromise: Promise<EventContract> | undefined;

async function loadJson<T>(name: string): Promise<T> {
  return JSON.parse(await readFile(new URL(`../../contracts/${name}`, import.meta.url), "utf8")) as T;
}

export function mcpSurface(): Promise<McpSurface> {
  surfacePromise ??= loadJson<McpSurface>("mcp-surface.json");
  return surfacePromise;
}

export function eventContract(): Promise<EventContract> {
  eventsPromise ??= loadJson<EventContract>("events.json");
  return eventsPromise;
}

export function assertShape(value: unknown, shape: Shape, path = "response"): void {
  validateShape(shape, path);
  matchShape(value, shape, path);
}

const LEAF_TYPES = new Set(["any", "array", "boolean", "null", "number", "object", "string"]);

/** Validates a shape declaration independently from any value matched against it. */
export function validateShape(shape: unknown, path = "shape"): asserts shape is Shape {
  if (typeof shape === "string") {
    const unknown = shape.split("|").find((alternative) => !LEAF_TYPES.has(alternative));
    if (unknown !== undefined) throw malformedShape(path, `unknown leaf type ${JSON.stringify(unknown)}`);
    return;
  }
  if (!isRecord(shape)) throw malformedShape(path, "must be a string leaf or an object");

  const keys = Object.keys(shape);
  const reserved = keys.filter((key) => key.startsWith("$"));
  if (reserved.length > 0) {
    const tag = reserved[0];
    if (reserved.length !== 1 || (tag !== "$array" && tag !== "$oneOf")) {
      throw malformedShape(path, `unknown reserved grammar tag ${JSON.stringify(tag)}`);
    }
    if (keys.length !== 1) throw malformedShape(path, `grammar tag ${tag} must be the only key`);
    if (tag === "$array") {
      validateShape(shape.$array, `${path}.$array`);
      return;
    }
    if (!Array.isArray(shape.$oneOf) || shape.$oneOf.length === 0) {
      throw malformedShape(path, "$oneOf must contain a non-empty array of shapes");
    }
    for (const [index, variant] of shape.$oneOf.entries()) {
      validateShape(variant, `${path}.$oneOf[${index}]`);
    }
    return;
  }

  const declared = new Set<string>();
  for (const [rawKey, child] of Object.entries(shape)) {
    const key = rawKey.endsWith("?") ? rawKey.slice(0, -1) : rawKey;
    if (declared.has(key)) {
      throw malformedShape(path, `field ${JSON.stringify(key)} declared in both required and optional form`);
    }
    declared.add(key);
    validateShape(child, `${path}.${rawKey}`);
  }
}

function matchShape(value: unknown, shape: Shape, path: string): void {
  if (typeof shape === "string") {
    const alternatives = shape.split("|");
    if (!alternatives.some((alternative) => matchesLeaf(value, alternative))) {
      throw new Error(`${path} must be ${shape}`);
    }
    return;
  }

  if ("$array" in shape) {
    if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
    for (const [index, element] of value.entries()) {
      matchShape(element, shape.$array, `${path}[${index}]`);
    }
    return;
  }

  if ("$oneOf" in shape) {
    let matches = 0;
    for (const variant of (shape as OneOfShape).$oneOf) {
      try {
        matchShape(value, variant, path);
        matches += 1;
      } catch {
        // A variant mismatch is expected; exact-one is decided after all variants run.
      }
    }
    if (matches === 0) throw new Error(`${path}: zero $oneOf variants matched`);
    if (matches > 1) throw new Error(`${path}: multiple $oneOf variants matched (${matches})`);
    return;
  }

  if (!isRecord(value)) throw new Error(`${path} must be an object`);
  const allowed = new Set(Object.keys(shape).map((key) => key.endsWith("?") ? key.slice(0, -1) : key));
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error(`${path}.${key} is undeclared`);
  for (const [rawKey, child] of Object.entries(shape)) {
    const optional = rawKey.endsWith("?");
    const key = optional ? rawKey.slice(0, -1) : rawKey;
    if (!(key in value)) {
      if (optional) continue;
      throw new Error(`${path}.${key} is required`);
    }
    matchShape(value[key], child, `${path}.${key}`);
  }
}

function malformedShape(path: string, detail: string): Error {
  return new Error(`malformed shape at ${path}: ${detail}`);
}

export async function assertToolRequest(tool: string, request: unknown): Promise<void> {
  const definition = (await mcpSurface()).tools[tool];
  if (!definition) throw new Error(`unknown MCP tool ${tool}`);
  assertShape(request, definition.request, `${tool}.request`);
}

/** Validates the frozen payload shape, including raw status-less success responses. */
export async function assertToolResponse(tool: string, response: unknown): Promise<void> {
  if (!isRecord(response)) throw new Error(`${tool}.response must be an object`);
  const definition = (await mcpSurface()).tools[tool];
  const status = typeof response.status === "string" ? response.status : undefined;
  const variant = status
    ?? Object.entries(definition?.discriminator ?? {}).find(([, key]) => key in response)?.[0]
    ?? "success";
  const shape = definition?.responses[variant];
  if (!shape) throw new Error(`${tool}.response has undeclared status ${JSON.stringify(response.status)}`);
  const payload = { ...response };
  if ("status" in payload) delete payload.status;
  assertShape(payload, shape, `${tool}.response`);
}

export async function assertEvent(event: unknown): Promise<void> {
  if (!isRecord(event) || typeof event.at !== "string" || typeof event.type !== "string") throw new Error("event requires at and type");
  const shape = (await eventContract()).kinds[event.type];
  if (!shape) throw new Error(`event has undeclared type ${JSON.stringify(event.type)}`);
  const payload = { ...event };
  delete payload.at;
  delete payload.type;
  assertShape(payload, shape, "event");
}

function matchesLeaf(value: unknown, type: string): boolean {
  if (type === "any") return true;
  if (type === "null") return value === null;
  if (type === "array") return Array.isArray(value);
  if (type === "object") return isRecord(value);
  return typeof value === type;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
