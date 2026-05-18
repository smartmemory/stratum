"""STRAT-JUDGE-T3-READJAIL-CODEXNEST — Docker non-nesting read-jail.

Unit tests (no daemon) cover the driver surface. The BLOCKING live gate
(`test_live_gate_*`, skipped — never passed — without Docker + an API key)
is the empirical reviewer: it runs a real `codex exec` model turn through
the *real connector path* and proves, /bin/cat-grade, that the container
namespace denies the sibling turns.jsonl and the host repo. Flipping
`sandbox._docker_readjail_verified()` is host-scoped; the live gate verifies it for real per host.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys

import pytest

sys.path.insert(
    0, os.path.join(os.path.dirname(__file__), "..", "stratum-mcp", "src")
)

from stratum.judge import sandbox  # noqa: E402
from stratum.judge.sandbox import (  # noqa: E402
    DockerJailDriver,
    JailUnavailableError,
    _rewrite_codex_args_for_container,
)

HAVE_DOCKER = shutil.which("docker") is not None
HAVE_OPENAI_KEY = bool(os.environ.get("OPENAI_API_KEY"))
LIVE = HAVE_DOCKER and HAVE_OPENAI_KEY


# ───────────────────────────── unit (no daemon) ─────────────────────────────

def test_rewrite_strips_sandbox_keeps_cwd():
    args = ["exec", "--json", "--sandbox", "read-only",
            "-m", "gpt-5.4", "-C", "/staged/turn-1", "-"]
    out = _rewrite_codex_args_for_container(args)
    assert "--sandbox" not in out and "read-only" not in out
    # -C is LEFT AS-IS: the staged tree is bind-mounted at that exact
    # absolute path :ro, so it is the adversary's evidence cwd.
    assert out[out.index("-C") + 1] == "/staged/turn-1"
    assert out[0] == "exec" and out[-1] == "-" and "--json" in out


def test_auth_env_only_passes_codex_relevant_keys():
    got = DockerJailDriver._auth_env(
        {"OPENAI_API_KEY": "sk", "CODEX_MODEL": "gpt-5.4",
         "FOO": "bar", "ANTHROPIC_API_KEY": "x", "OPENAI_API_KEY_EMPTY": ""}
    )
    assert got == {"OPENAI_API_KEY": "sk", "CODEX_MODEL": "gpt-5.4"}


def test_image_tag_is_deterministic_and_versioned(monkeypatch):
    t1 = sandbox._image_tag()
    assert t1.startswith("stratum-codexjail:") and len(t1.split(":")[1]) == 12
    assert t1 == sandbox._image_tag()
    monkeypatch.setattr(sandbox, "_PINNED_CODEX_VERSION", "9.9.9")
    assert sandbox._image_tag() != t1  # version bump → new tag → rebuild


def test_available_is_static_capability_only(monkeypatch):
    monkeypatch.setattr(sandbox.shutil, "which", lambda _: "/usr/bin/docker")
    monkeypatch.setattr(sandbox, "_docker_readjail_verified", lambda: False)
    assert DockerJailDriver().available() is False
    monkeypatch.setattr(sandbox, "_docker_readjail_verified", lambda: True)
    assert DockerJailDriver().available() is True
    monkeypatch.setattr(sandbox.shutil, "which", lambda _: None)
    assert DockerJailDriver().available() is False


def test_image_build_failure_raises_not_silent(monkeypatch):
    """Operational failure of a selected jail → JailUnavailableError
    (→ verifier codex_jailed_error), never a silent fallback or a
    public-image pull."""
    def fake_run(cmd, *a, **k):
        class R:
            returncode = 1 if cmd[:3] == ["docker", "build", "-t"] else 7
            stderr = "boom"
            stdout = ""
        return R()
    monkeypatch.setattr(sandbox.subprocess, "run", fake_run)
    with pytest.raises(JailUnavailableError):
        sandbox._ensure_image()


# ───────────────────────── BLOCKING live gate ──────────────────────────────

@pytest.mark.skipif(not LIVE, reason="requires Docker + OPENAI_API_KEY")
def test_live_gate_B_namespace_denies_sibling_and_repo(tmp_path):
    """(B) /bin/cat-grade DIRECT proof through the driver-produced mounts:
    inside the container the staged artifact reads OK, the sibling
    turns.jsonl and a host repo file are ABSENT (no-such-file). This is
    the cold-read boundary, proved at the namespace layer — not inferred
    from what a model chose to cite (the parent's exact rigor)."""
    flow = tmp_path / "flow"
    turn = flow / "step" / "turn-1"
    (turn / "artifacts").mkdir(parents=True)
    (turn / "artifacts" / "ok.txt").write_text("STAGED_EVIDENCE_OK")
    sibling = flow / "turns.jsonl"
    sibling.write_text("OTHER_PREDICATE_REASONING")
    repo_file = os.path.join(os.path.dirname(__file__), "test_judge_jail_docker.py")

    rr = os.path.realpath(str(turn))
    # Derive the isolation flags from the ACTUAL driver-produced argv so a
    # future second host bind in wrap_argv() is reflected here too (review
    # finding: don't hand-roll a minimal run that can't see a regression).
    drv = DockerJailDriver()
    argv = drv.wrap_argv(["exec", "-"], read_root=rr)
    img = argv[-4]  # … <tag> bash -lc <script>
    assert img.startswith("stratum-codexjail:")
    v_idxs = [i for i, a in enumerate(argv) if a == "-v"]
    assert len(v_idxs) == 1, f"driver emitted {len(v_idxs)} host binds, expected 1"
    binds = [argv[i + 1] for i in v_idxs]
    assert binds == [f"{rr}:{rr}:ro"], binds
    iso_flags = ["--rm", "--read-only"]
    for i, a in enumerate(argv):
        if a == "-v":
            iso_flags += ["-v", argv[i + 1]]
        elif a == "--tmpfs":
            iso_flags += ["--tmpfs", argv[i + 1]]
    probe = (
        f'echo S=$(cat "{rr}/artifacts/ok.txt" 2>&1); '
        f'echo SIB=$(cat "{os.path.realpath(str(sibling))}" 2>&1); '
        f'echo REPO=$(cat "{os.path.realpath(repo_file)}" 2>&1)'
    )
    run = subprocess.run(
        ["docker", "run", *iso_flags, "--entrypoint", "sh", img, "-c", probe],
        capture_output=True, text=True, timeout=120,
    )
    out = run.stdout
    assert "S=STAGED_EVIDENCE_OK" in out, run.stderr
    assert "OTHER_PREDICATE_REASONING" not in out  # sibling unreadable
    assert "SIB=" in out and "No such file" in out.split("SIB=")[1].split("REPO=")[0]
    assert "REPO=" in out and "No such file" in out.split("REPO=")[1]


@pytest.mark.skipif(not LIVE, reason="requires Docker + OPENAI_API_KEY")
def test_live_gate_A_real_model_turn_through_connector(tmp_path, monkeypatch):
    """(A) A real `codex exec` model turn through the REAL connector path
    (factory → CodexConnector._build_codex_cmd → DockerJailDriver), jailed
    to the staged tree, produces a real verdict that cites the planted
    artifact. Not a hand-rolled `docker run` — the shipped seam."""
    import asyncio

    monkeypatch.setattr(sandbox, "_docker_readjail_verified", lambda: True)
    from stratum_mcp.connectors.factory import make_agent_connector

    turn = tmp_path / "flow" / "step" / "turn-1"
    (turn / "artifacts").mkdir(parents=True)
    (turn / "artifacts" / "claim.txt").write_text(
        "PLANTED_FACT: the sky token is HELIOTROPE-42."
    )
    rr = os.path.realpath(str(turn))

    conn = make_agent_connector("codex", "gpt-5.4", rr, read_jail=rr)
    prompt = (
        "Read every file under the directory you are started in. Reply with "
        "exactly the sky token value you find in claim.txt, nothing else."
    )

    async def _drive():
        chunks = []
        async for ev in conn.run(prompt):
            t = ev.get("type")
            if t in ("assistant", "result"):
                chunks.append(ev.get("content") or "")
            elif t == "error":
                raise AssertionError(f"jailed codex errored: {ev.get('message')}")
        return "".join(chunks)

    text = asyncio.run(asyncio.wait_for(_drive(), timeout=600))
    assert "HELIOTROPE-42" in text, f"jailed codex did not cite staged artifact: {text!r}"
