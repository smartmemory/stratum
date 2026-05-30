"""STRAT-WORKFLOW-BUDGET-DOLLARS — token→USD pricing table.

Pure pricing helpers: base-model normalization, separate input/output rates,
unknown-model degrade-to-zero, and the STRATUM_MODEL_PRICING_JSON env override.
"""
from __future__ import annotations

import importlib

import pytest

import stratum_mcp.pricing as pricing


@pytest.fixture(autouse=True)
def _reset_pricing(monkeypatch):
    """Each test gets a fresh pricing module: cleared env override + memo cache."""
    monkeypatch.delenv("STRATUM_MODEL_PRICING_JSON", raising=False)
    importlib.reload(pricing)
    yield
    importlib.reload(pricing)


# --- base-model normalization ----------------------------------------------

def test_strips_codex_effort_suffix():
    # gpt-5.4/high prices identically to its base model gpt-5.4
    base = pricing.cost_from_tokens("gpt-5.4", 1_000_000, 0)
    effort = pricing.cost_from_tokens("gpt-5.4/high", 1_000_000, 0)
    assert effort == base
    assert effort > 0.0


def test_known_claude_model_priced():
    assert pricing.cost_from_tokens("claude-sonnet-4-6", 1_000_000, 0) > 0.0


# --- separate input/output rates -------------------------------------------

def test_input_and_output_priced_separately():
    rates = pricing.MODEL_PRICING["claude-sonnet-4-6"]
    cost = pricing.cost_from_tokens("claude-sonnet-4-6", 2_000_000, 3_000_000)
    expected = 2.0 * rates["input"] + 3.0 * rates["output"]
    assert cost == pytest.approx(expected)


def test_output_costs_more_than_input_for_claude():
    in_only = pricing.cost_from_tokens("claude-sonnet-4-6", 1_000_000, 0)
    out_only = pricing.cost_from_tokens("claude-sonnet-4-6", 0, 1_000_000)
    assert out_only > in_only


# --- unknown model degrades -------------------------------------------------

def test_unknown_model_costs_zero():
    assert pricing.cost_from_tokens("totally-made-up-model", 5_000_000, 5_000_000) == 0.0


def test_empty_model_costs_zero():
    assert pricing.cost_from_tokens("", 1_000_000, 1_000_000) == 0.0


@pytest.mark.parametrize("bad", [1, [], {}, 3.5, object()])
def test_non_string_model_degrades_without_raising(bad):
    # a malformed/untyped model id must never raise — it just prices as $0
    assert pricing.cost_from_tokens(bad, 1_000_000, 1_000_000) == 0.0
    assert pricing.is_priced(bad) is False
    pricing._maybe_warn_unpriced(bad, has_usd_cap=True)  # must not raise


def test_is_priced():
    assert pricing.is_priced("gpt-5.4/medium") is True
    assert pricing.is_priced("claude-sonnet-4-6") is True
    assert pricing.is_priced("nope") is False
    assert pricing.is_priced("") is False


# --- env override -----------------------------------------------------------

def test_env_override_adds_new_model(monkeypatch):
    monkeypatch.setenv(
        "STRATUM_MODEL_PRICING_JSON",
        '{"future-model-9": {"input": 2.0, "output": 8.0}}',
    )
    importlib.reload(pricing)
    assert pricing.is_priced("future-model-9")
    assert pricing.cost_from_tokens("future-model-9", 1_000_000, 1_000_000) == pytest.approx(10.0)


def test_env_override_patches_existing_price(monkeypatch):
    monkeypatch.setenv(
        "STRATUM_MODEL_PRICING_JSON",
        '{"gpt-5.4": {"input": 99.0, "output": 99.0}}',
    )
    importlib.reload(pricing)
    assert pricing.cost_from_tokens("gpt-5.4", 1_000_000, 0) == pytest.approx(99.0)


def test_malformed_env_override_degrades_to_builtin(monkeypatch):
    monkeypatch.setenv("STRATUM_MODEL_PRICING_JSON", "{not valid json")
    importlib.reload(pricing)
    # built-in table still works; no crash
    assert pricing.cost_from_tokens("claude-sonnet-4-6", 1_000_000, 0) > 0.0


def test_env_override_skips_entries_with_nonnumeric_rates(monkeypatch):
    monkeypatch.setenv(
        "STRATUM_MODEL_PRICING_JSON",
        '{"bad-model": {"input": "free", "output": 1.0}}',
    )
    importlib.reload(pricing)
    # malformed entry skipped → model stays unpriced
    assert pricing.is_priced("bad-model") is False


# --- unpriced warning (one-time per base model) ----------------------------

def test_warn_unpriced_only_when_usd_cap_and_unpriced(caplog):
    import logging
    with caplog.at_level(logging.WARNING):
        pricing._maybe_warn_unpriced("claude-sonnet-4-6", has_usd_cap=True)  # priced → no warn
        pricing._maybe_warn_unpriced("mystery-model", has_usd_cap=False)    # no cap → no warn
        assert not caplog.records
        pricing._maybe_warn_unpriced("mystery-model", has_usd_cap=True)     # unpriced + cap → warn
        assert len(caplog.records) == 1
        pricing._maybe_warn_unpriced("mystery-model", has_usd_cap=True)     # already warned → silent
        assert len(caplog.records) == 1
