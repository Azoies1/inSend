import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Live sandbox tests need credentials and network; run them with `npm run test:live`.
    exclude: [...configDefaults.exclude, '**/*.live.test.ts'],
  },
});
