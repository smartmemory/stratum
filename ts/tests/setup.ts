import { isolatedStateRoot } from "./helpers/state-root.js";

// Always replace an inherited root: it may belong to a live Stratum session.
// MCP/CLI defaults and their children inherit this per-test-file store. Direct
// StratumEngine/StateStore constructors still require an explicit test root.
process.env.STRATUM_STATE_ROOT = isolatedStateRoot();
