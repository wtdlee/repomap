---
"@wtdlee/repomap": minor
---

Add automatic port detection and fix critical dependency bug

**Bug Fix:**
- Move `express` from devDependencies to dependencies (fixes "Cannot find package 'express'" error when using npx)

**New Feature:**
- Automatically find available port if default port (3030) is in use
- Try up to 10 consecutive ports (3030-3039)
- Display warning message when using alternative port
