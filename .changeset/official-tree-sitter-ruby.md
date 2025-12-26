---
"@wtdlee/repomap": patch
---

Switch from tree-sitter-wasms to official tree-sitter-ruby package and unify glob libraries

- Replace `tree-sitter-wasms` with official `tree-sitter-ruby` package
- Upgrade `web-tree-sitter` from `^0.25.10` to `^0.26.3`
- Fix WASM compatibility issue with `web-tree-sitter` 0.26.x (dylink.0 format)
- Unify glob libraries: replace `fast-glob` with `glob` across all analyzers

Benefits:
- Latest Ruby grammar support (0.23.1 vs 0.20.1)
- Better compatibility with latest web-tree-sitter
- Official maintenance by tree-sitter team
- Reduced package size (only Ruby WASM instead of 37 languages)
- Reduced dependencies (removed fast-glob)
