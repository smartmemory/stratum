import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../src/cli/stratum.js";

const roots: string[] = [];
const packageVersion: string = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
).version;

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "stratum-mcp-install-"));
  roots.push(root);
  return root;
}

async function captureMain(argv: string[]) {
  let stdout = "";
  let stderr = "";
  const out = process.stdout.write;
  const err = process.stderr.write;
  process.stdout.write = ((chunk: string | Uint8Array) => { stdout += String(chunk); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string | Uint8Array) => { stderr += String(chunk); return true; }) as typeof process.stderr.write;
  try {
    const code = await main(argv);
    return { code, stdout, stderr };
  } finally {
    process.stdout.write = out;
    process.stderr.write = err;
  }
}

function canonicalEntry() {
  return {
    command: "npx",
    args: ["-y", `--package=@smartmemory/stratum@${packageVersion}`, "stratum-mcp"],
  };
}

async function seed(root: string, entry: unknown): Promise<void> {
  await writeFile(join(root, ".mcp.json"), `${JSON.stringify({ mcpServers: { stratum: entry } }, null, 2)}\n`, "utf8");
}

describe.sequential("stratum mcp install and doctor golden", () => {
  it("installs the package-version-pinned entry idempotently without clobbering sibling servers", async () => {
    const root = await project();
    const installed = await captureMain(["mcp", "install", "--project", root]);
    expect(installed).toMatchObject({ code: 0, stderr: "" });
    expect(installed.stdout).toContain("created");

    const first = await readFile(join(root, ".mcp.json"), "utf8");
    expect(JSON.parse(first)).toEqual({ mcpServers: { stratum: canonicalEntry() } });
    const repeated = await captureMain(["mcp", "install", "--project", root]);
    expect(repeated).toMatchObject({ code: 0, stderr: "" });
    expect(repeated.stdout).toContain("already-current");
    expect(await readFile(join(root, ".mcp.json"), "utf8")).toBe(first);

    const withSibling = { mcpServers: { stratum: canonicalEntry(), other: { command: "other-server", args: ["--flag"] } }, unrelated: { preserved: true } };
    await writeFile(join(root, ".mcp.json"), `${JSON.stringify(withSibling, null, 2)}\n`, "utf8");
    const before = await readFile(join(root, ".mcp.json"), "utf8");
    expect((await captureMain(["mcp", "install", "--project", root])).code).toBe(0);
    expect(await readFile(join(root, ".mcp.json"), "utf8")).toBe(before);
  });

  it.each([
    ["retired-bin", { command: "stratum-mcp", args: [] }],
    ["source-path", { command: "node", args: ["/consumer/stratum/ts/src/mcp/bin.mjs"] }],
    ["version-drift", { command: "npx", args: ["-y", "--package=@smartmemory/stratum@0.0.1", "stratum-mcp"] }],
  ])("detects and repairs %s", async (className, brokenEntry) => {
    const root = await project();
    await seed(root, brokenEntry);

    const broken = await captureMain(["doctor", "--project", root]);
    expect(broken.code).toBe(1);
    expect(broken.stderr).toBe("");
    expect(broken.stdout).toContain(className);

    const fixed = await captureMain(["doctor", "--project", root, "--fix"]);
    expect(fixed).toMatchObject({ code: 0, stderr: "" });
    expect(fixed.stdout).toContain(`before: ${className}`);
    expect(fixed.stdout).toContain("after: ok");
    expect(JSON.parse(await readFile(join(root, ".mcp.json"), "utf8"))).toEqual({ mcpServers: { stratum: canonicalEntry() } });

    const clean = await captureMain(["doctor", "--project", root]);
    expect(clean).toMatchObject({ code: 0, stderr: "" });
    expect(clean.stdout).toContain(": ok");
  });

  it("reports and repairs missing files, missing entries, and malformed JSON", async () => {
    const root = await project();
    const missingFile = await captureMain(["doctor", "--project", root]);
    expect(missingFile.code).toBe(1);
    expect(missingFile.stdout).toContain("missing-file");
    expect((await captureMain(["doctor", "--project", root, "--fix"])).code).toBe(0);

    await writeFile(join(root, ".mcp.json"), '{"mcpServers":{"other":{"command":"other"}}}\n', "utf8");
    const missingEntry = await captureMain(["doctor", "--project", root]);
    expect(missingEntry.code).toBe(1);
    expect(missingEntry.stdout).toContain("missing-entry");
    expect((await captureMain(["doctor", "--project", root, "--fix"])).code).toBe(0);
    expect(JSON.parse(await readFile(join(root, ".mcp.json"), "utf8"))).toMatchObject({ mcpServers: { other: { command: "other" }, stratum: canonicalEntry() } });

    await writeFile(join(root, ".mcp.json"), "not json\n", "utf8");
    const malformed = await captureMain(["doctor", "--project", root]);
    expect(malformed.code).toBe(1);
    expect(malformed.stdout).toContain("malformed-json");
    expect((await captureMain(["doctor", "--project", root, "--fix"])).code).toBe(0);
  });

  it("sweeps the STRATUM_CONSUMERS registry and treats an absent registry as clean", async () => {
    const root = await project();
    await seed(root, { command: "stratum", args: [] });
    const previous = process.env.STRATUM_CONSUMERS;
    try {
      process.env.STRATUM_CONSUMERS = root;
      const broken = await captureMain(["doctor", "--all"]);
      expect(broken.code).toBe(1);
      expect(broken.stdout).toContain("retired-bin");
      expect((await captureMain(["doctor", "--all", "--fix"])).code).toBe(0);

      process.env.STRATUM_CONSUMERS = "";
      const noRegistry = await captureMain(["doctor", "--all"]);
      expect(noRegistry.code).toBe(0);
      expect(noRegistry.stdout).toContain("no consumer registry configured");
    } finally {
      if (previous === undefined) delete process.env.STRATUM_CONSUMERS;
      else process.env.STRATUM_CONSUMERS = previous;
    }
  });
});
