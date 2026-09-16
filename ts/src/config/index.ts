import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "smol-toml";
import type {
  CodexApprovalPolicy,
  CodexSandboxMode,
  ConfigLayer,
  ConfigProvenance,
  SandboxPolicy,
  SandboxPolicyAudit,
  SandboxPolicyKey,
} from "./types.js";

export * from "./types.js";

export const DEFAULT_SANDBOX_POLICY: SandboxPolicy = Object.freeze({
  filesystemMode: "read-only",
  networkAccess: false,
  writableRoots: Object.freeze([] as string[]),
  approvalPolicy: "never",
});

export const SANDBOX_ENV = Object.freeze({
  filesystemMode: "STRATUM_CODEX_SANDBOX_MODE",
  networkAccess: "STRATUM_CODEX_NETWORK_ACCESS",
  writableRoots: "STRATUM_CODEX_WRITABLE_ROOTS",
  approvalPolicy: "STRATUM_CODEX_APPROVAL_POLICY",
} satisfies Record<SandboxPolicyKey, string>);

const SANDBOX_KEYS = Object.freeze([
  "filesystemMode",
  "networkAccess",
  "writableRoots",
  "approvalPolicy",
] as const satisfies readonly SandboxPolicyKey[]);
const SANDBOX_MODES = new Set<CodexSandboxMode>(["read-only", "workspace-write", "danger-full-access"]);
const APPROVAL_POLICIES = new Set<CodexApprovalPolicy>(["never", "on-request", "on-failure", "untrusted"]);

export interface DispatchSandboxOptions {
  readonly filesystemMode?: CodexSandboxMode;
  readonly networkAccess?: boolean;
  readonly writableRoots?: readonly string[];
  readonly approvalPolicy?: CodexApprovalPolicy;
}

export interface LoadStratumConfigOptions {
  readonly projectRoot?: string;
  readonly dispatch?: DispatchSandboxOptions;
  readonly env?: NodeJS.ProcessEnv;
}

/** Typed, deeply frozen effective configuration plus per-key winning-layer evidence. */
export class ResolvedStratumConfig {
  readonly sandbox: SandboxPolicy;
  readonly #provenance: Readonly<Record<SandboxPolicyKey, ConfigProvenance>>;
  readonly #fullAccessAuthorization: ConfigProvenance | undefined;

  constructor(
    sandbox: SandboxPolicy,
    provenance: Record<SandboxPolicyKey, ConfigProvenance>,
    fullAccessAuthorization?: ConfigProvenance,
  ) {
    this.sandbox = freezePolicy(sandbox);
    this.#provenance = freezeProvenance(provenance);
    this.#fullAccessAuthorization = fullAccessAuthorization === undefined
      ? undefined
      : Object.freeze({ ...fullAccessAuthorization });
    Object.freeze(this);
  }

  provenance(key: SandboxPolicyKey): ConfigProvenance {
    return this.#provenance[key];
  }

  /** Serializable evidence for connector results, background metadata, and flow audit events. */
  sandboxAudit(): SandboxPolicyAudit {
    return Object.freeze({
      policy: this.sandbox,
      provenance: this.#provenance,
      ...(this.#fullAccessAuthorization !== undefined
        ? { fullAccessAuthorization: this.#fullAccessAuthorization }
        : {}),
    });
  }
}

/**
 * Resolve defaults < user preferences < project config < dispatch params < env.
 * Missing TOML files are intentionally no-ops; malformed or unknown content is fatal.
 */
export function loadStratumConfig(options: LoadStratumConfigOptions = {}): ResolvedStratumConfig {
  const env = options.env ?? process.env;
  const projectRoot = options.projectRoot ?? process.cwd();
  const userPath = env.STRATUM_CONFIG_FILE || join(homedir(), ".stratum", "config.toml");
  const projectPath = join(projectRoot, "stratum.toml");
  const values: MutableSandboxPolicy = {
    filesystemMode: DEFAULT_SANDBOX_POLICY.filesystemMode,
    networkAccess: DEFAULT_SANDBOX_POLICY.networkAccess,
    writableRoots: [...DEFAULT_SANDBOX_POLICY.writableRoots],
    approvalPolicy: DEFAULT_SANDBOX_POLICY.approvalPolicy,
  };
  const provenance = Object.fromEntries(SANDBOX_KEYS.map((key) => [
    key,
    Object.freeze({ layer: "default" as const, source: "built-in defaults" }),
  ])) as unknown as Record<SandboxPolicyKey, ConfigProvenance>;

  applyFile(values, provenance, userPath, "user");
  applyFile(values, provenance, projectPath, "project");
  applyLayer(values, provenance, parseDispatch(options.dispatch ?? {}), "dispatch", "stratum_agent_run");
  applyEnv(values, provenance, env);
  return new ResolvedStratumConfig(values, provenance,
    values.filesystemMode === "danger-full-access" ? fullAccessAuthorization(env) : undefined);
}

export function fullAccessAuthorization(env: NodeJS.ProcessEnv): ConfigProvenance | undefined {
  const value = env.STRATUM_CODEX_ALLOW_FULL_ACCESS?.trim().toLowerCase();
  return value !== undefined && ["1", "true", "yes", "on"].includes(value)
    ? Object.freeze({ layer: "env", source: "STRATUM_CODEX_ALLOW_FULL_ACCESS" })
    : undefined;
}

export function isSandboxEscalated(policy: SandboxPolicy): boolean {
  return policy.filesystemMode !== DEFAULT_SANDBOX_POLICY.filesystemMode
    || policy.networkAccess !== DEFAULT_SANDBOX_POLICY.networkAccess
    || policy.writableRoots.length > 0
    || policy.approvalPolicy !== DEFAULT_SANDBOX_POLICY.approvalPolicy;
}

type MutableSandboxPolicy = {
  -readonly [Key in SandboxPolicyKey]: Key extends "writableRoots" ? string[] : SandboxPolicy[Key]
};

function applyFile(
  values: MutableSandboxPolicy,
  provenance: Record<SandboxPolicyKey, ConfigProvenance>,
  path: string,
  layer: Extract<ConfigLayer, "user" | "project">,
): void {
  if (!existsSync(path)) return;
  let raw: unknown;
  try {
    raw = parse(readFileSync(path, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${path}: TOML parse error: ${detail}`, { cause: error });
  }
  if (!isRecord(raw)) throw new Error(`${path}: config root must be a table`);
  rejectUnknown(raw, new Set(["sandbox"]), path, "");
  const sandbox = raw.sandbox;
  if (sandbox === undefined) return;
  if (!isRecord(sandbox)) throw new Error(`${path}: sandbox must be a table`);
  rejectUnknown(sandbox, new Set(SANDBOX_KEYS), path, "sandbox");
  const parsed: DispatchSandboxOptions = {
    ...(sandbox.filesystemMode !== undefined
      ? { filesystemMode: sandboxMode(sandbox.filesystemMode, path, "sandbox.filesystemMode") }
      : {}),
    ...(sandbox.networkAccess !== undefined
      ? { networkAccess: booleanValue(sandbox.networkAccess, path, "sandbox.networkAccess") }
      : {}),
    ...(sandbox.writableRoots !== undefined
      ? { writableRoots: stringArray(sandbox.writableRoots, path, "sandbox.writableRoots") }
      : {}),
    ...(sandbox.approvalPolicy !== undefined
      ? { approvalPolicy: approvalPolicy(sandbox.approvalPolicy, path, "sandbox.approvalPolicy") }
      : {}),
  };
  applyLayer(values, provenance, parsed, layer, path);
}

function applyLayer(
  values: MutableSandboxPolicy,
  provenance: Record<SandboxPolicyKey, ConfigProvenance>,
  layerValues: DispatchSandboxOptions,
  layer: ConfigLayer,
  source: string,
): void {
  if (layerValues.filesystemMode !== undefined) {
    values.filesystemMode = layerValues.filesystemMode;
    provenance.filesystemMode = Object.freeze({ layer, source });
  }
  if (layerValues.networkAccess !== undefined) {
    values.networkAccess = layerValues.networkAccess;
    provenance.networkAccess = Object.freeze({ layer, source });
  }
  if (layerValues.writableRoots !== undefined) {
    values.writableRoots = [...layerValues.writableRoots];
    provenance.writableRoots = Object.freeze({ layer, source });
  }
  if (layerValues.approvalPolicy !== undefined) {
    values.approvalPolicy = layerValues.approvalPolicy;
    provenance.approvalPolicy = Object.freeze({ layer, source });
  }
}

function applyEnv(
  values: MutableSandboxPolicy,
  provenance: Record<SandboxPolicyKey, ConfigProvenance>,
  env: NodeJS.ProcessEnv,
): void {
  const overrides: MutableDispatchSandboxOptions = {};
  if (env[SANDBOX_ENV.filesystemMode] !== undefined) {
    overrides.filesystemMode = sandboxMode(env[SANDBOX_ENV.filesystemMode], SANDBOX_ENV.filesystemMode, SANDBOX_ENV.filesystemMode);
  }
  if (env[SANDBOX_ENV.networkAccess] !== undefined) {
    overrides.networkAccess = envBoolean(env[SANDBOX_ENV.networkAccess]!, SANDBOX_ENV.networkAccess);
  }
  if (env[SANDBOX_ENV.writableRoots] !== undefined) {
    let parsed: unknown;
    try { parsed = JSON.parse(env[SANDBOX_ENV.writableRoots]!); }
    catch (error) { throw new Error(`${SANDBOX_ENV.writableRoots}: must be a JSON array of strings`, { cause: error }); }
    overrides.writableRoots = stringArray(parsed, SANDBOX_ENV.writableRoots, SANDBOX_ENV.writableRoots);
  }
  if (env[SANDBOX_ENV.approvalPolicy] !== undefined) {
    overrides.approvalPolicy = approvalPolicy(env[SANDBOX_ENV.approvalPolicy], SANDBOX_ENV.approvalPolicy, SANDBOX_ENV.approvalPolicy);
  }
  for (const key of SANDBOX_KEYS) {
    const value = overrides[key];
    if (value === undefined) continue;
    applyLayer(values, provenance, { [key]: value }, "env", SANDBOX_ENV[key]);
  }
}

function parseDispatch(dispatch: DispatchSandboxOptions): DispatchSandboxOptions {
  return {
    ...(dispatch.filesystemMode !== undefined
      ? { filesystemMode: sandboxMode(dispatch.filesystemMode, "stratum_agent_run", "filesystemMode") }
      : {}),
    ...(dispatch.networkAccess !== undefined
      ? { networkAccess: booleanValue(dispatch.networkAccess, "stratum_agent_run", "networkAccess") }
      : {}),
    ...(dispatch.writableRoots !== undefined
      ? { writableRoots: stringArray(dispatch.writableRoots, "stratum_agent_run", "writableRoots") }
      : {}),
    ...(dispatch.approvalPolicy !== undefined
      ? { approvalPolicy: approvalPolicy(dispatch.approvalPolicy, "stratum_agent_run", "approvalPolicy") }
      : {}),
  };
}

function sandboxMode(value: unknown, source: string, key: string): CodexSandboxMode {
  if (typeof value !== "string" || !SANDBOX_MODES.has(value as CodexSandboxMode)) {
    throw new Error(`${source}: ${key} must be "read-only", "workspace-write", or "danger-full-access"`);
  }
  return value as CodexSandboxMode;
}

function approvalPolicy(value: unknown, source: string, key: string): CodexApprovalPolicy {
  if (typeof value !== "string" || !APPROVAL_POLICIES.has(value as CodexApprovalPolicy)) {
    throw new Error(`${source}: ${key} must be "never", "on-request", "on-failure", or "untrusted"`);
  }
  return value as CodexApprovalPolicy;
}

function booleanValue(value: unknown, source: string, key: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${source}: ${key} must be a boolean`);
  return value;
}

function stringArray(value: unknown, source: string, key: string): string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`${source}: ${key} must be an array of strings`);
  }
  return [...value];
}

function envBoolean(value: string, key: string): boolean {
  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  throw new Error(`${key}: must be one of 1, true, yes, on, 0, false, no, or off`);
}

function rejectUnknown(value: Record<string, unknown>, allowed: ReadonlySet<string>, path: string, prefix: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      const full = prefix ? `${prefix}.${key}` : key;
      throw new Error(`${path}: unknown config key ${JSON.stringify(full)}`);
    }
  }
}

function freezePolicy(policy: SandboxPolicy): SandboxPolicy {
  return Object.freeze({ ...policy, writableRoots: Object.freeze([...policy.writableRoots]) });
}

function freezeProvenance(
  provenance: Record<SandboxPolicyKey, ConfigProvenance>,
): Readonly<Record<SandboxPolicyKey, ConfigProvenance>> {
  return Object.freeze(Object.fromEntries(SANDBOX_KEYS.map((key) => [key, Object.freeze({ ...provenance[key] })]))) as Readonly<Record<SandboxPolicyKey, ConfigProvenance>>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type MutableDispatchSandboxOptions = {
  -readonly [Key in keyof DispatchSandboxOptions]: DispatchSandboxOptions[Key]
};
