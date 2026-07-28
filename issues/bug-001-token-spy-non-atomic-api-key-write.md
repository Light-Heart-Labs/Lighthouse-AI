# Bug: Non-atomic write_text for API key file in token-spy

**Reported by:** patil2001  
**File:** `ods/extensions/services/token-spy/main.py:278`  
**Severity:** Medium  

## Description

`_key_file.write_text(TOKEN_SPY_API_KEY)` writes the auto-generated API key directly without using a tempfile + `os.replace` pattern. If the process crashes mid-write, a partial/truncated key is left on disk. The `chmod(0o600)` at line 279 runs after the write, meaning there's a window where the key file exists with default umask permissions.

## Impact

- API key file can be corrupted on crash, causing auth failures on restart
- Brief permission window where key is world-readable
- Inconsistent with `save_settings()` in the same file which uses atomic writes

## Fix

Use `tempfile.mkstemp()` + `os.replace()` for atomic write with restricted permissions before the replace.