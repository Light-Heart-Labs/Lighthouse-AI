# Bug: ODS agent key falls back to dashboard API key (credential reuse)

**Reported by:** patil2001  
**File:** `ods/extensions/services/dashboard-api/config.py:388`  
**Severity:** Medium  

## Description

```python
ODS_AGENT_KEY = os.environ.get("ODS_AGENT_KEY", "") or DASHBOARD_API_KEY
```

If `ODS_AGENT_KEY` is not set, the dashboard API key is reused as the host agent authentication key. This violates least-privilege: a compromise of one key compromises both systems. The agent key grants filesystem write access (.env file modification, container recreation), while the dashboard key should only grant read access to status information.

## Impact

- Single key compromise gives attacker full host agent access
- Dashboard authentication and host agent authentication share the same credential
- CSRF/XSS in dashboard UI gives attacker authenticated access to host agent

## Fix

Generate a separate agent key if one is not provided, or require explicit configuration of `ODS_AGENT_KEY`.