#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { extraNodeFlags } from "../cli/node-flags.mjs";

const child = spawnSync(process.execPath, [...extraNodeFlags(), "--import", new URL("../cli/bootstrap.mjs", import.meta.url).href, fileURLToPath(new URL("./main.ts", import.meta.url)), ...process.argv.slice(2)], { stdio: "inherit" });
process.exitCode = child.status ?? 1;
