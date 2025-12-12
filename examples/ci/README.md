# CI/CD Examples for repomap

Example GitHub Actions workflows for integrating repomap into your CI/CD pipeline.

## Available Examples

### 1. GitHub Pages Deployment (`github-pages.yml`)

Automatically deploy documentation to GitHub Pages on every push to main.

**Setup:**
1. Copy `github-pages.yml` to `.github/workflows/docs.yml`
2. Go to repository Settings > Pages > Source > **GitHub Actions**
3. Push to main branch

**Features:**
- Automatic deployment on push
- Manual trigger support
- Concurrent deployment protection

### 2. PR Preview (`pr-preview.yml`)

Generate documentation for pull requests and post summary as a comment.

**Setup:**
1. Copy `pr-preview.yml` to `.github/workflows/pr-preview.yml`
2. Create a PR

**Features:**
- Documentation stats in PR comment
- Downloadable artifacts
- Auto-updating comments

### 3. Netlify Preview (`netlify-preview.yml`)

Deploy live preview to Netlify for each pull request.

**Setup:**
1. Create a Netlify site
2. Add secrets to repository:
   - `NETLIFY_AUTH_TOKEN`: Your Netlify personal access token
   - `NETLIFY_SITE_ID`: Your Netlify site ID
3. Copy `netlify-preview.yml` to `.github/workflows/netlify-preview.yml`

**Features:**
- Live preview URLs for each PR
- Automatic cleanup on PR close

## CLI Options for CI

```bash
# Generate static site for deployment
npx repomap generate --static --output ./docs

# CI mode (minimal output, proper exit codes)
npx repomap generate --static --ci --output ./docs

# Generate JSON report only
npx repomap generate --format json --output ./docs

# Generate for specific repository in monorepo
npx repomap generate --static --repo frontend --output ./docs
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `CI` | Auto-detected, enables CI mode |
| `GITHUB_TOKEN` | Automatically provided by GitHub Actions |

## Tips

### Caching Dependencies

Add caching for faster builds:

```yaml
- name: Setup Node.js
  uses: actions/setup-node@v4
  with:
    node-version: '20'
    cache: 'npm'
```

### Conditional Generation

Only generate on specific file changes:

```yaml
on:
  push:
    branches: [main]
    paths:
      - 'src/**'
      - 'app/**'
      - 'config/**'
```

### Matrix Builds for Monorepos

```yaml
jobs:
  generate:
    strategy:
      matrix:
        repo: [frontend, backend, mobile]
    steps:
      - run: npx repomap generate --repo ${{ matrix.repo }} --output ./docs/${{ matrix.repo }}
```

## Output Structure

```
docs/
├── index.html       # Page map (main view)
├── rails-map.html   # Rails map (if Rails detected)
├── report.json      # JSON data
└── assets/
    ├── common.css
    ├── page-map.css
    ├── rails-map.css
    └── docs.css
```

