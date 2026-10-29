// Builder canvas slot (STRAT-UI-BUILDER-1 owns it). Ported from the Base44 "Stratum Studio"
// app as-is: Tailwind classes, sample data, no DataClient yet. The host must compile
// Tailwind over `src/builder/**` (the standalone shell does, see ui/tailwind.config.js).
export { default as FlowBuilder } from './FlowBuilder';
export { makeStarterFlow, validateFlow, buildExport, parseImport } from './lib/flowSchema';
