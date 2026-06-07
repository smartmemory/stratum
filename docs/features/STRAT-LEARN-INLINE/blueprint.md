# STRAT-LEARN-INLINE — Implementation Blueprint

**Status:** BLUEPRINT (Phase 4) · **Design:** `./design.md` (Codex-clean) · **Repo:** stratum (`/Users/ruze/reg/my/forge/stratum`)

All line references verified against working tree at blueprint time (2026-06-08).

---

## Corrections Table (design assumption → on-disk reality)

| # | Design assumed | Reality (verified) | Correction adopted |
|---|----------------|--------------------|--------------------|
| C1 | Add `JudgeResult.inline_patch_candidates` field + extend `to_dict()` (§4.2) | The judge contracts permit extra properties (`judge-result.json` has no `additionalProperties:false`; `review-result.json:125`/`cross-model-review-result.json:77` allow extras), so a new field would **not** trip `_validate_judge_result` (`server.py:2414`) — the design-doc "would break validation" rationale was **false**. | **Still do not touch `JudgeResult`/`to_dict()`/kernel/contract — but on coupling/ownership grounds:** the judge result is a cross-repo contract consumed by compose/cockpit; threading inline-learn data (a stratum-internal harvester concern) through it couples an unrelated surface and invites future contract drift. Classify at the MCP **consumer edge** from `result.predicates`. Kernel byte-identical by *zero change*. |
| C2 | Kernel may take an `inline_learn` config param | Harvesting at the MCP edge means `run_judge(...)` (`kernel.py`, called `server.py:2389`) signature is untouched. | Config resolved at the server layer; `run_judge` unchanged. |
| C3 | Config read via a `[learn.inline_patch]` TOML section | `StratumConfig.load` (`project_config.py:57`) parses **only** `[pipeline.*]` (`:86`). No `learn` section exists. | Extend `StratumConfig` with an additive `learn` field + `[learn.inline_patch]` parser; absent section → disabled (default). |
| C4 | Append optional keys to audit + persisted flow | `_build_audit_snapshot` (`server.py:1917`) and `persist_flow` (`executor.py:1400`) both `return`/build a **fixed dict literal**. | Append new keys **after** dict construction, guarded by truthiness (omit-when-empty) → byte-identical off-path. `restore_flow` reads via `.get(...)`. |
| C5 | One judge entry point | `record_judge_turn` has one caller (`stratum_judge`, `server.py:2422`), **but `run_judge` itself has 3 call paths**: the MCP judge-step tool (`server.py:2389`), the goal orchestrator loop (`src/stratum/goal/orchestrator.py:906`), and guard transitions (`stratum-mcp/.../guard/transition.py:380`). | **v1 scope is explicit: harvest only the `stratum_judge` MCP judge-step path** (`server.py:2422`). Goal-loop → follow-up `STRAT-LEARN-INLINE-GOAL`. Guard transitions are **deliberately excluded** (a guard A→B verdict is a resource-lifecycle gate, not a dev-work diagnosis — no skill/MEMORY lesson to harvest). Stated as a scope boundary, not an oversight. |
| C6 | Default memory target `MEMORY.md` | Project-memory convention is `.claude/memory/MEMORY.md` (`skills/.../stratum-feature/SKILL.md:216`, `stratum-onboard/SKILL.md:167`). | Default `target_path = ".claude/memory/MEMORY.md"`. |

**Net effect of C1/C2:** the entire feature is **additive at the stratum-mcp edge + two new library modules**. No kernel change, no judge-contract change, no `JudgeResult` change. Off-path byte-identity is structural, not test-enforced-by-luck.

---

## Boundary Map

> Produces/Consumes between slices. Each entry names a concrete symbol.

### S0 — Config (`function` `resolve_inline_learn`, `class` `LearnConfig`)
- **Produces:** `InlineLearnConfig` (`type`) = `{enabled: bool, classifier: Literal["heuristic","llm"]}`; `StratumConfig.learn` (new attr); `resolve_inline_learn(workspace_root) -> InlineLearnConfig` (`function`).
- **Consumes:** existing `StratumConfig.load` (`function`, `project_config.py:57`); env `STRATUM_LEARN_INLINE_PATCH_ENABLED` (`const`).
- Files: `src/stratum/project_config.py` (existing).

### S1 — Pure classify+emit (`function` `emit_candidates`, `class` `PatchCandidate`)
- **Produces:** `FixTarget` (`type`), `PatchCandidate` (`class`, frozen dataclass), `classify_fix_target(pr) -> FixTarget` (`function`), `emit_candidates(result, cfg, *, agent_run=None) -> list[PatchCandidate]` (`function`).
- **Consumes:** `InlineLearnConfig` (S0, `type`); `JudgeResult`/`PredicateResult`/`PredicateType` (`type`, `src/stratum/judge/result.py:204/126/21`) — read-only.
- Files: `src/stratum/judge/inline_learn.py` (new).

### S2 — Sidecar writer (`function` `append_inline_candidates`)
- **Produces:** `append_inline_candidates(sidecar_path, candidates, *, flow_id, step_id, turn, project) -> int` (`function`); inline record schema `_schema_version="inline-1.0"` (`const`).
- **Consumes:** `PatchCandidate` (S1, `class`); `fcntl.flock` pattern (mirrors `guard/store.py:344`).
- Files: `src/stratum/judge/postmortem/corpus.py` (new).

### S3 — FlowState carriers (`class` `FlowState` fields)
- **Produces:** `FlowState.learn_candidates: list[dict]` (`const`/field), `FlowState.learn_inline_evaluated: int` (`const`/field).
- **Consumes:** —. Wired into `persist_flow` (`function`, `executor.py:1397`) + `restore_flow` (`function`, `executor.py:1438`), omit-when-empty.
- Files: `stratum-mcp/src/stratum_mcp/executor.py` (existing).

### S4 — MCP harvest + audit (`function` `_harvest_inline_learn`)
- **Produces:** `_harvest_inline_learn(state, result, step_id, workspace_root) -> None` (`function`); audit keys `learn_inline` + `staged_patch_candidates` (`const`).
- **Consumes:** `resolve_inline_learn` (S0), `emit_candidates` (S1), `append_inline_candidates` (S2), `FlowState.learn_*` (S3), `_build_audit_snapshot` (`function`, `server.py:1900`).
- Files: `stratum-mcp/src/stratum_mcp/server.py` (existing).

**Topology:** S1←S0, S2←S1, S4←{S0,S1,S2,S3}. No cycles; every cross-slice reference points at an earlier slice.

---

## File-by-file plan

### 1. `src/stratum/project_config.py` (existing) — S0
- Add `@dataclass(frozen=True) class LearnConfig` with `inline_patch_enabled: bool = False`, `inline_patch_classifier: str = "heuristic"`.
- Add `learn: LearnConfig = field(default_factory=LearnConfig)` to `StratumConfig` (additive; `load` builds it from `raw.get("learn", {}).get("inline_patch", {})`; validates `classifier ∈ {heuristic,llm}`; bad section → `StratumCompileError` consistent with existing `[pipeline.*]` validation at `:88–110`).
- **New module-level** `def resolve_inline_learn(workspace_root: Path) -> "InlineLearnConfig"`: load `stratum.toml` from `workspace_root`; env `STRATUM_LEARN_INLINE_PATCH_ENABLED` (truthy `{1,true,yes}`, case-insensitive) **overrides** TOML `enabled` (env precedence, mirrors the truthy-env pattern in `result_cache.cache_disabled()`, `result_cache.py:53–57`). Returns the small `InlineLearnConfig` (defined in `inline_learn.py`, imported lazily to avoid a cycle — or define `InlineLearnConfig` here and import into S1; pick the no-cycle direction: **define `InlineLearnConfig` in `inline_learn.py`, build it here via late import**).

### 2. `src/stratum/judge/inline_learn.py` (new) — S1, pure, no IO
```python
FixTarget = Literal["transient", "step-local", "durable"]

@dataclass(frozen=True)
class InlineLearnConfig:
    enabled: bool = False
    classifier: str = "heuristic"   # "heuristic" | "llm"

@dataclass(frozen=True)
class PatchCandidate:
    fix_target: FixTarget
    target_kind: Literal["skill", "memory"]
    target_path: str
    patch_type: Literal["create", "patch", "edit"]
    rationale: str
    suggested_change: str
    source_finding: str
    predicate_id: str
    predicate_type: str
    confidence: int
    def to_dict(self) -> dict: ...

def classify_fix_target(pr: PredicateResult) -> FixTarget: ...   # heuristic table (design §4.1)
def _heuristic_classify(pr) -> FixTarget: ...
async def _llm_classify(pr, agent_run) -> FixTarget: ...          # fail-open → heuristic
def build_candidate(pr: PredicateResult) -> PatchCandidate: ...   # durable only; default path .claude/memory/MEMORY.md
async def emit_candidates(result: JudgeResult, cfg: InlineLearnConfig, *, agent_run=None) -> list[PatchCandidate]:
    # iterate result.predicates; classify; only 'durable' → build_candidate
```
- Iterates `result.predicates` (`list[PredicateResult]`), considering only `verdict == "not_met"` (the `must-fix` set, matching `_findings_from_predicates` at `kernel.py:352`).
- `confidence` from `pr.confidence`; `source_finding` from `f"{pr.statement} — {pr.tier_history[-1].reason}"`; `predicate_type` from `pr.type`.

### 3. `src/stratum/judge/postmortem/corpus.py` (new) — S2
```python
INLINE_SCHEMA_VERSION = "inline-1.0"
def append_inline_candidates(sidecar_path, candidates, *, flow_id, step_id, turn, project) -> int:
    # mkdir parents; fcntl.flock(LOCK_EX) on the file (mirror guard/store.py:344);
    # read existing candidate_ids; write only-missing as JSONL; LOCK_UN in finally.
    # candidate_id = f"inline:{flow_id}:{step_id}:{cand.predicate_id}:{turn}"
    # record = {candidate_id, origin:"inline", _schema_version, flow_id, step_id, turn,
    #           project, fix_target, classifier?, classifier_confidence, source_finding,
    #           predicate_id, predicate_type, inline_patch: cand.to_dict()}
```
- Default path resolved by caller: `workspace_root / ".stratum" / "postmortem" / "inline_candidates.jsonl"`.
- Synchronous file IO is fine (called from the already-synchronous persist path); flock is blocking but the critical section is tiny. (If async hygiene is needed, wrap in `asyncio.to_thread` like `guard/store.py:344` — decide at impl per surrounding call context.)

### 4. `stratum-mcp/src/stratum_mcp/executor.py` (existing) — S3
- `FlowState` (`:1003`): add after `judge_outcome` (`:1064`):
  ```python
  learn_candidates: list[dict] = field(default_factory=list)      # STRAT-LEARN-INLINE
  learn_inline_evaluated: int = 0
  ```
- `persist_flow` (`:1400` payload): after the literal, before `write_text`:
  ```python
  if state.learn_candidates: payload["learn_candidates"] = state.learn_candidates
  if state.learn_inline_evaluated: payload["learn_inline_evaluated"] = state.learn_inline_evaluated
  ```
- `restore_flow` (`:1438`): read both via `payload.get("learn_candidates", [])` / `payload.get("learn_inline_evaluated", 0)`.
- **Scope note (S3):** the goal orchestrator has its *own* FlowState serialize/restore seam (`src/stratum/goal/orchestrator.py:152–188`, `227–274`) that does not carry these fields. Harmless in v1 — the goal path does **not** harvest (C5), so it never sets `learn_*`. When `-GOAL` lands it must extend that serializer too; called out here so it isn't silently missed.

### 5. `stratum-mcp/src/stratum_mcp/server.py` (existing) — S4
- **New helper** `async def _harvest_inline_learn(state, result, step_id, workspace_root) -> None`. **MUST be wholly fail-open** — it runs *after* the judge result is validated; any exception (config parse, classifier, sidecar IO) must be swallowed with a `stderr` warning, never propagated, so a valid judge result is never turned into a tool failure:
  ```python
  async def _harvest_inline_learn(state, result, step_id, workspace_root) -> None:
      try:
          cfg = resolve_inline_learn(workspace_root)
          if not cfg.enabled:
              return
          cands = await emit_candidates(result, cfg, agent_run=stratum_agent_run)
          evaluated = sum(1 for pr in result.predicates if pr.verdict == "not_met")
          state.learn_inline_evaluated += evaluated
          if cands:
              state.learn_candidates.extend(c.to_dict() for c in cands)
              append_inline_candidates(
                  _inline_sidecar(workspace_root), cands,
                  flow_id=state.flow_id, step_id=step_id,
                  turn=result.budget_consumed.turns,
                  project=Path(workspace_root).name)
      except Exception as exc:  # noqa: BLE001 — harvester must never break the judge
          print(f"stratum-mcp: warning: inline-learn harvest skipped: {exc}",
                file=sys.stderr)
  ```
  Mutations on `state` happen incrementally inside the `try`; a mid-way failure may leave `learn_inline_evaluated` bumped without a sidecar row — acceptable (the audit count is advisory, not a contract). The judge result and `persist_flow` are unaffected.
- **Call site:** `stratum_judge` (`:2422`) — insert **between** `state.record_judge_turn(step_id, result)` (`:2422`) and `persist_flow(state)` (`:2423`):
  ```python
  state.record_judge_turn(step_id, result)
  await _harvest_inline_learn(state, result, step_id, workspace_root)   # NEW
  persist_flow(state)
  ```
  `workspace_root` is already in scope (`:2386`). The returned `result_dict` (`:2424`) is **unchanged** — candidates never enter the judge contract.
- `_build_audit_snapshot` (`:1917`): after the dict literal, before `return`, refactor to a local `snap = {...}` then:
  ```python
  if state.learn_inline_evaluated:
      snap["learn_inline"] = {"evaluated": state.learn_inline_evaluated,
                              "durable": len(state.learn_candidates)}
  if state.learn_candidates:
      snap["staged_patch_candidates"] = state.learn_candidates
  return snap
  ```

---

## Off-path byte-identity proof obligations
1. `cfg.enabled is False` → `_harvest_inline_learn` returns immediately → `learn_candidates`/`learn_inline_evaluated` stay default → persist payload + audit snapshot keys **absent** → byte-identical. (Test: §6.1.)
2. No kernel / `JudgeResult` / `to_dict()` / judge-contract bytes change at all (C1). The `stratum_judge` return value (`:2424`) is identical when the flag is off.

## Test plan → files
- `tests/test_project_config.py` (existing, pipeline-only today) — **S0 additions:** default `learn.inline_patch_enabled is False` when no `[learn]` section; valid `[learn.inline_patch] enabled/classifier` parse; invalid `classifier` value and non-table `[learn.inline_patch]` → `StratumCompileError`; `resolve_inline_learn` env precedence (`STRATUM_LEARN_INLINE_PATCH_ENABLED` truthy overrides TOML `enabled=false`, and unset env preserves TOML).
- `tests/test_inline_learn.py` — S1 classification table, candidate construction, LLM fail-open (design §6 tests 2,3,7).
- `tests/test_inline_corpus.py` — S2 sidecar idempotency, turn-scoping, flock concurrency, no-label/own-schema (tests 5,6).
- `stratum-mcp/tests/test_server_inline_learn.py` — S4 off-path byte-identity (1), audit surfacing (4), end-to-end harvest on a synthetic flow with a `not_met` `judged` predicate.

## Out of scope (follow-ups, design §7 + C5)
`-ENSURE`, `-CORRECTION`, `-APPLY`, `-GOAL` (goal-loop harvest seam).
