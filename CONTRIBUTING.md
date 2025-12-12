# Contributing to @wtdlee/repomap

First off, thank you for considering contributing to repomap! 🎉

## How Can I Contribute?

### Reporting Bugs

Before creating bug reports, please check existing issues to avoid duplicates.

When creating a bug report, include:

- **Clear title** describing the issue
- **Steps to reproduce** the problem
- **Expected behavior** vs actual behavior
- **Environment info** (Node.js version, OS, etc.)
- **Code samples** or error messages if applicable

### Suggesting Features

Feature requests are welcome! Please:

- Check if the feature has already been requested
- Describe the use case clearly
- Explain why this would be useful to most users

### Pull Requests

1. **Fork** the repository
2. **Clone** your fork locally
3. **Create a branch** for your changes:
   ```bash
   git checkout -b feature/amazing-feature
   ```
4. **Install dependencies**:
   ```bash
   pnpm install
   ```
5. **Make your changes** and ensure:
   - Code follows existing style (run `pnpm lint`)
   - Tests pass (run `pnpm test`)
   - Build succeeds (run `pnpm build`)
6. **Commit** using conventional commits:
   ```bash
   git commit -m "feat: add amazing feature"
   ```
7. **Push** to your fork:
   ```bash
   git push origin feature/amazing-feature
   ```
8. **Open a Pull Request** with a clear description

## Development Setup

```bash
# Clone your fork
git clone https://github.com/YOUR_USERNAME/repomap.git
cd repomap

# Install dependencies
pnpm install

# Run in development mode
pnpm dev

# Run tests
pnpm test

# Build
pnpm build

# Lint & Format
pnpm lint
pnpm format
```

## Commit Convention

We follow [Conventional Commits](https://www.conventionalcommits.org/):

| Type | Description |
|------|-------------|
| `feat` | New feature |
| `fix` | Bug fix |
| `docs` | Documentation only |
| `style` | Code style (formatting, etc.) |
| `refactor` | Code refactoring |
| `test` | Adding/updating tests |
| `chore` | Maintenance tasks |
| `deps` | Dependency updates |
| `ci` | CI/CD changes |

Example:
```
feat(rails): add controller dependency analysis
fix(cli): handle empty config file
docs: update installation guide
```

## Code Style

- TypeScript for all source code
- ESLint + Prettier for formatting
- Meaningful variable and function names
- Comments for complex logic (in English)

## Testing

- Write tests for new features
- Ensure existing tests pass before submitting PR
- Use Vitest for unit tests

## Questions?

Feel free to open an issue with the `question` label or start a discussion.

Thank you for contributing! 🙏

