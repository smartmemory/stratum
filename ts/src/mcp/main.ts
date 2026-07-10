#!/usr/bin/env -S node --experimental-strip-types
import { serveStdio } from "./server.js";

void serveStdio().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
