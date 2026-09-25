#!/usr/bin/env node
/** Offline deterministic adapter. Raw files are the unmodified default generate-ts output. */
import { createHash } from 'node:crypto';
import { readFile, writeFile, readdir, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
export const fixtureDir = join(root, 'contracts/codex-appserver/0.155.1');
const outputDir = join(root, 'src/connectors/codex-appserver-protocol');
export const sha256 = value => createHash('sha256').update(value).digest('hex');
export async function listFiles(dir, prefix = '') {
  const files = [];
  for (const entry of await readdir(join(dir, prefix), { withFileTypes: true })) {
    const name = posix.join(prefix, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(dir, name));
    else files.push(name);
  }
  return files.sort();
}
const imports = /\b(?:import|export)\s+type\b[^;]*?\bfrom\s+["'](\.[^"']+)["']/g;
export function normalizeImports(source) {
  return source.replace(imports, (statement, specifier) => statement.replace(specifier, `${specifier}.js`));
}
export async function checkContract(rawDir = fixtureDir, adaptedDir = outputDir, write = false) {
  const manifest = JSON.parse(await readFile(join(rawDir, 'manifest.json'), 'utf8'));
  if (manifest.version !== '0.155.1' || manifest.generator !== 'codex app-server generate-ts --out <directory>') {
    throw new Error('Unsupported contract manifest');
  }
  const names = (await listFiles(rawDir)).filter(name => name !== 'manifest.json');
  const sources = new Map();
  for (const name of names) {
    const source = await readFile(join(rawDir, name), 'utf8');
    if (sha256(source) !== manifest.sha256[name]) throw new Error(`Raw fixture hash mismatch: ${name}`);
    sources.set(name, source);
  }
  const closure = new Set();
  function visit(name) {
    if (closure.has(name)) return;
    const source = sources.get(name);
    if (source === undefined) throw new Error(`Missing type dependency: ${name}`);
    closure.add(name);
    for (const match of source.matchAll(imports)) visit(posix.normalize(posix.join(posix.dirname(name), `${match[1]}.ts`)));
  }
  for (const name of manifest.entrypoints) visit(name);
  if (JSON.stringify(names) !== JSON.stringify([...closure].sort())) throw new Error('Raw fixture inventory mismatch');
  const outputs = new Map([...closure].sort().map(name => [name, normalizeImports(sources.get(name))]));
  outputs.set('pinned-version.ts', `// Generated from the immutable contract manifest by pin-codex-appserver.mjs.\nexport const PINNED_APP_SERVER_VERSION = ${JSON.stringify(manifest.version)} as const;\nexport const PINNED_MANIFEST_SHA256 = ${JSON.stringify(sha256(await readFile(join(rawDir, 'manifest.json'))))} as const;\n`);
  if (write) {
    for (const [name, source] of outputs) {
      await mkdir(dirname(join(adaptedDir, name)), { recursive: true });
      await writeFile(join(adaptedDir, name), source);
    }
  }
  if (JSON.stringify(await listFiles(adaptedDir)) !== JSON.stringify([...outputs.keys()].sort())) throw new Error('Adapted fixture inventory mismatch');
  for (const [name, source] of outputs) {
    if (await readFile(join(adaptedDir, name), 'utf8') !== source) throw new Error(`Adapted fixture differs beyond import normalization: ${name}`);
  }
  return { version: manifest.version, rawFiles: names.length, fullGeneratedFiles: Object.keys(manifest.sha256).length, adaptedFiles: outputs.size };
}
/** Compare the entire generator output, including files outside the stored closure. */
export async function checkGenerated(generatedDir, rawDir = fixtureDir) {
  const manifest = JSON.parse(await readFile(join(rawDir, 'manifest.json'), 'utf8'));
  const names = await listFiles(generatedDir);
  if (JSON.stringify(names) !== JSON.stringify(Object.keys(manifest.sha256).sort())) throw new Error('Generated inventory mismatch');
  for (const name of names) {
    if (sha256(await readFile(join(generatedDir, name))) !== manifest.sha256[name]) throw new Error(`Generated hash mismatch: ${name}`);
  }
  return names.length;
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const [mode, flag] = process.argv.slice(2);
  if (!['--check', '--write'].includes(mode) || (flag !== undefined && !(mode === '--check' && flag === '--regenerate')) || process.argv.length > 4) {
    throw new Error('Usage: pin-codex-appserver.mjs --check [--regenerate]|--write');
  }
  const result = await checkContract(fixtureDir, outputDir, mode === '--write');
  if (flag === '--regenerate') {
    const dir = await mkdtemp(join(tmpdir(), 'codex-appserver-regenerate-'));
    try {
      const version = execFileSync('codex', ['--version'], {encoding:'utf8'}).trim();
      if (version !== `codex-cli ${result.version}`) throw new Error(`Unsupported generator version: ${version}`);
      execFileSync('codex', ['app-server', 'generate-ts', '--out', dir], {stdio:'inherit'});
      result.regeneratedFiles = await checkGenerated(dir);
    } finally { await rm(dir, {recursive:true, force:true}); }
  }
  console.log(JSON.stringify(result));
}
