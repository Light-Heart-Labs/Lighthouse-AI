# Bug: Non-atomic write of dashboard API key in security.py

**Reported by:** patil2001  
**File:** `ods/extensions/services/dashboard-api/security.py:18`  
**Severity:** Medium  

## Description

`key_file.write_text(DASHBOARD_API_KEY)` writes the generated API key directly without using a tempfile + `os.replace` pattern. If the write is interrupted, the key file at `/data/dashboard-api-key.txt` may be left in a partial/corrupt state. On next container restart, the application will attempt to read this corrupt file or generate a new key, causing authentication failures.

## Impact

- Corrupt key file on crash → auth failures on restart
- Clients holding old key get locked out
- Inconsistent with PR #2213 fix pattern used elsewhere in this repo

## Fix

Use `tempfile.NamedTemporaryFile` + `os.replace` for atomic write.