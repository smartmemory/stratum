# Section 01 — MCP Contract (`ts/contracts/mcp-surface.json`)

**Task ID:** T1
**Depends on:** —
**Files:** tests/mcp/contracts-grammar.test.ts

## Plan

**Depends on:** nothing  
**File:** `ts/contracts/mcp-surface.json`

Add tool-filter fields to the `stratum_agent_run` request schema and make `pid` optional in the `bg_started` response.

**Changes:**

- **Line 152** — Add `allowedTools?` and `disallowedTools?` to `stratum_agent_run.request`:
  ```json
  "request": { "agent": "string", "prompt": "string", "cwd": "string", "model?": "string", "sandboxMode?": "string", "background?": "boolean", "allowedTools?": { "$array": "string" }, "disallowedTools?": { "$array": "string" } },
  ```
  Use `{"$array": "string"}` — not `"string[]"`. `contracts.ts:46` LEAF_TYPES does not include `"string[]"`; the `{"$array":"string"}` shape causes `matchShape` (`contracts.ts:98-101`) to validate each element, providing free MCP-boundary validation without a custom helper.

- **Line 155** — Make `pid` optional in `bg_started`:
  ```json
  "bg_started": { "runId": "string", "pid?": "number", "streamPath": "string" }
  ```
  Claude Worker Threads expose `worker.threadId`, not an OS pid.

**Acceptance criteria:**
- [ ] `assertToolRequest` accepts `stratum_agent_run` calls with `allowedTools: ["Read", "Write"]`
- [ ] `assertToolRequest` accepts calls without `allowedTools` (field is optional)
- [ ] `assertToolRequest` rejects `allowedTools: ["Read", 42]` (element type validation)
- [ ] `bg_started` response validates without `pid` present
- [ ] `tests/mcp/contracts-grammar.test.ts` passes

---
