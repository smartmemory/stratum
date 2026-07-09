"""Real-backend proof that codex write mode actually writes files.

Availability-gated: skips when the `codex` CLI is not installed. This is the
blocking gate for STRAT-CODEX-WRITE — write mode is not considered shipped until
this passes against a real codex CLI (verified locally against codex-cli 0.143.0,
which created the target file and exited without hanging).
"""
import asyncio
import shutil
from pathlib import Path

import pytest

from stratum_mcp.connectors.codex import CodexConnector

pytestmark = pytest.mark.skipif(
    shutil.which("codex") is None,
    reason="codex CLI not installed; write proof is a manual/CI gate",
)


@pytest.mark.asyncio
async def test_codex_write_actually_creates_file(tmp_path):
    target = "hello_from_codex.txt"
    conn = CodexConnector(model_id="gpt-5.5", sandbox_mode="workspace-write")
    prompt = (
        f"Create a file named {target} in the current directory containing "
        "exactly the text OK. Do not ask for confirmation."
    )

    async def _drive():
        async for _ in conn.run(prompt, cwd=str(tmp_path)):
            pass

    # Hard wall-clock cap: write mode must NOT hang on an approval prompt.
    await asyncio.wait_for(_drive(), timeout=180)

    assert (Path(tmp_path) / target).exists(), "codex write did not create the file"
