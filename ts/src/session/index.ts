import { loadSessionConfig } from "../config/index.js";
import type { SessionBackend, SessionOp } from "./backend.js";
import { ScriptsBackend } from "./scripts-backend.js";

export * from "./backend.js";
export { configured } from "./configured.js";
export { MARKER_CAP_BYTES, OP_TIMEOUT_S, STRIPPED_ENV, scriptEnv } from "./scripts-backend.js";

export interface CreateSessionBackendOptions {
  /** The front door's own env (default process.env). */
  readonly env?: NodeJS.ProcessEnv;
  /** Overrides the user config path (as STRATUM_CONFIG_FILE would). */
  readonly configPath?: string;
  /** Where a project stratum.toml is checked for a forbidden [session] (default process.cwd()). */
  readonly projectRoot?: string;
  /** Test seam: per-op timeout override in milliseconds. */
  readonly timeoutsMs?: Partial<Record<SessionOp, number>>;
}

/**
 * contract `library.exports`. The configuration is read once, here: not configured gives a
 * backend whose `kind` is 'none' (admit passes through, other ops refuse
 * `backend-unconfigured`); configured gives 'scripts', where every failure refuses.
 */
export function createSessionBackend(options: CreateSessionBackendOptions = {}): SessionBackend {
  const env = options.env ?? process.env;
  const configEnv = options.configPath !== undefined ? { ...env, STRATUM_CONFIG_FILE: options.configPath } : env;
  const config = loadSessionConfig({ env: configEnv, ...(options.projectRoot !== undefined ? { projectRoot: options.projectRoot } : {}) });
  return new ScriptsBackend({ env, config, ...(options.timeoutsMs !== undefined ? { timeoutsMs: options.timeoutsMs } : {}) });
}
