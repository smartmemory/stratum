import { loadSessionConfig } from "../config/index.js";

/**
 * contract `backend.configured_test.rule`: true when STRATUM_SESSION_SCRIPTS_DIR is a
 * non-empty string, or the Stratum USER config file (STRATUM_CONFIG_FILE if non-empty,
 * else ~/.stratum/config.toml) holds a `session` key, or that file exists but cannot be
 * read or parsed (configured-and-broken). Nothing else makes it true or false.
 *
 * Not configured: admit passes through, every other op is `backend-unconfigured`.
 * Configured: every failure refuses (configured-but-broken = `backend-unavailable`).
 */
export function configured(env: NodeJS.ProcessEnv = process.env): boolean {
  return loadSessionConfig({ env }).configured;
}
