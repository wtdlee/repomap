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
  minify: false, // Keep readable for debugging
  external: [
    // Node.js built-ins
    'fs',
    'fs/promises',
    'path',
    'http',
    'net',
    'child_process',
    'url',
    // Dependencies (not bundled, installed separately)
    '@babel/parser',
    '@babel/traverse',
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
    'ts-morph',
    'web-tree-sitter',
    'yaml',
  ],
  onSuccess: async () => {
    // Copy CSS assets after build
    const { execSync } = await import('child_process');
    execSync('mkdir -p dist/generators/assets && cp src/generators/assets/*.css dist/generators/assets/');
    console.log('✓ Copied CSS assets');
  },
});

