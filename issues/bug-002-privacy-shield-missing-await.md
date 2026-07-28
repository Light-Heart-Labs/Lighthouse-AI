# Bug: Missing `await` on coroutine call in privacy-shield proxy

**Reported by:** patil2001  
**File:** `ods/extensions/services/privacy-shield/proxy.py:373-377`  
**Severity:** HIGH  

## Description

In `raw_chunks()`, when `StreamConsumed` is raised, the fallback calls `upstream.read()` without `await`. This returns a coroutine object instead of bytes. The coroutine object is truthy, so it gets yielded as raw binary data downstream.

## Impact

- Downstream receives coroutine objects instead of bytes
- `StreamRestorer.feed()` fails with `TypeError` trying to `codecs.decode()` a coroutine
- Client gets truncated response with 200 status code (looks like success but data is corrupted)
- In passthrough path, ASGI server errors trying to serialize coroutine object

## Fix

Add `await`: `raw = await upstream.read()`