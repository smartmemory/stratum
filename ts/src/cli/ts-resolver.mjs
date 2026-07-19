// Node 22 strips TypeScript syntax, but deliberately does not remap the
// NodeNext `.js` specifiers emitted by this source-only package. Keep that
// mapping at the executable boundary; library imports remain normal NodeNext.
//
// Synchronous `resolve` hook for `module.registerHooks()` (the DEP0205
// replacement for the deprecated loader-based `module.register()`). The hook
// does no async I/O — it only remaps the specifier — so `nextResolve` is
// synchronous and a plain function suffices.
export function resolve(specifier, context, nextResolve) {
  try {
    return nextResolve(specifier, context);
  } catch (error) {
    if (!specifier.endsWith(".js")) throw error;
    return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
  }
}
