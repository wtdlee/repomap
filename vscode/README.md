## Repomap (VS Code)

Make your codebase navigable in seconds.

- **Quick Jump**: search RepoMap results and jump to files instantly
- **Current File view**: see pages/components/GraphQL/deps for the active editor
- **GraphQL Structure (Highlight)**: inspect query/fragment structure and click to jump + highlight in-editor
- **Serve / Generate**: run Repomap from VS Code (same engine as the npm package)

## Getting started

1) Run **`Repomap: Refresh`** to generate/load a report  
2) Open the **Repomap** activity bar  
3) Use:
   - **Current File**: context for the active editor
   - **Search (Quick Jump)**: search the report and jump
   - **GraphQL Structure (Highlight)**: run it while your cursor is inside `gql\`...\`` (or `gql(\`...\`)`)

## Commands

- **Repomap: Refresh**: generate and load `report.json`
- **Repomap: Open**: open the Repomap webview
- **Repomap: Search (Quick Jump)**: quick search/jump across the report
- **Repomap: GraphQL Structure (Highlight)**: show query/fragment structure and jump on click
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
- For GraphQL co-location, the highlight panel supports both `gql\`...\`` and `gql(/* GraphQL */ \`...\`)` patterns.


