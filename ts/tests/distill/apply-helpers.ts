import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { authorCandidate, type AssetKind, type SourceMode } from "../../src/distill/candidate.js";
import { detect } from "../../src/distill/detector.js";
import { loadSessions } from "../../src/distill/harvest.js";

export async function assetFixture(mode: SourceMode = "explicit-project", kind: AssetKind = "skill", command = "git status") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "asset-apply-")));
  const project = mode === "workspace" ? join(homedir(), ".claude", "projects", root.replace(/\//g, "-")) : join(root, "transcripts");
  await mkdir(project, { recursive: true });
  for (const name of ["one", "two"]) await writeFile(join(project, `${name}.jsonl`), JSON.stringify({ type: "assistant", cwd: root,
    message: { content: [{ type: "tool_use", id: `tool-${name}`, name: "Bash", input: { command } }] } }) + "\n");
  const workflow = detect((await loadSessions(project, { windowDays: 0 })).sessions)[0]!;
  const candidate = authorCandidate(workflow, kind, { workspaceRoot: root, sourceMode: mode });
  return { root, project, workflow, candidate };
}
export function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
