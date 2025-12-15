import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    extension: 'src/extension.ts',
  },
  outDir: 'dist',
  format: ['cjs'],
  platform: 'node',
  target: 'node18',
  sourcemap: true,
  clean: true,
  external: ['vscode'],
});
