---
"@wtdlee/repomap": patch
---

Fix web-tree-sitter version compatibility with tree-sitter-wasms

Pin web-tree-sitter to version 0.25.10 to maintain compatibility with tree-sitter-wasms package.
The tree-sitter-wasms package builds WASM files using tree-sitter-cli 0.20.x, which is incompatible
with web-tree-sitter 0.26.x due to ABI changes. This fixes Rails analysis failures in npx environments.
