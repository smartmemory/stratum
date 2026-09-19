# STRAT-DISTILL-TS-1 — Implementation Report

**Status:** Staging implementation complete; live MCP publication blocked on the reserved contract. 2026-09-19. Uncommitted.

## Summary

Implemented the TS Claude transcript → recurring workflow → immutable asset draft staging pipeline. The reader preserves physical line/block locators, original-line SHA-256 digests, step-local cwd attribution, and scan diagnostics. Detection retains whole-session singleton and overlapping 2–4-tool recurrence, source-project isolation, deterministic ordering, and redaction before the 120-code-point preview.

Skill, subagent and command drafts use the design's exact `AssetCandidate` envelope, `sourceKind: "claude-transcript"`, complete evidence, create-only rendered content, immutable cluster/revision identities, and explicit known-empty authoring pool context. No memory candidate conversion, admission, apply, asset inventory, model call or automatic trigger was introduced.

Staging appends only to `.stratum/distill/candidates.jsonl`, with the existing explicit-root filesystem lock, revision deduplication, flush-before-success, malformed/unsupported-row diagnostics, torn-tail isolation and path checks. CLI `distill extract|top|stats` is routed through the shared runner. The MCP dispatcher case and stateless wire adapter are implemented, but the real server does **not** advertise or accept the new tool until its contract is declared.

## Delivered vs planned

| Slice | Delivered | Targeted tests |
|---|---|---|
| S0 harvest/detection | Sorted narrow JSONL reader; physical locators/digests; window/error diagnostics; source-isolated recurrence and redacted previews | 11 passed |
| S1 authoring/storage | Exact candidate envelope, full-file draft templates, form selection, evidence/identity validation, locked append-only staging | 17 passed |
| S2 runner/CLI | Shared source/root resolution, per-project `--all`, staging/preview, extract/top/stats, usage and operational exits | 20 passed |
| S3 MCP | Handler and dispatcher integration; strict request/error mapping; SDK integration using a test-only future contract | 5 passed; live publication deferred |

## Verification

**53 passed, 0 failed across exactly these seven new test files:**

| File | Result |
|---|---|
| `ts/tests/distill/harvest.test.ts` | 6 passed |
| `ts/tests/distill/detector.test.ts` | 5 passed |
| `ts/tests/distill/candidate.test.ts` | 11 passed |
| `ts/tests/distill/synthesize.test.ts` | 6 passed |
| `ts/tests/distill/runner.test.ts` | 5 passed |
| `ts/tests/cli/distill.test.ts` | 15 passed |
| `ts/tests/mcp/distill.test.ts` | 5 passed |

Final focused invocation, from `ts/`:

```sh
./node_modules/.bin/vitest run tests/distill/harvest.test.ts tests/distill/detector.test.ts tests/distill/candidate.test.ts tests/distill/synthesize.test.ts tests/distill/runner.test.ts tests/cli/distill.test.ts tests/mcp/distill.test.ts
```

Evidence includes eight concurrent native Node subprocess writers retaining all eight unique revisions exactly once; complete non-newline and malformed torn tails; symlink/nonregular destination refusal; injected lock/permission failures; candidate tampering; a test-local `PatchCandidate | AssetCandidate` consumer; CRLF digest handling; a preview truncated inside a redaction marker; source-handle resolution; nested Git-root discovery; all-project grouping parity; unchanged sentinel assets, learning/legacy corpora, flow and guard state with `STRATUM_LEARN_APPLY_ENABLED=1`.

Targeted typecheck passed for the five new distill modules and CLI wrapper (and their transitive dependencies):

```sh
./node_modules/.bin/tsc --noEmit --target ES2022 --module NodeNext --moduleResolution NodeNext --strict --noUncheckedIndexedAccess --exactOptionalPropertyTypes --skipLibCheck src/distill/harvest.ts src/distill/detector.ts src/distill/candidate.ts src/distill/synthesize.ts src/distill/runner.ts src/cli/distill.ts
```

No unscoped/full suite, whole-project typecheck, build, private transcript sweep, model invocation, or historical Python test run was performed. MCP SDK/listing/response-shape assertions use an isolated in-memory contract fixture in the new MCP test; they do not certify the current on-disk or packaged contract.

## Corrections / deviations from blueprint

| Original assumption | Reality | Resolution |
|---|---|---|
| Complete S3 includes contract declaration, version assertions and publication checks | User reserved `mcp-surface.json` and both grammar tests for in-flight surface-22 review | Implement handler/dispatcher now; use a strict test-only future contract; defer live registration and related sweep/version work |
| README/CHANGELOG are written with implementation | Concurrent sibling implementation owns overlapping edits | Leave both untouched; list the required entries below |
| Integration runs the full suite, whole-project typecheck and build | User explicitly restricted this pass to targeted tests and prohibited whole-project checks | Run only the seven new test files and the narrow module typecheck above |
| Python-compatible fallback JSON can be byte-identical for every value | ECMAScript preserves literal Unicode and formats small exponents differently | Recursive key sorting and ordinary JSON spacing are preserved; golden tests pin literal `é` and `1e-7` rather than Python's ASCII escapes / exponent formatting, as permitted by S0 |

No change to the candidate compatibility contract or pipeline design was needed. Regex redaction is best-effort, not a universal secret detector. Fixture results establish the documented TS behavior; exact archived-regex parity and real-corpus yield were not independently measured in this pass.

## Files changed

**New source:** `ts/src/distill/{harvest,detector,candidate,synthesize,runner}.ts`, `ts/src/cli/distill.ts`.

**Modified source:** `ts/src/cli/stratum.ts` (lazy route/usage), `ts/src/mcp/server.ts` (import, tool-name union, dispatcher case only).

**New tests:** the seven test files above plus `ts/tests/distill/fixtures.ts`.

**Documentation:** this report. No commit. No edits to the reserved contract/grammar tests, README, CHANGELOG, learning/apply machinery, or the excluded future/sibling feature directories.

## Blocked on mcp-surface.json

After `forge-f7` confirms surface 22 has landed:

1. Add the `stratum_distill` declaration to `ts/contracts/mcp-surface.json`: required `workspace_root`; optional `project_dir`, `window_days`, `min_count`, `write`; exact `ok`/`error` envelopes from the blueprint. Recursively declare candidate metadata, scope, evidence steps/handles and authoring context. The explicit strict shape fixture in `ts/tests/mcp/distill.test.ts` is ready to transfer; do not replace nested arrays/records with opaque leaves. No `apply`, arbitrary output or caller-provided candidate fields.
2. Advance surface to **23**, after coordinating with the sibling dispatch so its changes are preserved. Update the pinned versions and stale titles in `ts/tests/mcp/contracts-grammar.test.ts` and `ts/tests/mcp/schema-grammar.test.ts`.
3. Remove the test-only contract overrides from `ts/tests/mcp/distill.test.ts`, run its existing dispatcher/SDK tests against the real declaration, and add both statuses to the all-tools sweep in `ts/tests/mcp/p5.test.ts`. Run those four exact MCP test files once the reservation clears. The handler already uses the shared runner; no dispatch redesign is required.
4. Write **README** entries once by hand after both implementations land: CLI examples/defaults, explicit workspace vs source distinction, nested-root discovery, per-project `--all --projects-root`, MCP required root/default staging/`write:false`, draft review requirement, schema/sidecar path, recurrence limitations, and the correction to the retired-tool inventory for distill alone.
5. Write the **CHANGELOG** entry once by hand after both land: TS staging port, whole-file drafts and immutable revisions, source/destination separation, independent `distill-2.0` storage, and no implicit apply.
6. In the follow-up's authorized validation window, build/package and confirm the shipped CLI route and real SDK tool listing/schema. Packaged publication has intentionally not been claimed here.


## Contract follow-up complete — surface 23 (2026-09-19)

Completed the shared contract follow-up on top of landed surface 22 (`3d92b5c`), preserving its step-done provenance declarations. Surface **23** now admits optional `stratum_agent_run.peerLabel` and declares `stratum_distill` with recursive candidate, scope, evidence, handle, workflow and authoring shapes plus both response envelopes. Updated both grammar version pins; extended the existing peer-surface test (the file already existed); removed the temporary distill contract override and peer-label admission spy; added both distill statuses to the all-tools SDK sweep. Label normalization and completion-guidance assertions now pass through real contract admission.

Targeted verification from `ts/`:

```sh
./node_modules/.bin/vitest run tests/mcp/contracts-grammar.test.ts tests/mcp/schema-grammar.test.ts tests/mcp-surface-peer.test.ts tests/mcp/distill.test.ts tests/mcp/p5.test.ts tests/mcp/agent-run.test.ts
```

**PASS: 97/97 tests, 6/6 files:** contracts grammar 26, schema grammar 15, peer surface 4, distill 5, all-tools/P5 24, agent-run 23. Real SDK listing/calls use the on-disk contract. `git diff --check` also passed.

No contract-follow-up implementation remains. Only the coordinated README/CHANGELOG edits remain in this follow-up's scope; both files were left untouched. Earlier live-peer and built-package verification limits remain unverified: this pass ran only the six authorized test files, with no package build or full suite. No commit was made.
