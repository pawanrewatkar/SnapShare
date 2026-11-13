import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';

/** Emits manifest.json with the API origin injected into host_permissions. */
function manifestPlugin(apiBase: string, e2e: boolean): Plugin {
  return {
    name: 'snapshare-manifest',
    generateBundle() {
      const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, 'manifest/manifest.json'), 'utf8'));
      const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, 'package.json'), 'utf8'));
      manifest.version = pkg.version;
      const origin = new URL(apiBase).origin + '/*';
      manifest.host_permissions = Array.from(new Set([...(manifest.host_permissions ?? []), origin, ...(e2e ? ['<all_urls>'] : [])]));
      if (e2e) manifest.name += ' (E2E TEST BUILD)';
      this.emitFile({ type: 'asset', fileName: 'manifest.json', source: JSON.stringify(manifest, null, 2) });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, import.meta.dirname, 'VITE_');
  const apiBase = env.VITE_API_BASE_URL || 'http://localhost:3000';
  return {
    plugins: [react(), tailwindcss(), manifestPlugin(apiBase, mode === 'e2e')],
    resolve: { alias: { '@': resolve(import.meta.dirname, 'src') } },
    define: { __API_BASE__: JSON.stringify(apiBase) },
    build: {
      outDir: mode === 'e2e' ? 'dist-e2e' : 'dist',
      emptyOutDir: true,
      sourcemap: mode === 'development',
      target: 'chrome116',
      rollupOptions: {
        input: {
          popup: resolve(import.meta.dirname, 'popup.html'),
          editor: resolve(import.meta.dirname, 'editor.html'),
          gallery: resolve(import.meta.dirname, 'gallery.html'),
          settings: resolve(import.meta.dirname, 'settings.html'),
          recorder: resolve(import.meta.dirname, 'recorder.html'),
          offscreen: resolve(import.meta.dirname, 'offscreen.html'),
          permissions: resolve(import.meta.dirname, 'permissions.html'),
          background: resolve(import.meta.dirname, 'src/background/index.ts'),
        },
        output: {
          entryFileNames: (chunk) => (chunk.name === 'background' ? 'background.js' : 'assets/[name]-[hash].js'),
        },
      },
    },
  };
});
