# STRAT-WORKFLOW-NAMING — Design

**Status:** Implementing (Compose build, 2026-05-29)
**Owner repo:** stratum
**Epic:** STRAT-WORKFLOW (forge-top ROADMAP) — ticket 1 of 6
**Related:** [[project_strat_workflow_epic]]

## Problem

Stratum uses two related terms — *workflow* and *flow* — that an outside reader (or a
future contributor) can easily conflate. The codebase already encodes the distinction
structurally (`workflow:` block + `stratum_list_workflows` for authored definitions;
`FlowState`/`flow_id`/`@flow` for running executions), but the distinction was never
written down. The risk is vocabulary drift: someone calls a running execution a
"workflow" or an authored spec a "flow," and the boundary erodes.

## Decision (already made during epic filing)

**Two-tier vocabulary, formalized — not mass-renamed** (Temporal / Airflow model):

- **Workflow** = *authored definition*. The named, version-controlled `.stratum.yaml`
  artifact with a `workflow:` block, discoverable via `stratum_list_workflows`.
- **Flow** = *execution unit and its running instance*. A DAG of typed steps (`flows:`,
  `@flow`); each run is a `FlowState` with a `flow_id`.

A mass rename was explicitly rejected: the definition/instance split is intentional, and
the codebase is ~20 flow-family files vs ~4 workflow — renaming would be ~20 files of
churn for zero behavior gain. See [[project_strat_workflow_epic]].

**Rule of thumb:** if you can `git diff` it, it's a *workflow* (or the flows inside it);
if it has a `flow_id` and a state, it's a *flow execution*.

## Scope

This is a **pure-documentation** feature. No behavior change, no API change, no rename.

Deliverables:

1. **SPEC.md** — "Terminology: Workflow vs Flow" section with glossary table.
   *(Already drafted in the working tree; this build commits it.)*
2. **README.md** — "Workflow vs Flow" Core Concepts section + a positioning note framing
   Stratum as **governed, portable, cross-model workflows** (the cross-client answer to
   single-vendor in-context orchestrators). *(Already drafted; commit.)*
3. **Docstrings** (narrow scope — 3 load-bearing public symbols):
   - `stratum_list_workflows` (server.py) — currently no docstring. State that it lists
     *workflow definitions* (authored specs), not executions.
   - `@flow` (decorators.py) — augment to note: `@flow` *defines* a flow; invoking it
     *creates a flow execution* carrying a fresh `flow_id`.
   - `FlowState` (executor.py) — currently no docstring. State that it is the runtime
     state of a *single flow execution* (a running instance), not an authored definition.
4. **CHANGELOG.md** — entry under stratum.

Out of scope (deferred): broad flow-family docstring sweep (flow_scope, IRWorkflowDef,
executor flow methods, module docstrings). Narrow-first per standing rule.

## Acceptance criteria

- [ ] SPEC.md terminology section committed, glossary table present.
- [ ] README.md "Workflow vs Flow" + positioning note committed.
- [ ] `stratum_list_workflows` has a docstring distinguishing definition from execution.
- [ ] `@flow` docstring invokes the define-vs-execute distinction.
- [ ] `FlowState` has a docstring identifying it as a single flow execution.
- [ ] No symbol renamed; no behavior change.
- [ ] Existing test suite still green (docstrings must not break import/introspection).
- [ ] Codex doc-review gate: REVIEW CLEAN.
- [ ] CHANGELOG entry.

## Verification

- `pytest` on the affected packages stays green (docstrings are inert, but `@flow` is
  introspected via `_stratum_type`, so confirm the decorator still tags correctly).
- Manual consistency grep: no `.py` source treats a running execution as a "workflow."
