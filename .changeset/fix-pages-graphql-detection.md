---
"@wtdlee/repomap": patch
---

Fix page component and GraphQL operation detection for Next.js App Router and server-side GraphQL patterns

- Add support for `FunctionDeclaration` in default exports (fixes detection of `export default function PageName()` pattern commonly used in Next.js App Router)
- Add support for `ClassDeclaration`/`ClassExpression` for legacy React class components
- Fix App Router root page path mapping (`page.tsx` now correctly maps to `/` instead of `/page`)
- Replace hardcoded component path patterns with generic project import detection using `isProjectImport()`
- Improve GraphQL operation usage detection by adding `operationByName` lookup (fixes detection for codegen outputs without 'Document' suffix)
