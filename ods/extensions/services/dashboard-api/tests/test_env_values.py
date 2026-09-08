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


class TestParseEnvBooleanSafe:

    def test_parses_truthy_and_falsy_values(self):
        from env_values import parse_env_boolean_safe
        assert parse_env_boolean_safe("true") is True
        assert parse_env_boolean_safe("YES") is True
        assert parse_env_boolean_safe("1") is True
        assert parse_env_boolean_safe("false") is False
        assert parse_env_boolean_safe("0") is False

    def test_handles_none_and_defaults(self):
        from env_values import parse_env_boolean_safe
        assert parse_env_boolean_safe(None) is False
        assert parse_env_boolean_safe(None, default=True) is True
        assert parse_env_boolean_safe("unknown", default=False) is False

