---
"@wtdlee/repomap": patch
---

Fix Rails analyzer returning empty results when installed via npx

- Fixed WASM file path resolution for tree-sitter-ruby
- Use Node.js module resolution (`require.resolve`) instead of hardcoded relative paths
- Rails routes, controllers, and models are now correctly detected across all installation methods
