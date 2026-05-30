# STRAT-WORKFLOW-PIPELINE-STAGEOPTS — Design

**Status:** Phase 1 design (Compose build, 2026-05-30)
**Owner repo:** stratum
**Epic:** STRAT-WORKFLOW (forge-top ROADMAP) — follow-up to `-PIPELINE` (shipped same day, `bc8182d`)
**Related:** [[project_strat_workflow_epic]], [[feedback_ship_narrow_first]]

## Problem

`-PIPELINE` v1 ships per-stage `agent` + `intent_template`, but `task_reasoning_template` (cert) and
`task_timeout` stay **step-level and uniform** across every stage — the executor has no per-task
override for them. That's wrong for a realistic pipeline: a fast `claude` *clean* stage and a slow
`codex` *verify* stage want different timeouts, and a stage that must emit structured output wants its
own cert while a free-text stage wants none. This ticket adds per-stage `task_reasoning_template` and
`task_timeout`, overriding the step-level defaults.

This is a narrow extension to machinery shipped hours ago; all touchpoints were read live today.

## Goals / Non-Goals

**Goals**
- A pipeline `stage` may declare `task_reasoning_template` (cert) and/or `task_timeout` (seconds).
- Stage value **overrides** the step-level value for that stage's tasks; absent → step-level → engine default.
- Per-stage cert is honored in **both** cert paths (`ParallelExecutor._run_one` live dispatch +
  `server._evaluate_parallel_results` advance evaluation).
- Spec validation accepts the two new per-stage keys; checksum already covers them (the `stages`
  fingerprint serializes every stage dict).
- `parallel_dispatch` and existing `pipeline` behavior unchanged when no per-stage opts are set.

**Non-Goals**
- Within-stage fan-out / conditional routing (that's `-PIPELINE-FANOUT`).
- Per-stage `agent`/`intent_template` (already shipped in `-PIPELINE`).
- Per-stage `isolation`, `max_concurrent`, `require`, `merge` — those stay step-level (pipeline-wide).

## Design

### 1. IR surface — two new optional per-stage keys

```yaml
stages:
  - agent: claude
    intent_template: "clean {item}"
    task_timeout: 120                 # fast stage
  - agent: codex
    intent_template: "verify {prev}"
    task_timeout: 900                 # slow stage
    task_reasoning_template: {...}    # this stage must emit a structured cert
```

- Stage schema (today `additionalProperties:false` with `intent_template` + `agent`, `spec.py`) gains
  `task_reasoning_template` (object) and `task_timeout` (integer ≥ 1).
- Pipeline validation (today rejects any stage key beyond `intent_template`/`agent`) widens its allowed
  set to `{intent_template, agent, task_reasoning_template, task_timeout}`.
- **Stage cert gets the same defaults + shape-validation as the step-level cert** (Codex design-gate
  finding 1). Step-level `task_reasoning_template` is run through `_apply_cert_defaults(s, "task_reasoning_template")`
  in `_build_step` (`spec.py:1164/1223`), which fills default sections + rejects malformed templates;
  pipeline stages are copied raw today. Fix: in `_build_step`, call `_apply_cert_defaults(stage,
  "task_reasoning_template")` for each stage that has one **before** the `stages=tuple(...)` normalization,
  so a stage `task_reasoning_template: {}` inherits default sections and a malformed nested template raises.
- **Precedence (single rule, PRESENCE-based not truthiness):** for any field, *stage value if
  `is not None`, else step value, else default.* Using `is not None` (not `or`) so an explicit stage
  `task_reasoning_template: {}` (now defaulted to non-empty) — and more importantly any deliberately
  set stage value — is honored rather than falling through to the step value. `task_timeout` default
  `DEFAULT_TASK_TIMEOUT`; `task_reasoning_template` default = no cert.

### 2. Desugar — carry the resolved overrides on each task

`expand_pipeline_tasks` already stamps `_intent_template` / `_agent` per task. Add two more:
`_task_timeout = stage.get("task_timeout")` and `_task_reasoning_template = stage.get("task_reasoning_template")`
(both may be `None` → fall back to step-level at use). Underscore-prefixed → never collide with item fields.

### 3. Engine — apply the overrides

- **Timeout** (`parallel_exec.py:_run_one`, the `asyncio.wait_for(..., timeout=self.task_timeout)`):
  effective = `task["_task_timeout"] if task.get("_task_timeout") is not None else self.task_timeout`.
  (Schema floor `minimum:1` means a present value is always ≥ 1, so no zero-trap; still use presence
  for consistency with the cert rule.)
- **Cert template** (`parallel_exec.py:_run_one` cert block + `server._evaluate_parallel_results` cert
  loop): effective = stage template if `_task_reasoning_template is not None` else step template. A
  small shared resolver expresses this once so both sites can't drift (see Risks).

### 4. The one real semantic decision — does the claude agent-gate still apply to a *per-stage* cert?

`-PIPELINE` gates cert validation on the resolved stage agent (a codex stage skips the
claude-structured step-level cert) because the step-level cert is a *blanket* applied across mixed
agents and codex output isn't claude-cert-shaped. But a **per-stage** cert is an *explicit per-stage
opt-in* — if a user puts `task_reasoning_template` on a codex stage, they mean it.

**Decision:** the agent-gate applies only to the **step-level fallback** cert, not to an
**explicit per-stage** cert. So:
- stage has its own `task_reasoning_template` → validate it **unconditionally** for that stage's tasks
  (explicit beats heuristic), regardless of stage agent;
- stage has none, step-level cert exists → validate with the existing claude-agent-gate (unchanged
  `-PIPELINE` behavior).

This keeps `-PIPELINE`'s backward-compatible default while letting an explicit per-stage cert mean
exactly what it says. Both cert sites (`_run_one`, `_evaluate_parallel_results`) implement the same rule.

### 5. Cert *instructions* injected into the stage prompt (Codex design-gate finding 2)

Today the parallel path **validates** a cert post-hoc (`parallel_exec.py:_run_one`,
`server._evaluate_parallel_results`) but never **injects** the cert instructions into the prompt —
unlike inline/decompose steps, which call `inject_cert_instructions(intent, template)`
(`executor.py:1442/1487`). So an explicit per-stage cert that's only post-hoc-validated would almost
always *fail*: the agent was never told to produce the certificate. For §4's "explicit per-stage cert
means it" to hold, `ParallelExecutor._render_prompt` must append the **effective** cert's instructions
to the rendered stage prompt, using the **same precedence + agent-gate rule** as validation:
- compute the effective cert for the task (stage `is not None` → stage; else step);
- apply the §4 gate (explicit stage cert → always inject; step-level fallback → inject only for
  claude-agent stages);
- if a cert applies, `prompt = inject_cert_instructions(prompt, effective_template)`.

**Scope guard:** injection is gated on `self.is_pipeline`, so `parallel_dispatch` prompt construction
stays byte-identical (its existing validate-only behavior is unchanged — a deliberate non-goal to
avoid a regression on the shipped path). Documenting that `-PIPELINE`'s step-level cert was
validate-only and STAGEOPTS makes pipeline certs *instructed*; parallel_dispatch is untouched.

## Key decisions

1. **Same field names as step-level** (`task_reasoning_template`, `task_timeout`) so precedence is
   obvious (stage overrides the identically-named step field) — no second vocabulary.
2. **Precedence is one rule** (stage → step → default) applied to both fields.
3. **Explicit per-stage cert bypasses the agent-gate; step-level fallback keeps it** (§4).
4. **No checksum change needed** — the `stages` fingerprint (`executor.py`, added in `-PIPELINE`)
   already serializes every stage dict via `dict(sorted(st.items()))`, so new stage keys are covered
   automatically. Verify in a test rather than touch the fingerprint.

## Risks / unproven assumptions

- **Three sites must agree on the effective cert + gate.** `_run_one` validation, `_render_prompt`
  injection, and `_evaluate_parallel_results` validation must compute the *same* effective cert and
  apply the *same* gate. Mitigation: a single shared helper used at all three sites:

  ```
  # PIPELINE-ONLY helper. Non-pipeline branches are NOT routed through it.
  effective_pipeline_task_cert(stage_template, step_template, agent) -> template | None:
      if stage_template is not None:           # explicit per-stage cert → no gate (§4)
          return stage_template
      if step_template is not None and (agent or "claude").startswith("claude"):
          return step_template                 # step-level fallback → claude-gated (§4)
      return None
  ```

  **Why pipeline-only, not an `is_pipeline`-parametrized helper** (Codex design-gate round 2 + an
  asymmetry caught during blueprinting): the two non-pipeline cert sites are **already asymmetric** and
  must each stay byte-identical — `_run_one` validates a step-level `task_reasoning_template`
  *unconditionally* for parallel_dispatch (`parallel_exec.py:598`; `test_pipeline.py:416` asserts a
  codex parallel_dispatch step still certs), whereas `_evaluate_parallel_results` is *claude-gated* for
  parallel_dispatch (`server.py`, `(step.agent or 'claude').startswith('claude')`). A single helper
  *cannot* represent both non-pipeline behaviors, so it must not own the non-pipeline path at all.
  Therefore: each call site keeps `if self.is_pipeline:` → use the helper, `else:` → its existing
  non-pipeline branch verbatim. `_render_prompt` injection fires only in the `is_pipeline` branch, so
  parallel_dispatch prompt construction is untouched. Tests drive both the executor path and the server
  poll path and assert the three pipeline sites agree.
- **`task_timeout: 0`** — schema floor is `minimum: 1`, so 0 is rejected at the JSON layer; presence
  (`is not None`) resolution is used anyway for consistency with the cert rule.

## Design-gate resolution (Codex)

Round 1 raised two design-actionable findings, both folded in:
1. **(High) Stage cert templates skip the step-level default/validation pass** — §1: call
   `_apply_cert_defaults(stage, "task_reasoning_template")` per stage in `_build_step`; resolution is
   **presence-based** (`is not None`) not truthiness, so an explicit `{}` (now defaulted) isn't treated
   as absent and malformed templates raise at parse.
2. **(High) Cert instructions never injected on the parallel path** — new §5: `_render_prompt` appends
   the effective cert's instructions via `inject_cert_instructions` (same precedence + §4 gate),
   gated on `is_pipeline` so `parallel_dispatch` is byte-identical. A shared
   `effective_task_cert(...)` helper keeps the three sites (validate ×2 + inject) from drifting.

Round 2 raised one more:
3. **(High) Shared helper must carry `is_pipeline` or it regresses `parallel_dispatch`** — the helper
   contract (Risks §) now takes `is_pipeline`: non-pipeline returns the step template *unconditionally*
   (preserving `parallel_exec.py:598` + the `test_pipeline.py:416` regression), and only pipeline mode
   applies the stage-or-claude-gated-step rule. `_render_prompt` injection only ever fires for
   `is_pipeline` (parallel_dispatch prompt construction untouched).

## Acceptance criteria

- [ ] Pipeline stage accepts `task_timeout` and `task_reasoning_template`; schema rejects
      `task_timeout: 0` / non-object cert; non-pipeline steps still reject these as stage keys (n/a — they have no `stages`).
- [ ] Desugar stamps `_task_timeout` / `_task_reasoning_template` per task; precedence stage→step→default.
- [ ] A stage with a short `task_timeout` times out while a sibling stage with a long timeout completes
      (executor test with delays).
- [ ] An explicit per-stage cert on a **codex** stage **is** validated AND its instructions injected
      (bypasses the agent-gate); a step-level cert on a codex stage is **not** (agent-gate preserved) —
      consistent across `_run_one` validation, `_render_prompt` injection, and `_evaluate_parallel_results`.
- [ ] Stage cert overrides step cert when both present (presence-based); a stage `task_reasoning_template: {}`
      inherits default sections (not treated as absent).
- [ ] Cert instructions appear in the rendered stage prompt for an applicable cert (injection works);
      `parallel_dispatch` prompt construction is byte-identical (injection gated on `is_pipeline`).
- [ ] Malformed stage `task_reasoning_template` is rejected at parse (defaults/validation pass).
- [ ] Checksum changes when a stage's `task_timeout`/`task_reasoning_template` changes (no fingerprint
      edit needed — assert it).
- [ ] Regression: `-PIPELINE` tests + `parallel_dispatch` tests unchanged; full suite green.
