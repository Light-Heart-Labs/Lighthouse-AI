# Bug: Silent exception swallow in streaming proxy causes partial 200 responses

**Reported by:** patil2001  
**File:** `ods/extensions/services/privacy-shield/proxy.py:418-424`  
**Severity:** HIGH  

## Description

The `body_iter()` async generator catches `httpx.TimeoutException` and generic `Exception` mid-stream, logs them, but does **not** re-raise. The generator exits normally via the `finally` block. Since the HTTP response status code (200) has already been sent, the client receives a partial/truncated body with a 200 status code.

## Impact

- Client sees HTTP 200 with incomplete data
- No way for caller to distinguish truncated response from complete one
- Data integrity issue: downstream consumers process partial responses as if complete

## Fix

Re-raise after logging, or capture exception info and pass it to `__aexit__` so the client gets an error signal.