# Stratum

[![License](https://img.shields.io/badge/license-Apache%202.0-blue)](LICENSE)

**State machine dispatch server for AI agent workflows.**

*Your agent proposes the step. Stratum decides whether it actually finished.*

Stratum gives AI coding agents (Claude Code, Codex, etc.) a formal execution model. Instead of improvising a plan and retrying blindly, the agent writes a typed spec, the server tracks state, enforces postconditions, and returns structured failure context on retry. Every step produces an auditable trace record.

**Where it sits.** Stratum is the execution kernel, one layer below the thing most people run day to day. [Compose](https://github.com/smartmemory/compose) drives the product lifecycle (design, blueprint, plan, review gates) and calls Stratum to execute each step. Reach for Stratum directly when you want the state machine and the postconditions without a lifecycle on top of them.

The founding intent behind this machinery is recorded in [docs/VISION.md](docs/VISION.md): a spec language that keeps LLMs on rails invisibly, so the same conversation yields stronger results than freeform execution.

One shipped component:

- **`ts/`** — the TypeScript engine (`@smartmemory/stratum`): IR validation (`version: 1` specs), flow execution with ensure postconditions, MCP server for Claude Code, `query`/`gate`/`guard` CLI, background flows and background agent runs. Published to npm as `@smartmemory/stratum` (bins: `stratum`, `stratum-mcp`) and listed in the MCP registry as `ai.smartmemory/stratum-mcp`.

> **Engine status (2026-07-18, STRAT-PY-RETIRE):** the TS engine is the ONLY engine.
> The Python library (`stratum-py`) and Python MCP server (`stratum-mcp`) are retired.
> Their source is archived on the [`python-legacy`](../../tree/python-legacy) branch, and PyPI packages are
> frozen at their final releases. The engine executes **`version: 1`** specs exclusively.
> Legacy v0.x specs are rejected by `validate` and classified (report-only) by
> `stratum migrate --check`. The authoritative v1 shape is the Zod IR schema in
> [`ts/src/ir/`](ts/src/ir/) plus `stratum validate` output.

**Governed workflows as auditable flows — on any agent, not just one vendor.** Unlike a single-vendor in-context orchestrator, Stratum runs as an MCP server and a library under Claude Code, Codex, or any MCP host; enforces typed contracts and `ensure` postconditions on every flow execution; stops at real human gates; dispatches Claude *and* Codex agents in one flow (so an independent reviewer can be a different model from the implementer); and persists flow state across sessions. Where you want raw in-context fan-out, reach for an in-host workflow runtime; where you want the run governed, portable, and auditable, that's a Stratum workflow.

---

## Table of Contents

- [Installation](#installation)
- [Quick Start](#quick-start)
- [Core Concepts](#core-concepts)
- [YAML Spec Reference](#yaml-spec-reference)
- [MCP Tools API](#mcp-tools-api)
- [Step Types](#step-types)
- [Ensures (Postconditions)](#ensures-postconditions)
- [Contracts and Output Validation](#contracts-and-output-validation)
- [Gates (Human-in-the-Loop)](#gates-human-in-the-loop)
- [Flow Composition](#flow-composition)
- [Routing](#routing)
- [Iterations](#iterations)
- [Checkpoints](#checkpoints)
- [Recovery and Retry Logic](#recovery-and-retry-logic)
- [Workflows](#workflows)
- [Task Compiler](#task-compiler)
- [Skills](#skills)
- [CLI Reference](#cli-reference)
- [Configuration](#configuration)
- [Python Library (Track 1)](#python-library-track-1)
- [Examples](#examples)
- [Development](#development)
- [License](#license)

---

## Installation

Install from npm (Node >= 22):

```bash
npm install -g @smartmemory/stratum    # provides `stratum` (CLI) and `stratum-mcp` (MCP server)
```

Or run from a checkout for development:

```bash
git clone https://github.com/smartmemory/stratum
cd stratum/ts && npm install    # or pnpm install
```

Requires node >= 22 (erasable-syntax type stripping; node >= 24 needs no flags — the CLI
bootstrap gates `--experimental-transform-types` automatically).

### MCP Server (for Claude Code)

Register the server in your project's `.mcp.json`. From the npm package:

```json
{
  "mcpServers": {
    "stratum": {
      "command": "npx",
      "args": ["-y", "-p", "@smartmemory/stratum", "stratum-mcp"]
    }
  }
}
```

From a checkout:

```json
{
  "mcpServers": {
    "stratum": {
      "command": "node",
      "args": ["/absolute/path/to/stratum/ts/src/mcp/bin.mjs"]
    }
  }
}
```

Restart Claude Code to activate. Optionally append the [Stratum execution model block](#claudemd-block) to your `CLAUDE.md`.

### CLI

```bash
stratum help                    # validate | migrate | query | gate | guard | watch  (npm install)
node ts/src/cli/bin.mjs help    # same, from a checkout
```

From a checkout, a thin wrapper script (e.g. `~/bin/stratum-ts`) pointing at `ts/src/cli/bin.mjs` avoids a PATH collision with the installed `stratum` bin.

---

## Quick Start

When Claude Code has Stratum installed, it uses it automatically for non-trivial tasks:

1. Claude writes a `.stratum.yaml` spec internally (never shown to you)
2. Calls `stratum_plan` to validate the spec and get the first step
3. Executes each step using its own tools (reading files, writing code, running tests)
4. Calls `stratum_step_done` after each step -- the server checks postconditions
5. If a postcondition fails, Claude gets back the specific violation and retries
6. Calls `stratum_audit` at the end for a full execution trace

You see plain English narration throughout. The spec, state management, and postcondition enforcement happen behind the scenes.

---

## Core Concepts

### Specification vs Flow

A **specification** is the authored, version-controlled `.stratum.yaml` document. It declares contracts and one or more flows. The `flows.entry` field selects the flow that starts a run.

A **flow** is an executable directed acyclic graph of steps. Running the entry flow creates a persisted run with a `runId`. The v0.x top-level `workflow:` registration block and `stratum_list_workflows` were retired with the Python server.

### Flows

A flow declares typed `input` fields, a typed `output`, optional limits, and `steps`. References and `after` lists form data and ordering edges. Gate routing and `on_fail` add explicit routing edges.

### Steps

A step has an `id`, optional `after` dependencies, an optional `when` condition, and exactly one construct: `do`, `set`, `gate`, `fanout`, or `run`.

### Tasks

A `do` step is an agent-dispatched task. The task text is declared inline, and `${...}` references inject flow input or prior step output values. The v0.x `functions:` registry and `function:` steps have no place in a v1 document.

### Contracts

Contracts define named output shapes. A `do` or `set` step declares its output contract with `out`. A flow declares both the step-output reference that supplies its result and the contract used to validate that result.

### Ensures

Ensures are structured postconditions on `do`, `set`, and fanout stage results. V1 supports expression, file existence, file content, and judged predicates.

### Retries

A `do` or `fanout` step can set the positive integer `attempts` limit. The default is two attempts. Contract failures, ensure failures, task failures, and exhausted iterations use the same failure path. A deterministic `set` failure terminates the flow without retrying.

### Gates

Gate steps pause execution for an external `approve`, `revise`, or `kill` decision. Approve and kill routes may name a later step or use `null`. A revise route may name a strict ancestor and requires a flow-level `max_rounds` limit.

---

## YAML Spec Reference

The Zod IR schema in [`ts/src/ir/`](ts/src/ir/) and the errors produced by `stratum validate` are authoritative. The root is strict and has exactly three fields: `version`, `contracts`, and `flows`. Unknown fields are rejected.

### Minimal Example

```yaml
version: 1
contracts:
  SentimentResult:
    label: string
    confidence: number
flows:
  entry: classify
  classify:
    input:
      text: string
    output:
      from: "${classify_text.output}"
      contract: SentimentResult
    steps:
      - id: classify_text
        do: "Classify the sentiment of ${input.text}"
        agent: claude
        out: SentimentResult
        ensure:
          - expr: "result.label != ''"
          - expr: "result.confidence > 0.7"
        attempts: 2
```

### Full Example with a Gate

```yaml
version: 1
contracts:
  WorkOutput:
    result: string
    quality_score: number
flows:
  entry: reviewed_work
  reviewed_work:
    input:
      text: string
    output:
      from: "${work.output}"
      contract: WorkOutput
    max_rounds: 3
    steps:
      - id: work
        do: "Produce the deliverable requested in ${input.text}"
        agent: codex
        out: WorkOutput
        ensure:
          - expr: "result.quality_score >= 0.8"
        attempts: 3
      - id: review
        after: [work]
        gate:
          on_approve: null
          on_revise: work
          on_kill: null
          max_rounds: 2
```

### Full Field Reference

#### `version` (required)

The only accepted value is the number `1`. Quoted strings such as `"1"` and all v0.x values are rejected.

#### `contracts` (required)

Each contract maps field names to type strings. Objects are strict at runtime, so undeclared output fields are rejected.

| Type form | Meaning |
|---|---|
| `string`, `integer`, `number`, `boolean` | Scalar value |
| `object`, `array` | Untyped JSON object or array |
| `string[]`, `Result[]` | Typed array |
| `draft|final` | String enum |
| `(draft|final)[]` | Array of string enum values |
| `Result` | Another named contract |
| `string?`, `Result[]?` | Optional field |

Named contract references use an initial capital letter. Recursive contract references and unknown contract names are rejected.

#### `flows` (required)

`flows.entry` must name a flow in the same mapping. Every flow has these fields:

| Field | Required | Shape |
|---|---:|---|
| `input` | yes | Field-to-type mapping using the contract type language |
| `output` | yes | `{from: "${step_id.output}", contract: ContractName}` |
| `steps` | yes | Array of strict step objects |
| `budget` | no | Positive limits for one or more of `usd`, `tokens`, `dispatches`, or `ms` |
| `max_rounds` | no | Positive integer required when a gate can revise to an ancestor |
| `carry` | no | Named loop-carried flow values; entry flow only |

The `output.from` value must be one full reference to a step output with a known contract. A fanout output is an array, so a flow output must select an item such as `${fan.output[0]}`.

#### Steps

Step IDs start with a lowercase letter and may contain lowercase letters, digits, underscores, and hyphens. IDs are unique within a flow. Every step accepts `id`, optional `after`, and optional `when`, then exactly one construct with only the fields listed below.

| Construct | Purpose | Additional fields |
|---|---|---|
| `do` | Dispatch an inline task | `agent`, `out`, `ensure`, `attempts`, `iterate`, `budget`, `on_fail` |
| `set` | Build an output object from expressions | required `out`, optional `ensure` |
| `gate` | Pause for a decision | no fields outside the nested gate object |
| `fanout` | Run stages over an array | `attempts`, `budget`, `on_fail` |
| `run` | Invoke a subflow | required `with`, optional `budget`, `on_fail` |

`agent` is either `claude` or `codex`. `attempts` is a positive integer. An `iterate` object requires positive integer `max` and string expression `until`.

The nested `gate` object requires nullable `on_approve`, `on_revise`, and `on_kill` fields. It may also set a positive integer `max_rounds`.

The nested `fanout` object requires `over`, one or more `steps`, positive integer `concurrency`, `isolation` of `worktree` or `none`, `require` of `all`, `any`, or a positive integer, and `merge: sequential`. Optional fields are `pre_merge` and `dispatch`, whose value is `engine` or `consumer`. Each fanout stage requires `do` and may use `agent`, `out`, `ensure`, `attempts`, and `when`.

### References

V1 uses `${...}` references in task templates, subflow inputs, fanout sources, and flow outputs.

| Pattern | Resolves to |
|---|---|
| `${input.field}` | Flow input field |
| `${step_id.output}` | Full output of a prior step |
| `${step_id.output.field}` | Field in a prior step output |
| `${fan.output[0].field}` | Field in one fanout item output |
| `${item}` | Current item inside a fanout stage task |
| `${prev}` | Previous stage output for the same fanout item |
| `${name}` | A declared carry variable |
| `${name.field}` | Field inside a carry variable |

A full-value reference preserves its JSON type in `with` and `fanout.over`. A reference embedded in other text is interpolated into a string. Step-output references create data dependencies. Use `after` for ordering dependencies that are not implied by references.

Expressions in `ensure`, `when`, `set`, and `iterate.until` use the v1 expression bindings instead of `${...}` interpolation. `input` is the flow input. In an ensure, `result` is the output under test. In `when` and `set`, `result` is a mapping of completed step IDs to outputs. Fanout stage expressions also receive `item` and `prev`.

### Carry

The entry flow may declare a `carry:` block: a mapping from carry variable name to a shape with
one required `initial` reference and an optional `on_revise` mapping.

```yaml
carry:
  wave:
    initial: "${plan.output.tasks}"
    on_revise:
      assess_gate: "${assess.output.tasks}"
```

`initial` and every `on_revise` value must be one full `${...}` reference, exactly like a
step-output reference — no interpolation, no expression syntax. The `initial` source must be an
unconditional, non-gate step that is not the target of any routing edge (`on_fail`, `on_approve`,
or `on_kill`). Materialisation happens once per source epoch: the value is written the moment that
source step succeeds, and is written again if a revise resets the source and it succeeds anew.

Each `on_revise` key names a gate step id. When that gate resolves with `revise`, the engine
resolves the declared reference against the run's pre-reset scope and writes the result as the
variable's new value, alongside provenance (which gate, its consumed token, the source epoch, and
the round). A gate that declares nothing for a variable leaves it unchanged, so a merge-retry
revise re-fans over the same list.

A carry reference (`${name}` or `${name.field}`) is legal wherever a step-output reference is
legal on a **rendered** field — `do`, `with`, `evaluate.in`, `fanout.over`, and a fanout stage's
`do` — but is rejected in the six **expression** fields: `when`, `set`, a fanout stage's `when`,
`iterate.until`, and `ensure` (both flow-level and stage-level). Carry values do not participate
in the v1 expression bindings.

A carry path may not begin with the exact segment `output` — `${wave.output}` collides with the
step-output grammar and is rejected, while `${wave.outputs}` (or any other field name) is fine.

Carry creates **no dependency edge**. A step that reads `${wave}` needs an explicit `after` to
order it after the variable's `initial` source, and a gate that declares an `on_revise` for a
variable must have a revise target whose reset closure covers every step that reads that
variable. The gate itself must be ordered after those steps through `after` or step-output
dependencies — a routing edge into the gate does not count as ordering.

Carry is entry-flow only — a subflow's spec may not declare `carry`, and a carry variable is not
visible inside a subflow. Carry values are snapshotted with checkpoints (`stratum_commit` /
`stratum_revert` restore them alongside step outputs) and are exposed by `stratum_audit`.

### Migrating v0.x Specs

`stratum migrate --check <old.yaml>` is a report-only classifier. It does not emit translated YAML.

| V0.x construct | V1 construct |
|---|---|
| `functions` with `infer` or `compute`, plus `function` steps | Inline `do` task. Keep the step's `agent` when present, and do not translate `compute` to `set` |
| Gate function plus routing fields | Nested `gate` object |
| Inline `intent` step | `do` task |
| Deterministic or judged predicates with one antecedent | Ensures on that antecedent |
| `decompose` without cross-item dependencies | Task contract with `tasks: T[]`, followed by `fanout` |
| `depends_on` | Data references plus `after` for remaining ordering edges |
| `skip_if` | `when` with the condition inverted |
| `flow` step plus `inputs` | `run` plus `with` |
| `max_iterations` plus `exit_criterion` | `iterate: {max, until}` |
| `parallel_dispatch` | Re-authored `fanout` |
| Pipeline stage `when` | Fanout stage `when` |
| Flow `max_rounds` | Flow `max_rounds` |
| Reducible `next` routing | DAG edges and gate routing |
| `on_fail` | `on_fail` targeting a topologically later step |
| Legacy ensure expressions | Re-authored v1 expressions |
| `output_schema` or `output_contract` | Named v1 contract language |
| Route-dependent flow output | One static `output: {from, contract}` producer |

Some legacy constructs have no v1 equivalent. These include verified or applied-gate judge predicates, judge budgets, score and accumulator fields, cross-item decompose dependencies, branch or manual parallel merge modes, certificate and timeout fields, nested pipeline regions, pipeline `exit_when`, gate policies, gate timeouts, and the top-level `workflow` block. Flatten or re-author supported regions. Unsupported regions must be redesigned before they can run on v1.

---

## MCP Tools API

All tools are exposed via the MCP protocol. Claude Code calls them as tool invocations.

### `stratum_validate`

Validate a `.stratum.yaml` spec without creating a flow.

**Inputs:** `spec` (str, inline YAML)
**Returns:** `{valid: bool, errors: list}`

### `stratum_plan`

Validate a spec, create execution state, and return the first step to execute.

**Inputs:**
- `spec` (str) -- inline YAML
- `flow` (str) -- flow name
- `inputs` (dict) -- flow-level inputs

**Returns:** Step dispatch object with `status: "execute_step"` or `status: "await_gate"`, including:
- `flow_id` -- unique identifier for this execution
- `step_id`, `step_number`, `total_steps`
- `function`, `intent`, `inputs` (resolved)
- `output_contract`, `output_fields`, `ensure`
- `retries_remaining`
- `agent`, `step_mode`

### `stratum_step_done`

Report a completed step result. The server validates the result against output schemas and ensure expressions.

**Inputs:**
- `flow_id` (str)
- `step_id` (str)
- `result` (dict) -- step output matching the output contract

**Returns one of:**
- Next step to execute (`status: "execute_step"`)
- Ensure failure with retry info (`status: "ensure_failed"`, `violations`, `retries_remaining`)
- Schema validation failure (`status: "schema_failed"`, `violations`)
- Flow completion (`status: "complete"`, `output`, `trace`, `total_duration_ms`)
- Retries exhausted (`status: "error"`, `error_type: "retries_exhausted"`)
- Routed to recovery step (`routed_from`, `violations`)

### `stratum_audit`

Return the full execution trace for a flow.

**Inputs:** `flow_id` (str)

**Returns:**
- `flow_id`, `flow_name`, `status` (`complete`, `in_progress`, `killed`)
- `steps_completed`, `total_steps`
- `trace` -- array of step records (step_id, function_name, attempts, duration_ms, type, round)
- `round`, `rounds` -- round history for gate revise cycles
- `iterations`, `archived_iterations` -- iteration history
- `child_audits` -- audit snapshots from sub-flow executions
- `total_duration_ms`

### `stratum_gate_resolve`

Resolve a gate step with a human/agent/system decision.

**Inputs:**
- `flow_id` (str)
- `step_id` (str) -- must be the current gate step
- `outcome` (str) -- `"approve"`, `"revise"`, or `"kill"`
- `rationale` (str) -- human-readable reason
- `resolved_by` (str) -- `"human"`, `"agent"`, or `"system"`

**Returns:** Next step, flow completion, or flow termination.

### `stratum_commit`

Save a named checkpoint of the current flow state.

**Inputs:** `flow_id` (str), `label` (str)

### `stratum_revert`

Roll back flow state to a previously committed checkpoint.

**Inputs:** `flow_id` (str), `label` (str)

### `stratum_compile_speckit`

Compile a spec-kit tasks directory into a `.stratum.yaml` flow.

**Inputs:** `tasks_dir` (str), `flow_name` (str, default `"tasks"`)

**Returns:** `{status, yaml, flow_name, steps}` on success.

### `stratum_resume`

Rehydrate a persisted flow into this server process (live-process reparenting) so a fresh session can continue a run it did not start.

### `stratum_flow_run_bg` / `stratum_flow_poll` / `stratum_flow_bg_poll` / `stratum_flow_cancel_bg`

Detached background flow execution: start a flow under a background driver, poll its progress, cancel it. Survives the launching session.

### `stratum_flow_cancel`

Cancel a running **foreground** flow by flow id. Unlike `stratum_flow_cancel_bg`, which abandons a background run, this settles the run to the terminal status `cancelled` under the per-run file lock, burns every outstanding step, gate and fanout-item issuance, and then terminates the foreground agents Stratum spawned for that flow.

**Which process may issue it.** The lock makes the call safe from any process, but a run whose in-memory object is PINNED by a live driver can only be settled by that driver. A pin happens whenever a process is actively working the run: a background driver loop, a gate re-kick, or an engine-dispatch consumer fanout. The pinning process declares itself in a driver lease beside the run record, and a cancel from anywhere else is refused with `CANCELLATION_UNCONFIRMED` and `reason: "engine_dispatch_active"`, carrying the holder's pid, rather than being allowed to race the object that process is mutating. A lease whose owner is provably dead is reclaimed and the cancel proceeds. An unpinned run, which is the common case for a foreground consumer fanout driven by an external agent, is cancellable from any process at all. That boundary is the point of the split: a consumer fanout's agents are reachable through the registry from anywhere, a live driver's in-memory run is not.

**Inputs:** `runId` (str)

**Returns:** `{runId, status, flowSettled, acknowledged, reason?, ledger, agents}`. `flowSettled` says the run is durably `cancelled`. `acknowledged` additionally says every agent group claimed for the flow reached a final resolved state, either torn down by this call (`reaped`) or already gone when we first probed it (`gone`), and that no entry is left unsettled, unresolved or unreachable.

The durable status is read first, so a run that is already terminal is never mutated and never refused: a finished run returns `flowSettled: false` with `reason: "already_<status>"`, and an already-cancelled one returns `flowSettled: true` with `reason: "already_cancelled"` and still sweeps its agents. That second case is the documented recovery from a teardown timeout, and it works even while the original driver's lease is still live.

An unconfirmed teardown is an error, not a caveat: `CANCELLATION_TEARDOWN_TIMEOUT` (a group was signalled and outlived the deadline) or `CANCELLATION_UNCONFIRMED` (an entry is unreachable, the run lock was held, reported as `reason: "run_lock_held"` with `holderPid`, or a live driver holds the run, reported as `reason: "engine_dispatch_active"`). Errors raised after the settle carry the engine's real `status` and `flowSettled` plus the partial `agents` summary. Errors raised instead of a settle carry `flowSettled: false`, an all-zero `agents` summary because no teardown was attempted, and `status: "running"` as the caller's own assumption rather than a reading of the record, since nothing was loaded. That is what lets a caller tell "the flow is stopped but one group survived" from "we never even took the lock".

Cancellation is split by ownership: foreground cancel settles the flow and kills the agents **Stratum** spawned, background cancel abandons the run, and a consumer's own in-process agents remain the consumer's to abort, because Stratum cannot reach them.

### `stratum_agent_run` / `stratum_agent_poll` / `stratum_cancel_agent_run`

Dispatch Claude or Codex as part of a flow step, synchronously or in the background. Background runs return a durable `runId` for polling and cancellation.

MCP background responses include `completionInstructions` with the actual run ID and, when available, peer name. Follow these immediately: subscribe with Claude Code's `SendMessage` using `notify_when_idle: true`, then call `stratum_agent_poll` after the idle notice to fetch the report. Launching or polling alone does not subscribe the caller. If the peer or `SendMessage` is unavailable, keep polling while the run is running. The MCP tool descriptions also expose this workflow so callers do not need to discover it in this README.

**Why this subscribe step exists, and why Stratum cannot remove it:** MCP's spec supports server-initiated progress notifications (`progressToken`), and Claude Code does send that token on tool calls — but Claude Code does not currently wire that into its visible task-notification system, which requires client-side support for the MCP "Tasks" mode (SEP-1686). That support is not shipped as of Claude Code 2.1.272 (tracked upstream: [anthropics/claude-code#18617](https://github.com/anthropics/claude-code/issues/18617), [#52137](https://github.com/anthropics/claude-code/issues/52137)). Verified 2026-09-19: this is a Claude Code harness limitation, not something an MCP server can work around by changing how it uses the protocol. `Bash run_in_background` gets automatic notifications because it is a Claude Code-native mechanism, unrelated to MCP. Re-check this note if a future Claude Code version ships SEP-1686 — the subscribe/poll workflow above would then become unnecessary.

**Alternative for pure Codex dispatch (no Stratum flow/checkpoint features needed):** running `codex exec` directly inside a `Bash` call with `run_in_background: true` DOES get an automatic Claude Code notification, with no subscribe step, because it goes through the native Bash-backgrounding path instead of MCP. This only substitutes for the plain agent-dispatch part of `stratum_agent_run` — it has no equivalent for `flow`-attached runs, ledger/budget tracking, or peer registration. Recipe: `codex exec -m <model> -c model_reasoning_effort='"<effort>"' -s <read-only|workspace-write|danger-full-access> [-c sandbox_workspace_write.network_access=true] "<prompt>" < /dev/null` (the `< /dev/null` is required — see the stdin-stall note in the Codex connector section). A bare `codex exec` with no `-s` flag defaults to `danger-full-access`; always pass it explicitly.

Codex and Claude background runs both register a Claude Code peer row (`codex-<model>-<runId6> · bg · busy` or `claude-<model>-<runId12> · bg · busy`) when the session registry is available. The response includes `peerName` when registration is attempted; poll reports `peer.registered: true` once registration succeeds. Subscribe with `SendMessage(to=peerName, notify_when_idle=true)` to receive an idle notice when the run finishes. If the peer cannot be found, fall back to `stratum_agent_poll`. The idle row remains for 15 seconds before cleanup; `peer.registered` records successful registration, not current socket availability. Under the default `exec` strategy, inbound user messages are refused because the run's prompt is fixed at spawn. Background Codex runs can accept them under the `app-server` strategy described below. Set `STRATUM_PEER_REGISTER=0` to disable registration, or `STRATUM_PEER_LINGER_MS` to change retention. `STRATUM_PEER_SESSIONS_DIR` and `STRATUM_PEER_SOCK_DIR` override the registry and socket directories; the registry otherwise follows `CLAUDE_CONFIG_DIR` (default `~/.claude`) and sockets default to `/tmp/cc-socks`. This integration follows Claude Code 2.1.272's peer protocol; a live record advertising a newer protocol disables registration without affecting the run.

**Messaging a running Codex background run (`STRATUM_CODEX_BG_STRATEGY=app-server`, opt-in).** By default a background Codex run uses `codex exec`, which has no input channel after launch. Set `STRATUM_CODEX_BG_STRATEGY=app-server` in the MCP server's environment to run background Codex turns through `codex app-server` instead. A `SendMessage` to the run's peer name then reaches the active turn as a steer (`turn/steer`), and the model sees it within that same turn. Foreground runs and `STRATUM_CODEX_TRANSPORT` are unaffected, and an injected `command` always uses `exec`.

- **Delivery is reported truthfully.** The sender gets `delivered` only after Codex accepts the steer for the active turn. A message the server refuses, or one whose outcome cannot be known, is reported as dropped or unknown and never retried. A message to a run that has already finished is refused (`expired`). A message never ends the run, even when it fails.
- **Only the run's owner can steer it.** Steer frames must authenticate on the first frame with the run's peer token. `notify_when_idle` subscriptions work exactly as they do for `exec` runs, and exactly one idle notice arrives when the run finishes.
- **Sandbox and approvals match `exec`.** Sandbox mode, writable roots and network access are passed the same way `exec` passes them, so settings in your Codex config (for example temp-directory exclusions) apply identically. The strategy never grants more access than `exec` would. `approvalPolicy: "on-failure"` has no app-server equivalent, so that combination is rejected before anything starts. Nobody is present to answer approval prompts, so the run declines them and continues.
- **Process ownership.** A detached driver owns the app-server process and survives the MCP server exiting. `stratum_cancel_agent_run` stops the driver and app-server together. If the driver is killed, the poll reports an error and the app-server exits when its input closes. Tool processes that start their own process group are outside this cleanup, the same limitation `exec` has.
- **Version pin.** The app-server protocol is pinned to Codex CLI 0.155.1. With a different installed version, the run fails during the initial handshake with an unsupported-version error rather than risking a mismatched protocol. Use the default `exec` strategy if you run another Codex version.

Each Claude background worker (a thread inside the MCP server process, not a separate OS process) gets its own detached peer sidecar, the same one-process-per-run shape Codex uses — a worker thread has no pid of its own to register, so the sidecar supplies one. The sidecar learns the worker finished through a private IPC channel rather than watching a child pid; a worker that ends while the MCP server is still alive reports idle normally, and losing the MCP server itself (not just one worker) surfaces as `unavailable` rather than a false idle. Claude workers do not survive an MCP server restart — there is no detached process to reattach to, unlike Codex's independently-running child.

Pass an optional `peerLabel` on `stratum_agent_run` (background-only, either agent — foreground calls reject it) to get a readable name instead of a bare run ID: `peerLabel: "schema review"` on a Claude run named `claude-sonnet-5-<runId12>` yields `claude-sonnet-5-<runId12>-schema-review`. The label is normalized (lowercased, non-alphanumeric runs collapsed to `-`) and is a display hint only, not an address — always subscribe using the `peerName` the response returns, not the label you passed in.

A foreground agent run may declare `flow: {runId, stepId?, itemIndex?}` alongside its `cancellationId`. That gives the run a durable record carrying its child pid and process start time, which is what lets `stratum_flow_cancel` terminate its process group from a different process. `flow` without a `cancellationId` is rejected: without an owned process group there is nothing to cancel.

For acknowledged foreground cancellation, supply a fresh UUID as `cancellationId` on `stratum_agent_run`, then call `stratum_cancel_agent_run` with that UUID as `runId`. The cancellation response waits for connector teardown. Keep awaiting the original run response as well; cancellation reports an error there. MCP transport cancellation and disconnection also abort foreground work, but MCP cancellation notifications suppress the original response and do not acknowledge teardown. Foreground IDs are scoped to the current server process; recent terminal IDs return `already_complete`, `already_error`, or `cancelled`.

`allowedTools`, `disallowedTools`, and `thinking` are Claude-specific. `effort` accepts Claude's `low`, `medium`, `high`, `xhigh`, `max`, or Codex's `minimal`, `low`, `medium`, `high`, `xhigh`. Unsupported provider settings fail before execution. Codex uses `sandboxMode` (`read-only` or `workspace-write`); an explicit effort must agree with any model suffix. Cancellable Codex runs use an owned process group around the Codex CLI so shell descendants stop before cancellation is acknowledged; the CLI on `PATH` is preferred and the SDK's bundled CLI is the fallback. Claude uses the SDK's custom spawn hook for the same process ownership. Process-group ownership is claimed only when a `cancellationId` is supplied, so ordinary runs are unaffected by it. It requires POSIX process groups: on Windows a run that asks for cancellation fails before spawn with `CANCELLATION_UNSUPPORTED_PLATFORM`, and non-cancellable runs there are unaffected. Detached processes that intentionally leave the agent's process group are outside this cancellation contract.

The authenticated live Codex smoke test is opt-in: `STRATUM_LIVE_CODEX=1 npm test -- tests/connectors/codex.live.test.ts` from `ts/`. Ordinary test runs do not invoke a paid model.

> The authoritative tool surface is [`ts/src/mcp/server.ts`](ts/src/mcp/server.ts). Python-era tools that were retired rather than ported (parallel lifecycle, iterations, timers/skip, `list_workflows`, `draft_pipeline`, judge/goal surfaces) live on `python-legacy`; see the Phase 2/3 usage audit in [`docs/plans/2026-07-11-strat-py-retire-progress.md`](docs/plans/2026-07-11-strat-py-retire-progress.md) for per-tool dispositions. The distill staging pipeline below is a TS port (`STRAT-DISTILL-TS-1`), not one of the retired surfaces — only its apply/write path remains unported.

### `stratum_distill`

Detects recurring workflows in Claude Code transcripts under a workspace and stages draft skill/subagent/command candidates — it never writes into `skills/`, `agents/`, or `commands/` directly. Required: `workspace_root`. Optional: `project_dir` (defaults to the current transcript project directory), `min_count`, `window_days`, and `write` (default `false` — when `false` the tool only reports what it would stage; set `write: true` to actually append candidates to the sidecar). There is no MCP equivalent of the CLI's `--all`/`--projects-root` sweep; the MCP tool always targets one project directory per call.

Every candidate is a complete, human-reviewable draft: full rendered `SKILL.md`/`agent/*.md`/`command/*.md` content, the observed workflow (single tool or tool sequence) it's built from, resolvable evidence (transcript occurrences with source handles), and a deterministic `revisionId` — identical inputs always produce the identical candidate, and new evidence produces a new revision rather than mutating an old one. Candidates are staged to an independent `.stratum/distill/` sidecar (schema `distill-2.0`, separate from the `learn-1.0` MEMORY-patch sidecar) and are **never auto-installed**: nothing reads or applies a staged candidate without a human decision, and there is currently no gate that admits one into `skills/`/`agents/`/`commands/` at all — that's future work (`STRAT-DISTILL-APPLY`, `STRAT-ADMIT`), not something this tool does.

Recurrence requires at least `min_count` (default 2) occurrences across at least 2 distinct sessions — a workflow used once, even repeatedly within one session, never stages. This mirrors the MEMORY-patch harvester's (`ts/src/learn/`) conservatism by design.

CLI equivalent: `stratum distill <extract|top|stats> [--root <path>] [--project <path>] [--all --projects-root <path>] [--min-count N] [--window-days N] [--json]`. `extract` is the only subcommand that stages candidates (always writes; there's no separate `--write` flag); `top [--n N]` inspects the top workflows by recurrence without staging anything, and `stats` reports singleton/sequence counts — both leave `applied: false`. `--root` is where candidates get staged (your repo); `--project` is where Claude Code transcripts are read from — these are different directories and are not interchangeable. `--all --projects-root <path>` sweeps every nested project directory under a root in one pass instead of one `--project` at a time.

---

## STRAT-GUARD — guarded transitions outside a flow

> **Authorization model.** Three policy-change capabilities of increasing power:
> `stratum_guard_upgrade` needs no authorization because it is provably
> non-weakening; `stratum_guard_apply_upgrade` applies a signed, pre-reviewed
> descriptor; `stratum_guard_migrate` does anything, under a signed one-shot
> authorization. Plus `stratum_guard_override`, which bypasses predicate
> verification on one legal edge, also under a signed one-shot authorization. All
> signing keys are enrolled in `contracts/guard-signers.allowed`, read from the
> installed source tree and never from the environment. It ships empty: there is
> no default trust.

`stratum_judge`/`stratum_gate_resolve` enforce guarantees **only inside a flow**. STRAT-GUARD exposes the same independent-verification engine (`run_judge`) as a standalone, resource-agnostic, tamper-evident state machine for clients that manage a resource lifecycle **outside** a stratum flow (e.g. compose's feature tracker). A client registers a transition graph with per-edge evidence predicates; stratum then permits a transition only if the edge is legal and its predicates verify against **trusted, server-read evidence** (not caller-staged claims). Every attempt — applied or refused — is appended to a hash-chained ledger. See `docs/features/STRAT-GUARD/`.

### `stratum_guard_register`

Register a guarded resource. The `(graph, edge_predicates, terminal, stakes)` policy is checksummed and immutable — re-registering an identical policy is a no-op; a different policy is rejected (use `stratum_guard_upgrade` for an additive change, `stratum_guard_migrate` for anything else).

**Inputs:** `resource_id` (str, client-namespaced e.g. `"compose:FEAT-1"`), `graph` (`dict[from -> list[to]]`), `edge_predicates` (`dict["from->to" -> list of {id,type,statement}]`), `initial` (str), `terminal` (list[str]), `stakes` (`dict["from->to" -> "cheap"|"default"|"paranoid"]`), `workspace_root` (abs dir, for file/git/command evidence).

Predicate `type`: `"deterministic"` → server-side trusted evidence (`server_file_exists`/`git_commit_exists`/`command_exit_zero`/`verdict_receipt_clean`); `"verified"`/`"judged"` → LLM-tier, routed through `run_judge`. A `paranoid` edge must declare ≥1 trusted predicate.

**Returns:** `{guard_id, checksum, status}`.

### `stratum_guard_transition`

Attempt `from_state -> to_state`. Trusted predicates are verified server-side; any LLM-tier predicates go through the judge at the edge's stakes. Optimistic concurrency: evaluation runs outside a per-resource lock, the commit re-validates state under it.

**Inputs:** `resource_id`, `from_state`, `to_state`, `artifacts` (`dict[str,str]`), `modified_files` (list[str]), `idempotency_key` (str|None), `resolved_by` (str).

**Returns:** `{status: applied|refused|replayed, verdict: JudgeResult-dict, ledger_ref, current_state}`. `ledger_ref` is the receipt token presented to `verdict_receipt_clean`.

### `stratum_guard_override`

The single sanctioned bypass of predicate verification. Requires a **signed authorization**, a human resolver, and a rationale. Moves a **legal** edge without verifying predicates and records a `deviation` ledger entry naming the signer. Replaces a `force` flag.

The signature covers `{action, resource_id, from_state, to_state, rationale, ledger_head}` as canonical JSON, under namespace `stratum-guard-override`. The server rebuilds that payload itself, so nothing but the signature travels — and because it includes the resource's current **ledger head**, an authorization is valid at exactly one point in that resource's history. Spending it moves the head and kills the signature, so there is nothing to replay and no expiry to tune.

`stratum guard authorize` prints the exact payload to sign:

```bash
echo '{"kind":"override","resource_id":"…","from_state":"…","to_state":"…","rationale":"…"}' \
  | stratum guard authorize
# then: ssh-keygen -Y sign -f <key> -n stratum-guard-override <payload file>
```

> **Replaced `STRATUM_GUARD_OVERRIDE_TOKEN` (2026-08-17).** The token was compared against the environment of *whatever process was running*, so over the CLI a caller set both sides of the comparison and they matched — verified empirically against a guard whose predicate could never be satisfied. A signature has no such dependence on which process asks. See `docs/features/STRAT-GUARD-AUTHZ/design.md`.

**Inputs:** `resource_id`, `from_state`, `to_state`, `authorization`, `rationale`, `resolved_by` (`"human"`). **Returns:** adds `authorized_by`.

### `stratum_guard_migrate`

Evolve a registered policy arbitrarily — the emergency path. Requires a **signed authorization** whose payload names the *resulting* policy checksum, so it cannot be spent on a different migration: `{action, resource_id, policy_checksum, rationale, ledger_head}` under namespace `stratum-guard-migrate`. Bumps `graph_version`, writes a `graph_version` ledger entry naming the signer, and never silently relaxes an in-flight resource's policy. The current state must remain a node in the new graph.

Deliberately not retired in favour of signed descriptors: a mechanism that requires a reviewed artifact cannot be what you reach for when the reviewed artifact is what is broken.

**Inputs:** `resource_id`, `new_graph`, `new_edge_predicates`, `authorization`, `rationale`, `new_terminal`, `new_stakes`. **Returns:** adds `authorized_by`.

### `stratum_guard_upgrade`

Routine policy evolution, with **no** override token. Idempotent: a policy whose checksum already matches returns `unchanged` and writes nothing — no ledger entry, no `graph_version` bump — so a lazy per-resource migration is safe to re-run over hundreds of guards. Any other change must be **additive-only**: no node or edge removed, existing edges byte-identical in predicates and stakes, new edges may only terminate at states that did not exist before, and `terminal` frozen exactly as registered with no new edge entering or leaving a terminal state. It can therefore neither grant a new way to be complete nor walk a completed resource back out — those stay authorization decisions on `stratum_guard_migrate`. Anything else is refused with `incompatible_policy_upgrade`. Ledger entries are the same `graph_version` kind migrate writes, distinguished by `resolved_by: "agent"`.

**Inputs:** `resource_id`, `new_graph`, `new_edge_predicates`, `rationale`, `new_terminal`, `new_stakes`. **Returns:** `{status: "migrated"|"unchanged", checksum, graph_version, ledger_ref?, rationale}`.

### `stratum_guard_apply_upgrade`

Apply a **server-owned upgrade descriptor**: a policy change a human reviewed and installed, named by id. No override token. This is the middle of three capabilities — it can do what `stratum_guard_upgrade` refuses (grant a terminal state, remove an edge, retighten predicates) because the exact resulting policy was authorized in advance, not supplied by the caller.

Authorization is a **signature**, not a value in the environment. The descriptor file must carry a detached sshsig at `<path>.sig` under the namespace `stratum-guard-descriptors`, from a key enrolled in `contracts/guard-signers.allowed` — which is read from the installed source tree, never from an env var. `STRATUM_GUARD_UPGRADE_DESCRIPTORS` still names the file's path, because locating an artifact is not authorizing it.

Keep the private half protected by a passphrase that exists only in your head, and **never `ssh-add` it** — anything that can reach your agent socket could then use it without knowing the passphrase. Sign with:

```bash
ssh-keygen -Y sign -f ~/.stratum/guard-signing -n stratum-guard-descriptors /path/to/guard-upgrades.json
```

`contracts/guard-signers.allowed` ships empty: there is no default trust, and an empty or missing trust root makes these paths report themselves unavailable rather than degrading. Verification is native (`node:crypto`), not a shell-out to `ssh-keygen` — that binary is resolved through `PATH`, and an authorization decision must not be delegated to something the caller can shadow. Run `stratum guard descriptors` to see what is installed, who signed it, and whether it verifies.

Each descriptor is `{id, rationale, from_checksum, to_policy}` and applies only to a resource whose current policy checksum is exactly `from_checksum` — authorization is for a transition between two named policies, not a destination in the abstract. Idempotent: a resource already at the target answers `unchanged` and writes nothing, so a fleet-wide batch is safe to re-run. The ledger entry names the descriptor id and the file digest.

**MCP only, deliberately** — there is no `stratum guard apply-upgrade` CLI action. A CLI process inherits the *caller's* environment, so a caller could point both variables at a descriptor file it wrote itself and mint its own authorization. The privileged apply runs only inside the server that owns the pinned environment. (The read-only `stratum guard descriptors` inspection stays on the CLI: it grants nothing.)

**Inputs:** `resource_id`, `descriptor_id`. **Returns:** `{status: "applied"|"unchanged", checksum, graph_version, ledger_ref?, descriptor_id}`.

### `stratum_guard_history`

Return a resource's current state and its append-only, hash-chained transition/deviation ledger (the tamper-evident audit trail).

**Inputs:** `resource_id`. **Returns:** `{resource_id, current_state, graph_version, ledger: [...]}`.

---

## Step Types

V1 has five mutually exclusive step constructs. This example includes all five:

```yaml
version: 1
contracts:
  Analysis:
    summary: string
    score: number
  ItemResult:
    value: string
  Final:
    message: string
flows:
  entry: main
  main:
    input:
      topic: string
      items: string[]
    output:
      from: "${finish.output}"
      contract: Final
    steps:
      - id: analyze
        do: "Analyze ${input.topic}"
        agent: claude
        out: Analysis
      - id: normalize
        after: [analyze]
        set:
          summary: "result.analyze.summary"
          score: "result.analyze.score"
        out: Analysis
        ensure:
          - expr: "result.score >= 0"
      - id: review
        after: [normalize]
        gate:
          on_approve: null
          on_revise: null
          on_kill: null
      - id: inspect
        after: [review]
        fanout:
          over: "${input.items}"
          concurrency: 2
          isolation: none
          require: all
          merge: sequential
          steps:
            - do: "Inspect ${item}"
              agent: codex
              out: ItemResult
      - id: child
        after: [inspect]
        run: summarize
        with:
          topic: "${input.topic}"
      - id: finish
        after: [child]
        do: "Finalize ${child.output.message}"
        out: Final
  summarize:
    input:
      topic: string
    output:
      from: "${write_summary.output}"
      contract: Final
    steps:
      - id: write_summary
        do: "Summarize ${input.topic}"
        out: Final
```

### `do` Tasks

`do` contains the task text sent to an agent. `agent` defaults to `claude`. `out` names the result contract. A task may also declare `ensure`, `attempts`, `iterate`, `budget`, and `on_fail`.

### `set` Steps

`set` evaluates each field expression without dispatching an agent. The resulting object is validated against the required `out` contract, then checked against any ensures. Set steps are deterministic and are not retried.

### `gate` Steps

`gate` pauses the run until an external decision arrives. Its three route fields are required, although any of them may be `null`. Gate steps cannot carry task, retry, budget, or ensure fields.

### `fanout` Steps

`fanout.over` must be one full reference that resolves to an array. Each item moves through the declared stages. `${item}` is the source item and `${prev}` is the previous stage output. The final stage needs `out` when later steps or the flow output reference the fanout result.

`isolation: worktree` gives each item a Git worktree. `merge` only accepts `sequential`. `require` decides how many item successes are needed before merge. `dispatch` defaults to `engine`. Consumer-dispatched worktree fanout has extra validation rules, including a required unconditional successor gate.

### `run` Steps

`run` names another flow in the same spec. `with` is required and its keys must exactly match the callee input keys. A run step's output contract is inherited from the callee. Non-entry flows cannot contain `run` or `fanout`, and recursive calls are rejected.

### Mode Exclusion

Every step must have exactly one of `do`, `set`, `gate`, `fanout`, or `run`. Fields from one construct cannot be mixed into another.

---

## Ensures (Postconditions)

An `ensure` array contains strict predicate objects. Predicates run in order, and the first failure stops evaluation.

| Predicate | Shape |
|---|---|
| Expression | `{expr: "result.confidence > 0.7"}` |
| File exists | `{file_exists: "build/report.json"}` |
| File contains text | `{file_contains: {path: "build/report.json", text: "passed"}}` |
| Judged claim | `{judged: {statement: "result is accurate", stakes: "default"}}` |

Judged stakes are `cheap`, `default`, or `paranoid`. A judged predicate fails closed if no judge runner is configured. File predicates require a workspace root and are jailed to that root.

### Expression Syntax

The v1 evaluator is a restricted expression language, not Python. It accepts JSON literals, member access, non-negative literal array indexes, function calls, parentheses, unary `!` and `-`, arithmetic, comparisons, `in`, `&&`, and `||`.

In an ensure, `result` is the step output and `input` is the flow input. Fanout stage ensures also receive `item` and `prev`.

### Built-in Functions

| Function | Signature | Description |
|---|---|---|
| `len` | `len(value)` | Length of a string, array, or object |
| `any`, `all` | `any(array)`, `all(array)` | Truth test across an array |
| `max`, `min` | `max(array)`, `min(array)` | Largest or smallest number or string |
| `str`, `int`, `bool` | One argument | Restricted conversions |
| `matches` | `matches(text, pattern)` | Bounded regular expression match |
| `file_exists` | `file_exists(path)` | Check a file inside the workspace root |
| `file_contains` | `file_contains(path, text)` | Check file content inside the workspace root |

### Safety

- Only `result`, `input`, `item`, and `prev` can be bound.
- `__proto__`, `constructor`, and `prototype` member access is blocked.
- Parsing, nesting, regular expression size, and regular expression input are bounded.
- File helpers cannot escape the configured workspace root.

### Failure Behavior

An ensure failure records a structured failure reason. A `do` task is dispatched again while its `attempts` budget remains. Identical output evidence stops retries early because the same deterministic predicate cannot change its verdict.

---

## Contracts and Output Validation

### Contracts in the Spec

Contracts use the field-to-type string language in the YAML reference. Task output is validated against `out` before ensures run. Flow output is validated again against `output.contract` when the referenced producer completes.

`out` is required on `set`. A `do` step may omit `out` only when no later reference or flow output needs a contract for that result.

### Output Schema (Per-Step JSON Schema)

V1 does not accept per-step `output_schema` or `output_contract`. Move supported fields into a named contract and reference it with `out`. The v1 contract language supports the types listed above, but it is not arbitrary JSON Schema.

---

## Gates (Human-in-the-Loop)

Gates are approval checkpoints that pause flow execution until resolved externally.

### Defining a Gate

Declare the gate directly on a step, as shown in the [full gate example](#full-example-with-a-gate). There is no gate function declaration in v1.

### Gate Constraints

- `on_approve`, `on_revise`, and `on_kill` are all required and nullable.
- Named approve and kill targets must preserve an acyclic routing graph.
- A usable revise target must be a strict ancestor of the gate.
- Any non-null revise target requires flow-level `max_rounds`.
- Gate-level `max_rounds` may impose a tighter positive limit on that gate.
- A gate step accepts only common fields and the nested `gate` object.
- A revise at a gate that declares `on_revise` for a carry variable rewrites that variable
  before the reset. A gate that declares nothing for a variable leaves it unchanged, so a
  merge-retry revise re-fans over the same list.

### Resolution

Gates are resolved through `stratum_gate_resolve` with `runId`, `stepId`, `decision`, and the observation-time `gateToken`. The token fences stale decisions. The CLI uses `approve`, `revise`, and `reject`, where `reject` maps to the engine's `kill` decision.

- **approve** routes to `on_approve`, or completes the gate when the route is `null`.
- **revise** resets the affected descendant region and routes to `on_revise` while round limits remain.
- **kill** routes to `on_kill`, or terminates the run when the route is `null`.

Gate policies, policy fallbacks, and gate timeouts were not ported to v1. Resolve every waiting gate explicitly.

### Rounds

Each successful revise increments the flow round counter and the gate's local revision counter. The flow and optional gate limits are enforced before another revision begins.

---

## Flow Composition

Steps with `run` invoke a subflow defined in the same spec. The parent step completes only after the child flow produces and validates its output.

```yaml
version: 1
contracts:
  TestResult:
    all_passed: boolean
  DeployResult:
    status: string
flows:
  entry: deploy
  integration_tests:
    input:
      project: string
    output:
      from: "${run_tests.output}"
      contract: TestResult
    steps:
      - id: run_tests
        do: "Run integration tests for ${input.project}"
        out: TestResult
        ensure:
          - expr: "result.all_passed == true"
  deploy:
    input:
      project: string
    output:
      from: "${release.output}"
      contract: DeployResult
    steps:
      - id: test
        run: integration_tests
        with:
          project: "${input.project}"
      - id: release
        after: [test]
        do: "Deploy after test result ${test.output.all_passed}"
        out: DeployResult
```

- `with` values may contain nested literals and `${...}` references.
- `with` keys must exactly match the callee input fields.
- The run step inherits the callee output contract.
- A run step may set `budget` and `on_fail`.
- Recursive calls are rejected.
- Non-entry flows cannot contain another `run` or a `fanout`.

---

## Routing

### `on_fail` Recovery Routing

`on_fail` activates a named recovery step after a task, fanout, or subflow exhausts its failure path. The target must be later in the validated DAG.

```yaml
version: 1
contracts:
  TaskResult:
    ok: boolean
    details: string
flows:
  entry: build
  build:
    input:
      spec: string
    output:
      from: "${publish.output}"
      contract: TaskResult
    steps:
      - id: generate
        do: "Generate code for ${input.spec}"
        out: TaskResult
        attempts: 2
        on_fail: recover
      - id: verify
        after: [generate]
        when: "result.generate.ok == true"
        do: "Verify the generated code"
        out: TaskResult
      - id: recover
        do: "Repair generation failure"
        out: TaskResult
      - id: publish
        after: [verify, recover]
        do: "Publish the final result"
        out: TaskResult
```

Route-only recovery steps are skipped when their source succeeds. Downstream steps may depend on both the normal and recovery branches because skipped dependencies satisfy ordering edges.

### Success Routing

V1 has no `next` field. Success follows the DAG formed by `after` and step-output references. Gates provide explicit approve and kill routes. Backward success jumps are not supported.

### Conditional Skip

`when` is a positive v1 expression. The step runs only when the expression evaluates to `true`. Any other result skips the step. To migrate `skip_if`, invert the condition. A skipped step has no output, so later data references to it cannot resolve.

---

## Iterations

`iterate` repeats a `do` task until its predicate holds or its positive `max` is reached.

```yaml
version: 1
contracts:
  Draft:
    text: string
    quality: number
flows:
  entry: refine
  refine:
    input:
      brief: string
    output:
      from: "${improve.output}"
      contract: Draft
    steps:
      - id: improve
        do: "Improve the draft for ${input.brief}"
        out: Draft
        iterate:
          max: 5
          until: "result.quality >= 0.95"
```

The engine evaluates `until` after contracts and ensures pass. A false result records the attempt and redispatches the task. Repeated identical output stops early. Max exhaustion enters the normal failure path, including `on_fail` routing.

### Removed Iteration Fields

V0.x `score_expr`, `accumulate`, and `accumulate_key` have no v1 equivalent. V1 also has no separate iteration lifecycle tools. Iteration is part of normal task dispatch and result reporting.

---

## Checkpoints

Checkpoints are runtime operations, not YAML constructs. `stratum_commit` accepts `flow_id` and a non-empty `label`. `stratum_revert` accepts the same fields and re-advances the restored run.

```json
{"flow_id": "<run-id>", "label": "after_analysis"}
```

A checkpoint captures run status, output, failure, spent budget, rounds, step state, audit events, cancellation state, and parallel state. It does not snapshot the spec, input, workspace files, run identity, or the checkpoint list itself. Commit and revert are state-only operations. The caller owns file-level rollback.

Checkpoints are stored with the persisted run and survive server restarts. Reusing a label replaces its snapshot while keeping the label's original insertion position.

---

## Recovery and Retry Logic

### Retry Budget

`do` tasks and fanout steps use `attempts`, with a default of two. A fanout stage can override the enclosing fanout attempt limit. `set` is deterministic and does not retry. `run` does not accept an `attempts` field.

### Retry Flow

1. The executor reports a task result with the current dispatch token.
2. The engine validates the result against `out`.
3. The engine evaluates ensures in declaration order.
4. The engine evaluates `iterate.until` when iteration is configured.
5. A failure redispatches the task while attempts remain and evidence changed.
6. Exhaustion activates `on_fail` when configured, otherwise it fails the flow.

### Persistence

Flow state is persisted to `~/.stratum/ts/flows/{runId}.json` after state mutations. Runs survive MCP server restarts.

### Server Restart Recovery

The engine loads a missing run from disk, revalidates its persisted spec, and resumes from persisted DAG state. Dispatch and gate tokens prevent stale work from mutating a newer issuance.

---

## Workflows

V1 has no top-level `workflow` declaration and no discovery registry. Name the file for people, and select the executable entry flow with `flows.entry`. The former code-review workflow becomes a normal v1 specification:

```yaml
version: 1
contracts:
  ReviewResult:
    summary: string
flows:
  entry: code_review
  code_review:
    input:
      files: string[]
      depth: string?
    output:
      from: "${review.output}"
      contract: ReviewResult
    steps:
      - id: review
        do: "Review ${input.files} for security, logic, and performance"
        out: ReviewResult
```

V1 input contracts support optional fields, but not default values. The caller supplies defaults before planning a run.

---

## Task Compiler

The task compiler converts spec-kit task files (`tasks/*.md`) into `.stratum.yaml` flows.

### Task File Format

```markdown
# Task: [P] Implement authentication

Add JWT-based authentication to the API.

## Acceptance Criteria

- [ ] file src/auth/middleware.ts exists
- [ ] file src/auth/middleware.ts contains "verifyToken"
- [ ] tests pass
- [ ] no lint errors
- [ ] Error messages are user-friendly
```

### Compilation Rules

- `[P]` in the title marks the task as parallelizable
- `file X exists` compiles to `file_exists("X")`
- `file X contains Y` compiles to `file_contains("X", "Y")`
- `tests pass` compiles to `result.tests_pass == True`
- `no lint errors` compiles to `result.lint_clean == True`
- Freeform criteria are incorporated into the step's `intent`

### Dependency Graph

- Sequential tasks depend on the prior task
- Parallel tasks (`[P]`) share the same predecessor with no edges between them
- After a parallel group, the next sequential task depends on all tasks in the group

### Usage

Via MCP tool: `stratum_compile_speckit(tasks_dir, flow_name)`.

---

## Skills

The eleven `/stratum-*` skills shipped and were installed by the python `stratum-mcp install`
command, which is retired — their sources are archived on `python-legacy`
(`stratum-mcp/src/stratum_mcp/skills/`). Skills already installed under `~/.claude/skills/`
keep working (they drive the same `stratum_plan` / `stratum_step_done` / `stratum_audit`
tools the TS server exposes). There is no TS installer yet.

---

## CLI Reference

Two bins, both run with node from the checkout:

```
node ts/src/mcp/bin.mjs            # Start stdio MCP server (for Claude Code)

node ts/src/cli/bin.mjs <command>  # aka `stratum` via a wrapper script:
stratum validate <file>            # Validate a .stratum.yaml spec (version: 1)
stratum migrate --check <file>     # Report-only classification of a legacy v0.x spec
stratum query flows                # List all persisted flows (JSON)
stratum query flow <id>            # Full state for a single flow (JSON)
stratum query gates                # List all pending gate steps (JSON)
stratum gate approve <flow_id> <step_id> [--note "reason"]
stratum gate reject  <flow_id> <step_id> [--note "reason"]
stratum gate revise  <flow_id> <step_id> [--note "reason"]
stratum guard <action>             # Guard ledger operations (see STRAT-GUARD)
stratum flow cancel <flow_id>      # Cancel a running foreground flow (exit 0 ok, 1 unconfirmed, 2 unknown flow)
stratum watch <flow_id>            # Follow a flow's progress
stratum help                       # Show usage
```

---

## Configuration

### Flow State Storage

Persisted flows are stored in `~/.stratum/flows/{flow_id}.json`. This directory is created automatically.

### SmartMemory Receipt Egress

SmartMemory receipt egress is off by default, even when credentials are present. This
reverses the earlier "on with credentials" behavior. To opt in, set all four required
variables:

```bash
STRATUM_LEARN_EGRESS=1
SMARTMEMORY_API_URL=https://memory.example
SMARTMEMORY_API_KEY=...
SMARTMEMORY_WORKSPACE_ID=...
```

When enabled, Stratum mirrors its durable usage, step-reset, and checkpoint-revert receipts
to SmartMemory. The scoped `X-Workspace-Id` header is mandatory; egress refuses to enable
and warns once when `SMARTMEMORY_WORKSPACE_ID` is absent. Register the three record types in
the SmartMemory service environment before enabling delivery:

```bash
SMARTMEMORY_EXTRA_MEMORY_TYPES=stratum_usage_debit:append:false,stratum_step_reset:append:false,stratum_checkpoint_reverted:append:false
```

Delivery is at least once. Every row carries a stable `metadata.receipt_id` of
`<run_id>:<sequence>`; consumers must deduplicate on that value because a lost success
response can cause a retry to create a second SmartMemory item.

```bash
stratum learn egress drain [--run <id>]
stratum learn egress verify --run <id>
stratum learn egress retry-dead --run <id>
```

Because SmartMemory has no exact list API, `verify` performs one exact search probe per
local receipt and, only when the expected type is absent, probes the other two types. It is
therefore O(n) network requests. It reports missing, duplicate, wrong-type, and dead receipt
counts. `retry-dead` returns rows rejected with a terminal HTTP status to the pending queue
and drains the run again.

### Hooks

The python installer's session hooks (`~/.stratum/hooks/`) are retired with it; sources
are archived on `python-legacy`. Any hooks still registered in `.claude/settings.json`
from an old install are inert once removed from there.

### MCP Registration

The MCP server is registered in the project's `.mcp.json`:

```json
{
  "mcpServers": {
    "stratum": {
      "command": "node",
      "args": ["/absolute/path/to/stratum/ts/src/mcp/bin.mjs"]
    }
  }
}
```

### CLAUDE.md Block

The execution model block appended to `CLAUDE.md` instructs the agent to use Stratum for non-trivial tasks:

```
## Stratum Execution Model

For non-trivial tasks, use Stratum internally:
1. Write a .stratum.yaml spec -- never show it to the user
2. Call stratum_plan to validate and get the first step
3. Narrate progress in plain English as you execute each step
4. Call stratum_step_done after each step -- the server checks your work
5. If a step fails postconditions, fix it silently and retry
6. Call stratum_audit at the end and include the trace in the commit
```

---

## Python Library (Track 1)

**RETIRED.**

The `stratum-py` decorator library (`@infer`, `@contract`, `@compute`, `@flow`,
`@refine`, `parallel`, `debate`, `await_human`, budgets, OTLP export) was retired with
the python engine on 2026-07-18 (STRAT-PY-RETIRE). Its final source is archived on the
[`python-legacy`](../../tree/python-legacy) branch (`src/stratum/`), and its last PyPI
release stays installable for existing users but receives no further updates.

---

## Examples

Working examples in [`examples/`](https://github.com/smartmemory/stratum/tree/main/examples):

| Directory | What it demonstrates |
|---|---|
| [`custom-tracker/`](examples/custom-tracker) | Minimal MCP server exposing a project tracker over stdio (the compose-mcp pattern) |
| [`nextjs/`](examples/nextjs) | Embedding Stratum pipeline monitoring into a Next.js app |

The python decorator examples (`01_sentiment.py` … `06_hitl.py`) retired with `stratum-py`; see `python-legacy`.

---

## Development

```bash
git clone https://github.com/smartmemory/stratum
cd stratum/ts
npm install                      # or pnpm install
./node_modules/.bin/vitest run   # full engine suite
```

Never run two full vitest passes concurrently — the suites share on-disk state roots.

### Test Counts

The TS engine has 640+ vitest tests across the IR, engine, MCP surface, guard,
parallel, and migrate suites, including cross-engine goldens that pin byte
compatibility with python-era ledgers and specs. Compose's suite (4,600+ tests,
including the `ts-cutover-*` goldens that drive this engine's real binaries
end-to-end) is the downstream integration harness.

### CI/CD

PyPI publishing is retired with the python packages. There is no npm publish
pipeline yet — consumers run the engine from a checkout (see Installation).

---

## License

[Apache 2.0](LICENSE)
