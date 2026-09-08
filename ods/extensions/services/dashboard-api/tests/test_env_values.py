import pytest

from env_values import strip_matching_quotes


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


class TestParseEnvIntegerSafe:

    def test_parses_integer_values(self):
        from env_values import parse_env_integer_safe
        assert parse_env_integer_safe("8080") == 8080
        assert parse_env_integer_safe(42) == 42

    def test_handles_none_and_bounds_clamping(self):
        from env_values import parse_env_integer_safe
        assert parse_env_integer_safe(None, default=80) == 80
        assert parse_env_integer_safe("invalid", default=80) == 80
        assert parse_env_integer_safe("10", min_val=20) == 20
        assert parse_env_integer_safe("100", max_val=50) == 50

