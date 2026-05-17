"""Replay harness (STRAT-JUDGE-POSTMORTEM v2.2 #4).

Run a *faithful subset* of the judge stack against each corpus candidate at
moment-of-claim and score per-tier false-met / false-not-met against the
v1.1 ground-truth label.

Fidelity is routed by the kernel's REAL predicate taxonomy so per-tier
counts correspond to the shipped judge:

  * deterministic → T1 if decidable from the transcript record alone,
    else `unreplayable` (no live FS in replay — never silently promoted).
  * judged        → T2 (litellm judge over transcript evidence).
  * verified      → T2 iff the evidence is literally in the transcript
    (post_claim / work tools); else `unreplayable`.

A `verified` fact decided by the T2 judge records deciding_tier **T2**,
never T1 — replay does not relabel a convenient fact as deterministic.

Honest limits (made mechanical):
  * Zero predicates (decompose fail-open) → scored=False,
    reason="no_predicates". NEVER `all([]) → true_met` (that vacuous
    truth is exactly why the live kernel raises EmptyPredicateListError).
  * 20% holdout by sha1(candidate_id) — process-stable, NOT Python hash().
    At n≈11 the ~2-record holdout is SMOKE COVERAGE ONLY, not validation;
    the scorecard says so in-band.
"""

from __future__ import annotations

import hashlib
import json
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Literal, Protocol, runtime_checkable

import litellm

from stratum.judge.postmortem.decompose import LiteLLMDecomposer
from stratum.judge.result import Predicate

SCORECARD_SCHEMA_VERSION = "1.0"
DEFAULT_REPLAY_MODEL = "claude-haiku-4-5"
DEFAULT_OUT = Path(".stratum/postmortem/candidates.jsonl")
SCORECARD_OUT = Path(".stratum/postmortem/replay-scorecard.json")

Tier = Literal["T1", "T2", "unreplayable"]
Verdict = Literal["met", "not_met", "ambiguous", "n/a"]


@dataclass
class ReplayPredicateResult:
    predicate_id: str
    deciding_tier: Tier
    verdict: Verdict
    confidence: float
    reason: str


@dataclass
class ReplayCandidateResult:
    candidate_id: str
    ground_label: str
    predicted_label: str | None
    split: Literal["train", "holdout"]
    predicate_results: list[ReplayPredicateResult]
    scored: bool
    reason: str = ""  # "", "no_predicates", "all_unreplayable"


@dataclass
class ReplayScorecard:
    schema_version: str = SCORECARD_SCHEMA_VERSION
    n_candidates: int = 0
    n_scored: int = 0          # precision-eligible, EXCLUDES abstentions
    n_abstained: int = 0       # predicted ambiguous on non-ambiguous ground
    n_unreplayable: int = 0    # all-unreplayable candidates
    n_no_predicates: int = 0
    coverage: float = 0.0      # n_scored / (n_scored + n_abstained)
    false_met: int = 0
    false_not_met: int = 0
    by_tier: dict = field(default_factory=dict)
    train: dict = field(default_factory=dict)
    holdout: dict = field(default_factory=dict)
    holdout_caveat: str = ""


@runtime_checkable
class ReplayJudge(Protocol):
    def judge(
        self, statement: str, request_text: str, claim_text: str, work_summary: str
    ) -> tuple[Verdict, float, str]: ...


# --- holdout / routing -------------------------------------------------------

def _holdout(candidate_id: str) -> bool:
    """Deterministic, process-stable ~20% split (NOT Python hash())."""
    h = int(hashlib.sha1(candidate_id.encode()).hexdigest(), 16)
    return h % 5 == 0


def _work_summary(record: dict[str, Any]) -> str:
    tools = record.get("work_tool_uses") or []
    names = [t.get("name") for t in tools if isinstance(t, dict) and t.get("name")]
    return ", ".join(names[:50]) if names else "(no tool activity)"


def _tool_names(record: dict[str, Any]) -> set[str]:
    """Tools that ran BEFORE the completion claim (work span only).

    Moment-of-claim contract: post-claim tool activity must NOT decide a
    "did tool X run" predicate — that would judge with evidence the agent
    did not have when it claimed done.
    """
    out: set[str] = set()
    for t in record.get("work_tool_uses") or []:
        if isinstance(t, dict) and t.get("name"):
            out.add(str(t["name"]).lower())
    return out


def _t1_eval(pred: Predicate, record: dict[str, Any]) -> ReplayPredicateResult | None:
    """Deterministic predicates decidable from the transcript alone.

    The only honest transcript-deterministic check: the statement names a
    tool, and we can see whether that tool ran. Anything needing live FS
    state returns None → router marks it unreplayable.
    """
    if pred.type != "deterministic":
        return None
    stmt = pred.statement.lower()
    # Only "did tool X run" is transcript-deterministic. Anything about a
    # tool's RESULT/OUTPUT/exit/content needs evidence the transcript does
    # not carry — those are not T1 (→ None → unreplayable).
    _RESULT_WORDS = (
        "exit", "output", "contains", "return", "pass", "fail", "equal",
        "status", "code", "stdout", "stderr", "==", "result", "content",
        "value", "count", "match",
    )
    if any(w in stmt for w in _RESULT_WORDS):
        return None
    _RAN_WORDS = ("ran", "was run", "was used", "invoked", "called", "executed")
    if not any(w in stmt for w in _RAN_WORDS):
        return None
    names = _tool_names(record)
    for tool in ("edit", "write", "bash", "read", "grep", "glob"):
        if tool in stmt:
            ran = tool in names
            return ReplayPredicateResult(
                predicate_id=pred.id,
                deciding_tier="T1",
                verdict="met" if ran else "not_met",
                confidence=1.0,
                reason=f"transcript-deterministic: tool '{tool}' {'ran' if ran else 'absent'}",
            )
    return None  # not transcript-decidable → unreplayable


def _route_and_eval(
    pred: Predicate, record: dict[str, Any], judge: ReplayJudge
) -> ReplayPredicateResult:
    if pred.type == "deterministic":
        t1 = _t1_eval(pred, record)
        if t1 is not None:
            return t1
        return ReplayPredicateResult(
            pred.id, "unreplayable", "n/a", 0.0,
            "deterministic predicate needs live FS state absent from transcript",
        )
    # judged → always T2. verified → T2 ONLY when the verification evidence
    # is literally transcript-resident: a tool_result event in the
    # post-claim window (that is the only place a "tests pass"/"endpoint
    # 200" style result actually appears). Tool *invocations* and a
    # non-empty claim are NOT evidence. Otherwise → unreplayable.
    if pred.type == "verified":
        has_tool_result = any(
            isinstance(ev, dict) and ev.get("kind") == "tool_result"
            for ev in (record.get("post_claim_events") or [])
        )
        if not has_tool_result:
            return ReplayPredicateResult(
                pred.id, "unreplayable", "n/a", 0.0,
                "verified predicate has no transcript-resident evidence "
                "(no post-claim tool_result)",
            )
    verdict, conf, reason = judge.judge(
        pred.statement,
        record.get("request_text", "") or "",
        record.get("claim_text", "") or "",
        _work_summary(record),
    )
    return ReplayPredicateResult(pred.id, "T2", verdict, conf, reason)


def _predicates_for(record: dict[str, Any], decomposer) -> list[Predicate]:
    raw = record.get("predicates")
    if isinstance(raw, list) and raw:
        out: list[Predicate] = []
        for p in raw:
            try:
                out.append(
                    Predicate(
                        id=str(p["id"]),
                        type=p["type"],
                        statement=str(p["statement"]),
                        applied_gate=int(p.get("applied_gate", 7)),
                    )
                )
            except Exception:  # noqa: BLE001 — skip malformed, decompose below
                continue
        if out:
            return out
    # decompose-on-the-fly (v1.1 corpus has no `predicates` key)
    res = decomposer.decompose(
        record.get("request_text", "") or "", _work_summary(record)
    )
    return list(res.predicates)


def replay_candidate(
    record: dict[str, Any], judge: ReplayJudge, decomposer
) -> ReplayCandidateResult:
    cid = record.get("candidate_id", "")
    ground = record.get("label", "ambiguous")
    split = "holdout" if _holdout(cid) else "train"
    preds = _predicates_for(record, decomposer)

    if not preds:
        return ReplayCandidateResult(
            cid, ground, None, split, [], scored=False, reason="no_predicates"
        )

    results = [_route_and_eval(p, record, judge) for p in preds]
    replayable = [r for r in results if r.deciding_tier != "unreplayable"]
    if not replayable:
        return ReplayCandidateResult(
            cid, ground, None, split, results, scored=False, reason="all_unreplayable"
        )

    if any(r.verdict == "not_met" for r in replayable):
        predicted = "false_met"   # judge would have caught it → ground should be false_met
    elif all(r.verdict == "met" for r in replayable):
        predicted = "true_met"
    else:
        predicted = "ambiguous"
    return ReplayCandidateResult(
        cid, ground, predicted, split, results, scored=True, reason=""
    )


# --- scoring -----------------------------------------------------------------

def _blank_split() -> dict:
    return {"n_scored": 0, "n_abstained": 0, "false_met": 0, "false_not_met": 0}


def score(results: list[ReplayCandidateResult]) -> ReplayScorecard:
    sc = ReplayScorecard(n_candidates=len(results))
    by_tier: dict[str, int] = {}
    splits = {"train": _blank_split(), "holdout": _blank_split()}

    for r in results:
        for pr in r.predicate_results:
            by_tier[pr.deciding_tier] = by_tier.get(pr.deciding_tier, 0) + 1
        if not r.scored:
            if r.reason == "no_predicates":
                sc.n_no_predicates += 1
            elif r.reason == "all_unreplayable":
                sc.n_unreplayable += 1
            continue
        if r.ground_label == "ambiguous":
            continue  # no trustworthy ground label
        s = splits[r.split]
        if r.predicted_label == "ambiguous":
            sc.n_abstained += 1
            s["n_abstained"] += 1
            continue
        sc.n_scored += 1
        s["n_scored"] += 1
        if r.ground_label == "false_met" and r.predicted_label == "true_met":
            sc.false_met += 1
            s["false_met"] += 1
        elif r.ground_label == "true_met" and r.predicted_label == "false_met":
            sc.false_not_met += 1
            s["false_not_met"] += 1

    denom = sc.n_scored + sc.n_abstained
    sc.coverage = (sc.n_scored / denom) if denom else 0.0
    sc.by_tier = by_tier
    sc.train, sc.holdout = splits["train"], splits["holdout"]
    n_hold = sum(1 for r in results if r.split == "holdout")
    sc.holdout_caveat = (
        f"holdout n={n_hold}: smoke coverage only, NOT statistically "
        "decision-useful at this size"
        if n_hold < 5
        else f"holdout n={n_hold}"
    )
    return sc


# --- litellm replay judge ----------------------------------------------------

class LiteLLMReplayJudge:
    """T2 judge over transcript evidence. Fail-open → ambiguous/0.0."""

    def __init__(self, model: str = DEFAULT_REPLAY_MODEL, max_tokens: int = 256,
                 timeout: float = 30.0) -> None:
        self.model = model
        self.max_tokens = max_tokens
        self.timeout = timeout

    def judge(
        self, statement: str, request_text: str, claim_text: str, work_summary: str
    ) -> tuple[Verdict, float, str]:
        prompt = (
            "You are a verifier judging ONE predicate using ONLY the "
            "transcript evidence below — no filesystem, no running code.\n\n"
            f"PREDICATE: {statement}\n\n"
            f"ORIGINAL REQUEST: {request_text[:1500]}\n\n"
            f"WORK PERFORMED (tools): {work_summary[:600]}\n\n"
            f"COMPLETION CLAIM: {claim_text[:1500]}\n\n"
            'Reply ONLY: {"verdict": "met"|"not_met"|"ambiguous", '
            '"confidence": 0.0-1.0, "reason": "<one sentence>"}'
        )
        try:
            resp = litellm.completion(
                model=self.model,
                messages=[{"role": "user", "content": prompt}],
                max_tokens=self.max_tokens,
                timeout=self.timeout,
            )
            content = resp["choices"][0]["message"]["content"]
            s = content.strip()
            if s.startswith("```"):
                s = s.split("\n", 1)[1] if "\n" in s else ""
                if s.rstrip().endswith("```"):
                    s = s.rstrip()[:-3]
            lo, hi = s.find("{"), s.rfind("}")
            obj = json.loads(s[lo : hi + 1])
            verdict = obj["verdict"]
            if verdict not in ("met", "not_met", "ambiguous"):
                raise ValueError(f"bad verdict {verdict!r}")
            conf = float(obj["confidence"])
            if not (0.0 <= conf <= 1.0):
                raise ValueError("confidence out of range")
            return verdict, conf, str(obj.get("reason", ""))[:200]
        except Exception as exc:  # noqa: BLE001 — fail-open
            return "ambiguous", 0.0, f"judge_error:{type(exc).__name__}"


# --- runner ------------------------------------------------------------------

def _read_candidates(in_path: Path):
    with in_path.open("r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                continue


def run_replay(
    in_path: Path, judge: ReplayJudge, decomposer, out_path: Path | None = None
) -> ReplayScorecard:
    results = [
        replay_candidate(rec, judge, decomposer) for rec in _read_candidates(in_path)
    ]
    sc = score(results)
    out = out_path or (in_path.parent / SCORECARD_OUT.name)
    out.parent.mkdir(parents=True, exist_ok=True)
    with out.open("w", encoding="utf-8") as fh:
        json.dump(
            {
                "scorecard": asdict(sc),
                "candidates": [asdict(r) for r in results],
            },
            fh,
            ensure_ascii=False,
            indent=2,
        )
    return sc
