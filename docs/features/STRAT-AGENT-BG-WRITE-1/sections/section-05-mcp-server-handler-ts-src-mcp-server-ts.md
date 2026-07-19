# Section 05 — MCP Server Handler (`ts/src/mcp/server.ts`)

**Task ID:** T5
**Depends on:** —
**Files:** —

## Plan

**Depends on:** Tasks 1 and 4 (contract declares fields; runner accepts them)  
**File:** `ts/src/mcp/server.ts`

Update `stratum_agent_run` handler (current lines 111–121) to read and forward `allowedTools`/`disallowedTools`.

Critical detail — use `Array.isArray()` guard before `optionalArray()`:

```typescript
const allowedTools = Array.isArray(request.allowedTools)
  ? optionalArray(request, "allowedTools")
  : undefined;
const disallowedTools = Array.isArray(request.disallowedTools)
  ? optionalArray(request, "disallowedTools")
  : undefined;
```

**Why:** `optionalArray` (line 238) returns `[]` (empty array) when the key is absent — an empty array is truthy, so a naive `if (allowedTools)` spreads `allowedTools: []`, incorrectly restricting tools to zero when the caller provided no list. The `Array.isArray(request.allowedTools)` guard makes "not provided" map to `undefined`.

Then spread conditionally:
```typescript
...(allowedTools !== undefined ? { allowedTools } : {}),
...(disallowedTools !== undefined ? { disallowedTools } : {}),
```

**Acceptance criteria:**
- [ ] `stratum_agent_run` with `allowedTools: ["Read"]` passes `allowedTools` through to `agentRun`
- [ ] `stratum_agent_run` without `allowedTools` does NOT pass `allowedTools: []` to `agentRun`
- [ ] `stratum_agent_run` with `allowedTools: ["Read", 42]` rejected by `assertToolRequest` before reaching handler
- [ ] Existing `stratum_agent_run` calls without `allowedTools`/`disallowedTools` unaffected

---
