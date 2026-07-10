import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../../src/cli/stratum.js";
import { checkLegacySpec, checkLegacyYaml } from "../../src/migrate/check.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

function captureMain(argv: string[]) {
  let stdout = "";
  let stderr = "";
  const out = process.stdout.write;
  const err = process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => { stdout += String(chunk); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { stderr += String(chunk); return true; }) as typeof process.stderr.write;
  return main(argv).then((code) => ({ code, stdout, stderr })).finally(() => { process.stdout.write = out; process.stderr.write = err; });
}

async function pythonTestFiles(root: string): Promise<string[]> {
  const names = await readdir(root, { recursive: true });
  return names.filter((name) => typeof name === "string" && name.endsWith(".py")).map((name) => join(root, name));
}

describe("P6 report-only compatibility linter", () => {
  it("classifies table constructs without translating the legacy document", () => {
    const source = `version: "0.3"
contracts: {Result: {value: {type: string}}}
functions: {work: {mode: compute, intent: work, input: {}, output: Result}}
flows:
  main:
    input: {}
    steps:
      - {id: run, function: work, inputs: {}, max_iterations: 2, exit_criterion: "result.ok", score_expr: "1"}
      - {id: parallel, type: parallel_dispatch, source: "$.input.tasks", agent: codex, isolation: branch, merge: manual, intent_template: work}
      - {id: staged, type: pipeline, stages: [{id: inner, fanout: {source: "$.input.tasks"}}]}
`;
    const report = checkLegacyYaml(source);
    expect(report.findings.map((finding) => finding.id)).toEqual(expect.arrayContaining(["function-compute", "iterate", "score-accumulate", "parallel-dispatch", "parallel-unsupported", "pipeline-nested"]));
    expect(report.findings.find((finding) => finding.id === "pipeline-nested")?.status).toBe("unsupported");
    expect(source).toContain('version: "0.3"');
  });

  it("flags step-level reasoning_template certificates on parallel_dispatch as unsupported", () => {
    const report = checkLegacySpec({
      version: "0.3",
      flows: { main: { input: {}, steps: [{ id: "fan", type: "parallel_dispatch", source: "$.input.tasks", intent_template: "work", reasoning_template: { premise: "p" } }] } },
    });
    expect(report.findings.map((finding) => finding.id)).toEqual(expect.arrayContaining(["parallel-dispatch", "parallel-unsupported"]));
  });

  it("reports malformed and unknown legacy inputs instead of throwing", () => {
    expect(checkLegacyYaml("version: [")).toMatchObject({ findings: [{ id: "unreadable", status: "diagnostic" }] });
    expect(checkLegacySpec({ version: "9.9" })).toMatchObject({ findings: [{ id: "unreadable", status: "diagnostic" }] });
  });

  it("runs stratum migrate --check as an exit-zero, report-only CLI command", async () => {
    const root = await mkdtemp(join(tmpdir(), "stratum-p6-migrate-")); roots.push(root);
    const input = join(root, "old.yaml");
    const before = 'version: "0.2"\nfunctions: {review: {mode: gate}}\nflows: {main: {input: {}, max_rounds: 1, steps: [{id: review, function: review, inputs: {}, on_revise: null}]}}\n';
    await writeFile(input, before);
    const result = await captureMain(["migrate", "--check", input]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toContain("report-only: no YAML was emitted or translated");
    expect(result.stdout).toContain("function decl mode: gate");
    expect(await readFile(input, "utf8")).toBe(before);
  });

  it("accepts v1 YAML at the validate parse boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "stratum-p6-validate-")); roots.push(root);
    const input = join(root, "v1.yaml");
    await writeFile(input, "version: 1\ncontracts: {Result: {value: string}}\nflows: {entry: main, main: {input: {}, output: {from: '${work.output}', contract: Result}, steps: [{id: work, do: work, out: Result}]}}\n");
    expect(await captureMain(["validate", input])).toMatchObject({ code: 0, stdout: '{"valid":true}\n', stderr: "" });
  });

  it("classifies every checked-in .stratum YAML file and embedded v0 fixture without crashing", async () => {
    // The Python suites embed their spec fixtures in test source; the only
    // physical .stratum.yaml documents live under docs/.
    const docsRoot = resolve(import.meta.dirname, "../../../docs");
    const physical = (await readdir(docsRoot, { recursive: true })).filter((name) => typeof name === "string" && /\.stratum\.ya?ml$/i.test(name)).map((name) => join(docsRoot, name));
    expect(physical.length).toBeGreaterThan(0);
    for (const path of physical) {
      const yaml = await readFile(path, "utf8");
      expect(() => checkLegacyYaml(yaml)).not.toThrow();
    }
    // Both Python suites: the core library's tests/ and stratum-mcp/tests.
    const testRoots = ["../../../tests", "../../../stratum-mcp/tests"].map((root) => resolve(import.meta.dirname, root));
    let snippets = 0;
    const sweep = (yaml: string) => {
      if (!/^\s*version:\s*["']?0\.[123]/m.test(yaml)) return;
      snippets += 1;
      expect(() => checkLegacyYaml(yaml)).not.toThrow();
    };
    for (const testsRoot of testRoots) {
      for (const path of await pythonTestFiles(testsRoot)) {
        const text = await readFile(path, "utf8");
        for (const match of text.matchAll(/([rubfRUBF]{0,2})(\"\"\"|''')([\s\S]*?)\2/g)) sweep(match[3] ?? "");
        // Fixtures built from implicitly concatenated single-line literals,
        // e.g. spec = ('version: "0.2"\n' 'flows:\n' ...).
        for (const block of text.matchAll(/(?:^[ \t]*(["'])(?:\\.|(?!\1)[^\\\n])*\1[ \t]*\n){2,}/gm)) {
          const fragments = [...block[0].matchAll(/(["'])((?:\\.|(?!\1)[^\\\n])*)\1/g)]
            .map((fragment) => (fragment[2] ?? "").replace(/\\n/g, "\n").replace(/\\(["'\\])/g, "$1"));
          sweep(fragments.join(""));
        }
      }
    }
    expect(snippets).toBeGreaterThan(20);
  });
});
