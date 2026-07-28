# Bug: Shared PII session across clients sharing API key

**Reported by:** patil2001  
**File:** `ods/extensions/services/privacy-shield/proxy.py:147-161`  
**Severity:** HIGH  

## Description

The `get_session()` function uses the full `Authorization` header value as the session key seed. All clients sharing the same API key share the same PII session. PII detected from one client's prompts is stored in the shared session map, and PII restoration on another client's responses uses the combined PII map, cross-contaminating PII mappings between unrelated conversations.

## Impact

- User A's personal information (emails, phone numbers, SSNs) could be restored into User B's responses
- Privacy violation: PII data leaks between users sharing the same proxy
- The default configuration uses a single shared `SHIELD_API_KEY`

## Fix

Add a per-client identifier (e.g., a session ID from the caller, or a unique client-side token) to the session key generation.