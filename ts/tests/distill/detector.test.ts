import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, it } from "vitest";
import { canonicalizeInput, detect } from "../../src/distill/detector.js";
import { loadSessions } from "../../src/distill/harvest.js";
import { corpus, row, workflows } from "./fixtures.js";
it("pins ordinary JSON, priority, recursive sorting and Unicode/numeric differences", () => {
  expect(canonicalizeInput({ path: "p", command: "echo" })).toBe("echo");
  expect(canonicalizeInput({ z: [1, { b: 2, a: true }], a: "é" })).toBe('{"a": "é", "z": [1, {"a": true, "b": 2}]}');
  expect(canonicalizeInput({ x: 1e-7 })).toBe('{"x": 1e-7}');
  expect(canonicalizeInput({ command: "😀".repeat(121) })).toBe("😀".repeat(120));
});
it("redacts before truncation without exposing known secret patterns", () => {
  for (const secret of ["sk-abc123xyz", "ghp_abcdef", "AKIA1234567890123456", "Bearer abcdef", "password=abc123", "api_key=abc123", "-----BEGIN PRIVATE KEY-----\nabc123\n-----END PRIVATE KEY-----"]) {
    const result = canonicalizeInput({ command: "x".repeat(100) + " " + secret });
    expect(result).toContain("[REDACTED]"); expect(result).not.toContain("abc123");
  }
});
it("requires cross-session recurrence, never pooling projects", async () => {
  const { project } = await corpus(["Read"]);
  const { sessions } = await loadSessions(project);
  expect(detect([sessions[0]!, sessions[0]!])).toEqual([]);
  expect(detect([sessions[0]!, { ...sessions[1]!, projectDir: "/another" }])).toEqual([]);
  expect(detect([...sessions, ...sessions])).toEqual(detect(sessions));
});
it("counts all overlapping windows of lengths 2–4 and orders deterministically", async () => {
  const { project } = await corpus(["Read", "Read", "Read", "Read"]);
  const result = await workflows(project);
  expect(result.map(w => w.recurrence.records)).toEqual([8, 6, 4, 2]);
  expect(result.map(w => w.workflow.kind === "single" ? 1 : w.workflow.tools.length)).toEqual([1, 2, 3, 4]);
  const sessions = (await loadSessions(project)).sessions;
  expect(detect(sessions.reverse())).toEqual(result);
  expect(result[1]!.evidence.map(e => e.steps.map(s => s.blockIndex))).toEqual([[0, 1], [1, 2], [2, 3], [0, 1], [1, 2], [2, 3]]);
});
it("retains step-local cwd without carry-forward or unrelated scope widening", async () => {
  const { project } = await corpus();
  for (const name of ["a", "b"]) await writeFile(join(project, `${name}.jsonl`), [row(["Read"], "/first"), row(["Bash"], null), row(["Glob"], "/unrelated")].join("\n"));
  const sequence = (await workflows(project)).find(w => w.workflow.kind === "sequence" && w.workflow.tools.join() === "Read,Bash")!;
  expect(sequence.evidence[0]!.cwd).toBeNull();
  expect(sequence.evidence[0]!.steps.map(s => s.cwd)).toEqual(["/first", null]);
  expect(sequence.scope.observedCwds).toEqual(["/first"]);
  expect(sequence.sourceHandle).toMatchObject({ sessionId: "a", lineNo: 1, blockIndex: 0 });
});
