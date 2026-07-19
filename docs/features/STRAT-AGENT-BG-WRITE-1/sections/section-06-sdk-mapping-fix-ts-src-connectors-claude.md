# Section 06 — SDK Mapping Fix (`ts/src/connectors/claude.ts`)

**Task ID:** T6
**Depends on:** —
**Files:** sdkOptions.tools === ["Read"], sdkOptions.tools, sdkOptions.disallowedTools === ["Write"]

## Plan

**Depends on:** nothing (independent fix, but logically tied to BG-WRITE-B)  
**File:** `ts/src/connectors/claude.ts`

Fix `allowedTools` → SDK `tools` mapping at current lines 46–48.

**Current (WRONG):**
```typescript
if (this.options.allowedTools !== undefined) {
  sdkOptions.allowedTools = this.options.allowedTools;
```

**After (D5: maps to availability, not auto-approve):**
```typescript
if (this.options.allowedTools !== undefined) {
  // D5: ClaudeConnectorOptions.allowedTools controls AVAILABILITY (which tools the model
  // is offered), not permission auto-approve. Map to sdkOptions.tools instead.
  sdkOptions.tools = this.options.allowedTools;
```

The `else` branch (lines 49–52, preset `claude_code`) is unchanged.

**Breaking change:** Any internal callers that relied on the old `sdkOptions.allowedTools` (auto-approve) behavior must now pass `permissionMode: "acceptEdits"` separately. Audit: `grep -r "allowedTools" ts/src/` shows only `runner.ts` passes this field, and it receives it from MCP callers where availability semantics are the correct intent.

**Acceptance criteria:**
- [ ] `ClaudeConnector` instantiated with `allowedTools: ["Read"]`: verify `sdkOptions.tools === ["Read"]` and `sdkOptions.allowedTools` is NOT set
- [ ] `ClaudeConnector` instantiated without `allowedTools`: verify `sdkOptions.tools` is `{ type:"preset", preset:"claude_code" }` (unchanged default)
- [ ] `ClaudeConnector` instantiated with `disallowedTools: ["Write"]`: verify `sdkOptions.disallowedTools === ["Write"]`

---
