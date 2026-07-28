# Bug: Hermes session token leaked in URL query parameter

**Reported by:** patil2001  
**File:** `ods/extensions/services/dashboard-api/hermes_bridge.py:121`  
**Severity:** Medium  

## Description

```python
url = f"{ws_base}/api/ws?token={token}"
```

The Hermes session token is passed as a `?token=` query parameter in the WebSocket URL. Query parameters are logged by default by many proxies, load balancers, and reverse proxies (nginx, Traefik, Caddy, etc.), visible in `ps` output, and stored in server access logs.

## Impact

- Hermes session token leaks to proxy/load balancer logs
- Token visible in process listings
- Token stored in access logs indefinitely

## Fix

Pass the token via WebSocket protocol headers instead of URL query parameter. In aiohttp, use the `protocols` parameter or `headers` parameter of `ws_connect()`.