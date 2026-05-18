"""STRAT-JUDGE-T3-READJAIL — connector wiring + the load-bearing OS proof.

The OS-enforcement test executes the *profile the connector actually
generates* via `sandbox-exec` wrapping `/bin/cat`, and asserts a sibling
/ repo read is denied while the staged tree is readable. That is the
exact claim the parent feature could not make — proved at the OS layer,
not an adjacent fact.
"""

from __future__ import annotations

import asyncio
import os
import subprocess
import sys

import pytest

sys.path.insert(
    0,
    os.path.join(os.path.dirname(__file__), "..", "stratum-mcp", "src"),
)

from stratum.judge import sandbox  # noqa: E402
from stratum.judge.sandbox import (  # noqa: E402
    DockerJailDriver,
    SandboxExecJailDriver,
)
from stratum_mcp.connectors.codex import CodexConnector  # noqa: E402
from stratum_mcp.connectors.factory import make_agent_connector  # noqa: E402

DARWIN = sys.platform == "darwin"
HAVE_SBX = DARWIN and os.path.exists("/usr/bin/sandbox-exec")


def test_factory_threads_read_jail_to_codex():
    c = make_agent_connector("codex", "gpt-5.4", "/tmp", read_jail="/some/jail")
    assert isinstance(c, CodexConnector)
    assert c._read_jail == "/some/jail"


def test_factory_codex_default_no_jail():
    c = make_agent_connector("codex", "gpt-5.4", "/tmp")
    assert c._read_jail is None


def test_factory_claude_ignores_read_jail():
    # read_jail is codex-only by construction (claude runs in-process).
    c = make_agent_connector("claude", None, "/tmp", read_jail="/x")
    assert type(c).__name__ == "ClaudeConnector"


def test_build_cmd_no_jail_is_unchanged():
    c = CodexConnector(model_id="gpt-5.4")
    assert c._build_codex_cmd(["exec", "-"]) == ["codex", "exec", "-"]
    assert c._jail_profile is None


# ── STRAT-JUDGE-T3-READJAIL-CODEXNEST: the connector seam is now driver-
# dispatched. The Seatbelt-shape invariant is asserted by INJECTING the
# (inert, retained) SandboxExecJailDriver — verbatim shape, incl. the
# load-bearing `--ephemeral`-after-`exec` ordering. A DockerJailDriver
# analog asserts the live path's shape: one `codex` token (no double),
# `--ephemeral`+bypass after `exec`, `--sandbox` stripped, `-C` repointed.


def test_build_cmd_with_seatbelt_driver_wraps_and_adds_ephemeral(tmp_path):
    jail = tmp_path / "turn-1"
    jail.mkdir()
    c = CodexConnector(
        model_id="gpt-5.4",
        read_jail=str(jail),
        jail_driver=SandboxExecJailDriver(),
    )
    cmd = c._build_codex_cmd(["exec", "--json", "-"])
    try:
        assert cmd[0] == "sandbox-exec"
        assert cmd[1] == "-f"
        profile = cmd[2]
        assert os.path.exists(profile)
        assert cmd[3] == "codex"
        # exactly one `codex` token (no double-token regression)
        assert cmd.count("codex") == 1
        # --ephemeral is an `exec` subcommand flag → must follow `exec`
        assert cmd[4] == "exec"
        assert cmd[5] == "--ephemeral"
        assert cmd[6:] == ["--json", "-"]
        assert os.path.realpath(str(jail)) in open(profile).read()
    finally:
        asyncio.run(c._cleanup_jail(None))
    assert not os.path.exists(profile)


def test_build_cmd_with_docker_driver_shape(tmp_path, monkeypatch):
    jail = tmp_path / "turn-1"
    jail.mkdir()
    # Don't touch a real docker daemon: stub the lazy image build.
    monkeypatch.setattr(sandbox, "_ensure_image", lambda: "stratum-codexjail:test")
    c = CodexConnector(
        model_id="gpt-5.4",
        read_jail=str(jail),
        jail_driver=DockerJailDriver(),
    )
    args = ["exec", "--json", "--sandbox", "read-only",
            "-m", "gpt-5.4", "-C", "/host/cwd", "-"]
    cmd = c._build_codex_cmd(args, {"OPENAI_API_KEY": "sk-test", "FOO": "bar"})
    try:
        assert cmd[0:5] == ["docker", "run", "--rm", "-i", "--read-only"]
        # staged tree mounted read-only; writable work tmpfs (not /tmp)
        rr = os.path.realpath(str(jail))
        assert "-v" in cmd and f"{rr}:{rr}:ro" in cmd
        assert "--tmpfs" in cmd and "/work:rw" in cmd
        # THE guarantee, locked: EXACTLY ONE host bind, it is the staged
        # tree, and it is read-only. A future second `-v` (a second
        # readable host path) must fail this.
        v_idxs = [i for i, a in enumerate(cmd) if a == "-v"]
        assert len(v_idxs) == 1, f"expected exactly one -v host bind, got {len(v_idxs)}"
        bind = cmd[v_idxs[0] + 1]
        assert bind == f"{rr}:{rr}:ro" and bind.endswith(":ro")
        # the only other mount is the writable tmpfs (not a host path)
        assert cmd.count("--tmpfs") == 1
        assert "--mount" not in cmd  # no alternate bind syntax sneaking a path in
        # only auth-relevant env injected, not arbitrary host env
        joined = " ".join(cmd)
        assert "OPENAI_API_KEY=sk-test" in joined
        assert "FOO=bar" not in joined
        assert "HOME=/work" in cmd and "CODEX_HOME=/work/.codex" in cmd
        # entrypoint is the login-then-exec shell script
        assert cmd[-3:-1] == ["bash", "-lc"]
        script = cmd[-1]
        assert "codex login --with-api-key" in script
        assert "exec codex exec" in script
        assert "--dangerously-bypass-approvals-and-sandbox" in script
        # no double-`codex` token regression (codex codex exec …)
        assert "codex codex" not in script
        # `--sandbox read-only` stripped; `-C` PRESERVED (staged tree is
        # bind-mounted at that exact path :ro — it is the evidence cwd)
        assert "--sandbox" not in script
        assert "-C /host/cwd" in script
        # driver must NOT inject --skip-git-repo-check (connector base
        # args already carry it; double-passing errors — live-gate bug)
        assert "--skip-git-repo-check" not in script
    finally:
        asyncio.run(c._cleanup_jail(None))


def test_cleanup_idempotent_and_safe_without_proc():
    c = CodexConnector(model_id="gpt-5.4")
    asyncio.run(c._cleanup_jail(None))  # no jail, must not raise
    asyncio.run(c._cleanup_jail(None))


@pytest.mark.skipif(not HAVE_SBX, reason="requires macOS sandbox-exec")
def test_generated_profile_enforces_read_jail_at_os_layer(tmp_path):
    """THE load-bearing test. Take the profile the connector generates and
    actually run a confined process under it: the staged tree is readable,
    the sibling turns.jsonl and a repo file are NOT.
    """
    flow = tmp_path / "flow"
    turn_dir = flow / "step" / "turn-1"
    (turn_dir / "artifacts").mkdir(parents=True)
    allowed = turn_dir / "artifacts" / "ok.txt"
    allowed.write_text("STAGED_EVIDENCE_OK")
    sibling = flow / "turns.jsonl"  # the side channel — outside turn_dir
    sibling.write_text("OTHER_PREDICATE_REASONING")

    # Retargeted: inject the (inert, retained) Seatbelt driver so the
    # connector seam yields a real `.sb` profile. The /bin/cat OS-
    # enforcement proof below runs BYTE-IDENTICAL to the parent — only the
    # wiring that hands it the profile path changed.
    c = CodexConnector(
        model_id="gpt-5.4",
        read_jail=str(turn_dir),
        jail_driver=SandboxExecJailDriver(),
    )
    cmd = c._build_codex_cmd(["exec"])
    assert cmd[0] == "sandbox-exec"
    profile = cmd[2]
    try:
        ok = subprocess.run(
            ["sandbox-exec", "-f", profile, "/bin/cat", str(allowed)],
            capture_output=True, text=True,
        )
        assert ok.returncode == 0, ok.stderr
        assert "STAGED_EVIDENCE_OK" in ok.stdout

        denied_sibling = subprocess.run(
            ["sandbox-exec", "-f", profile, "/bin/cat", str(sibling)],
            capture_output=True, text=True,
        )
        assert denied_sibling.returncode != 0
        assert "operation not permitted" in denied_sibling.stderr.lower()

        denied_repo = subprocess.run(
            ["sandbox-exec", "-f", profile, "/bin/cat",
             os.path.join(os.path.dirname(__file__), "test_judge_readjail.py")],
            capture_output=True, text=True,
        )
        assert denied_repo.returncode != 0
        assert "operation not permitted" in denied_repo.stderr.lower()
    finally:
        asyncio.run(c._cleanup_jail(None))
