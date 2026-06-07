# STRAT-LEARN-INLINE — Design

**Owner:** stratum · **Status:** DESIGN (Phase 1) · **Roadmap row:** forge-top Standalone Tickets → `STRAT-LEARN-INLINE` (PLANNED)
**Filed:** 2026-06-03 (Nous Hermes `skill_manage(patch)` competitive scan) · **Design:** 2026-06-08

## Related Documents
- Roadmap row: `/Users/ruze/reg/my/forge/ROADMAP.md` → Standalone Tickets → STRAT-LEARN-INLINE
- Reuses: STRAT-JUDGE kernel (`src/stratum/judge/kernel.py`), STRAT-JUDGE-POSTMORTEM corpus (`src/stratum/judge/postmortem/`)
- Sibling idea (distinct): IDEA-11 (post-ship `learn: true` corpus append) — this fires **inline mid-run**, not post-ship
- Constraints: STRAT-IMMUTABLE (spec immutability), `[[feedback_review_loop_roles]]` (Opus fixes, never auto-edit), default-OFF gate discipline (STRAT-GUARD / COMP-MCP-ENFORCE precedent)

---

## 1. Problem

The judge kernel closes the loop *within a step*: `run_judge` returns a verdict, and on `must-fix` the worker regenerates until the predicate is met. The postmortem corpus closes it *across runs*: an offline `--all` cold-mine learns from past sessions. **Nothing patches the durable scaffold at the moment a failure is diagnosed.** When the kernel discovers a must-fix failure whose lesson generalizes beyond this run ("the actionable-error-message predicate keeps failing because the skill never tells the agent to include a remediation line"), that insight evaporates — it isn't captured anywhere a future run will see it until a human happens to re-derive it.

This is the gap STRAT-LEARN-INLINE fills: a **harvester edge** on the judge kernel that, on a diagnosed must-fix failure, asks "does this fix generalize?" and — if yes — emits a **staged, described patch candidate** for a skill or MEMORY file into (a) the `stratum_audit` trace and (b) a dedicated **inline sidecar** (`.stratum/postmortem/inline_candidates.jsonl`) — distinct from the transcript-shaped postmortem corpus, which a curator pass later promotes from (§4.4). It never edits anything; it surfaces a reviewable proposal.

## 2. Goal & Non-Goals

**Goal (v1):** On `run_judge` returning a `must-fix` finding, classify the fix target (`transient` / `step-local` / `durable`); for `durable`, build a described skill/MEMORY patch candidate; surface it in the audit trace and append it (idempotently, flock-guarded) to the **inline sidecar** (`.stratum/postmortem/inline_candidates.jsonl`, NOT the transcript corpus — §4.4). Default OFF; byte-identical when off.

**Non-Goals (v1):**
- **No auto-apply.** Candidates are logged (audit trace + inline sidecar JSONL), never written to skill/MEMORY source files or the working tree.
- **No spec mutation, ever.** Patches target skill/MEMORY files only — never the running `.stratum.yaml` (STRAT-IMMUTABLE).
- **No literal old→new string synthesis.** v1 emits *described intent* (target + operation + rationale + suggested-change prose); the curator authors the final string. (Decision, Phase 1.)
- **No `ensure`-failure or inline user-correction triggers.** Only the judge-kernel `must-fix` path. (Decision, Phase 1 — see §7 follow-ups.)
- **Does not replace the corpus.** Inline is the harvester (`origin: "inline"`); the batch `--all` pass stays the curator.

## 3. Phase-1 Decisions (resolved)

| # | Decision | Choice | Rationale |
|---|----------|--------|-----------|
| D1 | Trigger scope | **`run_judge` must-fix only** | Only the judge kernel emits a *structured* diagnosis today (`findings[severity]` + predicate `type` + `tier_history.reason`). `ensure`-failures are plain strings; inline user-correction is net-new and noisy. |
| D2 | Patch granularity | **Described intent** | Safest under "staged, not applied." No auto-synthesized old→new edits to pollute the trace/corpus. |
| D3 | Classifier | **Heuristic + optional LLM** | Cheap deterministic default (zero added model cost); opt-in LLM upgrade when configured. |

## 4. Architecture

Three layers, separated so the kernel stays pure and all IO sits at the edge:

```
run_judge (kernel.py)                     ── library, pure
  └─ if learn-inline enabled:
       emit_candidates(JudgeResult, cfg)  ── NEW pure module: classify + build
       └─ attaches → JudgeResult.inline_patch_candidates  (additive field, omitted-when-empty)

MCP judge handler (stratum-mcp)           ── IO edge
  ├─ copies candidates → FlowState.learn_candidates  (additive field, omitted-when-empty)
  └─ append_inline_candidates(sidecar,…)  ── NEW flock-guarded idempotent append
                                              to a SEPARATE inline sidecar file
                                              (NOT the transcript corpus)

_build_audit_snapshot(state)              ── reads FlowState.learn_candidates + learn_inline_evaluated
  ├─ when edge ran → audit["learn_inline"] = {evaluated:N, durable:M}  (else absent)
  └─ when M>0      → audit["staged_patch_candidates"] = [...]          (else absent)
```

**Byte-identity rule (applies to both additive fields):** `inline_patch_candidates` and `learn_candidates` are **omitted from serialization when empty**, never emitted as `[]`. `JudgeResult.to_dict()` (currently a fixed dict, `result.py:242`) and `FlowState` persistence (`executor.py` `persist_flow`, fixed payload) each add the key **only when the list is truthy**. Off-path → list empty → key absent → byte-for-byte identical to today's output. (Resolves the false byte-identity that a defaulted `[]` would cause.)

### 4.1 New module: `src/stratum/judge/inline_learn.py` (pure, no IO)

```python
FixTarget = Literal["transient", "step-local", "durable"]

@dataclass(frozen=True)
class PatchCandidate:
    fix_target: FixTarget            # classification result
    target_kind: Literal["skill", "memory"]
    target_path: str                 # best-guess hint, e.g. "MEMORY.md" or
                                     # "stratum-mcp/src/stratum_mcp/skills/<skill>/SKILL.md"
    patch_type: Literal["create", "patch", "edit"]   # intended op (curator authors string)
    rationale: str                   # why this generalizes (derived from the diagnosis)
    suggested_change: str            # prose description of the change — NOT a literal diff
    source_finding: str              # the must-fix finding text that triggered it
    predicate_id: str
    predicate_type: PredicateType    # deterministic | verified | judged
    confidence: int                  # carried from the predicate / classifier

def classify_fix_target(pr: PredicateResult) -> FixTarget: ...
def emit_candidates(jr: JudgeResult, cfg: InlineLearnConfig,
                    *, classifier=heuristic_classify) -> list[PatchCandidate]: ...
```

**Heuristic classifier (default path, deterministic):**
- `predicate_type == "deterministic"` AND reason matches flake/timeout/`eval raised` → **`transient`**.
- `predicate_type == "verified"` (tests pass / endpoint 200) failing → **`step-local`** (fix the code in this run; doesn't generalize).
- `predicate_type == "judged"` failing (subjective: "error message actionable", "design criteria satisfied in name only") → **`durable`** — the class a skill/MEMORY note generalizes.
- Default fallthrough → **`step-local`** (conservative: never emit a `durable` candidate without a positive reason).

**Optional LLM classifier** (`classifier = "llm"`): reuse the LiteLLM fail-open pattern (mirrors `postmortem/decompose.py:LiteLLMDecomposer`). On any error → fall back to `heuristic_classify`. Off by default; never on the default path.

Only `durable` classifications produce a `PatchCandidate`. `transient`/`step-local` results do **not** produce candidates, but the edge records a tiny per-flow tally so the audit can tell "inline learning ran and found nothing durable" apart from "inline learning never ran": `FlowState.learn_inline_evaluated: int` (count of must-fix findings classified, additive, omitted-when-zero). The audit surfaces a single optional summary object — `audit["learn_inline"] = {"evaluated": N, "durable": M}` — present whenever the edge ran (`N > 0`), absent otherwise. Off-path: edge never runs → `N == 0` → both the summary and `staged_patch_candidates` keys are absent (byte-identical).

**Target/`suggested_change` derivation (v1, described-intent):** `target_kind` defaults to `"memory"` with `target_path = ".claude/memory/MEMORY.md"` (the project-memory convention per `stratum-feature/SKILL.md:216` and `stratum-onboard/SKILL.md:167` — **not** a bare root `MEMORY.md`) and `patch_type = "edit"` (append a learned note) unless the finding text names a skill, in which case `target_kind="skill"` and the best-guess `SKILL.md` path is filled. `suggested_change` is a templated prose line built from `{statement} + {reason} + {predicate_type}`. Because the candidate is described, not applied, exactness of `target_path` is a hint, not load-bearing.

### 4.2 Additive fields (mirror existing `judge_history` / `decomposer_mode` patterns)

- `JudgeResult.inline_patch_candidates: list[dict] = field(default_factory=list)` — added to the dataclass **and** `to_dict()` (the on-wire contract `compose/contracts/judge-result.json` gets the optional field). Default `[]` → existing review consumers read their subset unchanged (strict-superset invariant preserved).
- `FlowState.learn_candidates: list[dict] = field(default_factory=list)` — additive, `default_factory` → deserialization of older flows fills `[]`.

### 4.3 Config (default OFF, byte-identical when unset)

Project TOML (`src/stratum/project_config.py`), new section:
```toml
[learn.inline_patch]
enabled = false                 # default OFF
classifier = "heuristic"        # "heuristic" | "llm"
```
Env override: `STRATUM_LEARN_INLINE_PATCH_ENABLED` (truthy: `1`/`true`/`yes`) — mirrors `result_cache.is_disabled()` env-guard convention.

**Off-path invariant:** when `enabled` is false, `run_judge` skips the entire classify+emit block at the top (single guard). `JudgeResult.inline_patch_candidates` stays `[]`, `FlowState.learn_candidates` stays `[]`, the audit key is absent, no corpus append occurs. The kernel's return value is byte-identical to today. A regression test asserts byte-identical `to_dict()` with the flag off.

### 4.4 Corpus integration: a SEPARATE inline sidecar (NEW module `src/stratum/judge/postmortem/corpus.py`)

**The inline harvester does NOT write into `candidates.jsonl`.** That corpus is transcript-shaped: every record carries `session_id`, `request_text`, `claim_kind`, `claim_text`, `work_tool_uses`, `post_claim_events` (`cli.py:65–96`), and the readers/replay dereference those fields directly (`cli.py:219–275`, `replay.py:103–190`). Worse, its `label` field is the **replay ground-truth contract** (`true_met|false_met|ambiguous`, scored in `replay.py:223–235`) — overloading it with a fix-target classification would make replay metrics meaningless. So inline rows must not masquerade as transcript rows.

Instead, the harvester appends to a **distinct sidecar** `.stratum/postmortem/inline_candidates.jsonl` with its own schema:

```python
def append_inline_candidates(sidecar_path: Path, candidates: list[PatchCandidate],
                             *, flow_id: str, step_id: str, turn: int,
                             project: str) -> int:
    """Append inline candidates to the inline sidecar, flock-guarded and
    idempotent on candidate_id. Returns count actually written."""
```

- **Own schema** (`_schema_version: "inline-1.0"`), never the transcript schema: `{candidate_id, origin:"inline", flow_id, step_id, turn, project, fix_target, classifier, classifier_confidence, source_finding, predicate_id, predicate_type, inline_patch:{…PatchCandidate…}}`. **No `label`, no `request_text`/`claim_*`/`work_tool_uses`** — so no existing reader/replay path can mis-dereference it.
- **Dedup key includes the judge turn:** `candidate_id = f"inline:{flow_id}:{step_id}:{predicate_id}:{turn}"`, where `turn = budget_consumed.turns` (the per-(flow,step) monotonic judge turn already tracked in `judge_history.turn`, `executor.py`). Distinct must-fix turns on the same predicate are preserved, not collapsed.
- **Atomic, race-safe append:** `fcntl.flock(LOCK_EX)` around read-existing-ids → write-missing (the repo's STRAT-GUARD ledger uses the same `flock` pattern). Safe under concurrent MCP flows / background execution.
- **"Feeds, not replaces":** the sidecar is the harvester's output; the curator's batch `--all` pass (and the replay harness, in a follow-up) may read it to *promote* high-signal entries into the canonical corpus after human review — but the inline edge never writes the canonical `candidates.jsonl`.

## 5. The three Hermes departures (mapped to enforcement)

| Hermes does | We do | Enforced by |
|---|---|---|
| Patches live `.stratum.yaml`/running scaffold | Patches **skill/MEMORY only** | `PatchCandidate.target_kind ∈ {skill, memory}` (validated); no code path writes a spec file |
| Auto-applies mid-session | **Staged** — audit trace + inline sidecar only | No writer touches skill/MEMORY source or the working tree; only the audit dict + inline sidecar JSONL (logs) |
| Mutates live, replaces learning | **Feeds** via a distinct sidecar; `--all` stays curator | `origin:"inline"` sidecar with its own schema; never writes canonical `candidates.jsonl`; flock-guarded idempotent append distinct from `cmd_extract` |

## 6. Test Strategy (golden-flow shape)

1. **Off-path byte-identity** — `run_judge` with flag off → `to_dict()` **byte-identical** to baseline (key omitted, not `[]`); persisted `FlowState` JSON byte-identical (key omitted); no sidecar write. (Contract-level regression, the load-bearing test.)
2. **Heuristic classification table** — table-driven over `(predicate_type, verdict, reason)` → expected `FixTarget`; assert only `judged`-failures yield `durable` candidates; `transient`/`step-local` produce no `PatchCandidate`.
3. **Candidate construction** — a `judged` must-fix → one `PatchCandidate` with `target_kind/patch_type/rationale/suggested_change` populated, `target_path == ".claude/memory/MEMORY.md"` by default, no literal diff.
4. **Audit surfacing** — enabled flow with a durable candidate → `stratum_audit` returns `learn_inline:{evaluated,durable}` + `staged_patch_candidates`; enabled flow that classified only non-durable → `learn_inline` present with `durable:0`, `staged_patch_candidates` absent; disabled → both keys absent.
5. **Sidecar idempotency + turn-scoping** — `append_inline_candidates` twice with same `(flow_id, step_id, predicate_id, turn)` → second writes 0; **different turns → distinct rows** (not collapsed); canonical `candidates.jsonl` never touched; sidecar carries `origin:"inline"` and no `label`.
6. **Concurrent append** — two appends racing under `flock` → no lost/duplicated rows.
7. **LLM-classifier fail-open** — `classifier="llm"` with the LLM raising → falls back to heuristic, no crash.

Per-directory runs (`tests/` and `stratum-mcp/tests/` separately), pytest + `@pytest.mark.asyncio`, real sidecar file in `tmp_path`.

## 7. Follow-ups (filed, not built in v1)

- `STRAT-LEARN-INLINE-ENSURE` — extend the trigger to the executor `ensure`-failure path (requires structuring `violations: list[str]` into a diagnosis first).
- `STRAT-LEARN-INLINE-CORRECTION` — inline user-correction trigger (lift `signals.py` patterns into the live loop).
- `STRAT-LEARN-INLINE-APPLY` — opt-in literal old→new synthesis + a guarded apply path (would graduate D2).

## 8. Deviations from the roadmap row (honest log)

- Row says triggers = "postcondition fails / `run_judge` must-fix / user correction." **v1 ships `run_judge` must-fix only** — the other two have no structured-diagnosis substrate today; filed as follow-ups (§7). The row's "the kernel already emits a diagnosis" is literally true *only* for the judge path.
- Row says patch shapes `create / patch (old→new) / edit`. **v1 emits the *intended operation* as metadata, not an applyable string** (D2); the operation enum is preserved so D2 can graduate without a schema break.
- Config key: row names `learn.inline_patch.enabled`; realized as TOML `[learn.inline_patch] enabled` + env `STRATUM_LEARN_INLINE_PATCH_ENABLED`.
- Row says inline "feeds the STRAT-JUDGE-POSTMORTEM corpus as a high-signal pre-scored entry." **Realized as a distinct inline sidecar** (`.stratum/postmortem/inline_candidates.jsonl`), not a row in the transcript-shaped `candidates.jsonl` — the transcript corpus's readers and its `label` ground-truth contract can't safely absorb a synthetic non-transcript row. The sidecar is still "feeding": a curator/`--all`/replay follow-up promotes reviewed entries into the canonical corpus. (Design-gate finding, 2026-06-08.)
- Byte-identity is achieved by **omitting** the new `JudgeResult`/`FlowState` keys when empty, not defaulting them to `[]` (a defaulted `[]` would change serialized bytes against the current fixed-shape serializers). (Design-gate finding, 2026-06-08.)
