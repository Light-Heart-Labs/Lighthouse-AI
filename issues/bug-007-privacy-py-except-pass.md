# Bug: `except Exception: pass` in privacy.py violates project policy

**Reported by:** patil2001  
**File:** `ods/extensions/services/dashboard-api/routers/privacy.py:76-77`  
**Severity:** Medium  

## Description

```python
try:
    body = e.read().decode()
except Exception:
    pass
```

This is the exact pattern explicitly forbidden by the project's error-handling rules in `CLAUDE.md`: "Never `except Exception: pass` or `except Exception: return None`." The `os.chmod()` failure is silently swallowed with zero logging, making debugging impossible if this path fails.

## Impact

- Violates project error-handling policy
- Any exception during HTTP error body decoding (including `MemoryError`, `TypeError`, etc.) is silently swallowed
- No logging means root cause is invisible in production

## Fix

Catch only the specific exceptions that `e.read().decode()` can raise (`UnicodeDecodeError`, `OSError`), and log at minimum a warning.