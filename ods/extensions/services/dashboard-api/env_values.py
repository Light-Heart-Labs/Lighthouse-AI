"""Small, dependency-free helpers for values read from ODS ``.env`` files."""


def strip_matching_quotes(value: str) -> str:
    """Trim whitespace and remove exactly one matching outer quote pair.

    ODS writes shell-compatible values that may be wrapped in single or
    double quotes. Unmatched or mixed quotes are data, not delimiters, and
    must survive reads unchanged.
    """
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        return value[1:-1]
    return value


def parse_env_int_safe(
    val: object, default: int = 0, min_val: int | None = None, max_val: int | None = None
) -> int:
    """Parse integer environment value with min/max bounds clamping safely.

    Returns default value for invalid format, NaN/float inputs, or None without exception.
    """
    if val is None:
        return default
    try:
        res = int(float(str(val).strip()))
        if min_val is not None and res < min_val:
            res = min_val
        if max_val is not None and res > max_val:
            res = max_val
        return res
    except (ValueError, TypeError, OverflowError):
        return default

