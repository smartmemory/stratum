"""Tests for vocabulary_compliance ensure builtin (STRAT-VOCAB)."""
import pytest

from stratum_mcp.spec import _load_vocabulary, vocabulary_compliance


# ---------------------------------------------------------------------------
# Loader tests
# ---------------------------------------------------------------------------

class TestVocabularyLoader:
    def test_missing_file_returns_empty(self, tmp_path):
        """Missing file → empty dict (no-op case)."""
        result = _load_vocabulary(str(tmp_path / "nope.yaml"))
        assert result == {}

    def test_empty_file_returns_empty(self, tmp_path):
        """Empty file → empty dict."""
        p = tmp_path / "vocab.yaml"
        p.write_text("")
        assert _load_vocabulary(str(p)) == {}

    def test_comments_only_returns_empty(self, tmp_path):
        """Comments-only YAML parses to None → treated as empty dict."""
        p = tmp_path / "vocab.yaml"
        p.write_text("# just a comment\n# another comment\n")
        assert _load_vocabulary(str(p)) == {}

    def test_empty_dict_returns_empty(self, tmp_path):
        """Empty dict literal → empty dict."""
        p = tmp_path / "vocab.yaml"
        p.write_text("{}\n")
        assert _load_vocabulary(str(p)) == {}

    def test_valid_flat_map(self, tmp_path):
        """Valid flat map with reject and reason."""
        p = tmp_path / "vocab.yaml"
        p.write_text(
            "user_id:\n"
            "  reject: [userId, uid]\n"
            "  reason: 'standardized 2026-01'\n"
        )
        result = _load_vocabulary(str(p))
        assert result == {
            "user_id": {"reject": ["userId", "uid"], "reason": "standardized 2026-01"}
        }

    def test_valid_without_reason(self, tmp_path):
        """reason is optional."""
        p = tmp_path / "vocab.yaml"
        p.write_text("user_id:\n  reject: [userId]\n")
        result = _load_vocabulary(str(p))
        assert result == {"user_id": {"reject": ["userId"], "reason": ""}}

    def test_malformed_yaml_raises(self, tmp_path):
        """YAML syntax error → ValueError with 'malformed' in message."""
        p = tmp_path / "vocab.yaml"
        p.write_text("user_id: [unclosed")
        with pytest.raises(ValueError, match="malformed"):
            _load_vocabulary(str(p))

    def test_top_level_not_dict_raises(self, tmp_path):
        """Top level must be a mapping."""
        p = tmp_path / "vocab.yaml"
        p.write_text("- not\n- a\n- dict\n")
        with pytest.raises(ValueError, match="schema error"):
            _load_vocabulary(str(p))

    def test_entry_not_dict_raises(self, tmp_path):
        """Each entry value must be a mapping."""
        p = tmp_path / "vocab.yaml"
        p.write_text("user_id: not_a_dict\n")
        with pytest.raises(ValueError, match="schema error"):
            _load_vocabulary(str(p))

    def test_missing_reject_raises(self, tmp_path):
        """Entry without reject field."""
        p = tmp_path / "vocab.yaml"
        p.write_text("user_id:\n  reason: 'no reject field'\n")
        with pytest.raises(ValueError, match="schema error"):
            _load_vocabulary(str(p))

    def test_empty_reject_raises(self, tmp_path):
        """Empty reject list."""
        p = tmp_path / "vocab.yaml"
        p.write_text("user_id:\n  reject: []\n")
        with pytest.raises(ValueError, match="schema error"):
            _load_vocabulary(str(p))

    def test_reject_not_list_raises(self, tmp_path):
        """reject must be a list."""
        p = tmp_path / "vocab.yaml"
        p.write_text("user_id:\n  reject: userId\n")
        with pytest.raises(ValueError, match="schema error"):
            _load_vocabulary(str(p))

    def test_unknown_field_raises(self, tmp_path):
        """Unknown fields (typos) are rejected strictly."""
        p = tmp_path / "vocab.yaml"
        p.write_text(
            "user_id:\n"
            "  reject: [userId]\n"
            "  rejects: [uid]\n"  # typo
        )
        with pytest.raises(ValueError, match="schema error"):
            _load_vocabulary(str(p))

    def test_non_identifier_canonical_raises(self, tmp_path):
        """Canonical name must match identifier syntax."""
        p = tmp_path / "vocab.yaml"
        p.write_text("'user->id':\n  reject: [userId]\n")
        with pytest.raises(ValueError, match="schema error"):
            _load_vocabulary(str(p))

    def test_non_identifier_alias_raises(self, tmp_path):
        """Aliases must match identifier syntax."""
        p = tmp_path / "vocab.yaml"
        p.write_text("user_id:\n  reject: ['user-id']\n")
        with pytest.raises(ValueError, match="schema error"):
            _load_vocabulary(str(p))

    def test_duplicate_alias_across_canonicals_raises(self, tmp_path):
        """Same rejected alias under two canonicals → error."""
        p = tmp_path / "vocab.yaml"
        p.write_text(
            "user_id:\n"
            "  reject: [userId]\n"
            "account_id:\n"
            "  reject: [userId]\n"  # same alias
        )
        with pytest.raises(ValueError, match="multiple canonicals"):
            _load_vocabulary(str(p))

    def test_canonical_rejects_itself_raises(self, tmp_path):
        """Canonical cannot list itself in reject."""
        p = tmp_path / "vocab.yaml"
        p.write_text("user_id:\n  reject: [user_id]\n")
        with pytest.raises(ValueError, match="schema error"):
            _load_vocabulary(str(p))

    def test_canonical_as_alias_for_another_raises(self, tmp_path):
        """One canonical appearing in another canonical's reject list."""
        p = tmp_path / "vocab.yaml"
        p.write_text(
            "user_id:\n"
            "  reject: [userId]\n"
            "account_id:\n"
            "  reject: [user_id]\n"  # user_id is a canonical
        )
        with pytest.raises(ValueError, match="schema error"):
            _load_vocabulary(str(p))
