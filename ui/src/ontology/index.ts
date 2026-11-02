/**
 * ontology — this app's one seam onto the project ontology pack (FORGE-ONTOLOGY-READY-1).
 *
 * Anything here that names a pack type (Project, Module, Lane, Feature, Unit, Seat, Session, Gate, ...) imports it
 * from this module and never declares it. `pack.generated.ts` is rendered by forge/compose
 * `lib/ontology/gen-stub.js` from the pack `resolve-pack.mjs` finds (a stub until core's ONTO-PROJECT-PACK-1 phase B
 * ships generated .d.ts and JSON Schemas); `tests/ontology-seam.test.ts` fails when the pack moves under it.
 */
export * from "./pack.generated";
