import { describe, expect, it } from "vitest";
import { procStartTime, processGroupId, processIdentityMatches } from "../../src/connectors/proc_identity.js";

describe("proc identity", () => {
  it("rejects invalid pids and missing expected start times", async () => {
    expect(await procStartTime(0)).toBeUndefined();
    expect(await procStartTime(-1)).toBeUndefined();
    expect(await processGroupId(0)).toBeUndefined();
    expect(await processIdentityMatches(process.pid, undefined)).toBe(false);
  });

  it.skipIf(process.platform !== "darwin")(
    "uses the microsecond libproc start-time token on darwin, never second-precision lstart",
    async () => {
      // `ps -o lstart` output looks like "Thu Jul 10 09:00:00 2026"; the
      // libproc token is "seconds.microseconds". A killpg may only ever be
      // gated on the precise form (fail-closed contract with Python).
      const token = await procStartTime(process.pid);
      expect(token).toMatch(/^\d+\.\d+$/);
      expect(await processGroupId(process.pid)).toBeGreaterThan(0);
    },
  );

  it("treats a never-existing pid as dead", async () => {
    // PID_MAX on Linux and macOS is far below this; the identity check must
    // fail closed rather than error.
    expect(await processIdentityMatches(2 ** 30, "1.2")).toBe(false);
  });
});
