# STRAT-CONFIG-MODELS-1 — model catalog and defaults become configuration

**Status:** PLANNED · **Created:** 2026-09-30 · **Complexity:** M

## Related Documents

- Related: [STRAT-CONFIG-PREFS-1](../STRAT-CONFIG-PREFS-1/design.md) (`stratum.toml` layered resolver, COMPLETE). Deliberately NOT extended, see review history.
- Preserves: [STRAT-AGENT-RUN-MODEL-VALIDATE](../STRAT-AGENT-RUN-MODEL-VALIDATE/design.md) (reject unknown model ids before dispatch: COMPLETE)
- Consumer: compose `server/model-tiers.js` (`CODEX_MODEL_TIERS`, `MODEL_TIERS`, `DEVIN_MODEL_TIERS`)

## Why

The owner asked on 2026-09-30: "why do we have to do so much coding? can't we just configure new
models and defaults?" Today we can't. A model bump is a code change plus a test rewrite:

| Bump | Real setting lines | Total diff |
|---|---|---|
| gpt-6-sol medium→high, compose `3fc49ca` | 1 (`server/model-tiers.js`) | 11 files, +691/−33 (three re-recorded baselines) |
| gpt-6-sol medium→high, stratum `ba8ae89` | 2 | 5 files |
| gpt-6.1-sol default, stratum `24eb3d8` | 3 + 1 price row | 9 files |
| gpt-6.1-sol standard tier, compose (2026-09-30) | 1 | 15 files + 3 new baseline fixtures |

The model id is hardcoded in four source places:

- `ts/src/judge/pricing.ts` `MODEL_PRICING`. This is also the dispatch allowlist (`dispatchableModels()`).
- `ts/src/connectors/codex.ts` `defaultCodexModel()`. `CODEX_MODEL` env overrides this, and it is the only existing config hook.
- `ts/src/judge/judged.ts` `STAKES_MODEL`
- compose `server/model-tiers.js` `CODEX_MODEL_TIERS` (and the Claude/Devin tier maps beside it)

Tests then assert those literals, and route baselines embed them, so every bump fans out.

## Prior art checked (2026-09-30)

- `ls docs/features | grep -i 'config\|model\|catalog'`: STRAT-CONFIG-PREFS-1/2, STRAT-AGENT-RUN-MODEL-VALIDATE. No existing model-config feature.
- `ts/src/config/index.ts` `loadStratumConfig()`: resolves defaults < `~/.stratum/config.toml` (or `STRATUM_CONFIG_FILE`) < project `stratum.toml` < dispatch < env, with per-key provenance. It covers **sandbox policy only**, with no model keys. Unknown TOML content is fatal.
- `grep -rn CODEX_MODEL ts/src`: one site, `codex.ts:128`.

## Design

**Review history:** round 1 (Codex `gpt-6.1-sol/high`, 2026-09-30) returned NOT CLEAN, 4 HIGH + 1 MEDIUM, all upheld.
Round 2 (same model): all five RESOLVED, one new MEDIUM (Devin model/effort pair validation), fixed inline in D2 as prescribed.
The draft's user/project TOML layering (old D2) was cut, because model resolution has no project context
(`codex.ts:649` takes neither cwd nor env; `pricing.ts:83` and `judged.ts:62` are global tables), so an
import-time catalog resolved against process cwd could pick the wrong project's models. The goal is a
one-file *shipped* edit, and that does not need runtime layering. `CODEX_MODEL` stays as today's only override.

### D1. One shipped catalog file holds every model default, complete

`ts/src/config/models.default.toml` (new, copied into `dist/` by `scripts/prepare-dist.mjs`). A tier
entry carries **model, effort and thinking mode together**, because compose resolves thinking/effort
from separate hardcoded maps today (`model-tiers.js:54`, `:65`, `:82`, `:108`) and a medium→high bump
must also be a data edit (review #4).

```toml
[codex]
default = { model = "gpt-6.1-sol", effort = "high" }       # was defaultCodexModel()

[judge]                                                       # was STAKES_MODEL
cheap    = { model = "gpt-6-luna",  effort = "low" }
default  = { model = "gpt-6.1-sol", effort = "high" }
paranoid = { model = "gpt-6-astra", effort = "high" }

[tiers.codex]                                                 # was CODEX_MODEL_TIERS + its thinking map
critical    = { model = "gpt-6-astra", effort = "high" }
standard    = { model = "gpt-6.1-sol", effort = "high" }
fast        = { model = "gpt-6-luna",  effort = "medium" }
budget      = { model = "gpt-6-luna",  effort = "low" }
coordinator = "unavailable"                                   # was null; key kept (review #3)

[tiers.claude]   # MODEL_TIERS + its thinking map, same shape, incl. thinking `mode`
[tiers.devin]    # DEVIN_MODEL_TIERS + DEVIN_TIER_THINKING, same shape

[pricing.codex."gpt-6.1-sol"]                                 # was MODEL_PRICING
input = 2
output = 10
cache_read = 0.1

[pricing.devin."swe-2-high"]                                  # was DEVIN_MODEL_PRICING; zero is legal
input = 0
output = 0
cache_read = 0
```

(Effort values in the example are illustrative. The implementation copies today's values exactly.)

### D2. Allowlists stay per provider

`pricing.codex` feeds `dispatchableModels()`, and `pricing.devin` feeds the devin allowlist. They never
mix, so moving Devin into the file cannot widen Codex's allowlist (review #3). Claude tiers are
validated against a `[models.claude]` name list, not a price table, because Claude pricing is not
stratum's concern today. `"unavailable"` keeps the tier key, because `agent-string.js:29` derives the
tier vocabulary from map keys.

Devin entries are validated as a **pair**, not field by field: loading passes each Devin tier's
`{model, effort}` through the real Devin resolver (`devin-model.ts:108`), because `swe-2-high` +
`medium` passes both membership checks yet is rejected at dispatch (round 2 finding, probe-confirmed).

STRAT-AGENT-RUN-MODEL-VALIDATE is preserved: dispatchable means present in that provider's pricing
and not `retired`. Loading the file fails fast if a default or tier names a model that is missing
from its provider's list.

### D3. Thin adapters, same exports

`MODEL_PRICING`, `RETIRED_MODELS`, `DEVIN_MODEL_PRICING`, `STAKES_MODEL`, `defaultCodexModel()` and
compose's `MODEL_TIERS`/`CODEX_MODEL_TIERS`/`DEVIN_MODEL_TIERS`/thinking maps keep their names and
shapes, derived from the parsed file at import. The file is immutable, so there is exactly one catalog
per installation and no context plumbing.

### D4. The catalog is bound to the engine compose actually runs

Compose can run stratum from `$COMPOSE_STRATUM_*_BIN`, an installed package, or a sibling checkout
(`stratum-engine.js:213`, review #5). Compose must read the catalog **from the same installation
`resolveStratumBin` selects**, via a `stratum models --json` CLI subcommand (new), not a separate
package import that could resolve elsewhere. The output carries a `catalogDigest` (sha256 of the file)
and the installation path. Compose records both in routing provenance and in baseline provenance.

### D5. Tests stop hardcoding model ids, including through digests

- **Behavior tests** read expectations from the parsed catalog, never a literal.
- **One contract test** pins the shipped file: it parses, every default and tier names a model in its provider's list or is `"unavailable"`, prices are ≥0, effort values are in the allowlist, and every tier key the old maps had still exists.
- **Route baselines** store a symbolic projection: model ids, efforts and thinking modes are replaced by `<provider:tier>` tokens. `profilesDigest` comparisons in tests (`build-wave-golden.test.js:276`, `:301`) use a digest computed over that same projection (review #1). Production `profilesDigest` stays concrete, so real routing drift is still detected, and a dedicated test asserts the concrete digest changes when the catalog changes.
- The recorder (`record-model-route-baselines.mjs`) writes the projection and records `catalogDigest`.

## Acceptance criteria

- [ ] `ts/src/config/models.default.toml` (new) holds every Codex default, judge tier, Codex/Claude/Devin tier (model + effort + thinking mode, `"unavailable"` for today's `null`), and Codex/Devin price rows, copying today's values exactly.
- [ ] `grep -rnE '"(gpt|swe|claude)-' ts/src compose/server compose/lib --include=*.ts --include=*.js` finds no model literals outside the loader and the file.
- [ ] The file ships in `dist/`, verified with `npm pack` (not the manifest).
- [ ] Catalog load and the contract test validate every Devin tier's `{model, effort}` pair through `devin-model.ts`'s resolver. A test proves a mismatched pair fails at load.
- [ ] Codex and Devin allowlists stay separate. A test proves a Devin model is not Codex-dispatchable.
- [ ] Load fails fast, naming the accepted list, when a default or tier names an unknown or retired model, or an effort is outside the allowlist.
- [ ] All existing exports in stratum and compose keep their names and shapes.
- [ ] `stratum models --json` (new) returns the catalog, `catalogDigest` and installation path. Compose reads tiers only through it, from the `resolveStratumBin`-selected install.
- [ ] Baselines and test-side digest assertions use the symbolic projection. Re-record once. The concrete production digest is kept and tested for drift.
- [ ] **Proof, in the implementation report:** two scratch bumps, (a) `tiers.codex.fast` model and (b) `tiers.codex.standard` effort, each touching only `models.default.toml`, with both suites' touched-area tests passing unmodified.

## Out of scope

- User/project-level model overrides in `stratum.toml` (cut in round 1; see review history). A possible follow-up once model resolution carries execution context.
- Fetching prices from OpenAI or LiteLLM at runtime.

## Open question

None blocking. Whether per-user overrides are worth the context plumbing is deferred until someone
needs to run a model the shipped file doesn't list yet. Today `CODEX_MODEL` covers the default for that.
