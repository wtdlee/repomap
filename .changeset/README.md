# Changesets

This project uses [Changesets](https://github.com/changesets/changesets) for version management and npm publishing.

## How to Add a Changeset

When making changes that should be released:

```bash
npx changeset
```

This will prompt you to:
1. Select the packages to include (just press enter for single package)
2. Choose bump type (major/minor/patch)
3. Write a summary of changes

## Versioning Guide

- **patch** (0.0.x): Bug fixes, documentation updates, refactoring
- **minor** (0.x.0): New features, new analyzers, new CLI options
- **major** (x.0.0): Breaking changes, API changes

## Automated Release Process

1. Create a PR with your changes
2. Run `npx changeset` to add a changeset file
3. Merge to main
4. Changesets bot will create a "Version Packages" PR
5. Merge the version PR to trigger npm publish

