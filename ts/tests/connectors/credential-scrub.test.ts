import { describe, expect, it } from "vitest";
import { ClaudeConnector, type QueryFunction } from "../../src/connectors/claude.js";
import { CodexConnector } from "../../src/connectors/codex.js";
import { SMARTMEMORY_SCRUB_VARS } from "../../src/connectors/base.js";

/**
 * GOV-COMPOSE-SEAM-1 step 0 — credential scrubbing at the agent boundary.
 *
 * Compose now injects SMARTMEMORY_API_KEY / SMARTMEMORY_WORKSPACE_ID into the
 * Stratum MCP server's env so the policy client can deliver enforcement events.
 * The MCP server reads them once at construction, long before any agent spawn.
 * An implementer or reviewer agent has no use for a live memory-write
 * credential, and handing one over widens a prompt injection from "edits code"
 * to "rewrites the audit trail it is being judged against".
 *
 * There were no scrub tests before this file, for any variable — the control
 * existed but nothing held it in place.
 */

const LEAKY_ENV = {
  PATH: "/usr/bin",
  ANTHROPIC_API_KEY: "sk-ant-leak",
  CLAUDE_API_KEY: "sk-claude-leak",
  CLAUDECODE: "1",
  OPENAI_API_KEY: "sk-openai-leak",
  SMARTMEMORY_API_KEY: "sk-smartmemory-leak",
  SMARTMEMORY_WORKSPACE_ID: "team_26f0bbe60a4c",
  SMARTMEMORY_API_URL: "https://api.example.test",
};

describe("SMARTMEMORY_SCRUB_VARS", () => {
  it("covers the credential and the workspace id", () => {
    expect([...SMARTMEMORY_SCRUB_VARS]).toEqual(["SMARTMEMORY_API_KEY", "SMARTMEMORY_WORKSPACE_ID"]);
  });
});

describe("ClaudeConnector env scrubbing", () => {
  async function capturedEnv(): Promise<Record<string, string | undefined>> {
    let seen: Record<string, string | undefined> = {};
    const query: QueryFunction = async function* (params) {
      const options = (params.options ?? {}) as { env?: Record<string, string | undefined> };
      seen = options.env ?? {};
      yield { type: "result", subtype: "success", result: "ok", duration_ms: 1, total_cost_usd: 0 };
    };
    await new ClaudeConnector({ env: LEAKY_ENV, query }).run("ping");
    return seen;
  }

  it("removes the SmartMemory credential and workspace id", async () => {
    const env = await capturedEnv();
    expect(env.SMARTMEMORY_API_KEY).toBeUndefined();
    expect(env.SMARTMEMORY_WORKSPACE_ID).toBeUndefined();
  });

  it("still removes the pre-existing sensitive vars", async () => {
    const env = await capturedEnv();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_API_KEY).toBeUndefined();
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
  });

  it("leaves ordinary vars alone", async () => {
    const env = await capturedEnv();
    expect(env.PATH).toBe("/usr/bin");
    // The API URL is not a credential and carries no access on its own; only
    // the key and the workspace scope are withheld.
    expect(env.SMARTMEMORY_API_URL).toBe("https://api.example.test");
  });

  it("does not mutate the caller's env object", async () => {
    await capturedEnv();
    expect(LEAKY_ENV.SMARTMEMORY_API_KEY).toBe("sk-smartmemory-leak");
    expect(LEAKY_ENV.ANTHROPIC_API_KEY).toBe("sk-ant-leak");
  });
});

describe("CodexConnector env scrubbing", () => {
  function connectorEnv(): Record<string, string | undefined> {
    const connector = new CodexConnector({ env: LEAKY_ENV });
    return (connector as unknown as { env: Record<string, string | undefined> }).env;
  }

  it("removes the SmartMemory credential and workspace id", () => {
    const env = connectorEnv();
    expect(env.SMARTMEMORY_API_KEY).toBeUndefined();
    expect(env.SMARTMEMORY_WORKSPACE_ID).toBeUndefined();
  });

  it("keeps OPENAI_API_KEY, which Codex legitimately needs", () => {
    // Deliberate divergence from the Claude list — asserted so a future tidy-up
    // that "unifies" the two lists cannot silently break Codex auth.
    expect(connectorEnv().OPENAI_API_KEY).toBe("sk-openai-leak");
  });

  it("still removes the Anthropic vars", () => {
    const env = connectorEnv();
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.CLAUDE_API_KEY).toBeUndefined();
    expect(env.CLAUDECODE).toBeUndefined();
  });
});
