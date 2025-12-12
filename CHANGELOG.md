# @wtdlee/repomap

## 0.3.2

### Patch Changes

- 87d03ab: Fix Express 5 route pattern compatibility
  - Update wildcard route `/docs/*` to Express 5 syntax `/docs/*path`
  - Fixes "Missing parameter name" error when starting server

- 87d03ab: Refactor inline styles to CSS utility classes for better maintainability
  - Add 50+ reusable CSS utility classes to common.css
  - Convert inline styles to class-based styling in page-map-generator
  - Improve tag color contrast for better readability
  - Add semantic class names: `.tag-*`, `.text-*`, `.hint`, `.code-block`, `.detail-item`, etc.
  - Reduce code duplication and improve style consistency

## 0.3.1

### Patch Changes

- 4fb6700: Migrate build system from tsc to tsup for faster builds and smaller package

  **Build Performance:**
  - ESM build time: ~2.5s → 182ms (-93%)

  **Package Size Reduction:**
  - Unpacked: 696 kB → 592 kB (-15%)
  - Packed: 144 kB → 121 kB (-16%)
  - Files: 67 → 32 (-52%)

  **Technical Changes:**
  - Use tsup (esbuild-based) for bundling
  - Enable code splitting and tree-shaking
  - Keep dependencies external (not bundled)

## 0.3.0

### Minor Changes

- 4998d68: Add automatic port detection and fix critical dependency bug

  **Bug Fix:**
  - Move `express` from devDependencies to dependencies (fixes "Cannot find package 'express'" error when using npx)

  **New Feature:**
  - Automatically find available port if default port (3030) is in use
  - Try up to 10 consecutive ports (3030-3039)
  - Display warning message when using alternative port

## 0.2.0

### Minor Changes

- be381ab: Update Express to v5 with improved async error handling and TypeScript support

### Patch Changes

- 962ef0a: Improve open-source contribution experience and optimize package size
  - Add CONTRIBUTING.md with development setup and guidelines
  - Add CODE_OF_CONDUCT.md (Contributor Covenant v2.1)
  - Add issue templates (bug report, feature request)
  - Add pull request template
  - Reduce package size by 37% (remove source maps)
  - Link changelog to GitHub Releases
