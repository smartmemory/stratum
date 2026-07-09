# Codex Write Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the Stratum codex connector generate/edit code in the working directory by emitting `--sandbox workspace-write`, opt-in via a `write: bool` on `stratum_agent_run`, with read-only staying the default so the review path is untouched.

**Architecture:** A public `write: bool` on the `stratum_agent_run` MCP tool maps to a sandbox-mode string threaded server → factory → `CodexConnector`. The connector holds the mode as the single source of truth for the `--sandbox <mode>` argv flag. Write-specific policy (codex-only, `cwd` required, env kill-switch) lives in a pure server-side resolver; hard invariants (valid mode set, no writable jail, no writable durable stream) are enforced defensively in the connector constructor.

**Tech Stack:** Python 3, FastMCP, pytest / pytest-asyncio, the `codex` CLI (`codex exec`).

## Global Constraints

- Default sandbox mode is `read-only`; the review path (`verifier.py` T3 / `stratum_judge`) never passes `write` and must stay byte-for-byte read-only.
- Public API exposes only read-only vs workspace-write. `danger-full-access` is nameable in the mode string but **rejected** by v1 connector validation.
- `write=True` is codex-only and **fail-loud**: reject (never silently ignore) on a non-codex connector base.
- `write=True` requires an explicit, non-empty `cwd`.
- Env kill-switch `STRATUM_CODEX_ALLOW_WRITE`: absent = enabled; `0`/`false`/`no`/`off` (case-insensitive) = disabled → raise a clear error, never a silent read-only downgrade.
- `write=True` is rejected when combined with `read_jail` (Docker `:ro` mount) or the durable/reparentable stream (`stream_path`), each deferred to a named follow-up.
- No approval flag is added; `codex exec` is non-interactive by default.
- Design source: `docs/plans/2026-07-09-codex-write-mode-design.md`.

---

### Task 1: Connector — sandbox mode into argv + hard invariants

**Files:**
- Modify: `stratum-mcp/src/stratum_mcp/connectors/codex.py` (`CodexConnector.__init__` ~262-296; `run()` args ~372-385; `stream_events()` args ~547-560; init event ~365-370)
- Test: `stratum-mcp/tests/test_codex_write_mode.py` (new)

**Interfaces:**
- Consumes: existing `CodexConnector(*, model_id, cwd, read_jail, jail_driver, stream_path, stderr_path)`.
- Produces:
  - `CodexConnector(..., sandbox_mode: str = "read-only")` — public attribute `connector.sandbox_mode: str`.
  - `CodexConnector._exec_args(base_model: str, effort: str, resolved_cwd: str) -> list[str]` — builds the `codex exec` argv list using `self.sandbox_mode`.
  - Constructor raises `ValueError` when: `sandbox_mode` not in `{"read-only","workspace-write"}`; `sandbox_mode != "read-only"` and `read_jail` set; `sandbox_mode != "read-only"` and `stream_path` set (durable).

- [ ] **Step 1: Write the failing tests**

Create `stratum-mcp/tests/test_codex_write_mode.py`:

```python
import pytest

from stratum_mcp.connectors.codex import CodexConnector


def _args(conn):
    return conn._exec_args("gpt-5.5", "", "/work")


def test_default_mode_is_read_only():
    conn = CodexConnector(model_id="gpt-5.5")
    assert conn.sandbox_mode == "read-only"
    a = _args(conn)
    assert a[a.index("--sandbox") + 1] == "read-only"


def test_write_mode_emits_workspace_write():
    conn = CodexConnector(model_id="gpt-5.5", sandbox_mode="workspace-write")
    assert conn.sandbox_mode == "workspace-write"
    a = _args(conn)
    assert a[a.index("--sandbox") + 1] == "workspace-write"
    # No approval flag is injected.
    assert "--dangerously-bypass-approvals-and-sandbox" not in a


def test_exec_args_shape_preserved():
    # effort suffix still becomes a -c model_reasoning_effort override, prompt
    # is still read from stdin ("-" last).
    conn = CodexConnector(model_id="gpt-5.5", sandbox_mode="workspace-write")
    a = conn._exec_args("gpt-5.5", "high", "/work")
    assert a[0] == "exec"
    assert a[-1] == "-"
    assert '-c' in a and 'model_reasoning_effort="high"' in a


def test_danger_full_access_rejected():
    with pytest.raises(ValueError, match="sandbox_mode"):
        CodexConnector(model_id="gpt-5.5", sandbox_mode="danger-full-access")


def test_write_plus_read_jail_rejected():
    with pytest.raises(ValueError, match="read_jail"):
        CodexConnector(
            model_id="gpt-5.5",
            sandbox_mode="workspace-write",
            read_jail="/some/staging",
        )


def test_write_plus_durable_rejected():
    with pytest.raises(ValueError, match="durable"):
        CodexConnector(
            model_id="gpt-5.5",
            sandbox_mode="workspace-write",
            stream_path="/tmp/out.jsonl",
        )
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pytest stratum-mcp/tests/test_codex_write_mode.py -v`
Expected: FAIL — `TypeError: __init__() got an unexpected keyword argument 'sandbox_mode'` (and `AttributeError` on `_exec_args`).

- [ ] **Step 3: Add `sandbox_mode` param, validation, and store it in `__init__`**

In `CodexConnector.__init__`, add the parameter to the signature (after `stderr_path`):

```python
    def __init__(
        self,
        *,
        model_id: str = _DEFAULT_MODEL_ID,
        cwd: Optional[str] = None,
        read_jail: Optional[str] = None,
        jail_driver: Optional[JailDriver] = None,
        stream_path: Optional[str] = None,
        stderr_path: Optional[str] = None,
        sandbox_mode: str = "read-only",
    ):
```

Then, at the END of `__init__` (after `self._jail_scratch = None`), add validation + storage:

```python
        # STRAT-CODEX-WRITE: sandbox mode drives the codex `--sandbox <mode>`
        # flag. v1 accepts only read-only and workspace-write; danger-full-access
        # is nameable but not constructible until it has its own guardrails.
        if sandbox_mode not in ("read-only", "workspace-write"):
            raise ValueError(
                f"CodexConnector: unsupported sandbox_mode {sandbox_mode!r}; "
                "v1 accepts 'read-only' or 'workspace-write'"
            )
        if sandbox_mode != "read-only":
            if read_jail is not None:
                raise ValueError(
                    "CodexConnector: write (sandbox_mode="
                    f"{sandbox_mode!r}) with read_jail is not supported in v1 "
                    "(the Docker jail mounts :ro and would silently eat writes; "
                    "see STRAT-CODEX-WRITE-JAIL)"
                )
            if stream_path is not None:
                raise ValueError(
                    "CodexConnector: write (sandbox_mode="
                    f"{sandbox_mode!r}) with the durable stream is not supported "
                    "in v1 (a durable child survives teardown and could keep "
                    "editing after cancel; see STRAT-CODEX-WRITE-DURABLE)"
                )
        self.sandbox_mode = sandbox_mode
```

- [ ] **Step 4: Add the `_exec_args` helper (single source of the argv)**

Add this method to `CodexConnector` (e.g. immediately before `run()`):

```python
    def _exec_args(
        self, base_model: str, effort: str, resolved_cwd: str
    ) -> list[str]:
        """Build the `codex exec` argv. Single source of the --sandbox flag."""
        args = [
            "exec",
            "--json",
            "--skip-git-repo-check",
            "--sandbox",
            self.sandbox_mode,
            "-m",
            base_model,
            "-C",
            resolved_cwd,
        ]
        if effort:
            args.extend(["-c", f'model_reasoning_effort="{effort}"'])
        args.append("-")  # read prompt from stdin
        return args
```

- [ ] **Step 5: Replace both inline argv blocks with the helper**

In `run()` replace the inline `args = [ ... ]` block (the one containing `"read-only"`, ~372-385) with:

```python
        args = self._exec_args(base_model, effort, resolved_cwd)
```

In `stream_events()` replace the identical inline `args = [ ... ]` block (~547-560) with the same line:

```python
        args = self._exec_args(base_model, effort, resolved_cwd)
```

Grep to confirm the literal is now gone from every argv site:

Run: `grep -n '"read-only"' stratum-mcp/src/stratum_mcp/connectors/codex.py`
Expected: no match inside `run()`/`stream_events()`/`_exec_args` argv construction (only the default in the signature / validation string remains).

- [ ] **Step 6: Record the sandbox mode in run metadata**

In `run()`, extend the `init` system event (~365-370) to carry the mode:

```python
        yield {
            "type": "system",
            "subtype": "init",
            "agent": _AGENT_NAME,
            "model": resolved_model_id,
            "sandbox": self.sandbox_mode,
        }
```

And add a spawn-time log line in BOTH `run()` and `stream_events()`, immediately after `codex_cmd = self._build_codex_cmd(args, clean_env)`:

```python
        logger.info(
            "codex spawn sandbox=%s cwd=%s model=%s",
            self.sandbox_mode, resolved_cwd, resolved_model_id,
        )
```

Add a metadata assertion to the test file:

```python
@pytest.mark.asyncio
async def test_run_init_event_reports_sandbox():
    # run() yields the init event BEFORE building argv / spawning codex, so we
    # can read it and close the generator without needing the real binary.
    conn = CodexConnector(model_id="gpt-5.5", sandbox_mode="workspace-write")
    agen = conn.run("hi")
    first = await agen.__anext__()
    await agen.aclose()
    assert first["subtype"] == "init"
    assert first["sandbox"] == "workspace-write"
```

(Requires `pytest-asyncio`, already used by `test_codex_durable.py`.)

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pytest stratum-mcp/tests/test_codex_write_mode.py -v`
Expected: PASS (all cases).

- [ ] **Step 8: Commit**

```bash
git add stratum-mcp/src/stratum_mcp/connectors/codex.py stratum-mcp/tests/test_codex_write_mode.py
git commit -m "feat(codex): sandbox_mode drives --sandbox flag; reject writable jail/durable (STRAT-CODEX-WRITE)"
```

---

### Task 2: Factory — thread `sandbox_mode` to the codex connector

**Files:**
- Modify: `stratum-mcp/src/stratum_mcp/connectors/factory.py` (`make_agent_connector` signature ~42-54; codex branch ~85-93)
- Test: `stratum-mcp/tests/test_codex_write_mode.py` (append)

**Interfaces:**
- Consumes: `CodexConnector(..., sandbox_mode=...)` from Task 1.
- Produces: `make_agent_connector(..., sandbox_mode: str = "read-only")` — passes `sandbox_mode` to the codex connector; ignored on the claude branch.

- [ ] **Step 1: Write the failing tests (append to test file)**

```python
from stratum_mcp.connectors.factory import make_agent_connector


def test_factory_defaults_codex_read_only():
    conn = make_agent_connector("codex", "gpt-5.5", "/work")
    assert conn.sandbox_mode == "read-only"


def test_factory_threads_workspace_write():
    conn = make_agent_connector(
        "codex", "gpt-5.5", "/work", sandbox_mode="workspace-write"
    )
    assert conn.sandbox_mode == "workspace-write"


def test_factory_suffix_variant_still_gets_write():
    # A '::tier' suffix selects the codex connector by base and must still
    # receive the sandbox mode.
    conn = make_agent_connector(
        "codex::fast", "gpt-5.5", "/work", sandbox_mode="workspace-write"
    )
    assert conn.sandbox_mode == "workspace-write"


def test_factory_write_plus_read_jail_rejected():
    with pytest.raises(ValueError, match="read_jail"):
        make_agent_connector(
            "codex", "gpt-5.5", "/work",
            sandbox_mode="workspace-write", read_jail="/staging",
        )
```

- [ ] **Step 2: Run to verify they fail**

Run: `pytest stratum-mcp/tests/test_codex_write_mode.py -k factory -v`
Expected: FAIL — `TypeError: make_agent_connector() got an unexpected keyword argument 'sandbox_mode'`.

- [ ] **Step 3: Add the parameter and thread it through**

Add `sandbox_mode` to the signature (after `stderr_path`):

```python
    stream_path: Optional[str] = None,
    stderr_path: Optional[str] = None,
    sandbox_mode: str = "read-only",
) -> AgentConnector:
```

In the codex branch (`if base == "codex":`), add it to `codex_kwargs`:

```python
    if base == "codex":
        codex_kwargs: dict[str, Any] = {
            "model_id": model_id or DEFAULT_CODEX_MODEL,
            "cwd": cwd,
            "read_jail": read_jail,
            "stream_path": stream_path,
            "stderr_path": stderr_path,
            "sandbox_mode": sandbox_mode,
        }
        return CodexConnector(**codex_kwargs)
```

(The claude branch is unchanged — it never receives `sandbox_mode`.)

- [ ] **Step 4: Run to verify they pass**

Run: `pytest stratum-mcp/tests/test_codex_write_mode.py -k factory -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add stratum-mcp/src/stratum_mcp/connectors/factory.py stratum-mcp/tests/test_codex_write_mode.py
git commit -m "feat(codex): thread sandbox_mode through make_agent_connector"
```

---

### Task 3: Server — `write` param, policy resolver, wiring

**Files:**
- Modify: `stratum-mcp/src/stratum_mcp/server.py` (tool description ~136-146; `stratum_agent_run` signature ~147-162; connector construction ~189-198; add module-level helpers near the top of the tool section)
- Test: `stratum-mcp/tests/test_agent_run_write.py` (new)

**Interfaces:**
- Consumes: `connector_base` (already importable from `.connectors.factory`), `_make_agent_connector(..., sandbox_mode=...)` from Task 2.
- Produces:
  - `_codex_write_allowed() -> bool` — reads `STRATUM_CODEX_ALLOW_WRITE`.
  - `_resolve_sandbox_mode(base: str, write: bool, cwd: Optional[str]) -> str` — returns `"read-only"` or `"workspace-write"`, else raises `ValueError`.
  - `stratum_agent_run(..., write: bool = False)`.

- [ ] **Step 1: Write the failing tests**

Create `stratum-mcp/tests/test_agent_run_write.py`:

```python
import pytest

from stratum_mcp.server import _resolve_sandbox_mode, _codex_write_allowed


def test_default_no_write_is_read_only():
    assert _resolve_sandbox_mode("codex", False, None) == "read-only"


def test_codex_write_resolves_workspace_write(monkeypatch):
    monkeypatch.delenv("STRATUM_CODEX_ALLOW_WRITE", raising=False)
    assert _resolve_sandbox_mode("codex", True, "/repo") == "workspace-write"


def test_write_on_claude_is_rejected():
    with pytest.raises(ValueError, match="type='codex'"):
        _resolve_sandbox_mode("claude", True, "/repo")


def test_write_requires_cwd():
    with pytest.raises(ValueError, match="cwd"):
        _resolve_sandbox_mode("codex", True, None)
    with pytest.raises(ValueError, match="cwd"):
        _resolve_sandbox_mode("codex", True, "   ")


@pytest.mark.parametrize("val", ["0", "false", "no", "off", "FALSE"])
def test_kill_switch_disables_write(monkeypatch, val):
    monkeypatch.setenv("STRATUM_CODEX_ALLOW_WRITE", val)
    assert _codex_write_allowed() is False
    with pytest.raises(ValueError, match="STRATUM_CODEX_ALLOW_WRITE"):
        _resolve_sandbox_mode("codex", True, "/repo")


@pytest.mark.parametrize("val", ["1", "true", "yes", "on"])
def test_kill_switch_enabled_values(monkeypatch, val):
    monkeypatch.setenv("STRATUM_CODEX_ALLOW_WRITE", val)
    assert _codex_write_allowed() is True


def test_absent_env_means_enabled(monkeypatch):
    monkeypatch.delenv("STRATUM_CODEX_ALLOW_WRITE", raising=False)
    assert _codex_write_allowed() is True
```

- [ ] **Step 2: Run to verify they fail**

Run: `pytest stratum-mcp/tests/test_agent_run_write.py -v`
Expected: FAIL — `ImportError: cannot import name '_resolve_sandbox_mode'`.

- [ ] **Step 3: Add the helpers**

In `server.py`, near the other `stratum_agent_run` helpers (above the `@mcp.tool` for `stratum_agent_run`), add. Ensure `connector_base` is imported (extend the existing `from .connectors.factory import make_agent_connector as _make_agent_connector` line):

```python
from .connectors.factory import (
    make_agent_connector as _make_agent_connector,
    connector_base,
)

_CODEX_WRITE_DISABLED_VALUES = frozenset({"0", "false", "no", "off"})


def _codex_write_allowed() -> bool:
    """STRATUM_CODEX_ALLOW_WRITE kill-switch. Absent = enabled."""
    val = os.environ.get("STRATUM_CODEX_ALLOW_WRITE")
    if val is None:
        return True
    return val.strip().lower() not in _CODEX_WRITE_DISABLED_VALUES


def _resolve_sandbox_mode(base: str, write: bool, cwd: Optional[str]) -> str:
    """Map the public write flag to a codex sandbox mode. Fail-loud."""
    if not write:
        return "read-only"
    if base != "codex":
        raise ValueError(
            "stratum_agent_run: write=True is only supported for type='codex' "
            f"(got base {base!r}); claude write is governed by allowed_tools/"
            "disallowed_tools"
        )
    if not cwd or not cwd.strip():
        raise ValueError(
            "stratum_agent_run: write=True requires an explicit cwd "
            "(otherwise codex would write into the server process's cwd)"
        )
    if not _codex_write_allowed():
        raise ValueError(
            "stratum_agent_run: codex write disabled by STRATUM_CODEX_ALLOW_WRITE"
        )
    return "workspace-write"
```

(Confirm `os` and `Optional` are already imported in `server.py` — they are used throughout; no new import beyond `connector_base`.)

- [ ] **Step 4: Add the `write` param and wire the resolver into construction**

Add `write: bool = False` to the `stratum_agent_run` signature (after `read_jail`):

```python
    cwd: Optional[str] = None,
    read_jail: Optional[str] = None,
    write: bool = False,
    correlation_id: Optional[str] = None,
) -> dict[str, Any]:
```

Immediately before the `connector = _make_agent_connector(...)` call (~189), resolve the mode, then pass it:

```python
    sandbox_mode = _resolve_sandbox_mode(connector_base(type), write, cwd)

    connector = _make_agent_connector(
        type,
        active_model_id,
        cwd,
        allowed_tools=allowed_tools,
        disallowed_tools=disallowed_tools,
        thinking=thinking,
        effort=effort,
        read_jail=read_jail,
        sandbox_mode=sandbox_mode,
    )
```

- [ ] **Step 5: Update the tool description**

In the `@mcp.tool(description=(...))` for `stratum_agent_run`, add a sentence before `"Returns {text: ...}"`:

```python
    "write (bool, default False): codex-only — when True, codex runs with "
    "--sandbox workspace-write and may create/edit files in cwd (cwd required); "
    "rejected for claude, when STRATUM_CODEX_ALLOW_WRITE is off, or with read_jail. "
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pytest stratum-mcp/tests/test_agent_run_write.py -v`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add stratum-mcp/src/stratum_mcp/server.py stratum-mcp/tests/test_agent_run_write.py
git commit -m "feat(codex): add write:bool to stratum_agent_run with codex-only/cwd/kill-switch guards"
```

---

### Task 4: Backward-compat — review path stays read-only (both lanes)

**Files:**
- Test: `stratum-mcp/tests/test_codex_write_backward_compat.py` (new)
- Reference (read-only): `src/stratum/judge/sandbox.py` (`DockerJailDriver.wrap_argv` ~414-467), `src/stratum/judge/verifier.py` (T3 dispatch ~264-291)

**Interfaces:**
- Consumes: `CodexConnector` (default read-only) from Task 1; the existing `DockerJailDriver`.
- Produces: no new production code — assertions that pin the safety property.

- [ ] **Step 1: Write the backward-compat tests**

Create `stratum-mcp/tests/test_codex_write_backward_compat.py`:

```python
import pytest

from stratum_mcp.connectors.codex import CodexConnector


def test_default_connector_argv_is_read_only():
    # The non-jailed default path must still emit --sandbox read-only.
    conn = CodexConnector(model_id="gpt-5.5")
    a = conn._exec_args("gpt-5.5", "", "/work")
    assert a[a.index("--sandbox") + 1] == "read-only"


def test_review_uses_read_only_by_construction():
    # The review path constructs the connector without sandbox_mode → defaults
    # read-only. Regression guard against a default flip.
    conn = CodexConnector(model_id="gpt-5.5", read_jail="/staging")
    assert conn.sandbox_mode == "read-only"
```

- [ ] **Step 2: Write the jailed-lane safety assertion**

The Docker jail *strips* `--sandbox <mode>` and relies on the container mount, so assert the real property on the final Docker argv. Append to the same file (skip if the driver import path is unavailable in the test env):

```python
def test_docker_jail_argv_is_read_only_mount():
    sandbox = pytest.importorskip("stratum.judge.sandbox")
    driver = sandbox.DockerJailDriver()
    inner = ["exec", "--json", "--sandbox", "read-only", "-C", "/staging", "-"]
    argv = driver.wrap_argv(inner, read_root="/staging", env={})
    joined = " ".join(argv)
    # The container is the sandbox: read-only rootfs + a :ro bind of the tree.
    assert "--read-only" in argv
    assert "/staging:/staging:ro" in joined or ":ro" in joined
    # No host-writable bind of the staged tree.
    assert ":rw" not in joined
    # Codex sandbox flag is stripped in favor of the container guarantee.
    assert "--dangerously-bypass-approvals-and-sandbox" in argv
```

(If the concrete mount string differs, adjust the assertion to the driver's actual `-v` spelling — read `sandbox.py:414-467` and match its format; the invariants to keep are: `--read-only` present, a `:ro` bind of the read root present, no `:rw` bind of it.)

- [ ] **Step 3: Run the tests**

Run: `pytest stratum-mcp/tests/test_codex_write_backward_compat.py -v`
Expected: PASS (Docker test may `SKIP` if `stratum.judge.sandbox` isn't importable in the MCP test env — that is acceptable; the connector-default tests must PASS).

- [ ] **Step 4: Run the full existing codex suite to prove no regression**

Run: `pytest stratum-mcp/tests/test_codex_chunk_size.py stratum-mcp/tests/test_codex_durable.py -v`
Expected: PASS (durable path unchanged; argv now flows through `_exec_args` but is byte-identical for read-only).

- [ ] **Step 5: Commit**

```bash
git add stratum-mcp/tests/test_codex_write_backward_compat.py
git commit -m "test(codex): pin review path read-only (connector default + Docker jail mount)"
```

---

### Task 5: Real-backend write gate + docs

**Files:**
- Test: `stratum-mcp/tests/test_codex_write_realbackend.py` (new)
- Modify: `CHANGELOG.md` (repo root — create if absent), `ROADMAP.md` (add STRAT-CODEX-WRITE row + follow-ups, following the existing table format)

**Interfaces:**
- Consumes: `CodexConnector(sandbox_mode="workspace-write")` from Task 1; the real `codex` CLI.
- Produces: the BLOCKING availability-gated proof that write actually writes and does not hang.

- [ ] **Step 1: Write the availability-gated real-backend test**

Create `stratum-mcp/tests/test_codex_write_realbackend.py`:

```python
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
    # Hard wall-clock cap: write mode must NOT hang on an approval prompt.
    async def _drive():
        async for _ in conn.run(prompt, cwd=str(tmp_path)):
            pass
    await asyncio.wait_for(_drive(), timeout=180)
    assert (Path(tmp_path) / target).exists(), "codex write did not create the file"
```

- [ ] **Step 2: Run the gate**

Run: `pytest stratum-mcp/tests/test_codex_write_realbackend.py -v`
Expected: PASS when `codex` is on PATH (write mode created the file, no timeout); SKIP otherwise. **Write mode is not considered shipped until this passes at least once — record the codex CLI version (`codex --version`) in the commit/PR body.**

- [ ] **Step 3: Update CHANGELOG and ROADMAP**

Add a `CHANGELOG.md` entry under the current unreleased section:

```markdown
### Added
- **Codex write mode (STRAT-CODEX-WRITE):** `stratum_agent_run(type="codex", write=True)`
  runs codex with `--sandbox workspace-write` to create/edit files in `cwd`.
  Read-only stays the default; write is codex-only, requires an explicit `cwd`,
  and honors the `STRATUM_CODEX_ALLOW_WRITE` kill-switch. Rejected with `read_jail`
  or the durable stream (follow-ups STRAT-CODEX-WRITE-JAIL / -DURABLE).
```

Add a `ROADMAP.md` row for `STRAT-CODEX-WRITE` (status COMPLETE) plus PLANNED rows for the follow-ups `STRAT-CODEGEN-TOOL`, `STRAT-CODEX-WRITE-JAIL`, `STRAT-CODEX-WRITE-DURABLE`, `STRAT-CODEX-WRITE-ROOTS`, matching the existing table's columns.

- [ ] **Step 4: Run the whole write-mode test set once more**

Run: `pytest stratum-mcp/tests/test_codex_write_mode.py stratum-mcp/tests/test_agent_run_write.py stratum-mcp/tests/test_codex_write_backward_compat.py -v`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add stratum-mcp/tests/test_codex_write_realbackend.py CHANGELOG.md ROADMAP.md
git commit -m "test(codex): blocking real-backend write gate; docs for STRAT-CODEX-WRITE"
```

---

## Self-Review Notes

- **Spec coverage:** write→workspace-write mapping (T1/T3), read-only default + review untouched (T1/T4), env kill-switch fail-loud (T3), write+read_jail reject (T1 connector, T2 factory, T3 server description), write+durable reject (T1), danger-full-access reject (T1), cwd required (T3), codex-only fail-loud + connector_base normalization (T3), end-to-end propagation server→factory→connector (T2/T3), sandbox in run metadata (T1), backward-compat both lanes (T4), blocking real-backend gate (T5), follow-ups filed (T5). All design sections map to a task.
- **Type consistency:** `sandbox_mode: str` and the attribute `connector.sandbox_mode` are used identically across T1/T2/T4; `_resolve_sandbox_mode(base, write, cwd)` and `_codex_write_allowed()` signatures match their T3 tests.
- **Manual verification required:** Task 5 Step 2 is the one gate that needs the real `codex` binary; everything else is deterministic and hermetic.
