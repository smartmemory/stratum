// claude-bg-worker-hooks.mjs
// Synchronous loader hooks for the claude background worker.
// Loaded via --import flag in the Worker's execArgv:
//   execArgv: ['--import', fileURLToPath(new URL("./claude-bg-worker-hooks.mjs", import.meta.url))]
//
// Two responsibilities:
//   1. resolve: remap ./foo.js → ./foo.ts for local project files when the .ts exists
//   2. load: read .ts files directly and strip TypeScript types before returning JS source
//
// Using readFileSync + shortCircuit:true bypasses nextLoad() entirely for .ts files,
// avoiding a Node.js built-in loader rejection on non-.ts format expectations.
//
// This module is a .mjs file (plain ES module) so the Worker can load it as a bootstrap
// without any TypeScript transformation needed on this file itself.
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

registerHooks({
  // Remap specifiers ending in .js to .ts when a sibling .ts file exists.
  // Guards: only apply when parentURL is present (i.e. import inside a module,
  // not the entry point — entry point is .ts already), and never for node: builtins
  // or node_modules paths.
  resolve(specifier, context, nextResolve) {
    if (
      specifier.endsWith(".js") &&
      context.parentURL &&
      !specifier.startsWith("node:") &&
      !specifier.includes("node_modules")
    ) {
      const tsSpecifier = specifier.replace(/\.js$/, ".ts");
      try {
        const tsUrl = new URL(tsSpecifier, context.parentURL);
        if (existsSync(fileURLToPath(tsUrl))) {
          return nextResolve(tsSpecifier, context);
        }
      } catch {
        // URL construction failed (e.g. absolute path) — fall through to default
      }
    }
    return nextResolve(specifier, context);
  },

  // Load .ts files by reading them synchronously and stripping TypeScript type
  // annotations. shortCircuit:true skips all subsequent hooks (including the
  // default Node.js loader which would reject .ts format on older Node versions).
  load(url, context, nextLoad) {
    if (url.endsWith(".ts")) {
      try {
        const source = readFileSync(fileURLToPath(url), "utf8");
        return {
          format: "module",
          source: stripTypeScriptTypes(source),
          shortCircuit: true,
        };
      } catch {
        // Fall through to nextLoad if readFileSync fails (e.g. path conversion error)
      }
    }
    return nextLoad(url, context);
  },
});
