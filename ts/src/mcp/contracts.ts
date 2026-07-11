import { readFile } from "node:fs/promises";

export type Shape = string | { readonly [key: string]: Shape };

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
  if (typeof shape === "string") {
    const alternatives = shape.split("|");
    if (!alternatives.some((alternative) => matchesLeaf(value, alternative))) {
      throw new Error(`${path} must be ${shape}`);
    }
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
    assertShape(value[key], child, `${path}.${key}`);
  }
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
