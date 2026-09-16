import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { CodexConnector } from "../../src/connectors/codex.js";

function codexAvailable(): boolean {
  const probe = spawnSync("codex", ["--version"], { encoding: "utf8" });
  return probe.status === 0 && !probe.error && !/operation not permitted/i.test(probe.stderr);
}

// Paid live execution is opt-in even on authenticated developer machines.
describe.skipIf(process.env.STRATUM_LIVE_CODEX !== "1" || !!process.env.CI || !codexAvailable())("live codex connector", () => {
  it("echoes through gpt-5.6-terra/low", async () => {
    const result = await new CodexConnector({ model: "gpt-5.6-terra/low" }).run("Reply with exactly: STRATUM_P3_ECHO_OK");
    expect(result.text).toContain("STRATUM_P3_ECHO_OK");
    expect(result.telemetry).toMatchObject({ model: "gpt-5.6-terra", effort: "low" });
  }, 120_000);
});
