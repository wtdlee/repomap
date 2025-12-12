---
"@wtdlee/repomap": patch
---

Fix Express 5 route pattern compatibility

- Update wildcard route `/docs/*` to Express 5 syntax `/docs/*path`
- Fixes "Missing parameter name" error when starting server
