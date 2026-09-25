import { readFileSync } from "node:fs";

// Both src/connectors and shipped dist/connectors sit two levels below package.json.
const { version } = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
if (typeof version !== "string" || !version) throw new Error("Missing Stratum package version");
export const clientInfo = Object.freeze({ name: "stratum", version });
