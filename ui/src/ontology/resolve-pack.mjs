/**
 * resolve-pack — where Stratum finds the project ontology pack (FORGE-ONTOLOGY-READY-1). Node only: tests and tooling
 * call it; the browser bundle imports `./index` (types, names, JSON Schemas) and never this file.
 *
 * A copy of forge/compose `lib/ontology/resolve-pack.js` (the same lookup as Compose's `lib/wiki-components-link.js`): an env override, then the sibling SmartMemory checkout.
 * Order, first hit wins:
 *   1. `PROJECT_ONTOLOGY_PACK` — a pack dir (holding `pack.json`) or a pack JSON file; `none` forces "absent".
 *   2. core's generated output (ONTO-PROJECT-PACK-1 phase B): `<core>/<PACK_DIR>/generated/` next to `pack.json`.
 *   3. core's pack (phase A): `<core>/<PACK_DIR>/pack.json`.
 *   4. the draft contract: `SmartMemory/contracts/project-ontology-bundle.v1.json`.
 * The SmartMemory checkout is found by walking up from this file, so a worktree at any depth resolves the same way.
 *
 * Absent is never silent: it returns null after a WARNING naming what is lost (the stub's drift check). The stub in
 * `pack.generated` still loads, so a build without SmartMemory on disk (CI, a published package) keeps working.
 *
 * Kept identical to the Compose copy (Stratum ships as its own package and cannot import across repos); the seam test
 * pins it the same way.
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PACK_DIR = ['smartmemory', 'ontology', 'packs', 'project-ontology', '1.0.0'];
export const DRAFT = ['contracts', 'project-ontology-bundle.v1.json'];

const isFile = (p) => { try { return statSync(p).isFile(); } catch { return false; } };
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };

/** The nearest `SmartMemory` checkout above `start` (or `start`'s own ancestor named so), or null. */
export function findSmartMemoryRoot(start = HERE) {
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    for (const cand of [join(dir, 'SmartMemory'), dir]) {
      if (isDir(join(cand, 'smart-memory-core')) || isFile(join(cand, ...DRAFT))) return cand;
    }
    if (dirname(dir) === dir) return null;
  }
}

function described(source, packFile, generatedDir) {
  const bytes = readFileSync(packFile);
  return { source, packFile, generatedDir, sha256: createHash('sha256').update(bytes).digest('hex'), pack: JSON.parse(bytes.toString('utf8')) };
}

/**
 * @returns {{source: 'env'|'generated'|'pack'|'draft', packFile: string, generatedDir: string|null, sha256: string, pack: object}|null}
 */
export function resolveOntologyPack(env = process.env, { start = HERE, warn = console.warn } = {}) {
  const raw = env.PROJECT_ONTOLOGY_PACK;
  if (raw === 'none') {
    warn('WARNING: project ontology pack forced absent (PROJECT_ONTOLOGY_PACK=none); the ontology stub is not checked for drift');
    return null;
  }
  if (raw) {
    const file = isDir(raw) ? join(raw, 'pack.json') : raw;
    if (isFile(file)) return described('env', resolve(file), null);
    warn(`WARNING: PROJECT_ONTOLOGY_PACK=${raw} holds no pack JSON; the ontology stub is not checked for drift`);
    return null;
  }
  const sm = findSmartMemoryRoot(start);
  if (sm) {
    const packDir = join(sm, 'smart-memory-core', ...PACK_DIR);
    const generated = join(packDir, 'generated');
    if (isFile(join(packDir, 'pack.json'))) {
      const hasGenerated = isDir(generated) && readdirSync(generated).some((n) => n.endsWith('.d.ts'));
      return described(hasGenerated ? 'generated' : 'pack', join(packDir, 'pack.json'), hasGenerated ? generated : null);
    }
    if (isFile(join(sm, ...DRAFT))) return described('draft', join(sm, ...DRAFT), null);
  }
  warn('WARNING: project ontology pack not found (no SmartMemory checkout above this file, PROJECT_ONTOLOGY_PACK unset); '
    + 'the ontology stub is not checked for drift');
  return null;
}
