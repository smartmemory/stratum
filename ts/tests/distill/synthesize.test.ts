import { expect, it } from "vitest";
import { synthesize } from "../../src/distill/synthesize.js";
import { corpus, workflows } from "./fixtures.js";
it.each([["Read"], ["Bash"], ["Grep"]])("singletons choose command: %s", async tool => {
  const { root, project } = await corpus([tool]);
  expect(synthesize((await workflows(project))[0]!, { workspaceRoot: root })!.targetKind).toBe("command");
});
it.each([["Read", "Grep", "subagent"], ["Read", "Bash", "skill"]])("selects the smallest sequence form: %s %s", async (a, b, expected) => {
  const { root, project } = await corpus([a, b]);
  const w = (await workflows(project)).find(w => w.workflow.kind === "sequence")!;
  expect(synthesize(w, { workspaceRoot: root })!.targetKind).toBe(expected);
  expect(synthesize(w, { workspaceRoot: root }, () => "command")).toMatchObject({ targetKind: "command", authoring: { selectedBy: "override" } });
  for (const selector of [() => "skill or command", () => ({ kind: "command" }), () => { throw new Error(); }]) {
    expect(synthesize(w, { workspaceRoot: root }, selector)).toEqual(synthesize(w, { workspaceRoot: root }));
  }
});
it("ignores selector mutations and declines unknown/below-bar input", async () => {
  const { root, project } = await corpus(); const w = (await workflows(project))[0]!;
  const original = structuredClone(w);
  synthesize(w, { workspaceRoot: root }, x => { x.evidence.length = 0; return "skill"; });
  expect(w).toEqual(original);
  expect(synthesize(w, { workspaceRoot: root, minCount: 100 })).toBeNull();
  expect(synthesize({ ...w, workflow: { ...w.workflow, kind: "unknown" } } as never, { workspaceRoot: root })).toBeNull();
});
