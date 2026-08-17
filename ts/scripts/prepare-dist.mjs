import { chmod, copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";

if (process.argv[2] === "--clean") {
  await rm(new URL("../dist/", import.meta.url), { recursive: true, force: true });
  process.exit(0);
}

const sourceShebang = "#!/usr/bin/env -S node --experimental-strip-types";
const distShebang = "#!/usr/bin/env node";
const entries = [
  new URL("../dist/cli/stratum.js", import.meta.url),
  new URL("../dist/mcp/main.js", import.meta.url),
];

for (const entry of entries) {
  const source = await readFile(entry, "utf8");
  if (!source.startsWith(`${sourceShebang}\n`)) {
    throw new Error(`Unexpected compiled bin shebang: ${entry.pathname}`);
  }
  await writeFile(entry, `${distShebang}${source.slice(sourceShebang.length)}`);
  await chmod(entry, 0o755);
}

// Every compiled module that reads a shipped contract: in the source tree the
// path is `../../contracts/` (src/<dir>/ -> ts/contracts/), and in dist it is
// `../contracts/` (dist/<dir>/ -> dist/contracts/). Each entry is asserted, so
// adding a contract reader without listing it here fails the build rather than
// shipping a package whose contract file cannot be found at runtime.
const sourceContractPath = "../../contracts/";
for (const relative of ["../dist/mcp/contracts.js", "../dist/guard/descriptors.js"]) {
  const compiled = new URL(relative, import.meta.url);
  const compiledSource = await readFile(compiled, "utf8");
  if (!compiledSource.includes(sourceContractPath)) {
    throw new Error(`Unexpected compiled contract path: ${compiled.pathname}`);
  }
  await writeFile(compiled, compiledSource.replaceAll(sourceContractPath, "../contracts/"));
}

const distContracts = new URL("../dist/contracts/", import.meta.url);
await mkdir(distContracts, { recursive: true });
for (const name of ["events.json", "mcp-surface.json", "guard-signers.allowed"]) {
  await copyFile(new URL(`../contracts/${name}`, import.meta.url), new URL(name, distContracts));
}
