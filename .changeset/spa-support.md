---
"@wtdlee/repomap": minor
---

Add SPA (react-router-dom) support and JavaScript project support

- Parse App.tsx/jsx/js for react-router-dom Route components to detect pages in SPA projects
- Add fallback for projects without tsconfig.json using default compiler options (allowJs, jsx)
- Support PrivateRoute and Route component patterns

