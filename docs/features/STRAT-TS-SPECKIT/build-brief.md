# STRAT-TS-SPECKIT — build brief (port `compile_speckit` → TS)

**Epic:** STRAT-PY-RETIRE · near-term queue item 2 (PORT-NOW: active surface)
**Live consumer:** the `stratum-speckit` skill (`stratum-mcp/.../skills/stratum-speckit/SKILL.md`
Phase 4 "Execute" — calls `stratum_compile_speckit`, then feeds the returned `yaml` to
`stratum_plan`). Keeping this skill working after Python is deleted REQUIRES the TS tool to emit
a spec the **TS** `stratum_plan` accepts.
**Status:** IN PROGRESS — codex writes, codex reviews, Opus adjudicates/verifies/commits.

## What this is (and why it's a re-port, not a transliteration)

Python `stratum-mcp/src/stratum_mcp/task_compiler.py` + tool `server.py:4052` compile a
directory of spec-kit `tasks/*.md` into a `.stratum.yaml` flow. The Python compiler emits the
**old Python IR** (`version: "0.1"`, a `functions:` block, `mode: compute`, `intent`,
per-step `output_schema`, `depends_on`, string `ensure` expressions). The **TS engine speaks a
different IR** (`version: 1`, no `functions` block — steps carry `do`/`out`/`ensure`/`after`
inline; ensures are STRUCTURED predicate objects). So the port must **re-target the output to
the TS v1 IR**. A literal transliteration would emit YAML the TS engine cannot run → dead on
arrival. The `migrate/check.ts` guidance table confirms the mapping: Python `compute + step`
→ v1 `task (agent-dispatched)` = a `do:` step (NOT `set:`).

The compiler is **pure** — filesystem read + string transform, no engine/flow state. This is the
easiest possible surface to port; the only real work is the IR mapping and honoring the frozen
MCP-surface gate.

## Parity oracle (Python, read these — behavior to preserve at the PARSER layer)

- `stratum-mcp/src/stratum_mcp/task_compiler.py` — the whole compiler.
- `stratum-mcp/tests/invariants/test_task_compiler.py` — parser + dep-graph + collision +
  criterion-matching invariants. The **parser/dep-graph/criterion/step-id/collision** behavior
  is ported byte-for-byte (same regexes, same rules). The **YAML-shape** assertions in that file
  are Python-IR-specific and DO NOT carry over — the TS tests assert the v1-IR shape instead.
- `stratum-mcp/tests/integration/test_compile_speckit.py` — the tool-level contract (statuses,
  error_types, steps summary).

## Design decisions (LOCKED)

### D1 — Emit TS v1 IR
Output is a `Specification` per `ts/src/ir/schema.ts` (`version: 1`, `contracts`, `flows`).
The emitted YAML MUST pass `validateSpec` (round-trip test is a hard gate).

### D2 — Parser layer: exact Python parity
Port these unchanged (same semantics, same regexes, same edge cases the invariant tests pin):
- **Title extraction:** first `#`-heading line, strip `#+` and optional `Task:` prefix.
- **`[P]` marker** (case-insensitive) anywhere in the title → `is_parallel`; strip it from the title.
- **`## Acceptance Criteria`** section (case-insensitive heading match); body = text between the
  title line and the criteria heading.
- **Criteria checkboxes:** `- [ ]` / `- [x]` / `- [X]` lines; both checked and unchecked compile.
- **`step_id_from_stem`:** lowercase, non-`[a-z0-9]`→`_`, strip leading/trailing `_`, prefix `t`
  if it doesn't start with a letter, empty→`"task"`. (`01-research`→`t01_research`,
  `02a-backend`→`t02a_backend`, `MyTask`→`mytask`, `""`→`task`.)
- **Discovery + ordering:** `sorted(glob("*.md"))` — alphabetical.
- **Step-ID collision guard:** two files normalizing to the same step_id → error naming BOTH files.
- **Dependency graph** (`build_dependency_graph`): sequential tasks depend on the whole preceding
  parallel group (or the last sequential task, or nothing); parallel tasks in a group share the
  last-sequential predecessor and have no edges between them. Reproduce the exact algorithm.

### D3 — Criterion → ensure (STRUCTURED, not string)
`criterionToEnsure(text)` returns a TS `EnsurePredicate` object or `null` (freeform). Map from
the SAME Python regexes:
- `file X exists` / `exist` (case-insensitive)   → `{ file_exists: "X" }`
- `file X contains Y` (Y unquoted / "double" / 'single', inner `"`→`\"`) → `{ file_contains: { path: "X", text: "Y" } }`
- `\btests?\b.*\bpass` (case-insensitive)         → `{ expr: "result.tests_pass == true" }`  (sets `needsTestsPass`)
- `(no lint errors? | lint (passes?|clean))`      → `{ expr: "result.lint_clean == true" }`  (sets `needsLintClean`)
- anything else / empty / whitespace              → `null` (freeform → goes into `do` text)

Note the TS `expr` grammar uses lowercase `true` (not Python `True`) and `result` is the step
output under test (`ts/src/eval/expr.ts`). Every step also gets a trailing `{ expr: "result.done == true" }`.

### D4 — Contracts: one shared `TaskResult`, optional flag fields
TS contracts are STRICT (`z.object(...).strict()` — extra keys rejected) and a field is optional
only when its type string ends `?`. Emit ONE contract:
```
TaskResult: { done: "boolean", tests_pass: "boolean?", lint_clean: "boolean?" }
```
`done` required on every step; `tests_pass`/`lint_clean` are optional at the contract layer (so
steps that never produce them still validate) and ENFORCED where present by the `result.X == true`
ensures (D3). This is the TS-native equivalent of Python's per-step `output_schema` (which added
required `tests_pass`/`lint_clean` fields) — the enforcement moves from schema to ensure, the
behavior (a tests step must return `tests_pass == true` or fail) is preserved.

### D5 — Step mapping (Python function+step → one v1 `do:` step)
For each task, emit one step:
```
{ id: <step_id>,
  do: <intent>,                       // title + "\n" + description + "\n" + "Also verify: <j1>; <j2>" (judgment joined by "; ")
  out: "TaskResult",
  ensure: [ ...structuredEnsures, { expr: "result.done == true" } ],
  attempts: 3,                        // Python retries:2 → total attempts 3
  after: [<deps>] }                   // omit `after` entirely when deps is empty (parity with Python omitting depends_on)
```
`intent` construction mirrors Python `build_yaml`: parts = [title, description?, "Also verify: …"?]
joined by `"\n"`. No per-step `inputs` mapping (the TS engine gives `do` steps the whole scope).

### D6 — Flow shape
```
flows:
  entry: <flow_name>
  <flow_name>:
    input: { project_context: "string" }
    output: { from: "${<lastTask.step_id>.output}", contract: "TaskResult" }
    steps: [ ... ]
```
`flow_name` defaults to `"tasks"`. `output.from` references the LAST task in sorted order — it is
always a sink (nothing declared after it can depend on it), so it is a valid flow-output source.
(Python's old IR had no `from`; this is a documented port decision, deterministic by construction.)

### D7 — YAML emission
Use `import { stringify } from "yaml"`. Emit block style (default). Key order should follow the
object insertion order above (the `yaml` package preserves it). Byte-identity with PyYAML is NOT
required — the only hard constraint is `validateSpec(parse(yaml))` succeeds and the parsed
structure matches D1–D6.

### D8 — MCP tool `stratum_compile_speckit`
- **Request:** `{ tasks_dir: "string", flow_name?: "string" }`.
- **Success (`status: "ok"`):** `{ status: "ok", yaml: <string>, flow_name: <string>, steps: [ { id, title, parallel, ensures, judgment } ] }`
  where each `steps[].ensures` is the array of STRUCTURED predicate objects for that task (minus
  the always-appended `done` check — match Python, which listed only the compiled criteria) and
  `judgment` is the array of freeform criterion strings.
- **Error (`status: "error"`):** `{ status: "error", error_type, message }`. error_types:
  - `directory_not_found` — `tasks_dir` is not a directory.
  - `no_tasks` — no `*.md` files (message contains `"No task files"`).
  - `step_id_collision` — two files normalize to one step_id (message names both).
  - `compile_error` — any other failure.
  Mirror Python `server.py:4059-4110` mapping exactly.

## Files

- `ts/src/speckit/compiler.ts` (NEW) — pure compiler: `parseTaskFile`, `stepIdFromStem`,
  `criterionToEnsure`, `buildDependencyGraph`, `buildSpec`, `compileSpeckit(tasksDir, flowName)`.
  `compileSpeckit` reads+sorts `*.md`, parses, checks collisions, returns
  `{ yaml, flowName, steps }`. Throw typed errors the tool layer maps to error_types (e.g. a
  `SpeckitCompileError` with a `kind` field, or reuse message-substring mapping like Python).
- `ts/src/mcp/server.ts` (EDIT) — add `"stratum_compile_speckit"` to the `ToolName` union and a
  dispatch `case` that: validates `tasks_dir` is a dir (`fs.stat`), calls `compileSpeckit`,
  returns the `ok` envelope, and maps thrown errors to the `error` envelope. No engine dependency.
- `ts/contracts/mcp-surface.json` (EDIT) — bump `surface` 4 → 5; add the `stratum_compile_speckit`
  entry (request + `ok`/`error` response shapes per D8).
- `ts/tests/speckit/compiler.test.ts` (NEW) — port the parser/dep-graph/criterion/step-id/
  collision invariants from `test_task_compiler.py` (assert the v1-IR shape, not the old shape),
  PLUS a hard round-trip: `validateSpec(parse(compileSpeckit(dir).yaml)).ok === true` for a
  representative multi-task + parallel fixture.
- `ts/tests/mcp/p5.test.ts` (EDIT) — (a) bump the "exposes exactly twenty tools" test to
  twenty-one (or make it assert the surface count generically — check how it currently derives the
  set; it already compares against `Object.keys(mcpSurface().tools)`, so only the human-readable
  count in the `it(...)` title/description needs updating). (b) In the big frozen-status test,
  exercise BOTH `stratum_compile_speckit` statuses: one `ok` (write a temp `tasks/` dir with a
  task `.md`, call, expect `ok`) and one `error` (call with a non-existent dir → `directory_not_found`).
  The final loop at p5.test.ts:210-213 requires every non-guard tool exercise ALL its declared
  statuses — `ok` and `error` must both appear in `seen`.

## Landmines (from this session)

- **Frozen surface (p5):** every DECLARED response status of every non-guard tool must be
  EXERCISED in `tests/mcp/p5.test.ts`, else the frozen gate fails. New tool → declare `ok`+`error`
  in `mcp-surface.json` AND exercise both.
- **`erasableSyntaxOnly`:** NO enum/namespace/param-properties/decorators in touched code. Use a
  string-literal union or `as const` object for any "kind" field, not a TS `enum`.
- **cwd resets between commands** — always `cd` in a compound command when running gates.
- Codex may make unplanned-but-correct adjacent fixes — that's fine; Opus adjudicates vs this brief
  and the Python source. Do NOT change any OTHER tool's surface or the engine.

## Gates (all must pass — Opus runs these; codex sandbox can't run vitest)

```
export PATH="$HOME/.nvm/versions/node/v22.22.3/bin:$PATH"; cd /Users/ruze/reg/my/forge/stratum/ts
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/tsc --noEmit --erasableSyntaxOnly
./node_modules/.bin/vitest run tests/speckit tests/mcp
```
Then the full suite before commit (`vitest run`), baseline ~523 pass / 1 skip.
