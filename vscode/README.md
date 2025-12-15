## Repomap (VS Code)

**Understand GraphQL at a glance. Click any field to jump to the exact place in your editor.**

Repomap’s main feature is **GraphQL Structure (Highlight)**: it visualizes the structure of a query/fragment (including fragment spreads) and keeps navigation inside VS Code.

## Main feature: GraphQL Structure (Highlight)

**What it does**

- Shows a clean, query-like structure view for the GraphQL under your cursor/selection
- Resolves fragment spreads (co-located and cross-file)
- Click-to-jump to the exact file/line and highlights only the focused field (no distracting “highlight everything” mode)
- Optional cursor-follow: as you move the editor cursor, the panel selection updates (and vice versa)

**How to use**

1) Put your cursor inside a GraphQL document (or select a range)  
2) Run **`Repomap: GraphQL Structure (Highlight)`**  
3) Click any field to jump, or toggle **Follow cursor** in the panel

Supported co-location patterns:

```ts
gql`...`
gql(`...`)
gql(/* GraphQL */ `...`)
```

## Workflow (recommended)

1) Run **`Repomap: Refresh`** once to generate/load a report  
2) Use **GraphQL Structure (Highlight)** while reading code  
3) Use the sidebar for quick context and navigation

## Other productivity features

- **Quick Jump**: search Repomap results and jump to files instantly
- **Current File view**: see pages/components/GraphQL/deps for the active editor
- **Serve / Generate**: run Repomap from VS Code (same engine as the npm package)

## Commands

- **Repomap: Refresh**: generate and load `report.json`
- **Repomap: GraphQL Structure (Highlight)**: show query/fragment structure and jump on click
- **Repomap: Search (Quick Jump)**: quick search/jump across the report
- **Repomap: Open**: open the Repomap webview
- **Repomap: Serve**: start Repomap dev server (extension uses `--no-open` by default)
- **Repomap: Generate (Static)**: generate static docs

## Settings

- **`repomap.npxSpecifier`**: npm package specifier (default: `@wtdlee/repomap`)
- **`repomap.port`**: port for `serve` (default: `3030`)
- **`repomap.useTempOutput`**: write output to extension-owned storage by default (avoids repo diffs)
- **`repomap.autoRefreshOnSave`** / **`repomap.autoRefreshDebounceMs`**: optional auto refresh
- **`repomap.hideDocumentVariableNames`**: hide GraphQL variable names ending with `Document`

## Notes

- This extension runs Repomap via `npx`. Make sure your workspace can run Node tools.
