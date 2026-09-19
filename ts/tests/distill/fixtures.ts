import { mkdtemp, mkdir, realpath, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { loadSessions } from "../../src/distill/harvest.js";
import { detect } from "../../src/distill/detector.js";
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
export async function scratch(): Promise<string> { const root = await realpath(await mkdtemp(join(tmpdir(), "distill-test-"))); roots.push(root); return root; }
export function row(tools: string[] = ["Read", "Bash"], cwd: string | null = "/work", input: unknown = { command: "echo safe" }): string {
  return JSON.stringify({ type: "assistant", ...(cwd === null ? {} : { cwd }), message: { content: tools.map((name, i) => ({ type: "tool_use", name, input, id: `tool-${i}` })) } });
}
export async function corpus(tools = ["Read", "Bash"]): Promise<{ root: string; project: string }> {
  const root = await scratch(), project = join(root, "transcripts"); await mkdir(project);
  for (const name of ["a", "b"]) await writeFile(join(project, `${name}.jsonl`), row(tools));
  return { root, project };
}
export async function workflows(project: string) { return detect((await loadSessions(project)).sessions); }
