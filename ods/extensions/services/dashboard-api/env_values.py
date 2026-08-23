"""Small, dependency-free helpers for values read from ODS ``.env`` files."""


_DOUBLE_QUOTE_ESCAPES = {'"', "$", "`", "\\"}


def _decode_double_quoted(value: str) -> str:
    """Decode the escape set shared by Bash and ODS's dotenv serializer."""
    decoded: list[str] = []
    index = 0
    while index < len(value):
        char = value[index]
        if (
            char == "\\"
            and index + 1 < len(value)
            and value[index + 1] in _DOUBLE_QUOTE_ESCAPES
        ):
            index += 1
            char = value[index]
        decoded.append(char)
        index += 1
    return "".join(decoded)


def strip_matching_quotes(value: str) -> str:
    """Trim whitespace and remove exactly one matching outer quote pair.

    ODS writes shell-compatible values that may be wrapped in single or
    double quotes. Unmatched or mixed quotes are data, not delimiters, and
    must survive reads unchanged.
    """
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        inner = value[1:-1]
        return _decode_double_quoted(inner) if value[0] == '"' else inner
    return value
