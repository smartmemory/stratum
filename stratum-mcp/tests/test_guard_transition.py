"""Tests for STRAT-GUARD transition orchestration (S4).

Golden flow: register -> transition (evidence met -> applied) -> history.
Plus every guarantee: refused, illegal edge, stale from_state, tamper, idempotent
replay/conflict, override (token), migrate (immutability + version bump),
paranoid-edge-needs-trusted-evidence, command opt-in.
"""

import asyncio
import json
import os
import sys
from contextlib import asynccontextmanager

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "src"))

from stratum_mcp.guard import store, transition as tr
from stratum_mcp.guard.errors import (
    CommandExecutionDisabled,
    EvidenceParseError,
    GuardAlreadyRegistered,
    GuardEngineOwned,
    GuardNotFound,
    GuardTampered,
    IdempotencyConflict,
    IllegalEdge,
    InvalidStateName,
    OverrideUnavailable,
    ParanoidEdgeNeedsTrustedEvidence,
    StaleFromState,
)


def _run(coro):
    return asyncio.run(coro)


@pytest.fixture
def guards_dir(tmp_path, monkeypatch):
    monkeypatch.setattr(store, "GUARDS_DIR", tmp_path / "guards")
    store._locks.clear()
    yield tmp_path / "guards"
    store._locks.clear()


def _register_simple(rid, workspace, **kw):
    return _run(
        tr.register_guard(
            resource_id=rid,
            graph={"draft": ["shipped"], "shipped": []},
            edge_predicates={
                "draft->shipped": [
                    {"id": "p1", "type": "deterministic", "statement": "server_file_exists('design.md')"}
                ]
            },
            initial="draft",
            terminal=["shipped"],
            workspace_root=str(workspace),
            **kw,
        )
    )


# ---- golden flow ---------------------------------------------------------- #


def test_golden_flow_applied(guards_dir, tmp_path):
    ws = tmp_path / "ws"
    ws.mkdir()
    (ws / "design.md").write_text("design")
    out = _register_simple("compose:FEAT-1", ws)
    assert out["status"] == "registered"

    res = _run(tr.guard_transition("compose:FEAT-1", "draft", "shipped"))
    assert res["status"] == "applied"
    assert res["current_state"] == "shipped"
    assert res["verdict"]["clean"] is True
    assert res["ledger_ref"]

    hist = tr.guard_history("compose:FEAT-1")
    assert hist["current_state"] == "shipped"
    assert len(hist["ledger"]) == 1
    assert hist["ledger"][0]["outcome"] == "applied"


def test_transition_refused_when_evidence_missing(guards_dir, tmp_path):
    ws = tmp_path / "ws"
    ws.mkdir()  # no design.md
    _register_simple("r", ws)
    res = _run(tr.guard_transition("r", "draft", "shipped"))
    assert res["status"] == "refused"
    assert res["current_state"] == "draft"  # unchanged
    assert res["verdict"]["clean"] is False
    # refused transition is STILL recorded in the ledger
    assert len(tr.guard_history("r")["ledger"]) == 1


# ---- structural guards ---------------------------------------------------- #


def test_illegal_edge(guards_dir, tmp_path):
    ws = tmp_path / "ws"; ws.mkdir(); (ws / "design.md").write_text("x")
    _register_simple("r", ws)
    with pytest.raises(IllegalEdge):
        _run(tr.guard_transition("r", "draft", "draft"))


def test_stale_from_state(guards_dir, tmp_path):
    ws = tmp_path / "ws"; ws.mkdir(); (ws / "design.md").write_text("x")
    _register_simple("r", ws)
    with pytest.raises(StaleFromState):
        _run(tr.guard_transition("r", "shipped", "draft"))


def test_guard_not_found(guards_dir):
    with pytest.raises(GuardNotFound):
        _run(tr.guard_transition("nope", "a", "b"))


def test_tamper_detected(guards_dir, tmp_path):
    ws = tmp_path / "ws"; ws.mkdir(); (ws / "design.md").write_text("x")
    _register_simple("r", ws)
    # weaken the policy on disk without recomputing checksum honestly
    path = store.resource_dir("r") / "registry.json"
    payload = json.loads(path.read_text())
    payload["edge_predicates"]["draft->shipped"] = []  # drop the predicate
    path.write_text(json.dumps(payload))
    with pytest.raises(GuardTampered):
        _run(tr.guard_transition("r", "draft", "shipped"))


# ---- idempotency ---------------------------------------------------------- #


def test_idempotent_replay(guards_dir, tmp_path):
    ws = tmp_path / "ws"; ws.mkdir(); (ws / "design.md").write_text("x")
    _register_simple("r", ws)
    r1 = _run(tr.guard_transition("r", "draft", "shipped", idempotency_key="k1"))
    r2 = _run(tr.guard_transition("r", "draft", "shipped", idempotency_key="k1"))
    assert r1["status"] == "applied"
    assert r2["status"] == "replayed"
    assert r2["ledger_ref"] == r1["ledger_ref"]
    # only one real transition recorded
    assert len(tr.guard_history("r")["ledger"]) == 1


def test_idempotency_conflict(guards_dir, tmp_path):
    ws = tmp_path / "ws"; ws.mkdir(); (ws / "design.md").write_text("x")
    _register_simple("r", ws)
    _run(tr.guard_transition("r", "draft", "shipped", idempotency_key="k1"))
    with pytest.raises(IdempotencyConflict):
        # same key, different payload (different to_state target via artifacts)
        _run(tr.guard_transition("r", "draft", "shipped", idempotency_key="k1", artifacts={"x": "different"}))


# ---- registration immutability ------------------------------------------- #


def test_reregister_identical_is_noop(guards_dir, tmp_path):
    ws = tmp_path / "ws"; ws.mkdir(); (ws / "design.md").write_text("x")
    _register_simple("r", ws)
    out = _register_simple("r", ws)
    assert out["status"] == "exists"


def test_reregister_different_rejected(guards_dir, tmp_path):
    ws = tmp_path / "ws"; ws.mkdir(); (ws / "design.md").write_text("x")
    _register_simple("r", ws)
    with pytest.raises(GuardAlreadyRegistered):
        _run(tr.register_guard(
            resource_id="r",
            graph={"draft": ["shipped"], "shipped": []},
            edge_predicates={"draft->shipped": []},  # weakened
            initial="draft",
            terminal=["shipped"],
            workspace_root=str(ws),
        ))


# ---- policy validation ---------------------------------------------------- #


def test_invalid_state_name_rejected(guards_dir, tmp_path):
    ws = tmp_path / "ws"; ws.mkdir()
    with pytest.raises(InvalidStateName):
        _run(tr.register_guard(
            resource_id="r",
            graph={"a/b": ["c"], "c": []},
            edge_predicates={},
            initial="a/b",
            workspace_root=str(ws),
        ))


def test_paranoid_edge_requires_trusted_evidence(guards_dir, tmp_path):
    ws = tmp_path / "ws"; ws.mkdir()
    with pytest.raises(ParanoidEdgeNeedsTrustedEvidence):
        _run(tr.register_guard(
            resource_id="r",
            graph={"a": ["b"], "b": []},
            edge_predicates={"a->b": [{"id": "p", "type": "judged", "statement": "is the design coherent?"}]},
            initial="a",
            stakes={"a->b": "paranoid"},
            workspace_root=str(ws),
        ))


def test_malformed_deterministic_predicate_rejected(guards_dir, tmp_path):
    """A typo'd trusted builtin in a deterministic predicate must fail closed at
    registration, not silently fall through to the LLM path (Codex finding-4)."""
    ws = tmp_path / "ws"; ws.mkdir()
    with pytest.raises(EvidenceParseError):
        _run(tr.register_guard(
            resource_id="r",
            graph={"a": ["b"], "b": []},
            edge_predicates={"a->b": [{"id": "p", "type": "deterministic", "statement": "server_file_exist('x')"}]},
            initial="a",
            workspace_root=str(ws),
        ))


def test_unknown_predicate_type_rejected(guards_dir, tmp_path):
    ws = tmp_path / "ws"; ws.mkdir()
    with pytest.raises(EvidenceParseError):
        _run(tr.register_guard(
            resource_id="r",
            graph={"a": ["b"], "b": []},
            edge_predicates={"a->b": [{"id": "p", "type": "bogus", "statement": "x"}]},
            initial="a",
            workspace_root=str(ws),
        ))


def test_command_predicate_requires_optin(guards_dir, tmp_path, monkeypatch):
    monkeypatch.delenv("STRATUM_GUARD_ALLOW_COMMANDS", raising=False)
    ws = tmp_path / "ws"; ws.mkdir()
    with pytest.raises(CommandExecutionDisabled):
        _run(tr.register_guard(
            resource_id="r",
            graph={"a": ["b"], "b": []},
            edge_predicates={"a->b": [{"id": "p", "statement": "command_exit_zero(['true'])"}]},
            initial="a",
            workspace_root=str(ws),
        ))


# ---- override ------------------------------------------------------------- #


def test_override_unavailable_without_env(guards_dir, tmp_path, monkeypatch):
    monkeypatch.delenv("STRATUM_GUARD_OVERRIDE_TOKEN", raising=False)
    ws = tmp_path / "ws"; ws.mkdir()
    _register_simple("r", ws)
    with pytest.raises(OverrideUnavailable):
        _run(tr.guard_override("r", "draft", "shipped", "tok", "because"))


def test_override_applies_with_token(guards_dir, tmp_path, monkeypatch):
    monkeypatch.setenv("STRATUM_GUARD_OVERRIDE_TOKEN", "secret")
    ws = tmp_path / "ws"; ws.mkdir()  # no design.md -> evidence would fail
    _register_simple("r", ws)
    res = _run(tr.guard_override("r", "draft", "shipped", "secret", "manual ship", resolved_by="human"))
    assert res["status"] == "deviation"
    assert res["current_state"] == "shipped"
    hist = tr.guard_history("r")
    assert hist["ledger"][-1]["kind"] == "deviation"
    assert hist["ledger"][-1]["rationale"] == "manual ship"


def test_override_wrong_token(guards_dir, tmp_path, monkeypatch):
    monkeypatch.setenv("STRATUM_GUARD_OVERRIDE_TOKEN", "secret")
    ws = tmp_path / "ws"; ws.mkdir()
    _register_simple("r", ws)
    with pytest.raises(OverrideUnavailable):
        _run(tr.guard_override("r", "draft", "shipped", "wrong", "x", resolved_by="human"))


# ---- migrate -------------------------------------------------------------- #


def test_migrate_bumps_version(guards_dir, tmp_path, monkeypatch):
    monkeypatch.setenv("STRATUM_GUARD_OVERRIDE_TOKEN", "secret")
    ws = tmp_path / "ws"; ws.mkdir(); (ws / "design.md").write_text("x")
    _register_simple("r", ws)
    res = _run(
        tr.guard_migrate(
            "r",
            new_graph={"draft": ["review", "shipped"], "review": ["shipped"], "shipped": []},
            new_edge_predicates={"draft->shipped": [{"id": "p1", "statement": "server_file_exists('design.md')"}]},
            override_token="secret",
            rationale="add review phase",
            new_terminal=["shipped"],
        )
    )
    assert res["graph_version"] == 2
    hist = tr.guard_history("r")
    assert hist["graph_version"] == 2
    assert hist["ledger"][-1]["outcome"] == "graph_version"
    # new edge now usable
    res2 = _run(tr.guard_transition("r", "draft", "review"))
    assert res2["status"] == "applied"


def test_migrate_requires_token(guards_dir, tmp_path, monkeypatch):
    monkeypatch.delenv("STRATUM_GUARD_OVERRIDE_TOKEN", raising=False)
    ws = tmp_path / "ws"; ws.mkdir(); (ws / "design.md").write_text("x")
    _register_simple("r", ws)
    with pytest.raises(OverrideUnavailable):
        _run(tr.guard_migrate("r", {"draft": [], }, {}, "tok", "x"))


# ---- engine handoff / ownership ------------------------------------------ #


def test_handoff_refuses_all_python_mutations_but_allows_reads(
    guards_dir, tmp_path, monkeypatch
):
    monkeypatch.setenv("STRATUM_GUARD_OVERRIDE_TOKEN", "secret")
    ws = tmp_path / "ws"; ws.mkdir(); (ws / "design.md").write_text("x")
    _register_simple("r", ws)

    result = _run(tr.guard_handoff("r", "secret"))
    assert result == {"status": "handed_off", "resource_id": "r", "owner": "ts"}
    marker = json.loads((store.resource_dir("r") / "engine.json").read_text())
    assert marker["owner"] == "ts"
    assert marker["since"]

    with pytest.raises(GuardEngineOwned):
        _run(tr.guard_transition("r", "draft", "shipped"))
    with pytest.raises(GuardEngineOwned):
        _run(
            tr.guard_override(
                "r", "draft", "shipped", "secret", "manual", resolved_by="human"
            )
        )
    with pytest.raises(GuardEngineOwned):
        _run(
            tr.guard_migrate(
                "r",
                {"draft": ["shipped"], "shipped": []},
                {},
                "secret",
                "policy update",
                new_terminal=["shipped"],
            )
        )
    with pytest.raises(GuardEngineOwned):
        _register_simple("r", ws)

    assert store.load_registry("r").current_state == "draft"
    assert tr.guard_history("r")["current_state"] == "draft"


def test_non_handed_off_resource_still_mutates(guards_dir, tmp_path):
    ws = tmp_path / "ws"; ws.mkdir(); (ws / "design.md").write_text("x")
    _register_simple("r", ws)
    assert not (store.resource_dir("r") / "engine.json").exists()
    assert _run(tr.guard_transition("r", "draft", "shipped"))["status"] == "applied"


def test_handoff_token_gate_not_found_and_idempotency(
    guards_dir, tmp_path, monkeypatch
):
    ws = tmp_path / "ws"; ws.mkdir()
    _register_simple("r", ws)

    monkeypatch.delenv("STRATUM_GUARD_OVERRIDE_TOKEN", raising=False)
    with pytest.raises(OverrideUnavailable):
        _run(tr.guard_handoff("r", "secret"))

    monkeypatch.setenv("STRATUM_GUARD_OVERRIDE_TOKEN", "secret")
    with pytest.raises(OverrideUnavailable):
        _run(tr.guard_handoff("r", "wrong"))
    with pytest.raises(GuardNotFound):
        _run(tr.guard_handoff("missing", "secret"))

    first = _run(tr.guard_handoff("r", "secret"))
    marker_path = store.resource_dir("r") / "engine.json"
    marker_before = marker_path.read_text()
    second = _run(tr.guard_handoff("r", "secret"))
    assert first == second
    assert marker_path.read_text() == marker_before


def test_handoff_waits_for_inflight_transition_commit_lock(
    guards_dir, tmp_path, monkeypatch
):
    monkeypatch.setenv("STRATUM_GUARD_OVERRIDE_TOKEN", "secret")
    ws = tmp_path / "ws"; ws.mkdir(); (ws / "design.md").write_text("x")
    _register_simple("r", ws)
    real_resource_lock = store.resource_lock

    async def main():
        commit_locked = asyncio.Event()
        release_commit = asyncio.Event()
        transition_acquisitions = 0

        @asynccontextmanager
        async def observed_resource_lock(resource_id):
            nonlocal transition_acquisitions
            async with real_resource_lock(resource_id):
                task = asyncio.current_task()
                if task is not None and task.get_name() == "transition":
                    transition_acquisitions += 1
                    if transition_acquisitions == 2:
                        commit_locked.set()
                        await release_commit.wait()
                yield

        monkeypatch.setattr(store, "resource_lock", observed_resource_lock)
        transition_task = asyncio.create_task(
            tr.guard_transition("r", "draft", "shipped"), name="transition"
        )
        await commit_locked.wait()
        handoff_task = asyncio.create_task(tr.guard_handoff("r", "secret"))
        await asyncio.sleep(0)
        assert not handoff_task.done()

        release_commit.set()
        assert (await transition_task)["status"] == "applied"
        assert (await handoff_task)["status"] == "handed_off"
        with pytest.raises(GuardEngineOwned):
            await tr.guard_transition("r", "shipped", "shipped")

    _run(main())


def test_handoff_during_transition_evaluation_blocks_commit(
    guards_dir, tmp_path, monkeypatch
):
    monkeypatch.setenv("STRATUM_GUARD_OVERRIDE_TOKEN", "secret")
    ws = tmp_path / "ws"; ws.mkdir(); (ws / "design.md").write_text("x")
    _register_simple("r", ws)
    real_evaluate = tr.ev.evaluate_evidence

    async def main():
        evaluation_started = asyncio.Event()
        release_evaluation = asyncio.Event()

        async def paused_evaluate(*args, **kwargs):
            evaluation_started.set()
            await release_evaluation.wait()
            return await real_evaluate(*args, **kwargs)

        monkeypatch.setattr(tr.ev, "evaluate_evidence", paused_evaluate)
        transition_task = asyncio.create_task(
            tr.guard_transition("r", "draft", "shipped")
        )
        await evaluation_started.wait()
        assert (await tr.guard_handoff("r", "secret"))["status"] == "handed_off"
        release_evaluation.set()
        with pytest.raises(GuardEngineOwned):
            await transition_task
        assert tr.guard_history("r")["ledger"] == []

    _run(main())


# ---- LLM-tier path (mocked verifier) -------------------------------------- #


def test_llm_tier_edge_uses_run_judge(guards_dir, tmp_path, monkeypatch):
    """An edge with a non-trusted (judged) predicate routes to run_judge; we mock
    the agent so T2 returns met, and confirm combined met requires evidence too."""
    from stratum.judge import staging

    monkeypatch.setattr(staging, "JUDGE_ROOT", tmp_path / "judge")
    ws = tmp_path / "ws"; ws.mkdir(); (ws / "design.md").write_text("x")
    _run(tr.register_guard(
        resource_id="r",
        graph={"a": ["b"], "b": []},
        edge_predicates={
            "a->b": [
                {"id": "t", "type": "deterministic", "statement": "server_file_exists('design.md')"},
                {"id": "j", "type": "verified", "statement": "the design covers error handling"},
            ]
        },
        initial="a",
        stakes={"a->b": "default"},
        workspace_root=str(ws),
    ))

    from unittest.mock import AsyncMock

    # _t2 verifier response: met with high confidence
    agent = AsyncMock(
        return_value=json.dumps(
            {"verdict": "met", "confidence": 9, "reason": "covers it", "evidence": []}
        )
    )

    class _Ctx:
        async def report_progress(self, *a, **k):
            pass

    res = _run(
        tr.guard_transition(
            "r", "a", "b", artifacts={"design": "x"}, stratum_agent_run=agent, ctx=_Ctx()
        )
    )
    assert res["status"] == "applied"
    assert res["verdict"]["met"] is True
    # both the evidence predicate and the judged predicate appear
    assert len(res["verdict"]["predicates"]) >= 2


# ---- concurrency (Codex finding-1, finding-3, finding-5) ------------------ #


def test_concurrent_same_key_applies_once(guards_dir, tmp_path):
    """Two concurrent same-key/same-payload transitions: exactly one applied, one
    replayed; exactly one ledger entry (the phase-3 idempotency re-check)."""
    ws = tmp_path / "ws"; ws.mkdir(); (ws / "design.md").write_text("x")
    _register_simple("r", ws)

    async def main():
        return await asyncio.gather(
            tr.guard_transition("r", "draft", "shipped", idempotency_key="k"),
            tr.guard_transition("r", "draft", "shipped", idempotency_key="k"),
        )

    results = _run(main())
    statuses = sorted(r["status"] for r in results)
    assert statuses == ["applied", "replayed"]
    assert len(tr.guard_history("r")["ledger"]) == 1
    assert tr.guard_history("r")["current_state"] == "shipped"


def test_concurrent_first_registration_one_wins(guards_dir, tmp_path):
    """Two concurrent first-time registrations with identical policy: one
    'registered', one 'exists'; exactly one resource dir (the register lock)."""
    ws = tmp_path / "ws"; ws.mkdir(); (ws / "design.md").write_text("x")

    def reg():
        return tr.register_guard(
            resource_id="r",
            graph={"draft": ["shipped"], "shipped": []},
            edge_predicates={
                "draft->shipped": [
                    {"id": "p1", "type": "deterministic", "statement": "server_file_exists('design.md')"}
                ]
            },
            initial="draft",
            terminal=["shipped"],
            workspace_root=str(ws),
        )

    async def main():
        return await asyncio.gather(reg(), reg())

    results = _run(main())
    statuses = sorted(r["status"] for r in results)
    assert statuses == ["exists", "registered"]
    assert len(list(guards_dir.iterdir())) == 1


def test_refused_records_true_target(guards_dir, tmp_path):
    """A refused transition records the attempted to_state in the ledger (audit
    fidelity, Codex finding-2), while current_state stays put."""
    ws = tmp_path / "ws"; ws.mkdir()  # no design.md
    _register_simple("r", ws)
    _run(tr.guard_transition("r", "draft", "shipped"))
    entry = tr.guard_history("r")["ledger"][-1]
    assert entry["outcome"] == "refused"
    assert entry["to_state"] == "shipped"  # true target preserved
    assert tr.guard_history("r")["current_state"] == "draft"


def test_replay_returns_original_verdict(guards_dir, tmp_path):
    """An idempotent replay returns the ORIGINAL stored verdict, not a synthesized
    empty one (Codex finding-2)."""
    ws = tmp_path / "ws"; ws.mkdir(); (ws / "design.md").write_text("x")
    _register_simple("r", ws)
    r1 = _run(tr.guard_transition("r", "draft", "shipped", idempotency_key="k"))
    r2 = _run(tr.guard_transition("r", "draft", "shipped", idempotency_key="k"))
    assert r2["status"] == "replayed"
    # original verdict carried its evidence predicates; the replay reflects them
    assert r2["verdict"]["predicates"] == r1["verdict"]["predicates"]
    assert r2["verdict"]["clean"] is True
