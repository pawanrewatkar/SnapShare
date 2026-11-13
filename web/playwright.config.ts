import { defineConfig } from '@playwright/test';

/** Browser tests for the public website, run against `next dev` with the in-memory E2E repository. */
export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 60_000,
  reporter: [['list']],
  use: { baseURL: 'http://localhost:3100' },
  webServer: {
    command: 'npx next dev --port 3100',
    url: 'http://localhost:3100/api/health',
    reuseExistingServer: false,
    timeout: 120_000,
    env: { SNAPSHARE_E2E_MEMORY: '1' },
  },
});
