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


def test_build_cmd_with_jail_wraps_and_adds_ephemeral(tmp_path):
    jail = tmp_path / "turn-1"
    jail.mkdir()
    c = CodexConnector(model_id="gpt-5.4", read_jail=str(jail))
    cmd = c._build_codex_cmd(["exec", "--json", "-"])
    try:
        assert cmd[0] == "sandbox-exec"
        assert cmd[1] == "-f"
        profile = cmd[2]
        assert os.path.exists(profile)
        assert cmd[3] == "codex"
        # --ephemeral is an `exec` subcommand flag → must follow `exec`
        assert cmd[4] == "exec"
        assert cmd[5] == "--ephemeral"
        assert cmd[6:] == ["--json", "-"]
        assert c._jail_profile == profile
        assert os.path.realpath(str(jail)) in open(profile).read()
    finally:
        asyncio.run(c._cleanup_jail(None))
    assert not os.path.exists(profile)
    assert c._jail_profile is None


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

    c = CodexConnector(model_id="gpt-5.4", read_jail=str(turn_dir))
    # Generate the real profile via the connector seam, then wrap /bin/cat.
    cmd = c._build_codex_cmd(["exec"])
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
