import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  testMatch: '**/*.spec.mjs',
  workers: 1,
  fullyParallel: false,
  retries: 0, // Never repeat content creation silently.
  timeout: 240_000,
  expect: { timeout: 20_000 },
  reporter: [['list'], ['html', { open: 'never' }], ['json', { outputFile: 'analysis/test-results.json' }]],
  // No Playwright browser fixture: all browser work runs through the existing MCP.
});
