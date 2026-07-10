import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFileHelpers, FileValidationError, resolveWorkspacePath } from "../../src/eval/files.js";

let root: string;
let outside: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "stratum-eval-root-"));
  outside = await mkdtemp(join(tmpdir(), "stratum-eval-outside-"));
  await mkdir(join(root, "a", "nested"), { recursive: true });
  await writeFile(join(root, "proof.txt"), "alpha\nbeta\n", "utf8");
  await writeFile(join(outside, "secret.txt"), "outside", "utf8");
});

afterEach(async () => {
  await Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]);
});

describe("workspace file jail", () => {
  it("reads regular files inside the root", () => {
    const files = createFileHelpers(root);
    expect(files.fileExists("proof.txt")).toBe(true);
    expect(files.fileContains("proof.txt", "beta")).toBe(true);
    expect(files.fileContains("proof.txt", "gamma")).toBe(false);
    expect(files.fileExists("missing.txt")).toBe(false);
  });

  it("allows normalization that remains inside the root", () => {
    expect(resolveWorkspacePath(root, "a/../proof.txt")).toBe(realpathSync(join(root, "proof.txt")));
  });

  it.each([
    ["parent escape", "../secret.txt"],
    ["nested normalization escape", "a/../.."],
    ["deep normalization escape", "a/nested/../../../secret.txt"],
    ["absolute POSIX", "/tmp/secret.txt"],
    ["absolute Windows drive", "C:\\secret.txt"],
    ["absolute Windows UNC", "\\\\server\\share\\secret.txt"],
    ["empty", ""],
    ["NUL", "proof.txt\0suffix"],
  ])("rejects %s paths", (_name, path) => {
    expect(() => resolveWorkspacePath(root, path)).toThrow(FileValidationError);
  });

  it("rejects an existing symlink that resolves outside the root", async () => {
    await symlink(join(outside, "secret.txt"), join(root, "escape.txt"));
    expect(() => createFileHelpers(root).fileExists("escape.txt")).toThrow(/outside workspace root/u);
  });

  it("fails file_contains loudly on files over the read limit", () => {
    const files = createFileHelpers(root, { maxFileBytes: 4 });
    expect(() => files.fileContains("proof.txt", "beta")).toThrow(/read limit/u);
    expect(() => files.fileContains("proof.txt", "beta")).toThrow(FileValidationError);
  });

  it("keeps files at or under the read limit readable", () => {
    const files = createFileHelpers(root, { maxFileBytes: 11 });
    expect(files.fileContains("proof.txt", "beta")).toBe(true);
  });
});
