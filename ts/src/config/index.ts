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
  /**
   * Which agent the policy applies to (STRAT-AGENT-DEVIN-1 D11). "codex"
   * (default) reads the STRATUM_CODEX_* env layer. "devin" reads NO sandbox
   * env layer — STRATUM_CODEX_* must never escalate a devin run — and its
   * networkAccess/approvalPolicy are enforced facts of the runtime, not
   * resolved options (D3): an explicit dispatch `networkAccess:false` or
   * `approvalPolicy` is rejected, while resolved values are overridden with
   * "enforced" provenance so the audit records the real boundary.
   */
  readonly agent?: "codex" | "devin";
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
  const agent = options.agent ?? "codex";
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
  if (agent === "devin") {
    // Explicit dispatch requests devin cannot honour are rejected here (D3's
    // network rule, D11's approvalPolicy rule). File-set values are NOT
    // rejected — they are overridden by the enforced block below, so a project
    // that is fine for codex cannot fail every devin dispatch.
    if (options.dispatch?.approvalPolicy !== undefined) {
      throw new Error("stratum_agent_run: approvalPolicy is not supported by devin; approval is enforced by the OS sandbox");
    }
    if (options.dispatch?.networkAccess === false) {
      throw new Error("devin cannot run without network; networkAccess:false is not enforceable for devin");
    }
  }
  applyLayer(values, provenance, parseDispatch(options.dispatch ?? {}), "dispatch", "stratum_agent_run");
  if (agent !== "devin") applyEnv(values, provenance, env);
  if (agent === "devin") {
    values.networkAccess = true;
    provenance.networkAccess = Object.freeze({ layer: "enforced", source: "devin: model traffic runs inside the sandbox, so network cannot be denied" });
    values.approvalPolicy = "never";
    provenance.approvalPolicy = Object.freeze({ layer: "enforced", source: "devin: --permission-mode dangerous never asks for approval" });
  }
  return new ResolvedStratumConfig(values, provenance,
    values.filesystemMode === "danger-full-access" ? fullAccessAuthorization(env, agent) : undefined);
}

const FULL_ACCESS_ENV: Readonly<Record<"codex" | "devin", string>> = Object.freeze({
  codex: "STRATUM_CODEX_ALLOW_FULL_ACCESS",
  devin: "STRATUM_DEVIN_ALLOW_FULL_ACCESS",
});

export function fullAccessAuthorization(env: NodeJS.ProcessEnv, agent: "codex" | "devin" = "codex"): ConfigProvenance | undefined {
  const variable = FULL_ACCESS_ENV[agent];
  const value = env[variable]?.trim().toLowerCase();
  return value !== undefined && ["1", "true", "yes", "on"].includes(value)
    ? Object.freeze({ layer: "env", source: variable })
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
  // `[learn]` belongs to resolveLearnConfig() (config/learn.ts); sandbox resolution
  // ignores its contents entirely so an invalid learn value can never fail a dispatch.
  // `[session]` belongs to loadSessionConfig() (below) and is legal in the USER file only
  // (SESSION-MGMT-1 D7): a repository can never point the session door at its own scripts.
  if (layer === "project" && Object.prototype.hasOwnProperty.call(raw, "session")) throw new Error(projectSessionError(path));
  rejectUnknown(raw, new Set(layer === "user" ? ["sandbox", "learn", "session"] : ["sandbox", "learn"]), path, "");
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

// ---------------------------------------------------------------- [session] (SESSION-MGMT-1-U1)

export const SESSION_SCRIPTS_DIR_ENV = "STRATUM_SESSION_SCRIPTS_DIR";
export const SESSION_PYTHON_ENV = "STRATUM_SESSION_PYTHON";
const SESSION_KEYS = Object.freeze(["scripts_dir", "python"] as const);

export interface LoadSessionConfigOptions {
  readonly env?: NodeJS.ProcessEnv;
  /** Where a project stratum.toml would be read from (default process.cwd(), as loadStratumConfig). */
  readonly projectRoot?: string;
}

/**
 * The session door's configuration (contract `backend.configured_test`, `backend.scripts_dir`,
 * `backend.python`). `configured` follows the contract rule exactly: the env variable is a
 * non-empty string, or the USER config file holds a `session` key. A user file that exists
 * but cannot be read or parsed is configured-and-broken (`error` set): the door then refuses
 * every op, it never passes through. A `session` key in a project stratum.toml is a config
 * error naming that file. Nothing here throws.
 */
export interface SessionConfig {
  readonly configured: boolean;
  /** The user config file consulted (STRATUM_CONFIG_FILE if non-empty, else ~/.stratum/config.toml). */
  readonly userPath: string;
  /** Effective scripts dir (env wins over the user file); null when neither names one. */
  readonly scriptsDir: string | null;
  readonly scriptsDirSource: "env" | "user" | null;
  /** Effective python (env > user file > "python3"). */
  readonly python: string;
  /** A configuration error: the door is broken, never pass-through. */
  readonly error: string | null;
}

export function sessionUserConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.STRATUM_CONFIG_FILE || join(homedir(), ".stratum", "config.toml");
}

export function loadSessionConfig(options: LoadSessionConfigOptions = {}): SessionConfig {
  const env = options.env ?? process.env;
  const userPath = sessionUserConfigPath(env);
  const errors: string[] = [];
  let fileConfigured = false;
  let fileScriptsDir: string | null = null;
  let filePython: string | null = null;

  if (existsSync(userPath)) {
    let raw: unknown;
    let text: string | null = null;
    try {
      text = readFileSync(userPath, "utf8");
      raw = parse(text);
    } catch (error) {
      // Unreadable: we cannot tell whether it holds [session], so it is configured-and-broken
      // (fixture row "file unreadable"). Readable but not TOML: configured-and-broken when the
      // text could spell a `session` key (the word, or a \u / \U escape in a quoted key);
      // text that can spell no such key cannot configure the door, so it stays unconfigured.
      // This keeps "Stratum configured => Compose configured" (contract configured_test.fixtures).
      if (text === null || mayNameSession(text)) {
        fileConfigured = true;
        errors.push(`${userPath}: cannot read session config: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (isRecord(raw) && Object.prototype.hasOwnProperty.call(raw, "session")) {
      fileConfigured = true;
      const table = raw.session;
      if (!isRecord(table)) {
        errors.push(`${userPath}: session must be a table`);
      } else {
        const unknown = Object.keys(table).find((key) => !(SESSION_KEYS as readonly string[]).includes(key));
        if (unknown !== undefined) errors.push(`${userPath}: unknown config key ${JSON.stringify(`session.${unknown}`)}`);
        if (table.scripts_dir !== undefined) {
          if (typeof table.scripts_dir !== "string") errors.push(`${userPath}: session.scripts_dir must be a string`);
          else fileScriptsDir = table.scripts_dir;
        }
        if (table.python !== undefined) {
          if (typeof table.python !== "string" || table.python === "") errors.push(`${userPath}: session.python must be a non-empty string`);
          else filePython = table.python;
        }
      }
    }
  }

  const projectError = projectSessionCheck(join(options.projectRoot ?? process.cwd(), "stratum.toml"));
  if (projectError !== null) errors.push(projectError);

  const envDir = env[SESSION_SCRIPTS_DIR_ENV];
  const envConfigured = typeof envDir === "string" && envDir !== "";
  const envPython = env[SESSION_PYTHON_ENV];
  return Object.freeze({
    configured: envConfigured || fileConfigured,
    userPath,
    scriptsDir: envConfigured ? envDir : fileScriptsDir,
    scriptsDirSource: envConfigured ? "env" as const : fileScriptsDir !== null ? "user" as const : null,
    python: typeof envPython === "string" && envPython !== "" ? envPython : filePython ?? "python3",
    error: errors.length > 0 ? errors.join("; ") : null,
  });
}

/** True when TOML text could hold a `session` key: the word itself, or a unicode escape that could spell it. */
function mayNameSession(text: string): boolean {
  return text.includes("session") || text.includes("\\u") || text.includes("\\U");
}

function projectSessionError(path: string): string {
  return `${path}: [session] is not allowed in a project stratum.toml; set it in the user config (STRATUM_CONFIG_FILE or ~/.stratum/config.toml)`;
}

/**
 * A project file never supplies session settings. One that parses and holds a `session`
 * key is a config error naming the file. One that does not parse cannot supply anything to
 * the door either (it is never read for session values), so its parse error stays the
 * sandbox loader's to report.
 */
function projectSessionCheck(path: string): string | null {
  if (!existsSync(path)) return null;
  let raw: unknown;
  try {
    raw = parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  return isRecord(raw) && Object.prototype.hasOwnProperty.call(raw, "session") ? projectSessionError(path) : null;
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
