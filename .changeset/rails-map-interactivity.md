---
"@wtdlee/repomap": minor
---

### New Features

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
