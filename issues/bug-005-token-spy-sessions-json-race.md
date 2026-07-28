# Bug: Race condition + non-atomic write in token-spy sessions.json

**Reported by:** patil2001  
**File:** `ods/extensions/services/token-spy/main.py:1401-1409`  
**Severity:** HIGH  

## Description

`_kill_session` performs a read-modify-write cycle on `sessions.json` without file locking. Two concurrent calls (e.g., from polling loop and dashboard request) can overwrite each other's changes. Additionally, `open(sessions_json, "w")` truncates the file before writing, so a crash mid-write corrupts the file.

## Impact

- Lost updates to sessions registry under concurrent access
- Corrupted sessions.json on crash
- Session cleanup timer state can become inconsistent

## Fix

Use file locking and atomic write pattern (tempfile + os.replace).