// Flow builder (STRAT-UI-BUILDER-1): a visual editor whose state is a real Stratum
// specification (`lib/spec.ts`). Ported from the Base44 "Stratum Studio" canvas; Tailwind
// classes, so the host compiles Tailwind over `src/builder/**` (the standalone shell does).
// Validation and the dry plan come from the host's DataClient (`validateSpec`, `planFlow`).
export { default as FlowBuilder } from './FlowBuilder';
/** The FlowBuilder ref handle: `getDocument()` and `flush()` (STRAT-FLOWBUILDER-FLUSH-1). @typedef {import('./FlowBuilder').FlowBuilderHandle} FlowBuilderHandle */
export {
  KINDS,
  KIND_FIELDS,
  buildExport,
  defaultStep,
  emptySpec,
  errorTarget,
  parseImport,
  pinErrors,
  stepKind,
} from './lib/spec';
