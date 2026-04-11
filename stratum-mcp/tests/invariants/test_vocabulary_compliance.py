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


# ---------------------------------------------------------------------------
# File scanning tests
# ---------------------------------------------------------------------------

def _write_vocab(tmp_path, content: str) -> str:
    """Helper to write a vocab file and return its path."""
    p = tmp_path / "vocab.yaml"
    p.write_text(content)
    return str(p)


class TestVocabularyScanning:
    def test_no_vocabulary_file_returns_true(self, tmp_path):
        """Missing vocabulary file → no-op pass."""
        assert vocabulary_compliance(
            str(tmp_path / "nope.yaml"),
            ["some/file.py"],
        ) is True

    def test_empty_vocabulary_returns_true(self, tmp_path):
        """Empty vocab → nothing to check."""
        vocab_path = _write_vocab(tmp_path, "")
        assert vocabulary_compliance(vocab_path, ["some/file.py"]) is True

    def test_clean_files_pass(self, tmp_path):
        """No rejected aliases in the file → pass."""
        vocab_path = _write_vocab(
            tmp_path,
            "user_id:\n  reject: [userId]\n",
        )
        src = tmp_path / "clean.py"
        src.write_text("def get_user_id():\n    return user_id\n")
        assert vocabulary_compliance(vocab_path, [str(src)]) is True

    def test_whole_word_match_finds_alias(self, tmp_path):
        """Rejected alias with word boundaries → violation."""
        vocab_path = _write_vocab(
            tmp_path,
            "user_id:\n  reject: [userId]\n",
        )
        src = tmp_path / "bad.py"
        src.write_text("def get_user():\n    return userId\n")
        with pytest.raises(ValueError) as exc_info:
            vocabulary_compliance(vocab_path, [str(src)])
        violations = exc_info.value.args[0]
        assert len(violations) == 1
        assert "userId" in violations[0]
        assert "user_id" in violations[0]

    def test_whole_word_does_not_match_inside_other_word(self, tmp_path):
        """'uid' should not match inside 'uuid' or 'guide'."""
        vocab_path = _write_vocab(
            tmp_path,
            "user_id:\n  reject: [uid]\n",
        )
        src = tmp_path / "safe.py"
        src.write_text("def get_uuid():\n    return 'guide_me'\n")
        assert vocabulary_compliance(vocab_path, [str(src)]) is True

    def test_case_sensitive_match(self, tmp_path):
        """'userId' does not match 'UserID' unless listed."""
        vocab_path = _write_vocab(
            tmp_path,
            "user_id:\n  reject: [userId]\n",
        )
        src = tmp_path / "mixed.py"
        src.write_text("class UserID:\n    pass\n")
        assert vocabulary_compliance(vocab_path, [str(src)]) is True

    def test_multiple_occurrences_one_per_violation(self, tmp_path):
        """Same alias used N times → N violations."""
        vocab_path = _write_vocab(
            tmp_path,
            "user_id:\n  reject: [userId]\n",
        )
        src = tmp_path / "multi.py"
        src.write_text(
            "def a(userId):\n"
            "    pass\n"
            "def b(userId):\n"
            "    return userId\n"
        )
        with pytest.raises(ValueError) as exc_info:
            vocabulary_compliance(vocab_path, [str(src)])
        violations = exc_info.value.args[0]
        assert len(violations) == 3

    def test_reason_included_in_violation(self, tmp_path):
        """Reason string appears in violation message."""
        vocab_path = _write_vocab(
            tmp_path,
            "user_id:\n"
            "  reject: [userId]\n"
            "  reason: 'standardized on snake_case'\n",
        )
        src = tmp_path / "bad.py"
        src.write_text("userId = 1\n")
        with pytest.raises(ValueError) as exc_info:
            vocabulary_compliance(vocab_path, [str(src)])
        violations = exc_info.value.args[0]
        assert "standardized on snake_case" in violations[0]

    def test_no_reason_omits_parenthetical(self, tmp_path):
        """When reason is absent, message has no (reason: ...) suffix."""
        vocab_path = _write_vocab(
            tmp_path,
            "user_id:\n  reject: [userId]\n",
        )
        src = tmp_path / "bad.py"
        src.write_text("userId = 1\n")
        with pytest.raises(ValueError) as exc_info:
            vocabulary_compliance(vocab_path, [str(src)])
        violations = exc_info.value.args[0]
        assert "(reason:" not in violations[0]

    def test_empty_reason_omits_parenthetical(self, tmp_path):
        """Empty reason string behaves same as absent."""
        vocab_path = _write_vocab(
            tmp_path,
            "user_id:\n"
            "  reject: [userId]\n"
            "  reason: ''\n",
        )
        src = tmp_path / "bad.py"
        src.write_text("userId = 1\n")
        with pytest.raises(ValueError) as exc_info:
            vocabulary_compliance(vocab_path, [str(src)])
        violations = exc_info.value.args[0]
        assert "(reason:" not in violations[0]

    def test_multiple_files(self, tmp_path):
        """Scan multiple files; violations reported with correct paths."""
        vocab_path = _write_vocab(
            tmp_path,
            "user_id:\n  reject: [userId]\n",
        )
        f1 = tmp_path / "a.py"
        f1.write_text("userId = 1\n")
        f2 = tmp_path / "b.py"
        f2.write_text("def foo(userId):\n    pass\n")
        with pytest.raises(ValueError) as exc_info:
            vocabulary_compliance(vocab_path, [str(f1), str(f2)])
        violations = exc_info.value.args[0]
        assert len(violations) == 2

    def test_missing_file_skipped_silently(self, tmp_path):
        """Deleted files in files_changed → skip, no error."""
        vocab_path = _write_vocab(
            tmp_path,
            "user_id:\n  reject: [userId]\n",
        )
        result = vocabulary_compliance(
            vocab_path,
            [str(tmp_path / "nonexistent.py")],
        )
        assert result is True

    def test_empty_files_changed_returns_true(self, tmp_path):
        """Empty files_changed with git_fallback off → nothing to scan."""
        vocab_path = _write_vocab(
            tmp_path,
            "user_id:\n  reject: [userId]\n",
        )
        assert vocabulary_compliance(vocab_path, [], git_fallback=False) is True

    def test_large_file_skipped(self, tmp_path, monkeypatch):
        """Files over the size limit are skipped silently."""
        import stratum_mcp.spec as spec_mod
        monkeypatch.setattr(spec_mod, "_VOCAB_SIZE_LIMIT", 10)

        vocab_path = _write_vocab(
            tmp_path,
            "user_id:\n  reject: [userId]\n",
        )
        src = tmp_path / "big.py"
        src.write_text("userId = " + "'x'" * 100)  # well over 10 bytes
        assert vocabulary_compliance(vocab_path, [str(src)]) is True

    def test_path_normalization_dedupe(self, tmp_path, monkeypatch):
        """Equivalent paths (./a.py, a.py) are scanned once."""
        monkeypatch.chdir(tmp_path)
        vocab_path = _write_vocab(
            tmp_path,
            "user_id:\n  reject: [userId]\n",
        )
        src = tmp_path / "a.py"
        src.write_text("userId = 1\n")
        with pytest.raises(ValueError) as exc_info:
            vocabulary_compliance(
                vocab_path,
                ["a.py", "./a.py"],  # same file, different form
            )
        violations = exc_info.value.args[0]
        # Should be 1 violation, not 2 (dedupe)
        assert len(violations) == 1
