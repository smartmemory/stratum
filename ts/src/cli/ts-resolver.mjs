// Node 22 strips TypeScript syntax, but deliberately does not remap the
// NodeNext `.js` specifiers emitted by this source-only package. Keep that
// mapping at the executable boundary; library imports remain normal NodeNext.
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (!specifier.endsWith(".js")) throw error;
    return nextResolve(`${specifier.slice(0, -3)}.ts`, context);
  }
}
