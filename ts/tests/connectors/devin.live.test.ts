import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DevinConnector } from "../../src/connectors/devin.js";

function devinAvailable(): boolean {
  const probe = spawnSync("devin", ["--version"], { encoding: "utf8" });
  return probe.status === 0 && !probe.error && !/operation not permitted/i.test(probe.stderr ?? "");
}

/**
 * STRAT-AGENT-DEVIN-1 golden 1 (S1b): a real devin foreground run through the
 * wrapper, per-run home, and seatbelt profile. Needs the real `devin` binary,
 * real credentials at ~/.local/share/devin, network, and a host where
 * sandbox-exec can actually run — so this is orchestrator-run only, gated on
 * STRATUM_DEVIN_LIVE=1, and skipped inside nested sandboxes where the probe
 * fails.
 */
describe.skipIf(process.env.STRATUM_DEVIN_LIVE !== "1" || !!process.env.CI || !devinAvailable())("live devin connector", () => {
  it("golden 1: swe-2-medium answers through the sandboxed foreground run", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "stratum-devin-live-"));
    try {
      const result = await new DevinConnector({ model: "swe-2-medium", cwd }).run(
        "Reply with exactly: STRATUM_DEVIN_G1_OK",
      );
      expect(result.text).toContain("STRATUM_DEVIN_G1_OK");
      expect(result.telemetry).toMatchObject({ model: "swe-2-medium" });
      expect(result.usdSource).toBe("estimated");
      expect(result.usage.usd).toBe(0);
      expect(result.usage.tokens).toBeGreaterThan(0);
      expect(result.sandboxAudit?.policy).toMatchObject({
        networkAccess: true, approvalPolicy: "never",
      });
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 300_000);
});
