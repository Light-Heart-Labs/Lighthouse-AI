# Bugs Found in ODS Codebase

**Reported by:** patil2001  
**Date:** 2026-07-28  

## Summary

10 bugs found across the codebase via thorough code review. Issues are documented in separate files.

| # | Bug | File | Severity |
|---|-----|------|----------|
| 1 | Non-atomic API key write | `token-spy/main.py:278` | Medium |
| 2 | Missing `await` on coroutine | `privacy-shield/proxy.py:373-377` | **HIGH** |
| 3 | Silent exception swallow in streaming | `privacy-shield/proxy.py:418-424` | **HIGH** |
| 4 | Shared PII session across clients | `privacy-shield/proxy.py:147-161` | **HIGH** |
| 5 | Race condition + non-atomic write in sessions.json | `token-spy/main.py:1401-1409` | **HIGH** |
| 6 | Non-atomic write of dashboard API key | `security.py:18` | Medium |
| 7 | `except Exception: pass` policy violation | `privacy.py:76` | Medium |
| 8 | Credential reuse (agent key = dashboard key) | `config.py:388` | Medium |
| 9 | Hermes token leaked in URL query param | `hermes_bridge.py:121` | Medium |
| 10 | Missing input validation on int() calls | `token-spy/main.py:1589,1597,1621` | Medium |

## Status

- [ ] Issue documentation created ✓
- [ ] Issues pushed to GitHub
- [ ] Fixes applied
- [ ] PRs raised