"""Cross-repo drift guard: Python CodexConnector vs Compose's JS codex-connector.

Two connector trees exist today (STRAT-DEDUP-AGENTRUN v3 not yet shipped):
- Python: stratum-mcp/src/stratum_mcp/connectors/codex.py (this repo)
- JS:     compose/server/connectors/codex-connector.js (sibling checkout)

On 2026-04-18 the JS side migrated from opencode to direct `codex exec --json`;
the Python side was left behind, causing every `stratum_agent_run type="codex"`
call to hang. This guard catches that class of drift before it ships:

- Both sides must use the direct `codex exec` CLI (neither may fall back to opencode).
- Model-ID sets must be identical (additions/removals must happen on both sides
  in the same commit).

The check is skipped when the Compose repo isn't adjacent to stratum (stratum-only
clones, CI matrices that don't check out Compose). Running `pytest` in a normal
dev tree — where both repos live as siblings under forge/ — will always run it.

Retire this file when STRAT-DEDUP-AGENTRUN v3 ships and the JS connector tree
is removed.
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest

from stratum_mcp.connectors.codex import CODEX_MODEL_IDS


def _locate_js_connector() -> Path | None:
    """Find compose/server/connectors/codex-connector.js relative to this repo."""
    here = Path(__file__).resolve()
    # stratum-mcp/tests/test_codex_connector_sync.py → walk up to forge/, then compose/
    for parent in here.parents:
        candidate = parent / "compose" / "server" / "connectors" / "codex-connector.js"
        if candidate.exists():
            return candidate
    return None


JS_PATH = _locate_js_connector()
_skip_no_compose = pytest.mark.skipif(
    JS_PATH is None,
    reason="compose repo not adjacent to stratum — sync guard skipped",
)


@_skip_no_compose
def test_js_connector_uses_direct_codex_cli_not_opencode():
    """JS side must spawn `codex exec`, not `opencode run`."""
    text = JS_PATH.read_text()
    assert "codex exec" in text or "'exec'" in text, (
        "JS codex connector no longer references `codex exec` — "
        "did it revert to opencode? Sync Python side or retire this guard."
    )
    # Allow documentation/comment mentions of opencode (the migration note),
    # but the import must not pull it in.
    import_matches = re.findall(
        r"^\s*import\s+.*from\s+['\"].*opencode.*['\"]",
        text,
        re.MULTILINE,
    )
    assert not import_matches, (
        f"JS codex connector imports from opencode: {import_matches}. "
        "Python side has been migrated; keep both in sync."
    )


@_skip_no_compose
def test_codex_model_ids_match_across_languages():
    """Model-ID sets must be identical between JS and Python connectors."""
    text = JS_PATH.read_text()

    # Extract the `export const CODEX_MODEL_IDS = new Set([ 'a', 'b', ... ]);` block.
    block_match = re.search(
        r"CODEX_MODEL_IDS\s*=\s*new\s+Set\(\s*\[(.*?)\]\s*\)\s*;",
        text,
        re.DOTALL,
    )
    assert block_match, (
        "Could not locate `CODEX_MODEL_IDS = new Set([...])` in JS connector. "
        "File structure may have changed; update this guard."
    )

    # Pull single-quoted string literals from the block.
    js_ids = set(re.findall(r"'([^']+)'", block_match.group(1)))
    py_ids = set(CODEX_MODEL_IDS)

    missing_from_py = js_ids - py_ids
    missing_from_js = py_ids - js_ids
    assert not missing_from_py, (
        f"Model IDs present in JS but missing from Python: {sorted(missing_from_py)}. "
        "Add to stratum-mcp/src/stratum_mcp/connectors/codex.py:CODEX_MODEL_IDS."
    )
    assert not missing_from_js, (
        f"Model IDs present in Python but missing from JS: {sorted(missing_from_js)}. "
        "Add to compose/server/connectors/codex-connector.js:CODEX_MODEL_IDS."
    )
