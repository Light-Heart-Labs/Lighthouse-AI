# Bug: Missing input validation on int() calls causes 500 errors

**Reported by:** patil2001  
**File:** `ods/extensions/services/token-spy/main.py:1589,1597,1621`  
**Severity:** Medium  

## Description

The `/api/settings` endpoint accepts user-supplied JSON values and blindly calls `int(val)` on them:
- Line 1589: `val = int(body["session_char_limit"])` — raises `ValueError` on floats, strings, null
- Line 1597: `val = int(body["poll_interval_minutes"])` — same issue
- Lines 1620-1621: `val = int(val)` on agent settings — same issue

A client sending `{"session_char_limit": "not_a_number"}` triggers an unhandled 500 Internal Server Error with stack trace potentially leaking in the response.

## Impact

- API returns 500 on malformed input instead of proper 400 validation error
- Stack trace may leak in error response
- Poor developer experience for API consumers

## Fix

Wrap `int()` calls in try/except ValueError and return proper HTTP 400 validation errors.