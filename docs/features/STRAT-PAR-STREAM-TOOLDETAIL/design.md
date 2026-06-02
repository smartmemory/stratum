# STRAT-PAR-STREAM-TOOLDETAIL — Per-task tool-use detail in the parallel-dispatch stream

**Status:** SHIPPED 2026-06-02 (TDD, Codex review 2 rounds → CLEAN, full suite 1384 passed) — consumed by compose COMP-GSD-5
**Date:** 2026-06-02
**Owner:** stratum
**First consumer:** compose `COMP-GSD-5` (gsd stuck detection) — `compose/docs/features/COMP-GSD-5/design.md`
**Family:** STRAT-PAR-STREAM-* (per-task BuildStream event transport)

## Problem

The streaming **claude** connector emits, on each `ToolUseBlock`, a `tool_use_summary` event with only `{tool, summary (≤80 chars), ok: true (hardcoded), duration_ms: 0}` (`connectors/claude.py:191-200`). It never emits:
- the **raw tool input** (only an 80-char `_short_input_summary`, so a consumer cannot reliably recover `input.file_path`);
- any **tool result** — the `ToolResultBlock` (which carries `is_error` + result content) is not surfaced in the streaming path, and `ok` is hardcoded `true`.

So a stream consumer cannot tell *which file* a tool touched (structurally) or *whether a tool errored*. This blocks per-task observability features — concretely, compose's gsd stuck detection (same-file thrash, error recurrence). The codex connector already emits richer `tool_use_summary` with `output` (`connectors/codex.py:169/187`); claude is the gap.

## Goal

Enrich the per-task stream so consumers get **structured tool input** and **tool results/errors**, additively (no existing consumer breaks), connector-local, minimal.

- **In scope:** claude connector emits raw (sanitized, size-capped) tool input on the call event + a tool-result event with `ok`/error text; a schema-version bump registering the result event; bring claude to parity with codex.
- **Non-scope:** new redaction/secret-scrubbing beyond size caps (documented residual); opencode changes beyond parity if already sufficient; any change to poll/advance control flow.

## Decision 1: Enrich the tool *call* event with raw input

On `ToolUseBlock`, `tool_use_summary.metadata` gains:
- `input`: the raw `block.input` dict, **size-capped** (e.g. JSON-serialized ≤ 2 KiB; over-cap → truncated marker) and shallow — no transformation of values beyond the cap.
- `tool_use_id`: `block.id` (to correlate with the result event).

`tool`, `summary`, `ok`, `duration_ms` are retained for back-compat. `input` is **optional** in the schema so older consumers ignore it.

## Decision 2: Emit a tool *result* event

The SDK delivers tool results as `ToolResultBlock` (inside a `UserMessage`) carrying `tool_use_id`, `content`, `is_error`. The streaming loop currently ignores these. Add emission of a new event:
- `kind: "tool_result"`, `metadata: {tool_use_id, ok: (not is_error), output: <result/error text, size-capped ≤ 2 KiB>}`.

This gives consumers per-call success/failure + error text, correlated to the call via `tool_use_id`. (Alternative considered — overload a second `tool_use_summary` — rejected: a distinct kind keeps call vs result unambiguous and avoids double-counting in existing consumers that count `tool_use_summary`.)

## Decision 3: Schema version bump 0.2.6 → 0.2.7

- Bump `BuildStreamEvent` `schema_version` producer default and `KNOWN_VERSIONS` to include `0.2.7`.
- Register `tool_result` as a known kind (open metadata is acceptable; closed shape `{tool_use_id, ok, output?}` preferred for rigor).
- `tool_use_summary` metadata stays open/back-compat with `input` optional.
- **Compose consumer** (`compose/lib/build-stream-schema.js`) adds `0.2.7` to its `KNOWN_VERSIONS` and accepts `tool_result`; `executeParallelDispatchServer` forwards any event whose `schema_version ∈ KNOWN_VERSIONS` (`compose/lib/build.js:2989`), so no per-kind wiring needed there.

## Decision 4: Sanitization / size caps

- Input and output each capped to ≤ 2048 **characters** (~2 KiB ASCII); over-cap yields a truncated string with a `"…[truncated N chars]"` marker, and the emitted value stays within the cap *including* the marker. Same cap applied across connectors (claude + codex parity) for payload consistency.
- No new secret redaction in v1 (the raw input is already visible to the agent and host); documented as a residual. A redaction pass is a possible follow-up if these streams are ever surfaced to lower-trust consumers.

## Decision 5: Connector parity

- **claude:** the change (this feature).
- **codex:** already emits `tool_use_summary` with `output` (`codex.py:169/187/927`); add `tool_use_id`/`input` only if cheap, else leave (its output already covers error text).
- **opencode:** `opencode.py:265` emits `{summary, output}`; bring to the same shape if trivial, else parity-note only.
Keep each change connector-local; no shared-path refactor.

## Files (stratum)

| File | Action | Purpose |
|------|--------|---------|
| `connectors/claude.py` | existing | emit raw `input` + `tool_use_id` on `tool_use_summary`; emit `tool_result` on `ToolResultBlock` |
| BuildStream schema module (`KNOWN_VERSIONS`, kind registry — pinned in blueprint) | existing | bump to `0.2.7`; register `tool_result` kind |
| `connectors/codex.py`, `connectors/opencode.py` | existing (parity) | add `tool_use_id`/`input` where trivial |
| stratum tests (`tests/…` per-connector + schema) | new | call event carries capped input; result event carries ok/error; version-bump back-compat |

## Files (compose, consumer side)

| File | Action | Purpose |
|------|--------|---------|
| `lib/build-stream-schema.js` | existing | `KNOWN_VERSIONS += '0.2.7'`; accept `tool_result` kind |
| `test/build-stream-schema.test.js` (or equiv) | existing | 0.2.7 + `tool_result` accepted; older versions still valid |

## Open Questions (design gate)

1. `tool_result` as a new closed-metadata kind vs enriched `tool_use_summary` — recommend new kind (unambiguous; no double-count). Confirm at blueprint.
2. 2 KiB cap acceptable, or make it env-tunable (mirror `_CODEX_STDOUT_LIMIT`)? Lean: constant in v1, env-tunable if needed.
3. Verify exact SDK message shape for `ToolResultBlock` (UserMessage content) against the installed `claude_agent_sdk` version — pin in blueprint.
