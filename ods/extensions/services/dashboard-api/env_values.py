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


def parse_env_integer_safe(
    val: object, default: int = 0, min_val: int | None = None, max_val: int | None = None
) -> int:
    """Parse environment integer values safely with bounds checking.

    Returns default on None or invalid non-integer string representations.
    Clamps value to min_val/max_val if provided.
    """
    if val is None:
        return default
    try:
        parsed = int(str(val).strip())
    except (ValueError, TypeError):
        return default

    if min_val is not None and parsed < min_val:
        return min_val
    if max_val is not None and parsed > max_val:
        return max_val
    return parsed

