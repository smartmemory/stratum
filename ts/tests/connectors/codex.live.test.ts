import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { CodexConnector } from "../../src/connectors/codex.js";

function codexAvailable(): boolean {
  const probe = spawnSync("codex", ["--version"], { encoding: "utf8" });
  return probe.status === 0 && !probe.error && !/operation not permitted/i.test(probe.stderr);
}

// Live test: needs an authenticated codex CLI + network, which CI lacks (the
// binary exists on the runner but has no creds → 401). Skip under CI; run locally.
describe.skipIf(!codexAvailable() || !!process.env.CI)("live codex connector", () => {
  it("echoes through gpt-5.3-codex-spark/low", async () => {
    const result = await new CodexConnector({ model: "gpt-5.3-codex-spark/low" }).run("Reply with exactly: STRATUM_P3_ECHO_OK");
    expect(result.text).toContain("STRATUM_P3_ECHO_OK");
    expect(result.telemetry).toMatchObject({ model: "gpt-5.3-codex-spark", effort: "low" });
  }, 120_000);
});
