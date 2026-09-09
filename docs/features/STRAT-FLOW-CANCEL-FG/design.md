# STRAT-FLOW-CANCEL-FG: Foreground flow cancel addressable by flow id. Consumer fanout is rejected in background flows (engine.ts), so compose runs team builds as foreground flows; the only durable flow-cancel operation is flowCancelBg, and foreground agent cancellation needs the per-call cancellationId held by the MCP server that started the call (mcp/server.ts). A second process (compose build --abort opens a fresh client) therefore cannot cancel a running foreground build or its agents. Add a foreground cancel surface keyed by flow id: mark the run cancelling in the persisted record, propagate to in-flight agent runs through their recorded cancellation ids, refuse any consumer result or patch captured after the cancel mark, and settle the run as cancelled with an acknowledgement (0.4.0 acknowledged-cancellation semantics). Expose it on the CLI and MCP surface. First consumer: compose COMP-FABLE-ASTRA (D5) and the general compose build --abort defect. Standalone Tickets M high

**Status:** PLANNED
**Created:** 2026-09-09

---

## Intent

Foreground flow cancel addressable by flow id. Consumer fanout is rejected in background flows (engine.ts), so compose runs team builds as foreground flows; the only durable flow-cancel operation is flowCancelBg, and foreground agent cancellation needs the per-call cancellationId held by the MCP server that started the call (mcp/server.ts). A second process (compose build --abort opens a fresh client) therefore cannot cancel a running foreground build or its agents. Add a foreground cancel surface keyed by flow id: mark the run cancelling in the persisted record, propagate to in-flight agent runs through their recorded cancellation ids, refuse any consumer result or patch captured after the cancel mark, and settle the run as cancelled with an acknowledgement (0.4.0 acknowledged-cancellation semantics). Expose it on the CLI and MCP surface. First consumer: compose COMP-FABLE-ASTRA (D5) and the general compose build --abort defect. Standalone Tickets M high

---

## Notes

_This is a seed design doc created by `compose feature`. The `compose build` pipeline will expand it into a full design, blueprint, and implementation plan._

## Evidence (from COMP-FABLE-ASTRA round-2 review, 2026-09-09)

- Consumer fanout is rejected in background flows (engine.ts, background flow validation),
  so compose team builds are foreground flows.
- `flowCancelBg` is the only durable flow cancel; foreground agent cancellation is keyed by
  a per-call `cancellationId` held by the originating MCP server process (mcp/server.ts).
- `compose build --abort` opens a fresh client, audits and closes it (compose lib/build.js);
  the build's signal handler changes local status and closes the stream. Neither reaches the
  flow or the agents.

Compose consumer: `compose/docs/features/COMP-FABLE-ASTRA/design.md`, dependency D5.
