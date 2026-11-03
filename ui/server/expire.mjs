#!/usr/bin/env node
// Expire dead RUNNING runs through the engine's own cancel path (`cancelFlow`, ts/src/engine/flow_cancel.ts, the same
// call `stratum flow cancel` makes), with the reason `expired: no event since <date>` recorded on the run's
// `flow_cancelled` event. Never edits a run file by hand. Never selects an awaiting-gate run (`expiryCandidates`).
//
//   node ui/server/expire.mjs [--flows-dir <dir>] [--engine-dist <dir>] [--days 30] [--apply]
//
// Without --apply it only lists what it would cancel. Prints counts by display status before and after.
import { readdir, readFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { displayStatus, expiryCandidates, isRun } from "./project.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const flowsDir = resolve(flag("--flows-dir") ?? process.env.STRATUM_STATE_ROOT ?? join(homedir(), ".stratum", "ts", "flows"));
const engineDist = resolve(flag("--engine-dist") ?? join(here, "..", "..", "ts", "dist"));
const days = Number(flag("--days") ?? 30);
const apply = args.includes("--apply");
// Number("oops") is NaN and every comparison with NaN is false, which would read every run as old: refuse first.
if (!Number.isFinite(days) || days < 1) {
  console.error(`expire.mjs: --days must be a number of at least 1 (got ${JSON.stringify(flag("--days"))}); nothing selected`);
  process.exit(2);
}

const files = new Map(); // run id -> file name, for the re-read right before each cancel

async function loadRuns() {
  const runs = [];
  for (const name of (await readdir(flowsDir)).filter((n) => n.endsWith(".json"))) {
    try {
      const run = JSON.parse(await readFile(join(flowsDir, name), "utf8"));
      if (isRun(run)) { runs.push(run); files.set(run.id, name); }
    } catch { /* half-written or unreadable: skipped, like the list endpoint */ }
  }
  return runs;
}

const byStatus = (runs) => runs.reduce((acc, run) => ({ ...acc, [displayStatus(run)]: (acc[displayStatus(run)] ?? 0) + 1 }), {});

const before = await loadRuns();
const now = Date.now();
const candidates = expiryCandidates(before, now, days * 24 * 3600 * 1000);
console.log(JSON.stringify({ flowsDir, apply, days, total: before.length, before: byStatus(before), toExpire: candidates.length }));

if (apply) {
  const url = (...parts) => pathToFileURL(join(realpathSync(engineDist), ...parts)).href;
  const [{ StratumEngine }, { cancelFlow }, { createEvaluator }, { createEvaluateRunner }] = await Promise.all([
    import(url("engine", "engine.js")), import(url("engine", "flow_cancel.js")), import(url("eval", "expr.js")), import(url("engine", "evaluate.js")),
  ]);
  const engine = new StratumEngine({ stateRoot: flowsDir, evaluator: createEvaluator(), evaluateRunner: createEvaluateRunner() });
  let cancelled = 0;
  let skipped = 0;
  const failures = [];
  for (const { id, reason } of candidates) {
    try {
      // The run may have moved since selection (a gate opened, a step wrote an event): re-read and apply the same rule.
      // A small window between this read and the cancel remains: the engine's cancel path takes no precondition.
      const fresh = JSON.parse(await readFile(join(flowsDir, files.get(id)), "utf8"));
      if (!isRun(fresh) || fresh.status !== "running" || expiryCandidates([fresh], Date.now(), days * 24 * 3600 * 1000).length !== 1) {
        skipped += 1;
        console.log(JSON.stringify({ id, skipped: "changed since selection" }));
        continue;
      }
      const ack = await cancelFlow(engine, id, { reason });
      if (ack.status === "cancelled") cancelled += 1; else failures.push({ id, status: ack.status, detail: ack.reason });
    } catch (error) {
      failures.push({ id, error: String(error?.message ?? error) });
    }
  }
  const after = await loadRuns();
  console.log(JSON.stringify({ cancelled, "skipped (changed since selection)": skipped, failures, after: byStatus(after), total: after.length }));
  process.exit(failures.length ? 1 : 0);
}
