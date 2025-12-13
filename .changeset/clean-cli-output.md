---
"@wtdlee/repomap": minor
---

### CLI Output Improvements
- Cleaner, more concise console output
- Remove verbose logging (use `REPOMAP_VERBOSE=1` for detailed logs)
- Display analysis summary with clear metrics

### Performance Optimization
- Remove caching system (no longer needed with SWC's fast parsing)
- Reduce package size by removing cache.ts and related dependencies

### Rails Map Enhancements
- Add fullscreen mode for Mermaid diagrams
- Improved diagram controls (zoom, pan, reset, fullscreen)

### Bug Fixes
- Fix 404 page handling with helpful navigation
- Silent WebSocket connection logs
- Remove redundant debug output
