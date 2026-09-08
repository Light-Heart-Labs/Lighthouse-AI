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


class TestParseEnvIntSafe:

    def test_parses_integer_env_values(self):
        from env_values import parse_env_int_safe
        assert parse_env_int_safe("8080") == 8080
        assert parse_env_int_safe("100", min_val=0, max_val=50) == 50

    def test_handles_none_and_invalid_inputs(self):
        from env_values import parse_env_int_safe
        assert parse_env_int_safe(None, default=80) == 80
        assert parse_env_int_safe("invalid", default=3000) == 3000

