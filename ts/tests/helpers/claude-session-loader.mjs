import { registerHooks } from 'node:module';
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@anthropic-ai/claude-agent-sdk') {
      return {url: new URL('./claude-session-sdk.mjs', import.meta.url).href, shortCircuit: true};
    }
    return nextResolve(specifier, context);
  },
});
