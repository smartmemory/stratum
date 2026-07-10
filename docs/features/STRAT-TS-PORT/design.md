# STRAT-TS-PORT — TypeScript port of the Stratum engine (design)

**Status:** DESIGN (2026-07-10). Supersedes the PARKED T1-12 row (ROADMAP-ARCHIVE).
**Decision provenance:** owner decisions 2026-07-10 — standalone engine (NOT a
library inside compose), TS preferred for stack homogeneity, and the port
integrates the v3 constructs-review conclusions instead of porting the
Python IR verbatim.

## Related Documents
- `docs/VISION.md` — founding vision; the port's acceptance frame
- `forge/docs/product/2026-07-10-stratum-compose-product-review.md` — v2 (workflow engine), v3 (constructs verdict)
- Memory `project_stratum_ts_port` — 2026-06-02 litellm/AI-SDK de-risk spike (findings incorporated below)
- `stratum-mcp/src/stratum_mcp/spec.py`, `executor.py`, `connectors/` — reference implementation being ported
- Forge-top `ROADMAP.md` — STRAT-TS-PORT rows

## Goals (in vision order)

1. **Rails that hold:** every declared contract checked, no silently ignored
   spec fields, no unbounded routing (fixes E1/E2/E3 from the v3 review —
   these are design invariants here, not patches).
2. **Token-cheap authoring:** a typical 5-step flow in ≤400 tokens (Python IR
   today: 900–1,600). The model is the primary author.
3. **Consolidated IR:** 5 orthogonal constructs replacing the 7-step-mode zoo.
4. **Standalone engine:** core has zero MCP/CLI imports — daemon-ready
   (future G1/G2), with stdio MCP + CLI as thin adapters in v1.
5. **Clean cutover:** re-author on v1 (recorded clean-break decision); a
   report-only compat linter classifies old specs. Compose flips when its
   used subset reaches parity.

## Non-goals (v1)

- Guard, goal/decompose-tool, distill/learn/postmortem, blame/transcript
  tools, draft_pipeline — stay on Python stratum-mcp until demanded.
- Daemon, triggers, out-of-session gates (G1–G3) — architecture must not
  preclude them; v1 does not ship them.
- A second higher-level surface language — the IR IS the language.
- Windows support (macOS/Linux only, matching Python behavior).

## Locked stack decisions

| Decision | Value | Why |
|---|---|---|
| Package | `@smartmemory/stratum` (single package) | prior decision; lib + `bin: {stratum-mcp, stratum}` |
| Location | `ts/` workspace in this repo, pnpm | shared docs/history; publish from monorepo |
| Runtime | Node ≥ 20, ESM only | AI SDK + MCP SDK baseline |
| Types/contracts | zod v3 | contracts compile to zod schemas; `generateObject` native fit |
| LLM calls | Vercel AI SDK (`ai` + `@ai-sdk/anthropic` + `@ai-sdk/openai`) | 2026-06-02 spike: cleaner than the litellm dance; providerOptions covers thinking/effort/cache_control |
| Cost calc | static pricing JSON at `ts/src/pricing.json`, same rows as `stratum-mcp/src/stratum_mcp/pricing.py` | spike's identified gap; monthly pricing cron updates both |
| MCP server | `@modelcontextprotocol/sdk`, stdio | same as compose-mcp |
| Subprocess | `node:child_process` only | no execa; keep deps lean |
| Tests | vitest | table-driven + golden flows |
| Persistence root | `~/.stratum/ts/` (flows/, agent_runs/) | never clobbers Python state; both engines can coexist |
| Ensure expressions | custom mini-evaluator (grammar below) | no eval(), no jexl/filtrex supply-chain surface; identical semantics portable to future hosts |

## The IR — v1.0 (consolidated)

Five constructs: **task**, **edge**, **fanout**, **gate**, **subflow**.
Judge is unified INTO `ensure` (a task property), not a step kind.

**Contract language (locked, complete):** a strict JSON-Schema-subset that
maps 1:1 to zod. A contract is an object; every field is REQUIRED unless
suffixed `?`. Field types: `string | integer | number | boolean |
"<a>|<b>|..."` (enum) | `<T>[]` (array of any listed type) | `object`
(untyped map) | `array` (untyped list) | `<ContractName>` (nested ref,
non-recursive). Declared contract objects parse STRICT (unknown keys
rejected); the bare `object` type alone admits arbitrary keys. Ref/contract
path segments are contract field names (`[a-zA-Z_][a-zA-Z0-9_]*`) plus
numeric indices (`[0]`); no escaping.
The compat linter RECOGNIZES Python `{type, values}` descriptors within
this enumerated subset (guidance for re-authoring); arbitrary type strings
and general-JSON-Schema `output_schema` bodies are reported as
no-equivalent. Nothing is emitted or translated.

**Budget schema (locked):** `budget: { usd?: number>0, tokens?: int>0,
dispatches?: int>0, ms?: int>0 }` — at least one key required if `budget`
is present; same keys at flow and task level (task budgets are sub-ledgers
debited against the flow ledger).

**Reference & edge semantics (locked):** the routing DAG's edges are
`${refs}`, explicit `after: [ids]`, `on_fail` targets, and non-revise gate
routes — **list order is never an implicit dependency**. `when` is a LOCAL
conditional skip (no target, not an edge); `iterate` is a bounded LOCAL loop
(not an edge). The DAG must be acyclic; gate `on_revise` back-edges are
added AFTER ancestry is computed against that DAG. Reference grammar: `${input.<path>}`,
`${<step-id>.output[.<path>]}`, `${item}`/`${prev}` (fanout stages only).
Step ids match `[a-z][a-z0-9_-]*` (no dots). A field whose entire value is
one `${ref}` preserves the referenced TYPE (full-value reference); a `${ref}`
embedded in a longer string interpolates canonically (strings verbatim,
numbers/booleans as JSON, null as empty string, objects/arrays as compact
JSON). Unknown step-ids/paths = validation error, and a path ref into a
step's output REQUIRES that step to declare an `out` contract containing the
path. `input` in the evaluator and in refs denotes the flow's input object.
Tasks receive data ONLY via refs in `do`; `with:` exists on subflow calls
only, and its keys must exactly match the callee's input contract
(full-value refs preserve type). `agent:` accepts the literals
`claude | codex | none` only. `attempts: N` (replaces `retries`) = TOTAL
attempts including the first, default 2.

**Fanout output (locked):** `${<fanout-id>.output}` is the array of per-item
final-stage outputs, in `over` order (failed/skipped items are null when
`require` tolerates them); its element type is the last stage's `out`
contract.

**Contract syntax addenda (locked):** optionality is a suffix on the TYPE
string (`hint: "string?"`); enum arrays parenthesize (`"(red|green)[]"`).

**Step field matrix (normative — E2 is defined by THIS, not by examples).**
Every step has exactly one discriminant: `do` (agent task), `set` (compute
task), `gate`, `fanout`, or `run` (subflow). Any other combination, and any
field not listed for its kind, is a validation error.

| Field | agent task (`do`) | compute (`set`) | `gate` | `fanout` | `run` |
|---|---|---|---|---|---|
| `id` | REQ | REQ | REQ | REQ | REQ |
| `after` | opt | opt | opt | opt | opt |
| `when` | opt | opt | opt | opt | opt |
| `agent` | opt (default claude) | — | — | — | — |
| `out` | opt | REQ | — | — | — (callee output types it) |
| `ensure` | opt | opt | — | — | — |
| `attempts` | opt (default 2) | — (pure) | — | opt (per item) | — |
| `iterate` | opt | — | — | — | — |
| `budget` | opt | — | — | opt | opt |
| `on_fail` | opt | — | — | opt | opt |
| `with` | — | — | — | — | REQ |
| gate keys (`on_approve/on_revise/on_kill/max_rounds`) | — | — | in `gate:` | — | — |
| fanout keys (`over/steps/concurrency/isolation/require/merge/pre_merge`) | — | — | — | in `fanout:` | — |

Fanout stages are agent tasks restricted to: `do, agent, out, ensure,
attempts, when` (no nested fanout/gate/run/iterate). The final stage's
`out` is REQUIRED if `${<fanout-id>.output}` is referenced anywhere.

**Gate routing model (locked, E3):** every non-null gate route is a control
EDGE `gate → target` in the same graph as data edges. Self-targets and any
route whose edge creates a cycle are validation errors — except `on_revise`,
which must target a STRICT ANCESTOR of the gate in that graph and consumes
the flow-level `max_rounds` budget. Budget exhaustion at a task sub-ledger
fails that step (normal validation-failure path, `on_fail` eligible); at the
flow ledger it terminalizes the flow (`budget_exhausted`).

```yaml
version: 1
contracts:
  Review: { verdict: "pass|fail", notes: string, items: "string[]", hint: "string?" }
  Fixup: { done: boolean, path: string }
flows:                            # named map; `entry:` names the root flow
  entry: main
  main:
    input: { goal: string }
    output: { from: "${wrap.output}", contract: Review }  # EXPLICIT binding, zod-enforced (E1) — never an inferred "final step"
    budget: { usd: 5, dispatches: 20 }   # optional; ledger-enforced
    max_rounds: 3                 # flow-level TOTAL gate-revision budget; REQUIRED whenever any gate has on_revise
    steps:
    - id: build
      do: "Implement ${input.goal}. Follow the design at docs/x.md."
      agent: codex                # claude (default) | codex | none — literals only
      out: Review                 # contract ref — ENFORCED on THIS step (E1)
      ensure:
        - expr: "result.verdict == 'pass'"
        - file_exists: "src/x.ts"
        - judged: { statement: "No requirement in the design was dropped", stakes: cheap }
      attempts: 2                 # TOTAL attempts incl. the first; default 2
    - id: check
      do: "Verify ${build.output.notes} against tests"
      out: Review                 # required: ${check.output.items} is referenced below
      # NO depends_on: the ${build...} ref creates the edge (construct: edge)
    - id: approve
      after: [check]              # gates consume no data — edge must be explicit
      gate:                       # construct: gate — human/policy decision
        on_approve: fixups        # a control EDGE — must not create a cycle; null = terminal
        on_revise: build          # must target a STRICT ANCESTOR; consumes flow max_rounds
        on_kill: null             # control edge or null — must not create a cycle
        max_rounds: 2             # optional per-gate tightening; flow max_rounds is the hard total (E3)
    - id: fixups
      fanout:                     # construct: fanout — the ONE collection primitive
        over: "${check.output.items}"
        steps:                    # ordered per-item stages (absorbs pipeline)
          - do: "Fix ${item}"
            out: Fixup            # final stage MUST declare out — it types ${fixups.output}
            ensure: [{ expr: "result.done == true" }]
        concurrency: 3
        isolation: worktree       # worktree | none
        require: all              # all | any | <int>
        merge: sequential         # sequential (v1's only mode — manual merge needs a waiting surface engine-owned fanout doesn't have; revisit with G1)
        pre_merge: ["pnpm vitest run"]   # optional merge-safety commands (rails-critical, kept from Python)
    - id: wrap
      run: summarize              # construct: subflow — resolves in the flows: map below (non-recursive)
      with: { notes: "${fixups.output}" }
  summarize:
    input: { notes: array }
    output: { from: "${digest.output}", contract: Review }
    steps:
    - id: digest
      do: "Summarize ${input.notes} as a Review"
      out: Review
```

`run:` resolves ONLY within this spec's `flows:` map; unknown names and
recursion (direct or transitive) are validation errors. Python's `flows`
map carries over 1:1 when re-authoring; `entry:` = the Python `workflow.name`
match or the sole flow (multi-flow specs pick explicitly — never insertion
order).

`agent: none` = a compute step: no `do`; instead `set: { field: "<expr>" }`
where each expr uses the ensure evaluator grammar (pure data reshaping,
content-addressed cacheable). NOTE: this is for newly authored transforms
only — Python `compute` functions are agent-dispatched with an intent and
re-author as agent tasks, not this (see guidance table). `out` is enforced on the
assembled object like any task.

Tasks may carry bounded iteration: `iterate: { max: <int>, until: "<expr>" }`
— re-dispatch the task with structured feedback until `until` holds or `max`
exhausts (then normal on_fail/validation-failure semantics). This is a task
property, not a construct; it replaces Python `max_iterations`/`exit_criterion`.

### Construct mapping from Python IR (re-authoring guidance)

**SCOPE DECISION (2026-07-10, after three sol/high design-review rounds):
there is NO semantic migrator.** Three review passes generated a widening
stream of must-fixes, nearly all rooted in mechanically preserving Python
semantics — the non-convergence signal that the spec was too broad. The
clean break was already the recorded decision (2026-04-19: compose is the
only consumer; specs are predominantly ephemeral, model-authored per task).
Old specs are RE-AUTHORED in v1, not translated. What ships instead:
`stratum migrate --check <old.yaml>` — a report-only compat linter that
lists which Python constructs the spec uses and points at the guidance
below. It emits no YAML.

The table below is therefore **re-authoring GUIDANCE for humans and
models**, not a normative machine mapping. "UNSUPPORTED" rows mean v1
deliberately has no equivalent (keep such flows on Python stratum-mcp or
redesign them).

| Python v0.1–0.3 | v1.0 | Notes |
|---|---|---|
| `function` decl `mode: infer` + step | task (`agent:` from step, decl inlined) | agent-dispatched |
| `function` decl `mode: compute` + step | task (agent-dispatched) | Python compute IS dispatched with an intent — NOT `agent: none`/`set` (that is for new authoring only) |
| `function` decl `mode: gate` + step | gate construct | routing fields carried over |
| `inline` step | task | |
| `judge` step, `deterministic`/`judged` predicates | ensures folded onto the judge step's SINGLE antecedent (its sole `depends_on`/`$`-ref source) | zero or multiple antecedents → diagnostic (no unambiguous producer) |
| `judge` step: `verified` tier, per-predicate `applied_gate`, judge budgets | UNSUPPORTED → diagnostic | fold manually or keep flow on Python |
| `max_iterations` + `exit_criterion` | `iterate: { max, until }` | |
| `score_expr`, `accumulate`, `accumulate_key` | UNSUPPORTED → diagnostic | |
| `decompose` (TaskGraph without cross-task `depends_on`) | task with `out` = contract containing `tasks: T[]` + fanout over `${step.output.tasks}` | TaskGraph shape: `.tasks`, not a bare list |
| `decompose`/dispatch where TaskGraph tasks carry `depends_on` | UNSUPPORTED → diagnostic | v1 fanout has no cross-item dependencies; dependency-aware fanout is a possible v1.1 |
| `parallel_dispatch` (core: source/intent/concurrency/`isolation: worktree\|none`/require/merge/pre-merge COMMAND lists) | fanout | |
| `parallel_dispatch`: `isolation: branch`, `merge: manual`, reference-valued `pre_merge_verify`, certificates, task timeouts, diff capture, deferred advance | UNSUPPORTED → diagnostic | |
| `pipeline` stages with `when` | fanout `steps:` with `when:` | nested fanout/join regions: UNSUPPORTED → diagnostic |
| `pipeline` with `exit_when` | UNSUPPORTED → diagnostic | Python `exit_when` skips LATER stages for the item (not iteration); v1 has no stage early-exit — do not mis-map to `iterate.until` |
| `flow` step | subflow (`run:`); Python `flows` map → `flows:` map + `entry:` | non-recursive, unchanged |
| flow `max_rounds` present | flow `max_rounds` (same semantics: total gate-revision budget) | |
| flow `max_rounds` OMITTED but a gate has revise routing | re-author with an explicit `max_rounds` (start at 3) | Python treats omitted as unlimited — unlimited violates E3 |
| `depends_on` | per-dependency: each dep already implied by a `${ref}` is dropped; each remaining dep becomes an `after:` entry | never drop a dependency that has no ref |
| `skip_if` | `when:` (same evaluator, inverted sense) | |
| `next` | DAG edges + gate routing; irreducible jump graphs → diagnostic | expected rare |
| `on_fail` | `on_fail: <step-id>` — target MUST be topologically LATER (cleanup/report shape); participates in cycle detection | backward Python on_fail graphs → diagnostic (E3: no unbounded rework loops) |
| `ensure`/`exit_criterion` exprs | translated to the v1 grammar | untranslatable → diagnostic |
| contracts `{type, values}` / per-step `output_schema` | contract-language equivalents / anonymous per-task contract — ONLY for the enumerated subset (string/integer/number/boolean/enum/typed array/object/array/nested ref) | arbitrary type strings, general JSON Schema → diagnostic |
| flow output contract (Python: last non-null output in topo order, route-dependent) | `output: { from, contract }` — `from` inferred ONLY when a unique static terminal producer exists | branch-dependent or ambiguous final outputs → diagnostic |

### Ensure evaluator — locked grammar

No eval. A ~300-line recursive-descent evaluator over JSON values:

- Literals: string, number, boolean, null. Identifiers: `result`, `input`,
  `item`, `prev`, plus member access `a.b`, index `a[0]`.
- Operators: `== != < <= > >= && || ! + - * / in`.
- Whitelisted functions: `len, any, all, max, min, str, int, bool, matches(s, regex), file_exists(p), file_contains(p, s)`.
- File helpers resolve against the flow's workspace root; absolute paths and
  `..` escapes are validation errors.
- Type errors and unknown identifiers → predicate FAILS with a structured
  reason (fed to the retry prompt), never throws the engine.

`judged:` predicates route through the judge tier: `stakes: cheap|default|
paranoid` selects model/effort (same table as Python `codex_models.py` /
judge kernel); result is `{holds: bool, reason: string}` charged to the
flow ledger.

### Strictness invariants (design-level, tested in every phase)

- **E1:** `out` enforced by zod parse on every task (and fanout item, and
  flow output). Parse failure = validation failure = retry with the zod
  error message in context.
- **E2:** unknown fields, or fields from two constructs on one step
  (e.g. `do` + `gate`), are validation ERRORS. There is no lenient mode.
- **E3:** control transfer exists only as (a) the routing DAG (refs,
  `after`, `on_fail`, non-revise gate routes — acyclic, self-targets
  rejected), (b) local bounded constructs (`when` skip, `iterate` with
  mandatory `max`), and (c) the single sanctioned back-edge, gate
  `on_revise` (strict DAG ancestor), consumed from a REQUIRED finite
  flow-level `max_rounds`. Nothing exists to be unbounded.

## Architecture (daemon-ready)

```
ts/src/
  ir/        schema.ts (zod), validate.ts, refs.ts ($-ref parsing → edges)
  eval/      expr.ts (grammar above), files.ts
  engine/    engine.ts (StratumEngine: plan/stepDone/resume/audit)
             state.ts (persistence ~/.stratum/ts/flows/)
             ledger.ts (budget), fanout.ts, gates.ts
  judge/     judged.ts (AI SDK generateObject, stakes table), pricing.ts
  connectors/ claude.ts (@anthropic-ai/claude-agent-sdk query())
             codex.ts (codex exec --json; sync + durable bg incl. T2F5
             wrapper + sentinel + proc-identity — port semantics 1:1)
  mcp/       server.ts (stdio; thin adapter over StratumEngine)
  cli/       main.ts (validate | migrate --check | watch | audit)
  migrate/   check.ts (v0.1–0.3 parser + construct-usage report; NO emission)
```

`engine/` imports nothing from `mcp/`/`cli/`. The MCP tool surface in v1 is
the core loop only: `stratum_validate, stratum_plan, stratum_step_done,
stratum_resume, stratum_audit, stratum_gate_resolve, stratum_agent_run,
stratum_agent_poll, stratum_cancel_agent_run`.

**Compatibility contract (corrected after design review):** tool NAMES match
Python, but result shapes are NOT claimed byte-compatible — Python fanout
requires the `stratum_parallel_*` tools (client-driven advance via
`status: "parallel_dispatch"`), which v1 deliberately omits. Instead:
- **Fanout is engine-owned in TS:** the engine dispatches items itself via
  connectors (this also serves daemon-readiness); `plan`/`step_done` never
  return a parallel-advance status.
- Request AND response schemas of every tool are FROZEN in a contract file,
  `ts/contracts/mcp-surface.json` (every `status` variant enumerated), and
  contract-tested. Version key `surface: 1`.
- Clients (compose, CLAUDE.md skills) migrate against that contract file,
  not against recorded Python outputs.

## Phases — work packages for codex/terra-class implementers

Routing: terra/high default; **sol/high for P2 and P3** (expression evaluator
and process management are the two judgment-heavy packages). Every phase:
files enumerated, MUST checklist, mechanical gate (vitest green + enumerated
behaviors). One phase per dispatch; controller commits.

**Invariant gating is cumulative by capability** (corrected after design
review — earlier phases cannot execute later invariants): structural E2 at
P0; task/flow E1 + one-graph acyclicity (incl. `on_fail`) at P1; evaluator
enforcement (jail, structured failures) at P2; gate/fanout E1/E3 at P4. From
P4 on, the FULL E1/E2/E3 regression suite runs in every phase gate.

### P0 — scaffold + IR schema + validator
Files (new): `ts/package.json, tsconfig.json, src/ir/*, tests/ir/*`
- [ ] MUST: zod schemas for every construct exactly as specced above
- [ ] MUST: E2 strictness — unknown field / construct-mix fixtures all rejected with path-precise errors
- [ ] MUST: `$`-ref parser produces edges; cycle detection; unknown-ref = error
- [ ] MUST: fixture corpus ≥ 25 specs (valid + each error class), table-driven
- [ ] Gate: `pnpm vitest run` green; validator exercised via its API (the `stratum validate` CLI command lands in P5)

### P1 — engine core (fake connectors)
Files (new): `src/engine/*`, tests/engine/*
- [ ] MUST: plan → stepDone loop with persisted state, resume mid-flow after process restart (golden flow test)
- [ ] MUST: `attempts` with structured failure context; `on_fail` routing; `when`
- [ ] MUST: budget ledger (usd/tokens/dispatches/ms) — task sub-ledger exhaustion fails the step (on_fail eligible); flow exhaustion terminalizes (`budget_exhausted`) (E-harness)
- [ ] MUST: E1 — task `out` + flow `output` zod-enforced (failure ⇒ retry, message in context)
- [ ] Gate: golden flow + error-harness tables green

### P2 — ensure evaluator + judged tier (sol/high)
Files (new): `src/eval/*, src/judge/*`, tests
- [ ] MUST: grammar exactly as locked (no additions); dunder/prototype access impossible by construction; fuzz test with hostile strings
- [ ] MUST: file helpers jailed to workspace root (traversal fixtures)
- [ ] MUST: predicate failure returns structured reason, never throws
- [ ] MUST: `judged:` via generateObject with stakes→model table + ledger debit; ONE live test (cheap stakes), rest mocked at the AI-SDK boundary only
- [ ] Gate: table-driven predicate suite (≥ 60 rows) green

### P3 — connectors + background runs (sol/high)
Files (new): `src/connectors/*`, tests
- [ ] MUST: claude via agent-sdk query(); codex via `codex exec --json` argv identical to Python `_exec_args`
- [ ] MUST: durable bg mode — T2F5 shell wrapper, sentinel `{"__t2f5_done__":rc}`, 12-hex run registry under `~/.stratum/ts/agent_runs/`, proc-identity (pid + start-time) before any signal
- [ ] MUST: cancel = killpg after identity check; poll = restart-proof registry read with 20k text caps
- [ ] MUST: live e2e smoke with `gpt-5.3-codex-spark/low` (echo test), skipped when codex absent
- [ ] Gate: port the Python `test_agent_run_bg.py` scenarios 1:1

### P4 — gates + fanout
- [ ] MUST: gate resolve (approve/revise/kill), revise targets ancestor only, `max_rounds` enforced (E3 fixtures)
- [ ] MUST: fanout concurrency cap, `require` semantics, worktree isolation (create/apply/cleanup), sequential merge with conflict = flow error
- [ ] Gate: golden flows incl. a fanout-with-stages flow

### P5 — MCP server + CLI + watch
- [ ] MUST: stdio server exposing the frozen 9-tool surface; every response validates against `ts/contracts/mcp-surface.json` (contract test enumerating every status variant)
- [ ] MUST: `stratum watch <run_id> [--json|--events [--kinds=...]]` — port STRAT-AGENT-BG-MONITOR semantics exactly (reuse its test matrix)
- [ ] Gate: MCP integration test via SDK client

### P6 — compat linter + reference parity flows
- [ ] MUST: `stratum migrate --check <old.yaml>` — parses v0.1–0.3, reports which constructs the spec uses keyed to the guidance table, exit 0 (report-only, no YAML emission, no semantic translation)
- [ ] MUST: 3 reference flows hand-authored in BOTH IRs (linear+gate, fanout, subflow) — run on both engines with fake connectors, compare terminal state + ensure/gate outcomes (NOT step-by-step traces; the IRs deliberately differ structurally)
- [ ] MUST: one reference flow has exactly 5 task steps and is the authoring-cost specimen: ≤ 400 tokens counted with cl100k_base (deterministic; spec file bytes only)
- [ ] Gate: linter classifies every Python test fixture without crashing; parity report committed

### P7 — compose cutover (separate feature, compose repo)
Flag-gated engine selection in compose; flip default after a soak week; then
deprecation notes on `stratum-py`/`stratum-mcp` PyPI pages. NOT part of this
feature's gate.

## Acceptance (feature-level)

- [ ] 5-step reference flow authored in ≤ 400 cl100k_base tokens (counted in CI from the P6 specimen)
- [ ] Full E1/E2/E3 regression suite green (cumulative per capability from P0, complete from P4)
- [ ] Live golden flow: spec → codex task → judged ensure → gate → fanout → audit, on the real binaries
- [ ] Python engine untouched and green throughout (`pytest` suite stays 1517+)

## Review trail

Four adversarial design-review rounds (codex `gpt-5.6-sol/high`,
2026-07-10). Rounds 1–2: 16 must-fixes, all applied (MCP-surface/fanout
contract, per-mode migration, bounded routing, contract language, phase
gating, corpus split). Round 3 stopped converging (10 finer must-fixes,
mostly migrator-rooted) → scope cut: semantic migrator removed entirely
(clean-break decision reaffirmed), replaced by a report-only compat linter.
Round 4 (post-cut): 4 must-fixes — cut debris + the normative field matrix +
`merge: manual` removal — all applied. Remaining findings were
phase-brief-grade; implementation dispatches carry their own review gates.

## Risks / honest caveats

- The codex durable-child semantics (P3) are the subtlest port — that is why
  it's sol-routed and test-ported 1:1 rather than re-derived.
- Compose parity is scoped to compose's *used* subset; anything compose calls
  that is not in the 9-tool surface must be discovered in P7 scoping (grep
  compose for `mcp__stratum__` before starting P7) and either added or kept
  on Python.
- The ≤400-token authoring target is a design constraint, not a hope — if a
  construct can't hit it, the construct (not the target) gets redesigned.
