import { chmod, copyFile, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";

if (process.argv[2] === "--clean") {
  await rm(new URL("../dist/", import.meta.url), { recursive: true, force: true });
  process.exit(0);
}

const sourceShebang = "#!/usr/bin/env -S node --experimental-strip-types";
const distShebang = "#!/usr/bin/env node";
const entries = [
  new URL("../dist/connectors/codex-appserver-driver.js", import.meta.url),
  new URL("../dist/connectors/peer-sidecar.js", import.meta.url),
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
for (const relative of ["../dist/mcp/contracts.js", "../dist/guard/trust.js"]) {
  const compiled = new URL(relative, import.meta.url);
  const compiledSource = await readFile(compiled, "utf8");
  if (!compiledSource.includes(sourceContractPath)) {
    throw new Error(`Unexpected compiled contract path: ${compiled.pathname}`);
  }
  await writeFile(compiled, compiledSource.replaceAll(sourceContractPath, "../contracts/"));
}

const distContracts = new URL("../dist/contracts/", import.meta.url);
await mkdir(distContracts, { recursive: true });
for (const name of ["events.json", "mcp-surface.json"]) {
  await copyFile(new URL(`../contracts/${name}`, import.meta.url), new URL(name, distContracts));
}

// The trust root is the one contract whose committed contents are LOCAL state:
// this checkout is its own install site, so an operator enrolled here has their
// public key in `contracts/guard-signers.allowed` and needs it in dist for the
// symlinked-consumer path to verify. A published package must not carry it -
// "empty by default, there is no default trust" is the whole design, and a
// tarball that trusts this machine's operator would trust them on every
// installer's machine too. `npm run release` sets the flag; a plain build keeps
// the local enrolment.
{
  const source = await readFile(new URL("../contracts/guard-signers.allowed", import.meta.url), "utf8");
  const shipped = process.env.STRATUM_TRUST_ROOT_EMPTY === "1"
    ? source.split("\n").filter((line) => line.trim() === "" || line.startsWith("#")).join("\n")
    : source;
  await writeFile(new URL("guard-signers.allowed", distContracts), shipped);
}

// Generated protocol types have no runtime behavior. Fail closed if a binding
// ever starts emitting executable code; retain the pinned version module.
async function removeProtocolStubs(directory) {
  for (const entry of await readdir(directory, {withFileTypes:true})) {
    const file = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
    if (entry.isDirectory()) {
      await removeProtocolStubs(file);
    } else if (entry.name.endsWith(".js") && entry.name !== "pinned-version.js") {
      const source = await readFile(file, "utf8");
      const body = source.replace(/\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, "").trim();
      if (!/^export\s*\{\s*\}\s*;?$/.test(body)) {
        throw new Error(`Protocol binding is not an empty type-only module: ${file.pathname}`);
      }
      await rm(file);
      await rm(new URL(`${entry.name}.map`, directory), {force:true});
    }
  }
}
await removeProtocolStubs(new URL("../dist/connectors/codex-appserver-protocol/", import.meta.url));
