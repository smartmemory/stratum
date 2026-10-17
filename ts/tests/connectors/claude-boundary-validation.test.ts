import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "../../src/connectors/runner.js";
import { claudeWorkerRegistry, startBackgroundRun } from "../../src/connectors/background.js";
import { ClaudeConnector, type QueryFunction } from "../../src/connectors/claude.js";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "test_dn2_p3s-"));
  vi.stubEnv("DETACH_CLAUDE_INDEX_DIR", join(root, "index"));
});
afterEach(async () => {
  claudeWorkerRegistry.clear();
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

const bg = { cwd: "", registryRoot: "", prompt: "test", env: {} as NodeJS.ProcessEnv };
const bad = { sessionId: { sessionId: "not-a-uuid" }, label: { indexLabel: "  " } };

// One row per entry point that can reach ClaudeConnector.run with caller options, crossed with
// {bad sessionId, blank label} as explicit rows. Each must refuse with the connector's own typed error
// before a run directory (background) or a query (foreground) exists.
const entries: Array<{ name: string; call: (extra: Record<string, unknown>, query: QueryFunction) => Promise<unknown>; background: boolean }> = [
  { name: "runAgent foreground", background: false,
    call: (extra, query) => runAgent({ agent: "claude", cwd: root, prompt: "test", ...extra }, { claudeQuery: query }) },
  { name: "runAgent background", background: true,
    call: (extra, query) => runAgent({ agent: "claude", background: true, cwd: root, registryRoot: join(root, "runs"), prompt: "test", env: {}, ...extra }, { claudeQuery: query }) },
  { name: "startBackgroundRun", background: true,
    call: (extra) => startBackgroundRun({ ...bg, agent: "claude", cwd: root, registryRoot: join(root, "runs"), ...extra } as Parameters<typeof startBackgroundRun>[0]) },
  { name: "ClaudeConnector.run", background: false,
    call: (extra, query) => new ClaudeConnector({ ...extra, query }).run("test") },
];
const rows = entries.flatMap(entry => [
  { entry, kind: "sessionId", extra: bad.sessionId, message: "Claude sessionId must be a UUID" },
  { entry, kind: "blank label", extra: bad.label, message: "Claude indexLabel must be a non-empty label" },
]);

it.each(rows)("$entry.name refuses $kind with the typed error before starting work", async ({ entry, extra, message }) => {
  const query = vi.fn<QueryFunction>(async function* () { yield { type: "result", subtype: "success", result: "x" }; });
  const refusal = entry.call(extra, query);
  await expect(refusal).rejects.toBeInstanceOf(TypeError);
  await expect(refusal).rejects.toThrow(message);
  expect(query).not.toHaveBeenCalled();
  expect(claudeWorkerRegistry.size).toBe(0);
  if (entry.background) await expect(readdir(join(root, "runs"))).rejects.toMatchObject({ code: "ENOENT" });
});
