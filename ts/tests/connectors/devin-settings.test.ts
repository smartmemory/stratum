import { testModels } from "../helpers/models.js";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { SMARTMEMORY_SCRUB_VARS } from "../../src/connectors/base.js";
import { pollBackgroundRun, startBackgroundRun } from "../../src/connectors/background.js";
import { createForegroundRun, settleForegroundRun } from "../../src/connectors/foreground_registry.js";
import {
  DEVIN_DEFAULT_MODEL,
  DEVIN_SCRUB_VARS,
  assertDevinSandboxAllowed,
  devinModelFamilies,
  devinModelIds,
  resolveDevinModel,
} from "../../src/connectors/devin-model.js";
import { runAgent, validateAgentSettings } from "../../src/connectors/runner.js";
import { fullAccessAuthorization, loadStratumConfig } from "../../src/config/index.js";
import { DEVIN_MODEL_PRICING, dispatchableModels } from "../../src/judge/pricing.js";
import { createToolDispatcher } from "../../src/mcp/server.js";

/**
 * STRAT-AGENT-DEVIN-1 slice S1a — the D6 (models), D7 (env) and D11 (config)
 * error-harness rows. Everything here is table-driven and needs no devin
 * binary: with HOME redirected to the temp root the foreground connector fails
 * validation-last at the not-logged-in boundary in both dispatch modes.
 */

const NOT_LOGGED_IN = "devin is not logged in (run `devin auth`)";

const roots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "stratum-devin-s1a-"));
  roots.push(root);
  return root;
}

/** Env that isolates config resolution AND devin state from the developer's
 *  real files: HOME redirects the credentials probe onto the temp root, so a
 *  valid dispatch can never reach the real ~/.local/share/devin or ~/.stratum. */
function isolatedEnv(root: string, extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { STRATUM_CONFIG_FILE: join(root, "missing-user.toml"), HOME: root, PATH: "/usr/bin:/bin", ...extra };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("DEVIN_MODEL_PRICING (D6)", () => {
  it.each([testModels.devinMedium, testModels.devinDefault, testModels.devinMax])("prices free SWE-2 model %s at zero", (id) => {
    expect(DEVIN_MODEL_PRICING[id]).toEqual({ input: 0, output: 0, cacheRead: 0 });
  });

  it("stays out of the codex allowlist", () => {
    for (const id of devinModelIds()) expect(dispatchableModels()).not.toContain(id);
  });
});

describe("synthetic Devin allowlist", () => {
  it("rejects retired and foreign provider ids", () => {
    expect(devinModelIds()).not.toContain("test-retired-low");
    expect(() => resolveDevinModel("test-retired-low")).toThrow("Unknown devin model");
    expect(() => resolveDevinModel("test-codex-a")).toThrow("Unknown devin model");
    expect(DEVIN_DEFAULT_MODEL).toBe("test-devin-high");
  });
});

describe("devinModelFamilies", () => {
  it("derives family→effort tables from the pricing ids", () => {
    const families = devinModelFamilies();
    expect(families.get(testModels.devinFamily)).toEqual(["high", "max", "medium"]);
    expect(families.get(testModels.devinOpusFamily)).toEqual(["high", "low", "max", "medium", "xhigh"]);
    expect(families.get(testModels.devinSonnetFamily)).toEqual(["high", "low", "max", "medium", "xhigh"]);
    expect(families.get(testModels.claudeDefault)).toEqual(["high", "low", "max", "medium", "xhigh"]);
    // A priced id surfaced by a -fast variant is a full id, not a family.
    expect(families.has(testModels.devinOpusLow)).toBe(false);
    expect(families.has(testModels.devinOpusLowFast)).toBe(false);
  });
});

describe("resolveDevinModel (D6)", () => {
  it.each([
    [undefined, undefined, DEVIN_DEFAULT_MODEL],
    [undefined, "max", testModels.devinMax],
    [testModels.devinDefault, undefined, testModels.devinDefault],
    [testModels.devinSonnetXhigh, undefined, testModels.devinSonnetXhigh],
    // The -fast serving variants are dispatchable by full id only.
    [testModels.devinOpusLowFast, undefined, testModels.devinOpusLowFast],
    [testModels.devinFamily, "high", testModels.devinDefault],
    [testModels.devinFamily, "medium", testModels.devinMedium],
    [testModels.devinOpusFamily, "xhigh", testModels.devinOpusXhigh],
    [`${testModels.devinFamily}/high`, undefined, testModels.devinDefault],
    [`${testModels.devinSonnetFamily}/low`, undefined, testModels.devinSonnetLow],
    // A full id plus its own effort is not a conflict.
    [testModels.devinDefault, "high", testModels.devinDefault],
    [`${testModels.devinFamily}/high`, "high", testModels.devinDefault],
  ])("resolves (%s, %s) → %s", (model, effort, expected) => {
    expect(resolveDevinModel(model, effort)).toBe(expected);
  });

  it("resolves all three accepted spellings to the same id", () => {
    expect(resolveDevinModel(testModels.devinFamily, "high")).toBe(resolveDevinModel(`${testModels.devinFamily}/high`));
    expect(resolveDevinModel(`${testModels.devinFamily}/high`)).toBe(resolveDevinModel(testModels.devinDefault));
  });

  it.each([
    "typo",
    testModels.codexDefault,
    `${testModels.devinDefault}/extra/deep`,
  ])("rejects unknown model %s naming the valid ids", (model) => {
    expect(() => resolveDevinModel(model)).toThrow(
      new RegExp(`Unknown devin model .*; accepted models: .*${testModels.devinDefault}`),
    );
  });

  it.each([
    [testModels.devinFamily, "high, max, medium"],
    [testModels.devinSonnetFamily, "high, low, max, medium, xhigh"],
    [testModels.devinOpusFamily, "high, low, max, medium, xhigh"],
  ])("rejects a bare family %s with no effort, naming the family's efforts", (family, efforts) => {
    expect(() => resolveDevinModel(family)).toThrow(
      `devin model family ${JSON.stringify(family)} requires an effort; accepted efforts: ${efforts}`,
    );
  });

  it.each(["xhigh", "ultra", "low-fast"])(`rejects unknown ${testModels.devinFamily} effort %s naming the valid set`, (effort) => {
    expect(() => resolveDevinModel(testModels.devinFamily, effort)).toThrow(
      `Unknown devin effort "${effort}" for family "${testModels.devinFamily}"; accepted efforts: high, max, medium`,
    );
    expect(() => resolveDevinModel(`${testModels.devinFamily}/${effort}`)).toThrow(
      `Unknown devin effort "${effort}" for family "${testModels.devinFamily}"; accepted efforts: high, max, medium`,
    );
  });

  it("rejects a full id plus a conflicting effort", () => {
    expect(() => resolveDevinModel(testModels.devinDefault, "max")).toThrow(
      `devin effort "max" conflicts with model "${testModels.devinDefault}"`,
    );
    expect(() => resolveDevinModel(`${testModels.devinFamily}/high`, "max")).toThrow(
      `devin effort "max" conflicts with the effort in model "${testModels.devinFamily}/high"`,
    );
  });
});

describe("DEVIN_SCRUB_VARS (D7)", () => {
  it("scrubs every provider key, every devin mode override, and the SmartMemory set", () => {
    expect([...DEVIN_SCRUB_VARS]).toEqual([
      "ANTHROPIC_API_KEY", "CLAUDE_API_KEY", "CLAUDECODE", "OPENAI_API_KEY",
      "DEVIN_MODEL", "DEVIN_PERMISSION_MODE", "DEVIN_SANDBOX",
      ...SMARTMEMORY_SCRUB_VARS,
    ]);
  });
});

describe("validateAgentSettings for devin (D1/D3/D11)", () => {
  it.each([
    [{ thinking: { type: "adaptive" } }, "thinking"],
    [{ allowedTools: ["Read"] }, "allowedTools"],
    [{ disallowedTools: ["Write"] }, "disallowedTools"],
  ])("rejects Claude-only %s with codex's wording, naming devin", (options, _name) => {
    expect(() => validateAgentSettings({ agent: "devin", ...options }))
      .toThrow("Devin does not support Claude thinking/tool filters; select a Devin sandboxMode instead");
  });

  it("rejects an explicit approvalPolicy — including the enforced 'never'", () => {
    for (const approvalPolicy of ["never", "on-request", "on-failure", "untrusted"] as const) {
      expect(() => validateAgentSettings({ agent: "devin", approvalPolicy }))
        .toThrow("Codex approvalPolicy is not supported by devin");
    }
  });

  it("rejects an explicit networkAccess:false with the D3 message", () => {
    expect(() => validateAgentSettings({ agent: "devin", networkAccess: false }))
      .toThrow("devin cannot run without network; networkAccess:false is not enforceable for devin");
  });

  it.each([
    {},
    { networkAccess: true },
    { writableRoots: ["/tmp"] },
    { model: testModels.devinFamily, effort: "max" },
    { model: testModels.devinOpusHigh },
  ])("accepts %j", (options) => {
    expect(() => validateAgentSettings({ agent: "devin", ...options })).not.toThrow();
  });
});

describe("assertDevinSandboxAllowed / fullAccessAuthorization (D11)", () => {
  it("requires STRATUM_DEVIN_ALLOW_FULL_ACCESS for danger-full-access", () => {
    expect(() => assertDevinSandboxAllowed("read-only", {})).not.toThrow();
    expect(() => assertDevinSandboxAllowed("workspace-write", {})).not.toThrow();
    expect(() => assertDevinSandboxAllowed("danger-full-access", {}))
      .toThrow("devin danger-full-access is disabled; set STRATUM_DEVIN_ALLOW_FULL_ACCESS=1 to opt in explicitly");
  });

  it("STRATUM_CODEX_ALLOW_FULL_ACCESS alone does not authorise devin", () => {
    expect(() => assertDevinSandboxAllowed("danger-full-access", { STRATUM_CODEX_ALLOW_FULL_ACCESS: "1" }))
      .toThrow("STRATUM_DEVIN_ALLOW_FULL_ACCESS");
    expect(fullAccessAuthorization({ STRATUM_CODEX_ALLOW_FULL_ACCESS: "1" }, "devin")).toBeUndefined();
    expect(fullAccessAuthorization({ STRATUM_DEVIN_ALLOW_FULL_ACCESS: "yes" }, "devin"))
      .toEqual({ layer: "env", source: "STRATUM_DEVIN_ALLOW_FULL_ACCESS" });
    // The codex call site is unchanged.
    expect(fullAccessAuthorization({ STRATUM_CODEX_ALLOW_FULL_ACCESS: "yes" }))
      .toEqual({ layer: "env", source: "STRATUM_CODEX_ALLOW_FULL_ACCESS" });
  });
});

describe("runAgent devin — validation precedes the connector boundary", () => {
  it("rejects a valid dispatch only at the real connector's not-logged-in gate", async () => {
    const root = await temporaryRoot();
    await expect(runAgent({ agent: "devin", prompt: "p", cwd: root, registryRoot: root, env: isolatedEnv(root) }))
      .rejects.toThrow(NOT_LOGGED_IN);
  });

  it.each<[Partial<import("../../src/connectors/runner.js").AgentRunOptions>, RegExp]>([
    [{ model: "typo" }, /Unknown devin model "typo"/],
    [{ effort: "ultra" }, /Unknown devin effort "ultra"/],
    [{ model: testModels.devinMax, effort: "high" }, /conflicts/],
    [{ thinking: { type: "adaptive" } }, /Devin does not support Claude thinking\/tool filters/],
    [{ allowedTools: ["Read"] }, /Devin does not support Claude thinking\/tool filters/],
    [{ approvalPolicy: "never" }, /Codex approvalPolicy is not supported by devin/],
    [{ networkAccess: false }, /devin cannot run without network; networkAccess:false is not enforceable for devin/],
    [{ sandboxMode: "bogus" as never }, /Unknown sandboxMode/],
  ])("rejects %j before reaching the connector boundary", async (options, pattern) => {
    const root = await temporaryRoot();
    await expect(runAgent({ agent: "devin", prompt: "p", cwd: root, registryRoot: root, env: isolatedEnv(root), ...options }))
      .rejects.toThrow(pattern);
  });

  it("rejects danger-full-access without the devin opt-in — a codex grant does not count", async () => {
    const root = await temporaryRoot();
    await expect(runAgent({
      agent: "devin", prompt: "p", cwd: root, registryRoot: root, sandboxMode: "danger-full-access",
      env: isolatedEnv(root),
    })).rejects.toThrow("STRATUM_DEVIN_ALLOW_FULL_ACCESS");
    await expect(runAgent({
      agent: "devin", prompt: "p", cwd: root, registryRoot: root, sandboxMode: "danger-full-access",
      env: isolatedEnv(root, { STRATUM_CODEX_ALLOW_FULL_ACCESS: "1" }),
    })).rejects.toThrow("STRATUM_DEVIN_ALLOW_FULL_ACCESS");
    await expect(runAgent({
      agent: "devin", prompt: "p", cwd: root, registryRoot: root, sandboxMode: "danger-full-access",
      env: isolatedEnv(root, { STRATUM_DEVIN_ALLOW_FULL_ACCESS: "1" }),
    })).rejects.toThrow(NOT_LOGGED_IN);
  });

  it("STRATUM_CODEX_SANDBOX_MODE does not change devin's mode", async () => {
    const root = await temporaryRoot();
    // If the codex env layer leaked in this would fail on the missing
    // STRATUM_DEVIN_ALLOW_FULL_ACCESS opt-in; instead it reaches the connector.
    await expect(runAgent({
      agent: "devin", prompt: "p", cwd: root, registryRoot: root,
      env: isolatedEnv(root, { STRATUM_CODEX_SANDBOX_MODE: "danger-full-access" }),
    })).rejects.toThrow(NOT_LOGGED_IN);
  });

  it("a project stratum.toml approvalPolicy does not fail a devin dispatch", async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, "stratum.toml"), [
      "[sandbox]",
      'approvalPolicy = "on-request"',
      "networkAccess = false",
      'writableRoots = ["/cache"]',
    ].join("\n"));
    await expect(runAgent({ agent: "devin", prompt: "p", cwd: root, registryRoot: root, env: isolatedEnv(root) }))
      .rejects.toThrow(NOT_LOGGED_IN);
  });

  it("background dispatch validates then stops at the credentials gate, leaving no run dir", async () => {
    const root = await temporaryRoot();
    await expect(runAgent({
      agent: "devin", prompt: "p", cwd: root, background: true, registryRoot: root, env: isolatedEnv(root),
    })).rejects.toThrow(NOT_LOGGED_IN);
    expect(await readdir(root)).toEqual([]);
  });
});

describe("startBackgroundRun devin — third validation layer (D6/D11)", () => {
  it.each<[Partial<import("../../src/connectors/background.js").StartBackgroundRunOptions>, RegExp]>([
    [{}, /devin is not logged in \(run `devin auth`\)/],
    [{ networkAccess: false }, /devin cannot run without network; networkAccess:false is not enforceable for devin/],
    [{ approvalPolicy: "on-request" }, /Codex approvalPolicy is not supported by devin/],
    [{ model: "typo" }, /Unknown devin model "typo"; accepted models:/],
    [{ sandboxMode: "danger-full-access" }, /STRATUM_DEVIN_ALLOW_FULL_ACCESS/],
  ])("rejects %j correctly", async (options, pattern) => {
    const root = await temporaryRoot();
    await expect(startBackgroundRun({
      agent: "devin", prompt: "p", cwd: root, registryRoot: root,
      env: isolatedEnv(root), ...options,
    })).rejects.toThrow(pattern);
    expect(await readdir(root)).toEqual([]);
  });
});

describe("devin sandboxAudit records the enforced boundary (D11)", () => {
  it("networkAccess:true and approvalPolicy:'never' carry enforced provenance", async () => {
    const root = await temporaryRoot();
    const resolved = loadStratumConfig({ projectRoot: root, agent: "devin", env: isolatedEnv(root) });
    const audit = resolved.sandboxAudit();
    expect(audit.policy).toEqual({
      filesystemMode: "read-only", networkAccess: true, writableRoots: [], approvalPolicy: "never",
    });
    expect(audit.provenance.networkAccess).toEqual({ layer: "enforced", source: expect.stringContaining("devin:") });
    expect(audit.provenance.approvalPolicy).toEqual({ layer: "enforced", source: expect.stringContaining("devin:") });
    expect(audit.provenance.filesystemMode).toEqual({ layer: "default", source: "built-in defaults" });
    expect(audit.provenance.writableRoots).toEqual({ layer: "default", source: "built-in defaults" });
  });

  it("enforcement survives a stratum.toml that sets networkAccess=false", async () => {
    const root = await temporaryRoot();
    await writeFile(join(root, "stratum.toml"), '[sandbox]\nnetworkAccess = false\napprovalPolicy = "untrusted"\n');
    const audit = loadStratumConfig({ projectRoot: root, agent: "devin", env: isolatedEnv(root) }).sandboxAudit();
    expect(audit.policy.networkAccess).toBe(true);
    expect(audit.policy.approvalPolicy).toBe("never");
    expect(audit.provenance.networkAccess.layer).toBe("enforced");
    expect(audit.provenance.approvalPolicy.layer).toBe("enforced");
  });
});

describe("devin record parse (D1)", () => {
  it("a foreground meta.json with agent:devin round-trips through the registry", async () => {
    const root = await temporaryRoot();
    const registryId = await createForegroundRun({
      foreground: true, state: "starting", agent: "devin",
      cancellationId: randomUUID(), serverPid: process.pid,
      flow: { runId: "deadbeef0001" }, cwd: root, groups: [],
      createdAt: new Date().toISOString(),
    }, { registryRoot: root });
    // settleForegroundRun re-parses the meta — a devin record the parser
    // rejected would throw "missing or unreadable" here.
    await expect(settleForegroundRun(registryId, { registryRoot: root })).resolves.toBeUndefined();
    const written = JSON.parse(await readFile(join(root, registryId, "meta.json"), "utf8"));
    expect(written.agent).toBe("devin");
    expect(written.state).toBe("settled");
  });

  it("a background meta.json with agent:devin parses (childPid carried like codex)", async () => {
    const root = await temporaryRoot();
    const runId = "deadbeef0001";
    await mkdir(join(root, runId));
    await writeFile(join(root, runId, "stream.jsonl"), "");
    await writeFile(join(root, runId, "meta.json"), JSON.stringify({
      runId, agent: "devin", model: testModels.devinDefault, cwd: root, sandboxMode: "read-only",
      promptChars: 1, createdAt: new Date().toISOString(),
      streamPath: join(root, runId, "stream.jsonl"), stderrPath: join(root, runId, "stderr.log"),
      childPid: process.pid,
    }));
    // Self pid is alive, so poll reaches the codex-style liveness path —
    // "running" outside a ps-denied sandbox, an error verdict under it. Either
    // way the meta PARSED: a rejected record answers "not_found" (S2 owns the
    // real devin poll semantics).
    const polled = await pollBackgroundRun(runId, { registryRoot: root });
    expect(polled.status).not.toBe("not_found");

    // A devin record missing childPid is unparseable, same as codex.
    const bad = "deadbeef0002";
    await mkdir(join(root, bad));
    await writeFile(join(root, bad, "meta.json"), JSON.stringify({
      runId: bad, agent: "devin", model: testModels.devinDefault, cwd: root,
      promptChars: 1, createdAt: new Date().toISOString(),
      streamPath: join(root, bad, "stream.jsonl"), stderrPath: join(root, bad, "stderr.log"),
    }));
    await expect(pollBackgroundRun(bad, { registryRoot: root }))
      .resolves.toMatchObject({ status: "not_found" });
  });
});

describe("stratum_agent_run MCP boundary for devin (D6)", () => {
  it("rejects an unknown devin model as input_validation_failed before dispatch", async () => {
    const root = await temporaryRoot();
    const agentRun = vi.fn();
    const dispatcher = createToolDispatcher({ runAgent: agentRun, foregroundRegistryRoot: root });
    await expect(dispatcher.call("stratum_agent_run", {
      agent: "devin", prompt: "p", cwd: root, model: "typo",
    })).rejects.toMatchObject({
      code: ErrorCode.InvalidParams,
      data: { code: "input_validation_failed", errors: [
        { code: "input_validation_failed", path: "model", message: expect.stringContaining('Unknown devin model "typo"') },
      ] },
    });
    expect(agentRun).not.toHaveBeenCalled();
    expect(await readdir(root)).toEqual([]);
  });

  it("accepts agent:devin and reaches the real runAgent boundary", async () => {
    const root = await temporaryRoot();
    const dispatcher = createToolDispatcher({
      foregroundRegistryRoot: root,
      runAgent: options => runAgent({ ...options, env: isolatedEnv(root), registryRoot: root }),
    });
    await expect(dispatcher.call("stratum_agent_run", {
      agent: "devin", prompt: "p", cwd: root,
    })).rejects.toMatchObject({
      code: ErrorCode.InternalError,
      data: { code: "agent_run_failed" },
      message: expect.stringContaining(NOT_LOGGED_IN),
    });
  });
});

// Inject synthetic bytes into the real singleton loader, preserving every adapter.
vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const { fileURLToPath } = await import("node:url");
  const shipped = fileURLToPath(new URL("../../src/config/models.default.toml", import.meta.url));
  const fixture = fileURLToPath(new URL("../fixtures/models.synthetic.toml", import.meta.url));
  return { ...actual, readFileSync: new Proxy(actual.readFileSync, {
    apply(target, receiver, args) {
      if (args[0] === shipped) args[0] = fixture;
      return Reflect.apply(target, receiver, args);
    },
  }) };
});
