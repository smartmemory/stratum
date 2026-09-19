import * as fs from "node:fs/promises";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { digest, loadSessions } from "../../src/distill/harvest.js";
import { corpus, row, scratch } from "./fixtures.js";
vi.mock("node:fs/promises", async (original) => ({ ...await original<typeof import("node:fs/promises")>() }));
afterEach(() => vi.restoreAllMocks());
it("sorts top-level files and preserves physical lines, blocks and exact line digests", async () => {
  const root = await scratch(); const good = row(["Read"]);
  await fs.writeFile(join(root, "z.jsonl"), "\nmalformed\n" + good + "\n");
  await fs.writeFile(join(root, "a.jsonl"), JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "noise" }, { type: "tool_use", name: "Grep", input: {} }] } }));
  await fs.mkdir(join(root, "nested")); await fs.writeFile(join(root, "nested", "hidden.jsonl"), good);
  const result = await loadSessions(root);
  expect(result.sessions.map(s => s.sessionId)).toEqual(["a", "z"]);
  expect(result.sessions[0]!.observations[0]).toMatchObject({ blockIndex: 1, cwd: null });
  expect(result.sessions[1]!.observations[0]).toMatchObject({ lineNo: 3, blockIndex: 0, lineDigest: digest(good) });
  expect(result.diagnostics.droppedLines).toBe(1);
});
it("drops sidechains and noise, diagnoses malformed records and tool events", async () => {
  const root = await scratch();
  await fs.writeFile(join(root, "a.jsonl"), [row(["Read"]).replace('"type":"assistant"', '"isSidechain":true,"type":"assistant"'), '{"type":"user"}', 'null', '{"type":"assistant"}', row(["bad name"]), row(["Read"], null, null)].join("\n"));
  const result = await loadSessions(root);
  expect(result.diagnostics).toMatchObject({ droppedLines: 2, droppedEvents: 2 });
  expect(result.sessions[0]!.observations).toHaveLength(1);
  expect(result.sessions[0]!.observations[0]!.input).toEqual({});
});
it("defaults to 30 days, permits zero, rejects invalid windows", async () => {
  const { project } = await corpus();
  await fs.utimes(join(project, "a.jsonl"), new Date(0), new Date(0));
  expect((await loadSessions(project)).sessions).toHaveLength(1);
  expect((await loadSessions(project, { windowDays: 0 })).sessions).toHaveLength(2);
  for (const windowDays of [-1, 0.5, Infinity, NaN]) await expect(loadSessions(project, { windowDays })).rejects.toThrow();
});
it("keeps mtime failures visible, skips unreadable files, errors on directory failure", async () => {
  const { project } = await corpus();
  vi.spyOn(fs, "stat").mockRejectedValue(Object.assign(new Error(), { code: "EACCES" }));
  expect((await loadSessions(project)).diagnostics).toMatchObject({ mtimeFailures: 2, sessions: 2 });
  vi.spyOn(fs, "readFile").mockRejectedValue(Object.assign(new Error(), { code: "EACCES" }));
  expect((await loadSessions(project)).diagnostics.skippedFiles).toBe(2);
  vi.spyOn(fs, "readdir").mockRejectedValue(Object.assign(new Error(), { code: "EACCES" }));
  await expect(loadSessions(project)).rejects.toThrow("enumerate");
});
it("missing source is empty; source symlinks cannot escape", async () => {
  const root = await scratch();
  expect((await loadSessions(join(root, "absent"))).sessions).toEqual([]);
  const other = await scratch(); await fs.writeFile(join(other, "secret.jsonl"), row());
  await fs.symlink(join(other, "secret.jsonl"), join(root, "escape.jsonl"));
  expect((await loadSessions(root)).diagnostics.skippedFiles).toBe(1);
});
it("excludes a CRLF terminator from evidence digests", async () => {
  const root = await scratch(); const source = row(["Read"]);
  await fs.writeFile(join(root, "a.jsonl"), source + "\r\n");
  expect((await loadSessions(root)).sessions[0]!.observations[0]!.lineDigest).toBe(digest(source));
});
