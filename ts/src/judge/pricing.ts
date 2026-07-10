export interface ModelPricing {
  input: number;
  output: number;
}

/** Approximate USD per one million tokens, mirrored from the Python MCP table. */
export const MODEL_PRICING: Readonly<Record<string, ModelPricing>> = Object.freeze({
  "gpt-5.3-codex-spark": { input: 1.75, output: 14 },
  "gpt-5.6-terra": { input: 2.5, output: 15 },
  "gpt-5.6-sol": { input: 5, output: 30 },
});

export interface PricedTokenUsage {
  inputTokens?: number;
  outputTokens?: number;
}

export function baseModel(model: string): string {
  const slash = model.lastIndexOf("/");
  return slash === -1 ? model : model.slice(0, slash);
}

export function usdFromTokens(model: string, usage: PricedTokenUsage): number {
  const pricing = MODEL_PRICING[baseModel(model)];
  if (!pricing) return 0;
  const input = validCount(usage.inputTokens);
  const output = validCount(usage.outputTokens);
  return (input * pricing.input + output * pricing.output) / 1_000_000;
}

function validCount(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}
