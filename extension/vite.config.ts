import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

const PLACEHOLDER_CLIENT_ID = 'REPLACE_WITH_YOUR_CLIENT_ID.apps.googleusercontent.com';

/** Emits manifest.json with the OAuth client id (from VITE_GOOGLE_CLIENT_ID) and the stable extension key. */
function manifestPlugin(clientId: string, e2e: boolean): Plugin {
  return {
    name: 'snapshare-manifest',
    generateBundle() {
      const manifest = JSON.parse(readFileSync(resolve(import.meta.dirname, 'manifest/manifest.json'), 'utf8'));
      const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, 'package.json'), 'utf8'));
      manifest.version = pkg.version;
      const keyPath = resolve(import.meta.dirname, 'manifest/public-key.txt');
      if (existsSync(keyPath)) manifest.key = readFileSync(keyPath, 'utf8').trim();
      if (!clientId) this.warn('VITE_GOOGLE_CLIENT_ID is not set: Google sign-in will be disabled in this build.');
      manifest.oauth2 = { client_id: clientId || PLACEHOLDER_CLIENT_ID, scopes: ['openid', 'email', 'profile', 'https://www.googleapis.com/auth/drive.file'] };
      if (e2e) {
        manifest.host_permissions = [...(manifest.host_permissions ?? []), '<all_urls>'];
        manifest.name += ' (E2E TEST BUILD)';
      }
      this.emitFile({ type: 'asset', fileName: 'manifest.json', source: JSON.stringify(manifest, null, 2) });
    },
  };
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, import.meta.dirname, 'VITE_');
  const clientId = (env.VITE_GOOGLE_CLIENT_ID ?? '').trim();
  return {
    plugins: [react(), tailwindcss(), manifestPlugin(clientId, mode === 'e2e')],
    resolve: { alias: { '@': resolve(import.meta.dirname, 'src') } },
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
