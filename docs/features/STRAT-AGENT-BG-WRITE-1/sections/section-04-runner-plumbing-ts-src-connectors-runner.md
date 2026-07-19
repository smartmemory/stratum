# Section 04 — Runner Plumbing (`ts/src/connectors/runner.ts`)

**Task ID:** T4
**Depends on:** —
**Files:** meta.json, pid = child.pid, tests/connectors/background.test.ts:84

## Plan

**Depends on:** Task 2 (calls `startBackgroundRun` which now accepts `allowedTools`/`disallowedTools`)  
**File:** `ts/src/connectors/runner.ts`

Three changes:

#### Task 4a — Make `pid` optional in return type (current line 30)

```typescript
// Before:
): Promise<ConnectorResult | { status: "bg_started"; runId: string; pid: number; streamPath: string }> {

// After:
): Promise<ConnectorResult | { status: "bg_started"; runId: string; pid?: number; streamPath: string }> {
```

#### Task 4b — Forward `allowedTools`/`disallowedTools` to `startBackgroundRun` (current lines 33–43)

Add two optional spreads at the end of the `startBackgroundRun()` call:

```typescript
...(options.allowedTools !== undefined ? { allowedTools: options.allowedTools } : {}),
...(options.disallowedTools !== undefined ? { disallowedTools: options.disallowedTools } : {}),
```

Note: `AgentRunOptions` (lines 6–18) already declares `allowedTools?: string[]` and `disallowedTools?: string[]` — no interface change needed.

**Acceptance criteria:**
- [ ] TypeScript compiles without error when destructuring `bg_started` result with `pid` as optional
- [ ] `allowedTools` passed to `runAgent` reaches `startBackgroundRun` (verifiable via `meta.json` test)
- [ ] Codex path still returns `pid: number` (the codex code sets `pid = child.pid`)
- [ ] Existing `tests/connectors/background.test.ts:84` passes: `expect(meta.childPid).toBe(started.pid)` — update to `expect(typeof started.pid).toBe("number")` first

#### Task 4c — Sync-path discriminant validation in `runAgent()` (current lines 44–61)

Design.md:286 requires the same agent/sandboxMode guards in the synchronous foreground path. Currently `runAgent()` dispatches `options.agent === "codex"` to CodexConnector and everything else to ClaudeConnector with no validation — unknown agent values silently fall through to ClaudeConnector.

Insert the following constants and guards at the top of the `runAgent()` body (before both the `background` and connector dispatch branches, i.e. before line 32):

```typescript
const VALID_AGENTS = new Set<string>(["claude", "codex"]);
const VALID_SANDBOX_MODES = new Set<string>(["read-only", "workspace-write"]);

if (!VALID_AGENTS.has(options.agent)) {
  throw new Error(
    `Unknown agent ${JSON.stringify(options.agent)}; must be "claude" or "codex"`
  );
}
if (options.sandboxMode !== undefined && !VALID_SANDBOX_MODES.has(options.sandboxMode)) {
  throw new Error(
    `Unknown sandboxMode ${JSON.stringify(options.sandboxMode)}; must be "read-only" or "workspace-write"`
  );
}
```

These constants can be defined as module-level `const` sets in `runner.ts` (not re-created per call) or inlined as literals inside the guard — either is acceptable. They are distinct from the ones in `background.ts` to avoid adding an import; the check is a one-liner per value and duplication is intentional for isolation.

**Acceptance criteria:**
- [ ] `runAgent({ agent: "gemini" as "claude", prompt: "p", cwd: "/tmp" })` throws with message containing `"Unknown agent"`
- [ ] `runAgent({ agent: "codex", sandboxMode: "locked" as "read-only", prompt: "p", cwd: "/tmp" })` throws with message containing `"Unknown sandboxMode"`
- [ ] `runAgent({ agent: "claude", ... }, { claudeQuery: stubQuery })` succeeds (foreground positive path)
- [ ] `runAgent({ agent: "codex", sandboxMode: "read-only", ... }, { codexSpawn: stubSpawn })` succeeds (foreground codex positive path)

---
