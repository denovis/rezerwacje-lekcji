import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['db/tests/**/*.test.ts'],
    globalSetup: ['db/tests/global-setup.ts'],
    // Testy bazy korzystają z jednej bazy testowej — pliki po kolei.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
