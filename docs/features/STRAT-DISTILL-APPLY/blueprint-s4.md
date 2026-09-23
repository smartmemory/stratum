# STRAT-DISTILL-APPLY — S4 implementation blueprint

Status: plan only. This document specifies future S4 work. S4 assumes the S1 protocol, S2 `distill-2.1` candidate/legacy-row reader, and S3 asset adapter are already present with their settled corrections. S4 adds only CLI wiring, CLI/contract/golden-flow tests and fixtures, the MCP description, and the CHANGELOG entry. It adds no MCP mutation surface and no runtime dependency.

## A. CLI surface

### Command grammar and help

Keep `extract`, `top`, and `stats` behavior unchanged. Extend `distillCommand` with four separately parsed asset actions. The exact new grammar is:

```text
stratum distill list
stratum distill apply <revision-id> [--root <dir>] [--trust-source]
stratum distill revert <apply-id>
stratum distill reconcile
```

`stratum distill --help` writes the following to stdout and returns `0`:

```text
Usage:
  stratum distill extract [--root <dir>] [--project <dir> | --all --projects-root <dir>] [--min-count <n>] [--window-days <n>] [--json]
  stratum distill top [--root <dir>] [--project <dir> | --all --projects-root <dir>] [--min-count <n>] [--window-days <n>] [--n <n>] [--json]
  stratum distill stats [--root <dir>] [--project <dir> | --all --projects-root <dir>] [--min-count <n>] [--window-days <n>] [--json]
  stratum distill list
  stratum distill apply <revision-id> [--root <dir>] [--trust-source]
  stratum distill revert <apply-id>
  stratum distill reconcile

Asset apply is disabled unless STRATUM_DISTILL_APPLY_ENABLED=1.
--trust-source is required for explicit-project and projects-root revisions.
Agent harnesses can deny Bash(stratum distill apply*) in Claude Code settings.
```

`ts/src/cli/learn.ts` is the sibling CLI examined for the command-handler convention. In particular, its `apply`, `revert`, and `reconcile` handlers return `0` on success, `2` for usage/ambiguous input, and `1` for an operational refusal or failure; success goes to stdout and failures go to stderr. S4 follows that exit/output convention while retaining `distill.ts`'s stricter duplicate/unsupported-option checks. Existing `extract`/`top`/`stats` error text is not changed.

For all four new actions, `applyRoot` is the canonical absolute realpath of the selected root. `apply` selects `--root <dir>` or `process.cwd()`; `list`, `revert`, and `reconcile` use `process.cwd()` because D4 exposes no `--root` option for those verbs. A missing, unreadable, or non-directory root is an operational error, exit `1`.

The asset-action parser has these exact rules:

- Options may appear before or after the one positional ID for `apply`. Only `--root <dir>` and `--trust-source` are accepted there.
- `--root` requires one following value which is neither empty nor another option. Duplicate `--root`, duplicate `--trust-source`, `--root=<dir>`, bare `--`, unknown options, and options on `list`, `revert`, or `reconcile` are syntax errors.
- `apply` requires exactly one lowercase hexadecimal revision selector of length 1–64. Prefixes are intentional because `list` prints 12 hexadecimal characters. `revert` requires exactly one full 32-character lowercase hexadecimal apply id. Extra positionals are syntax errors.
- A syntax error writes `stratum distill: <problem>\n` followed by the complete help block above to stderr and returns `2`. No adapter or sidecar function is called after a syntax error.
- Asset operational errors write exactly `<error.message>\n` to stderr and return `1`; this preserves the sibling `learn` mutation-handler shape and ensures the fixed legacy refusal is not decorated with a prefix.
- The new verbs do not accept `--json`. Adding a second output contract is outside D4's declared surface. Existing actions retain their present `--json` support.

### `list`

Resolve `sidecarPath(applyRoot)` and call S2's raw `readCandidates` once. Merge modern `candidates` and projected `legacyRows` into display-only summaries, then sort by full `revisionId` using code-unit order. Do not call `verifyCandidateIdentity` on legacy rows and do not rewrite the sidecar.

With no retained modern or legacy rows, stdout is exactly:

```text
no staged candidates (run: stratum distill extract)
```

Each modern row is one exact line:

```text
<first-12-revision-hex>  <targetKind>  <assetName>  distill-2.1
```

Each legacy row is one exact line using S2's exported constant, not a duplicated literal in production code:

```text
<first-12-revision-hex>  <targetKind>  <assetName>  legacy (distill-2.0; re-run extract)
```

Malformed/unsupported-row counters do not change the success exit: `list` shows only retained summaries and returns `0`. A sidecar read failure is operational and returns `1`.

### `apply <revision-id>`

Read the sidecar once and prefix-match the selector across both `candidates` and `legacyRows` by full `revisionId`:

- No match: stderr `no staged revision matching <selector>\n`, exit `1`.
- More than one match, including a modern/legacy collision: stderr `ambiguous revision <selector> matches <n> candidates: <sorted-12-char-ids>\n`, exit `2`. The displayed IDs are sorted in code-unit order and joined by `, `.
- One legacy match: use its full stored id in the exact stderr line `revision <id> is schema distill-2.0; not apply-eligible, re-run extract\n`, exit `1`. Do not pass the projected row to the asset adapter.
- One modern match: call `applyAssetCandidate(candidate, { applyRoot, trustSource })`. Pass `trustSource: true` only when `--trust-source` is present; otherwise omit the property. Do not pass `enabled: true`: the S3 wrapper must enforce `STRATUM_DISTILL_APPLY_ENABLED=1` itself.

Success writes exactly:

```text
applied <applyId> -> <targetPath>
```

and returns `0`. The CLI does not remap or normalize `targetPath`; the returned path must be the same admitted path recorded by candidate, journal, and ledger.

`--trust-source` is only an operator assertion routed to S3's `AssetApplyOptions.trustSource`; it is not an identity/authenticity claim. S3 must still re-harvest the workspace evidence. For `explicit-project` and `projects-root`, absence of the option surfaces S3's exact error `source mode <mode> requires --trust-source` with exit `1`.

### `revert <apply-id>`

Call `revertAssetApply(applyId, applyRoot, {})`. Do not inspect the candidate sidecar and do not scan for descendants. On success, stdout is exactly two lines:

```text
reverted <apply-id>
descendants: 0
```

The second line is a settled constant. S2 rejects non-empty `poolSnapshot` and S3 records empty lineage by construction, so a scan would add behavior without information. Success returns `0`; adapter refusal/failure writes the bare message to stderr and returns `1`.

### `reconcile`

Call `reconcileAssetApplies(applyRoot, {})`. On success, stdout is exactly:

```text
completed <completed>, rolled back <rolledBack>, reverted <reverted>, diverged <diverged>
```

Return `0` when `diverged === 0` and `1` when `diverged > 0`. A thrown adapter error also writes its bare message and returns `1`. Include `reverted`; the asset report uses all four settled `ReconcileReport` counters.

## B. Golden flow

Add `ts/tests/distill/golden-flow.test.ts`. It must exercise the CLI handlers against a temporary, canonical absolute workspace, actual files, the real resource locks, and the real guard store. It must not stub `applyAssetCandidate`, guard registration/transitions, candidate identity, critics, filesystem calls, or ledger reads.

Create `ts/tests/fixtures/distill/` if absent and add these exact UTF-8 JSONL fixture files, each with one trailing newline:

`ts/tests/fixtures/distill/session-a.jsonl`

```json
{"type":"assistant","sessionId":"distill-golden-a","cwd":"__WORKSPACE_ROOT__","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_distill_golden_a","name":"Read","input":{"file_path":"__WORKSPACE_ROOT__/README.md"}}]}}
```

`ts/tests/fixtures/distill/session-b.jsonl`

```json
{"type":"assistant","sessionId":"distill-golden-b","cwd":"__WORKSPACE_ROOT__","message":{"role":"assistant","content":[{"type":"tool_use","id":"toolu_distill_golden_b","name":"Read","input":{"file_path":"__WORKSPACE_ROOT__/README.md"}}]}}
```

The test copies both files to `<temp>/transcripts/`, replacing every literal `__WORKSPACE_ROOT__` with the temporary workspace's canonical path, and creates `<temp>/README.md` with exact bytes `# Golden workspace\n`. The two distinct sessions contain the same harmless normalized `Read` workflow so recurrence reaches `min-count=2`, semantic admission can re-harvest every cited block, and no behavioral hazard is introduced. Materialization is necessary because workspace provenance and evidence `cwd`/input paths must name the real temporary root rather than the repository checkout.

The exact flow is:

1. Clear both apply environment variables. Run `distillCommand(["extract", "--root", root, "--project", project, "--min-count", "2", "--window-days", "0"])`. Assert exit `0`, `.stratum/distill/candidates.jsonl` exists, and every staged row remains unapplied.
2. Read the S2 sidecar through `readCandidates(sidecarPath(root))`; select the single staged `targetKind === "skill"` row produced for the repeated safe workflow and retain its full `revisionId`, `assetName`, `targetPath`, and exact `rendered.content`. If the fixture produces zero or more than one skill row, fail rather than picking arbitrarily.
3. Run `distillCommand(["apply", revisionId, "--root", root])` with `STRATUM_DISTILL_APPLY_ENABLED=1` but without `--trust-source`. Assert exit `1`, exact stderr `source mode explicit-project requires --trust-source\n`, target absence, no asset journal, and no `distill-apply-*` guard ledger. This proves the D5a gate before the successful run.
4. Under the same flag, run `distillCommand(["apply", revisionId, "--root", root, "--trust-source"])`. Assert exit `0` and parse the 32-hex `applyId` from exact stdout `applied <applyId> -> <targetPath>\n`.
5. Assert the only created asset is `<root>/.claude/skills/<assetName>/SKILL.md`; its bytes equal `candidate.rendered.content` exactly, contain `disable-model-invocation: true`, and contain the exact sentence `To promote this draft for automatic routing, remove \`disable-model-invocation\` only after supplying a trigger description.`
6. Read `<root>/.stratum/distill/applies/<applyId>.json`. Assert `state === "applied"`, `targetPath` is the candidate path, `afterDigest` is SHA-256 of the exact installed bytes, `lineage.poolSnapshot` is `[]`, `sourceMode === "explicit-project"`, `sourceTrust === "operator-asserted"`, and `ledgerRef` is present.
7. Read the real guard history for resource `distill-apply-<applyId>`. Assert the committed `applying -> applied` row has `artifacts.after_digest === journal.afterDigest` and `modifiedFiles` exactly `[candidate.targetPath]`. Do not treat candidate/revision hashes as authenticity evidence; the successful semantic critic's real workspace re-harvest is the relevant proof.
8. With the flag still set, run the revert from `cwd=root` as `distillCommand(["revert", applyId])`. Assert exit `0`, exact two-line stdout, target `ENOENT`, journal `state === "reverted"`, and an `applied -> reverted` ledger row with `artifacts.reverted_to === journal.beforeDigest` and `modifiedFiles === [candidate.targetPath]`.
9. Re-run the identical trusted apply command for the same `revisionId`. Assert exit `0`, a different 32-hex apply id, an `applied` journal/receipt, and target bytes still exactly equal the staged `rendered.content`. This pins that revert restores prior non-existence and does not consume or rewrite the immutable revision.

Only steps 3, 4, and 9 need the distill apply flag. Steps 4 and 9 additionally need `--trust-source` because `--project <temp>/transcripts` made S2 persist `sourceMode: "explicit-project"`; the flag enables mutation, while `--trust-source` acknowledges the independently selected transcript source.

## C. CHANGELOG and MCP contract

### CHANGELOG

Under the existing `[Unreleased]` `### Added` heading in `CHANGELOG.md` (creating only that heading if the unreleased section lacks it), add exactly this house-style bullet:

```md
- `stratum distill list`, `apply`, `revert`, and `reconcile` CLI verbs — install reviewed `distill-2.1` drafts behind `STRATUM_DISTILL_APPLY_ENABLED=1`, record guard-ledger receipts, support reversible asset creation, and keep MCP extraction staging-only (`applied: false`)
```

Do not add dependency, migration, or release-version entries.

### MCP description and contract test

In `ts/contracts/mcp-surface.json`, leave `surface: 23`, the complete `stratum_distill.request`, every response shape, and the `"applied": "boolean"` shape leaf byte-for-byte unchanged. Replace only the tool description with this exact string:

```json
"description": "Extract recurring workflows from Claude transcripts into immutable distill-2.1 asset drafts for review. Requires an explicit workspace_root; project_dir selects the transcript source. Defaults: window_days=30, min_count=2, write=true. Use write=false to preview. Stages only to .stratum/distill/candidates.jsonl; never applies drafts; applied is always false. Applying, reverting, and reconciling assets are CLI-only operations."
```

Add `ts/tests/mcp/distill-contract.test.ts` with one focused test that loads the JSON contract and asserts:

```ts
expect(contract.surface).toBe(23);
expect(contract.tools.stratum_distill.description).toBe(
  "Extract recurring workflows from Claude transcripts into immutable distill-2.1 asset drafts for review. Requires an explicit workspace_root; project_dir selects the transcript source. Defaults: window_days=30, min_count=2, write=true. Use write=false to preview. Stages only to .stratum/distill/candidates.jsonl; never applies drafts; applied is always false. Applying, reverting, and reconciling assets are CLI-only operations.",
);
expect(contract.tools.stratum_distill.request).toEqual(UNCHANGED_REQUEST_FIXTURE);
expect(contract.tools.stratum_distill.responses).toEqual(UNCHANGED_RESPONSE_FIXTURE);
expect(contract.tools.stratum_distill.responses.ok.applied).toBe("boolean");
```

`UNCHANGED_REQUEST_FIXTURE` and `UNCHANGED_RESPONSE_FIXTURE` are literal test constants copied from the pre-S4 contract before editing the description; they are not snapshots and are not generated from the value under test. Pass `responses.ok` and `responses.error` to `validateShape` as the existing contract loader does. The separate MCP handler assertion must continue to require the actual result value `applied === false` for preview and write modes. `ts/src/mcp/contracts.ts:47` accepts only type leaves such as `"boolean"`, not the literal `false`, so neither `"applied": false` nor a made-up literal grammar belongs in the schema. No `stratum_distill_apply`, revert, or reconcile MCP tool is added.

## D. `runner.test.ts` extension

The existing sentinel begins at `ts/tests/distill/runner.test.ts:19` with `it("stages only the distill sidecar, even when learning apply is enabled", ...)`; line 20 currently sets only `STRATUM_LEARN_APPLY_ENABLED=1`. After S2 has moved the sentinel paths to `.claude/...` and the schema expectation to `distill-2.1`, add this exact assertion setup immediately after the learn flag:

```ts
vi.stubEnv("STRATUM_DISTILL_APPLY_ENABLED", "1");
```

Rename the test to:

```ts
it("stages only the distill sidecar, even when both apply flags are enabled", async () => {
```

Keep the existing byte-equality checks for every sentinel, exact `.stratum/distill` directory listing, and `ENOENT` assertion for every candidate target. Do not replace them with a mock/call-count assertion. The strengthened test proves that `runDistill` remains staging-only even when its own mutation flag is set; the golden flow separately proves that only the explicit `apply` verb crosses the write boundary.

## E. Ordered implementation steps

1. **Split the new asset-action parser from extraction parsing and pin CLI syntax.**
   - Files: edit `ts/src/cli/distill.ts`; add `ts/tests/distill/cli.test.ts`.
   - Add the exact help/grammar, canonical-root handling, strict option validation, exit codes, and stdout/stderr capture cases from §A. Preserve current `extract`/`top`/`stats` results and flags.
   - Prove from `ts/` with:

     ```sh
     npx vitest run tests/distill/cli.test.ts tests/distill/runner.test.ts
     npx tsc --noEmit
     ```

2. **Wire sidecar listing and revision selection.**
   - Files: edit `ts/src/cli/distill.ts`; extend `ts/tests/distill/cli.test.ts`.
   - Import S2's sidecar reader/path and `LEGACY_DISTILL_2_0_LABEL`. Add deterministic modern/legacy list lines, no-row output, unique-prefix selection, no-match/ambiguity behavior, and the exact full-id legacy refusal. Never re-author or verify a legacy row.
   - Prove from `ts/` with:

     ```sh
     npx vitest run tests/distill/cli.test.ts tests/distill/candidate.test.ts
     ```

3. **Wire apply, revert, and reconcile to the S3 wrappers.**
   - Files: edit `ts/src/cli/distill.ts`; extend `ts/tests/distill/cli.test.ts`.
   - Map `--root` and `--trust-source` exactly to `AssetApplyOptions`; leave enablement to S3. Pin successful output, disabled/refusal output, `descendants: 0`, all four reconcile counters, and divergence exit `1`. No descendant scan and no MCP route are introduced.
   - Prove from `ts/` with:

     ```sh
     npx vitest run tests/distill/cli.test.ts tests/distill/apply.test.ts
     npx tsc --noEmit
     ```

4. **Strengthen the staging-only sentinel.**
   - Files: verify `ts/tests/distill/runner.test.ts`; the final tree must contain the exact §D flag/title change once. If S2 supplied it as planned, S4 makes no duplicate edit.
   - Preserve every S2 path/schema update and sentinel-byte assertion.
   - Prove from `ts/` with:

     ```sh
     npx vitest run tests/distill/runner.test.ts
     ```

5. **Add the real golden flow.**
   - Files: add `ts/tests/fixtures/distill/session-a.jsonl`, `ts/tests/fixtures/distill/session-b.jsonl`, and `ts/tests/distill/golden-flow.test.ts`.
   - Materialize the placeholder paths in an isolated temporary workspace, run the nine steps in §B, and inspect real journal and guard-ledger records. Do not mock filesystem, candidate identity, critics, locks, or guards.
   - Prove from `ts/` with:

     ```sh
     npx vitest run tests/distill/golden-flow.test.ts
     ```

6. **Document the unchanged MCP boundary.**
   - Files: edit only the `stratum_distill.description` string in `ts/contracts/mcp-surface.json`; add `ts/tests/mcp/distill-contract.test.ts`.
   - Pin `distill-2.1`, the unchanged request/response literals, schema surface `23`, `"applied": "boolean"`, and handler value `applied === false`. Add no MCP write tool.
   - Prove from `ts/` with:

     ```sh
     npx vitest run tests/mcp/distill-contract.test.ts
     npx tsc --noEmit
     ```

7. **Add the release note and run the slice gate.**
   - Files: edit `CHANGELOG.md` with the exact bullet in §C.
   - Confirm no package manifest/lockfile, runtime dependency, S1–S3 production module, or MCP schema shape changed in S4.
   - Prove from `ts/` with:

     ```sh
     npx vitest run tests/distill/*.test.ts tests/mcp/distill-contract.test.ts
     npx tsc --noEmit
     git diff --check
     ```

## Corrections

1. The checked-in `blueprint-s1.md` currently shows the older two-argument `journalEntry(candidate, base)` declaration and only ten listed corrections. Controller ground truth and S3 correction #12 supersede it: the settled signature is `journalEntry(candidate, base, admission: AdmissionResult)`, and S4 assumes that interface without reopening S1.
2. D2 says “S2 adds” `stratum distill list`, but design §8 assigns `ts/src/cli/distill.ts` and all CLI verbs to S4. S2 supplies the raw legacy projection and label; S4 owns their display and selection behavior.
3. D4 writes `apply <revision-id> [--root]` without stating that `--root` consumes a directory value, how it is canonicalized, or what the other verbs use as their root. S4 defines `--root <dir>` for `apply` and canonical cwd for `list`, `revert`, and `reconcile`, matching the surface as written rather than silently adding options to it.
4. D4 and §4 do not define revision-prefix behavior, ambiguity, apply-id length, duplicate flags, output bytes, or exit codes. Because `list` presents 12-character IDs and the examined `learn.ts` sibling accepts unique prefixes, S4 makes prefixes explicit and pins every parse/result case in §A.
5. `learn.ts`'s simple `flag`/`option` helpers tolerate unknown or duplicate flags, while current `distill.ts` rejects them. S4 follows the sibling's exit/stdout/stderr convention, not its permissive option helpers; weakening the existing distill parser would be unrelated behavior drift.
6. `learn.ts`'s reconcile line omits `ReconcileReport.reverted`. The settled S1 report has four counters, so the S4 asset CLI prints `completed`, `rolled back`, `reverted`, and `diverged` rather than copying that omission.
7. S2's test delta already assigns `STRATUM_DISTILL_APPLY_ENABLED=1` to the `runner.test.ts` staging-only sentinel, while design §8 assigns the final CLI/golden-flow acceptance to S4. S4 must not add a duplicate stub if S2 already landed it; it verifies the exact title/setup/assertions in §D and adds them only if absent.
8. Section 4 says the MCP grammar carries types rather than literals while also requiring `applied: false` to remain literal. In the real contract those are two different layers: the unchanged schema leaf is `"boolean"`; the MCP handler result is the literal `false`, and the description states that invariant. Encoding `false` in `mcp-surface.json` would fail `LEAF_TYPES` at `ts/src/mcp/contracts.ts:47`.
9. The contract acceptance criterion says “surface bump only if the contract test demands it” but the required change is description-only. S4 pins `surface: 23` and exact request/response fixtures; a surface bump would falsely imply a schema change.
10. Blueprint S3 correction #14 and controller ground truth settle lineage as empty by construction. Therefore revert prints the constant `descendants: 0`; it never scans the sidecar, journals, installed pool, or guard ledger for descendants.
11. The controller's corrected `resourceLock` anchor is `ts/src/guard/lock.ts:385`, and `registerGuard` takes all eight arguments at `transition.ts:396-404`. S4 does not call either function directly or redefine their shapes; its golden flow deliberately traverses the already-settled S3 adapter so the real nested locks and full guard registration are exercised.
12. Candidate `revisionId` and `verifyCandidateIdentity` are unkeyed SHA-256 integrity checks, not authenticity controls. The CLI may use them for deterministic lookup/corruption detection, but the golden-flow trust claim is pinned to S3's workspace re-harvest. `--trust-source` acknowledges source selection only; it does not authenticate a staged row.

## Tests

| Changed code or contract | Test file | Action |
|---|---|---|
| `ts/src/cli/distill.ts` | `ts/tests/distill/cli.test.ts` | Add strict parsing, help, list, legacy refusal, apply, revert, reconcile, output, and exit-code cases |
| `ts/src/distill/runner.ts` behavior (unchanged) | `ts/tests/distill/runner.test.ts` | Extend the real staging-only sentinel with `STRATUM_DISTILL_APPLY_ENABLED=1` |
| S1–S3 integrated behavior (unchanged) | `ts/tests/distill/golden-flow.test.ts` plus `ts/tests/fixtures/distill/*.jsonl` | Add real extract/apply/revert/re-apply flow with real files, locks, journal, and guard store |
| `ts/contracts/mcp-surface.json` description only | `ts/tests/mcp/distill-contract.test.ts` | Pin `distill-2.1`, unchanged schema/surface, and runtime `applied === false` |

Commands from `ts/`:

```bash
npx vitest run tests/distill/cli.test.ts tests/distill/runner.test.ts
npx vitest run tests/distill/apply.test.ts tests/distill/golden-flow.test.ts
npx vitest run tests/mcp/distill-contract.test.ts
npx vitest run tests/distill/*.test.ts tests/mcp/distill-contract.test.ts
npx tsc --noEmit
git diff --check
```

## Documentation

- [ ] `ts/src/cli/distill.ts` — add the exact `--help` surface and operator-gate text in §A.
- [ ] `ts/contracts/mcp-surface.json` — change only the `stratum_distill` description; retain the request/response schema and `surface: 23`.
- [ ] `CHANGELOG.md` — add the exact `[Unreleased]` bullet in §C.
- [ ] No README, roadmap, SDK, package manifest, or dependency documentation change: S4 adds no MCP/API write surface and no dependency.
