---
"@wtdlee/repomap": patch
---

Move typescript from devDependencies to dependencies and exclude from bundle

- Move `typescript` to runtime dependencies as it's required at runtime for type analysis
- Add `typescript` to tsup external list to avoid bundling the large TS compiler
- Add `--pool=threads` option to vitest for improved test performance
