import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

const roots: string[] = [];

export function isolatedStateRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "stratum-test-flows-"));
  roots.push(root);
  return root;
}

// Registered before test hooks, so Vitest's default reverse teardown order
// closes servers and children before removing their stores.
afterAll(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, {
    recursive: true, force: true, maxRetries: 5, retryDelay: 50,
  })));
});
