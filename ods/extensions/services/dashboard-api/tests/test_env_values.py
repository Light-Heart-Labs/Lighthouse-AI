import pytest

from env_values import (
    read_env_file_value,
    read_env_file_value_state,
    strip_matching_quotes,
)


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("value", "value"),
        ("  value  ", "value"),
        ('"value"', "value"),
        ("'value'", "value"),
        ('""', ""),
        ("''", ""),
        ("it's", "it's"),
        ('"value', '"value'),
        ('value"', 'value"'),
        ("'value", "'value"),
        ("value'", "value'"),
        ('"value\'', '"value\''),
        ("''value''", "'value'"),
        ('""value""', '"value"'),
    ],
)
def test_strip_matching_quotes_removes_exactly_one_complete_pair(raw, expected):
    assert strip_matching_quotes(raw) == expected


def test_env_file_reader_preserves_first_value_and_embedded_equals(tmp_path):
    (tmp_path / ".env").write_text(
        "TOKEN=first=value\nTOKEN=second\n",
        encoding="utf-8",
    )

    assert read_env_file_value("TOKEN", tmp_path) == "first=value"


def test_env_file_reader_does_not_match_key_prefixes(tmp_path):
    (tmp_path / ".env").write_text("CTX_SIZE=4096\n", encoding="utf-8")

    assert read_env_file_value("CTX", tmp_path) == ""


def test_env_file_reader_preserves_unmatched_quotes(tmp_path):
    (tmp_path / ".env").write_text(
        "PAIRED='model-v2'\nUNMATCHED=model-v2'\n",
        encoding="utf-8",
    )

    assert read_env_file_value("PAIRED", tmp_path) == "model-v2"
    assert read_env_file_value("UNMATCHED", tmp_path) == "model-v2'"


def test_env_file_reader_distinguishes_empty_assignment_from_missing_key(tmp_path):
    (tmp_path / ".env").write_text("EMPTY=\n", encoding="utf-8")

    assert read_env_file_value_state("EMPTY", tmp_path) == (True, "")
    assert read_env_file_value_state("MISSING", tmp_path) == (False, "")


def test_env_file_reader_accepts_missing_file_and_string_path(tmp_path):
    assert read_env_file_value("ANY", str(tmp_path)) == ""
