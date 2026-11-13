import { defineConfig } from '@playwright/test';

/**
 * Real-browser tests (Chromium):
 *  - editor.spec.ts: drives the real Fabric.js editor engine in a harness page (blur/crop/undo/export pixels).
 *  - extension.spec.ts: loads the built extension (dist-e2e, test build with <all_urls>) and runs real captures.
 * Build first: npm run build:e2e
 */
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  workers: 1,
  reporter: [['list']],
  use: { trace: 'retain-on-failure' },
  webServer: { command: 'npx vite --port 5179 --strictPort', url: 'http://localhost:5179/tests/e2e/fixtures/long.html', reuseExistingServer: true, timeout: 60_000 },
});
