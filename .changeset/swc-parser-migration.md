---
"@wtdlee/repomap": minor
---

Migrate DataFlowAnalyzer to @swc/core for 10x faster parsing

- Replace ts-morph with @swc/core for component file parsing (10x faster)
- Fix empty query name issue in GraphQL hook detection
- Make Q/M counts in page list match detail panel counts
- Add step-by-step logging in GraphQL analyzer for debugging

