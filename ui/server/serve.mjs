#!/usr/bin/env node
// Standalone Stratum UI server. Binds 127.0.0.1 only.
//
//   node ui/server/serve.mjs --port <n> [--flows-dir <dir>] [--stratum-bin <path>] [--static <dir>]
//                            [--engine-dist <dir>] [--plan-scratch <dir>]
//
// --flows-dir   run files (default $STRATUM_STATE_ROOT, else ~/.stratum/ts/flows). Read-only.
// --stratum-bin the stratum CLI used for `query gates` and `gate` (default ../../ts/dist/cli/stratum.js;
//               build it with `cd ts && npm run build`). A .js path runs under this node.
// --static      a built shell (`npm run build:shell` → ui/dist-shell) to serve at /. Omit when using `vite` dev.
// --engine-dist the built engine for the builder's validate / dry plan (default ../../ts/dist).
// --plan-scratch parent dir for the dry plan's throwaway state dirs (default the OS temp dir).
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createHandler } from "./handler.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};

const port = Number(flag("--port") ?? process.env.STRATUM_UI_PORT);
if (!Number.isInteger(port) || port <= 0) {
  process.stderr.write("stratum-ui: --port <n> is required (reserve one with ~/.claude/scripts/port_check.py)\n");
  process.exit(2);
}
const flowsDir = resolve(flag("--flows-dir") ?? process.env.STRATUM_STATE_ROOT ?? join(homedir(), ".stratum", "ts", "flows"));
const stratumBin = resolve(flag("--stratum-bin") ?? process.env.STRATUM_UI_STRATUM_BIN ?? join(here, "..", "..", "ts", "dist", "cli", "stratum.js"));
const staticDir = flag("--static");
if (!existsSync(stratumBin)) process.stderr.write(`stratum-ui: warning: stratum CLI not found at ${stratumBin}; gates will fail\n`);
const engineDist = resolve(flag("--engine-dist") ?? process.env.STRATUM_UI_ENGINE_DIST ?? join(here, "..", "..", "ts", "dist"));
const engineFound = existsSync(join(engineDist, "ir", "validate.js"));
if (!engineFound) process.stderr.write(`stratum-ui: warning: built engine not found at ${engineDist}; builder validate/plan disabled\n`);
const planScratch = flag("--plan-scratch");

const host = "127.0.0.1";
const handler = createHandler({
  flowsDir,
  stratumBin,
  staticDir: staticDir ? resolve(staticDir) : undefined,
  allowedHosts: [`${host}:${port}`, `localhost:${port}`],
  engineDist: engineFound ? engineDist : undefined,
  planScratch: planScratch ? resolve(planScratch) : undefined,
});
const server = createServer((req, res) => void handler(req, res));
server.listen(port, host, () => {
  process.stdout.write(`stratum-ui listening on http://${host}:${port} (flows ${flowsDir})\n`);
});
// Close the run watcher and any open live streams, then exit (stream sockets would hold server.close()).
const shutdown = () => {
  handler.close();
  server.close(() => process.exit(0));
  server.closeAllConnections();
};
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, shutdown);
process.on("exit", () => handler.close());
