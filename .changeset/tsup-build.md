---
"@wtdlee/repomap": patch
---

Migrate build system from tsc to tsup for faster builds and smaller package

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
