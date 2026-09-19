# STRAT-AGENT-PEER-2 Implementation Report

**Related:** [design.md](./design.md), [blueprint.md](./blueprint.md), [PEER-1 report](../STRAT-AGENT-PEER-1/report.md)
**Date:** 2026-09-19
**Commits:** None. Implementation remains uncommitted; feature status unchanged.

## 1. Summary

Implemented File Plan items 1–7 and 9–15: background-only normalized labels, Claude worker peer registration, private IPC readiness/finalization, source/dist worker selection, and request forwarding. Real peer interoperability remains **unverified**: this sandbox denies Unix socket binding and process inspection. The public MCP label field remains intentionally unavailable pending the contract follow-up.

## 2. Delivered vs planned

| Unit | Delivered |
|---|---|
| S1 | Label validation/naming with legacy Codex names preserved; discriminated owner config and environment serialization; exit-plus-finalization lifecycle latch. |
| S2 | Per-worker detached IPC sidecar; bounded readiness/send deadlines; stream-first terminal precedence; unavailable retention on owner loss; late-registration abandonment; safe historical Claude discovery reads. Existing cancellation finalization ordering retained. |
| S2 packaging/fixtures | Source `.ts` worker with existing hooks or emitted `.js` without hooks; controlled-release synthetic worker fixture, requiring a release path and bounded by 30 seconds. |
| S3 allowed portion | Runner/server validation and normalized forwarding; Claude completion guidance, concurrency/cancellation/owner-loss fixtures, emitted-JS and metadata compatibility tests. |
| S3 deferred | Contract field, peer-surface test, README and CHANGELOG, as explicitly excluded by this dispatch. |

## 3. Corrections and deviations

| Blueprint assumption | Actual implementation/evidence | Resolution |
|---|---|---|
| Clear all handle listeners at termination | A child can emit an asynchronous `error` after IPC disconnect. Removing every error listener would make that peer-only event fatal to the host. | Remove operational listeners and timers; retain an inert error sink. No worker authority is added. |
| Public label forwarding can be tested through the real request contract | The explicitly excluded contract still rejects the undeclared key. | One MCP test temporarily admits only `peerLabel` at the request-validation seam, retaining other request and response checks. This proves forwarding, **not** end-to-end contract acceptance. |
| Socket/process/live checks and a full package build are available implementation gates | Unix socket `listen` returns `EPERM`; `ps` cannot provide identity. Whole-project build/typecheck/full-suite commands were prohibited. | Record failures below; narrowly transpile the worker dependency closure in a temporary fixture and typecheck only connector roots/tests. Full-package and live checks remain unverified. |

No design change was required. Other sessions' edits, including concurrent additions in `server.ts`, were preserved. No excluded file or excluded feature directory was edited.

## 4. Verification

Only explicitly scoped Vitest commands were used, from `ts/`. Results below reflect the final executed cases per touched file, not a single full-suite run.

| Touched test file | Result |
|---|---|
| `tests/connectors/peer-worker-lifecycle.test.ts` | **PASS: 12/12** — both fact orders, late attachment, abandonment, exception containment, readiness/run-ID filtering, send timeout and late IPC errors. |
| `tests/connectors/background-claude-interleavings.test.ts` | **PASS: 26/26** — existing terminal/cancel races plus delayed attachment, error-before-exit, failed terminal I/O, late handle and late gate. |
| `tests/connectors/runner.test.ts` | **PASS: 15/15** — includes rejection before provider invocation and label persistence. |
| `tests/mcp/agent-run.test.ts` | **PASS: 23/23** — Claude completion guidance, rejection, staged forwarding, and existing behavior. |
| `tests/connectors/peer-registry.test.ts` | **FAIL: 28 passed, 3 failed** — existing real `ps` identity and two socket-construction fixtures blocked by sandbox. New label/config cases pass. |
| `tests/connectors/peer-sidecar.test.ts` | **FAIL: 17 passed, 53 failed** across the 69-case file run plus the added early-start case run separately. Socket-dependent cases fail binding or time out awaiting publication; process-identity checks also blocked. Missing-IPC rejection and delayed-start readiness abandonment pass. |
| `tests/connectors/background-claude-peer.test.ts` | **FAIL: 6 passed, 4 failed** — registration-disabled/missing/protocol isolation, invalid labels, malformed metadata and emitted-JS worker execution pass. Two concurrent-worker flows, owner death and emitted-JS peer registration cannot reach socket publication. |

Commands (run separately; no unscoped invocation):

```sh
./node_modules/.bin/vitest run tests/connectors/peer-worker-lifecycle.test.ts tests/connectors/peer-registry.test.ts tests/connectors/background-claude-interleavings.test.ts tests/connectors/runner.test.ts tests/mcp/agent-run.test.ts
./node_modules/.bin/vitest run tests/connectors/peer-sidecar.test.ts tests/connectors/background-claude-peer.test.ts
./node_modules/.bin/vitest run tests/connectors/peer-worker-lifecycle.test.ts tests/connectors/background-claude-interleavings.test.ts tests/connectors/runner.test.ts tests/mcp/agent-run.test.ts
./node_modules/.bin/vitest run tests/connectors/background-claude-peer.test.ts
./node_modules/.bin/vitest run tests/connectors/background-claude-interleavings.test.ts
./node_modules/.bin/vitest run tests/connectors/peer-sidecar.test.ts -t 'abandons delayed startup before owner-ready'
```

Passing scoped TypeScript compiler-API checks cover the six modified/new connector implementations and six connector test files, with strict/exact-optional settings and no emit. No whole-project typecheck, build, full suite, real SDK call, or live Claude peer registration was run. Temporary fixtures use isolated sessions/socket/run roots; the suite-wide kill switch is unchanged.

## 5. Blocked on mcp-surface.json

After `forge-f7` confirms surface 22 has landed, complete this exact follow-up:

1. **File Plan 8 — `ts/contracts/mcp-surface.json`:** add `"peerLabel?": "string"` to `stratum_agent_run` request and describe the background-only display hint for Claude and Codex. Preserve `completionInstructions`, historical `peer.registered`, optional `peerName`, and absence of `peer:"pending"`. Respect the newly landed surface/version rather than overwriting it.
2. **File Plan 16 — `ts/tests/mcp-surface-peer.test.ts`:** test optional-label acceptance, wrong-type/unknown-key rejection, Claude start/poll response conformity and continued rejection of `peer:"pending"`. Replace the staged MCP forwarding seam with real contract admission once the field exists.
3. **File Plan 17 — `README.md`:** one coordinated hand edit after both implementations land: Claude and Codex background peers, background-only label examples, subscribe-then-poll guidance, loss of Claude workers on MCP restart, historical registration semantics.
4. **File Plan 18 — `CHANGELOG.md`:** one coordinated Unreleased entry after both implementations land, covering Claude peers and optional labels.

The README/CHANGELOG deferral is also blocked by the sibling DISTILL implementation's shared-file ownership; it is not a technical dependency on the contract.

## 6. Remaining verification limits

Rerun the three environment-blocked test files in an environment that permits `ps` and local Unix sockets. Their real-socket golden flows and cleanup/notification behavior are not proven by the passing mock tests. Then perform the blueprint's intended-package build and installed-Claude live exit check: two independently listed workers, model-admitted correlated idle notices with echoed mode, polling and eventual owned-file cleanup. No claim of live model admission, whole-package correctness, or resource-overhead measurement is made here.


## Contract follow-up complete — surface 23 (2026-09-19)

Completed the shared contract follow-up on top of landed surface 22 (`3d92b5c`), preserving its step-done provenance declarations. Surface **23** now admits optional `stratum_agent_run.peerLabel` and declares `stratum_distill` with recursive candidate, scope, evidence, handle, workflow and authoring shapes plus both response envelopes. Updated both grammar version pins; extended the existing peer-surface test (the file already existed); removed the temporary distill contract override and peer-label admission spy; added both distill statuses to the all-tools SDK sweep. Label normalization and completion-guidance assertions now pass through real contract admission.

Targeted verification from `ts/`:

```sh
./node_modules/.bin/vitest run tests/mcp/contracts-grammar.test.ts tests/mcp/schema-grammar.test.ts tests/mcp-surface-peer.test.ts tests/mcp/distill.test.ts tests/mcp/p5.test.ts tests/mcp/agent-run.test.ts
```

**PASS: 97/97 tests, 6/6 files:** contracts grammar 26, schema grammar 15, peer surface 4, distill 5, all-tools/P5 24, agent-run 23. Real SDK listing/calls use the on-disk contract. `git diff --check` also passed.

No contract-follow-up implementation remains. Only the coordinated README/CHANGELOG edits remain in this follow-up's scope; both files were left untouched. Earlier live-peer and built-package verification limits remain unverified: this pass ran only the six authorized test files, with no package build or full suite. No commit was made.
