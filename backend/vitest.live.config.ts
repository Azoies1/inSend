import { defineConfig } from 'vitest/config';

/** Runs only the tests that call the live provider sandboxes. Needs credentials in the repo .env. */
export default defineConfig({
  test: {
    include: ['**/*.live.test.ts'],
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
