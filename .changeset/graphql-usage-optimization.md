---
"@wtdlee/repomap": patch
---

Optimize GraphQL usage detection for large codebases

- Use single regex to match all Document names in one pass
- Add quick pre-filter to skip irrelevant files
- Process files in parallel batches
- Reduces analysis time significantly for projects with 600+ operations

