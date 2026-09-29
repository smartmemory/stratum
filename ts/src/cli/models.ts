import { readFileSync } from "node:fs";
import { modelCatalog } from "../config/models.js";

const version: string = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")).version;

export function modelsCommand(args: string[]): number {
  if (args.length !== 1 || args[0] !== "--json") {
    process.stderr.write("Usage: stratum models --json\n");
    return 2;
  }
  process.stdout.write(`${JSON.stringify({ ...modelCatalog, version })}\n`);
  return 0;
}
