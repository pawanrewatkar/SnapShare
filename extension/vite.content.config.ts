import { defineConfig } from 'vite';
import { resolve } from 'node:path';

/** Content scripts are injected on demand and must be single self-contained IIFE files. */
export default defineConfig(({ mode }) => ({
  resolve: { alias: { '@': resolve(import.meta.dirname, 'src') } },
  build: {
    outDir: mode === 'e2e' ? 'dist-e2e' : 'dist',
    emptyOutDir: false,
    target: 'chrome116',
    lib: { entry: resolve(import.meta.dirname, 'src/content/index.ts'), formats: ['iife'], name: 'SnapShareContent', fileName: () => 'content.js' },
  },
}));
