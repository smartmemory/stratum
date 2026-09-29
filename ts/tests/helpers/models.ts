import { catalog } from "../../src/config/models.js";
import { devinModelFamilies, resolveDevinModel } from "../../src/config/devin-resolution.js";

export { catalog };

const family = (id: string) => id.slice(0, id.lastIndexOf("-"));
const devinFamily = family(catalog.devin.default.model);
const families = [...devinModelFamilies(catalog).keys()];
// Select serving roles by their behavior, never TOML row order.
const devinOpusFamily = families.find(id => `${id}-low-fast` in catalog.pricing.devin)!;
const devinSonnetFamily = families.find(id => id !== devinFamily && id !== devinOpusFamily && id !== catalog.claude.default.model)!;
export const testModels = {
  codexRetired: catalog.retired.codex[0]!,
  codexDefault: catalog.codex.default.model,
  cheap: catalog.judge.cheap.model,
  paranoid: catalog.judge.paranoid.model,
  claudeDefault: catalog.claude.default.model,
  devinDefault: catalog.devin.default.model,
  devinFamily,
  devinMedium: resolveDevinModel(devinFamily, "medium", catalog),
  devinMax: resolveDevinModel(devinFamily, "max", catalog),
  devinOpusFamily,
  devinSonnetFamily,
  devinOpusLow: `${devinOpusFamily}-low`,
  devinOpusHigh: `${devinOpusFamily}-high`,
  devinOpusXhigh: `${devinOpusFamily}-xhigh`,
  devinOpusLowFast: `${devinOpusFamily}-low-fast`,
  devinSonnetLow: `${devinSonnetFamily}-low`,
  devinSonnetXhigh: `${devinSonnetFamily}-xhigh`,
  unpriced: `${catalog.codex.default.model}-unpriced-fixture`,
};
