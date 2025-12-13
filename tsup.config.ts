import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    cli: 'src/cli.ts',
    types: 'src/types.ts',
    'analyzers/index': 'src/analyzers/index.ts',
    'generators/index': 'src/generators/index.ts',
    'server/index': 'src/server/index.ts',
  },
  format: ['esm'],
  dts: true,
  splitting: true,
  clean: true,
  treeshake: true,
  minify: true, // Reduce package size
  external: [
    // Node.js built-ins
    'fs',
    'fs/promises',
    'path',
    'http',
    'net',
    'child_process',
    'url',
    'os',
    // Large runtime dependency: keep external to avoid bundling TS into dist
    'typescript',
    // Dependencies (not bundled, installed separately)
    '@swc/core',
    'chalk',
    'commander',
    'express',
    'fast-glob',
    'glob',
    'graphql',
    'marked',
    'open',
    'simple-git',
    'socket.io',
    'tree-sitter-wasms',
    'web-tree-sitter',
    'yaml',
  ],
  onSuccess: async () => {
    // Copy CSS assets after build
    const { execSync } = await import('child_process');
    execSync(
      'mkdir -p dist/generators/assets && cp src/generators/assets/*.css dist/generators/assets/'
    );
    // Copy favicon files
    execSync(
      'mkdir -p dist/generators/assets/favicon && cp src/generators/assets/favicon/* dist/generators/assets/favicon/'
    );
    console.log('✓ Copied assets (CSS + favicon)');
  },
});
