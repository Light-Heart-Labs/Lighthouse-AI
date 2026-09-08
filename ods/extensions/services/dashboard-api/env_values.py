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


def parse_env_boolean_safe(val: object, default: bool = False) -> bool:
    """Parse environment string or boolean values safely.

    Truth-y strings: '1', 'true', 'yes', 'on', 'enable', 'enabled' (case-insensitive).
    Fals-y strings: '0', 'false', 'no', 'off', 'disable', 'disabled'.
    Returns default on None or unrecognized values without raising ValueError.
    """
    if val is None:
        return default
    if isinstance(val, bool):
        return val
    val_str = str(val).strip().lower()
    if val_str in {"1", "true", "yes", "on", "enable", "enabled"}:
        return True
    if val_str in {"0", "false", "no", "off", "disable", "disabled"}:
        return False
    return default

