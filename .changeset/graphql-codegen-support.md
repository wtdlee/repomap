---
"@wtdlee/repomap": minor
---

Add GraphQL Code Generator client preset support

- Parse `__generated__/graphql.ts` for TypedDocumentNode exports
- Track Document imports in components (`useQuery`, `useMutation`, etc.)
- Deduplicate operations from multiple sources
- Optimized line-by-line parsing for large generated files (handles 650+ operations)

