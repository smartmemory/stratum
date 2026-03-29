# stratum-mcp

Stratum MCP server for Claude Code. Structured execution, typed contracts, postcondition enforcement — no sub-LLM calls.

## Install

```bash
pip install stratum-mcp
stratum-mcp install
```

`install` configures Claude Code in one command: writes `.claude/mcp.json`, appends the execution model block to `CLAUDE.md`, installs skills to `~/.claude/skills/`, and registers session hooks to `~/.stratum/hooks/`. Restart Claude Code and it's active.

## IR Spec (v0.3)

Stratum specs are YAML files with typed contracts, step definitions, and postcondition ensures:

```yaml
version: "0.3"

contracts:
  ReviewResult:
    clean:    {type: boolean}
    summary:  {type: string}
    findings: {type: array}

flows:
  my_flow:
    steps:
      - id: implement
        agent: claude
        intent: "Build the feature"
        output_contract: ReviewResult
        ensure:
          - "result.clean == True"
        retries: 3
```

### Step types

| Type | Purpose |
|---|---|
| `inline` | Single agent step with intent + ensures (default) |
| `function` | Named function reference |
| `flow` | Sub-flow invocation |
| `decompose` | Agent decomposes work into a TaskGraph |
| `parallel_dispatch` | Fan-out tasks from a TaskGraph with concurrency control |

### Parallel dispatch (v0.3)

```yaml
- id: execute
  type: parallel_dispatch
  source: "$.steps.decompose.output.tasks"
  max_concurrent: 3
  isolation: worktree    # worktree | branch | none
  require: all           # all | any | N
  merge: sequential_apply
  intent_template: "Implement {task.description}"
```

- `isolation: worktree` — git worktree per task (write isolation)
- `isolation: none` — shared working directory (read-only tasks)
- `require` — how many tasks must pass: `all`, `any`, or integer N

## Skills

| Skill | What it structures |
|---|---|
| `/stratum-onboard` | Read a new codebase cold and write project-specific `MEMORY.md` |
| `/stratum-plan` | Design a feature and present it for review — no implementation until approved |
| `/stratum-feature` | Feature build: read existing patterns → design → implement → tests pass |
| `/stratum-review` | Three-pass code review: security → logic → performance → consolidate |
| `/stratum-debug` | Debug: read test → read code → check env → hypotheses → confirm/rule out → fix |
| `/stratum-refactor` | File split: analyze → design modules → plan extraction order → extract one at a time |
| `/stratum-migrate` | Find bare LLM calls and rewrite as `@infer` + `@contract` |
| `/stratum-test` | Write a test suite for existing untested code |
| `/stratum-speckit` | Spec-kit lifecycle: spec.md → plan.md → tasks/ → `.stratum.yaml` → execute |

## MCP Tools

| Tool | What it does |
|---|---|
| `stratum_validate` | Validate a `.stratum.yaml` spec |
| `stratum_plan` | Validate + create execution state + return first step |
| `stratum_resume` | Resume an existing flow from its current step |
| `stratum_step_done` | Report step result; check postconditions; return next step or completion |
| `stratum_parallel_done` | Report batch results for a parallel_dispatch step |
| `stratum_skip_step` | Skip a step (policy: skip mode) |
| `stratum_gate_resolve` | Resolve a gate step (approve/revise/kill) |
| `stratum_audit` | Return per-step trace (attempts, duration) for any flow |
| `stratum_check_timeouts` | Check for timed-out steps in a flow |
| `stratum_iteration_start` | Start an iteration loop on a step |
| `stratum_iteration_report` | Report iteration result (clean/dirty/max_reached) |
| `stratum_iteration_abort` | Abort an iteration loop |
| `stratum_commit` | Checkpoint flow state with a label |
| `stratum_revert` | Revert flow state to a labeled checkpoint |
| `stratum_compile_speckit` | Compile tasks/*.md into a `.stratum.yaml` spec |
| `stratum_draft_pipeline` | Generate a pipeline spec from a description |
| `stratum_list_workflows` | List all active and completed flows |

## Building on Stratum

Stratum exposes four stable integration points for apps and tooling:

### 1. MCP tools (Claude Code agents)
The primary control plane — `stratum_plan`, `stratum_step_done`, `stratum_audit`. Used by agents running inside Claude Code.

### 2. Query CLI (read-side, any process)
```bash
stratum-mcp query flows              # → JSON array of FlowSummary
stratum-mcp query flow <id>          # → JSON FlowState
stratum-mcp query gates              # → JSON array of pending gates
```
Exit 0, JSON to stdout. Use from shell scripts, background services, or UI backends.

### 3. Gate CLI (write-side, any process)
```bash
stratum-mcp gate approve <flow_id> <step_id> [--note "..."] [--resolved-by agent]
stratum-mcp gate reject  <flow_id> <step_id> [--note "..."]
stratum-mcp gate revise  <flow_id> <step_id> [--note "..."]
```
Exit codes: `0` success · `1` error (JSON on stdout) · `2` conflict (already resolved).

### 4. Storage schemas (`contracts/`)
Versioned JSON schemas for the flow state and audit record formats. Stable across internal refactors.

```
stratum-mcp/contracts/
  flow-state.v1.schema.json
  query-flows.v1.schema.json
  query-gates.v1.schema.json
  gate-mutation.v1.schema.json
  audit-record.v1.schema.json
```

## Hooks

`stratum-mcp install` registers three Claude Code hooks in `~/.stratum/hooks/`:

| Hook | Trigger | Purpose |
|---|---|---|
| `stratum-session-start.sh` | SessionStart | Initialize Stratum state for the session |
| `stratum-session-stop.sh` | Stop | Clean up and persist session state |
| `stratum-post-tool-failure.sh` | PostToolUseFailure | Log tool failures for debugging |

## How It Works

Claude writes `.stratum.yaml` specs internally — you never see them. You see plain English narration. The MCP server enforces postconditions on every step; if a step's output fails a check, Claude fixes it and retries before reporting success.

Full documentation: [stratum-in-claude-code.md](https://github.com/regression-io/stratum/blob/main/blog/stratum-in-claude-code.md)

Tutorial: [claude-code-tutorial.md](https://github.com/regression-io/stratum/blob/main/blog/claude-code-tutorial.md)

## License

Apache 2.0

<!-- mcp-name: io.github.ruze00/stratum-mcp -->
