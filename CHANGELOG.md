# @wtdlee/repomap

## 0.8.0

### Minor Changes

- 7f9fe06: ### New Features
  - **`--temp` option**: Use OS temp directory to avoid creating files in repository
    - Auto-cleanup on server exit (Ctrl+C)
    - Works with both `serve` and `generate` commands
  - **`-o, --output` for serve**: Specify custom output directory for serve command

  ### Rails Map Enhancements
  - **Fullscreen mode**: View ER diagrams in fullscreen with the ⛶ button
  - **Interactive diagrams**: Click on model boxes to view details (associations, validations, scopes)
  - **Pan & Zoom**: Navigate large diagrams with drag-to-pan and scroll-to-zoom

  ### Branding
  - **Favicon**: Added favicon support for all pages (page-map, rails-map, docs)
  - **Web manifest**: PWA-ready with app icons
  - **README logo**: New centered logo with badge layout

  ### Performance
  - **Removed unused dependencies**: @babel/parser, @babel/traverse, ts-morph
  - **Faster install**: ~50MB less dependencies to download

## 0.7.0

### Minor Changes

- 17deab7: ### CLI Output Improvements
  - Cleaner, more concise console output
  - Remove verbose logging (use `REPOMAP_VERBOSE=1` for detailed logs)
  - Display analysis summary with clear metrics

  ### Performance Optimization
  - Remove caching system (no longer needed with SWC's fast parsing)
  - Reduce package size by removing cache.ts and related dependencies

  ### Rails Map Enhancements
  - Add fullscreen mode for Mermaid diagrams
  - Improved diagram controls (zoom, pan, reset, fullscreen)

  ### Bug Fixes
  - Fix 404 page handling with helpful navigation
  - Silent WebSocket connection logs
  - Remove redundant debug output

## 0.6.0

### Minor Changes

- 73605a0: Add SPA (react-router-dom) support and JavaScript project support
  - Parse App.tsx/jsx/js for react-router-dom Route components to detect pages in SPA projects
  - Add fallback for projects without tsconfig.json using default compiler options (allowJs, jsx)
  - Support PrivateRoute and Route component patterns

## 0.5.0

### Minor Changes

- 5672ee3: Migrate DataFlowAnalyzer to @swc/core for 10x faster parsing
  - Replace ts-morph with @swc/core for component file parsing (10x faster)
  - Fix empty query name issue in GraphQL hook detection
  - Make Q/M counts in page list match detail panel counts
  - Add step-by-step logging in GraphQL analyzer for debugging

## 0.4.1

### Patch Changes

- ef3ae92: Optimize GraphQL usage detection for large codebases
  - Use single regex to match all Document names in one pass
  - Add quick pre-filter to skip irrelevant files
  - Process files in parallel batches
  - Reduces analysis time significantly for projects with 600+ operations

## 0.4.0

### Minor Changes

- b0b68e4: Add GraphQL Code Generator client preset support
  - Parse `__generated__/graphql.ts` for TypedDocumentNode exports
  - Track Document imports in components (`useQuery`, `useMutation`, etc.)
  - Deduplicate operations from multiple sources
  - Optimized line-by-line parsing for large generated files (handles 650+ operations)

## 0.3.3

### Patch Changes

- 2dc5b70: Fix Rails analyzer returning empty results when installed via npx
  - Fixed WASM file path resolution for tree-sitter-ruby
  - Use Node.js module resolution (`require.resolve`) instead of hardcoded relative paths
  - Rails routes, controllers, and models are now correctly detected across all installation methods

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
