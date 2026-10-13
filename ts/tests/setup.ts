import { isolatedStateRoot } from "./helpers/state-root.js";
import { join } from "node:path";

// Always replace an inherited root: it may belong to a live Stratum session.
// MCP/CLI defaults and their children inherit this per-test-file store. Direct
// StratumEngine/StateStore constructors still require an explicit test root.
process.env.STRATUM_STATE_ROOT = isolatedStateRoot();
// Claude's attribution index is durable state too. Override even a live inherited
// index path, and let the same per-file fixture remove it after workers settle.
process.env.DETACH_CLAUDE_INDEX_DIR = join(process.env.STRATUM_STATE_ROOT, "claude-session-index");
