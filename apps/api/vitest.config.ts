import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./vitest.setup.ts'],
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    exclude: ['node_modules', 'dist'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text', 'json', 'html'],
      exclude: [
        'node_modules/',
        'dist/',
        '**/*.test.ts',
        '**/__tests__/**',
        'scripts/',
        // Type-only module, and the server bootstrap, which the CI smoke test
        // covers by actually booting the built server.
        'src/lib/messages.ts',
        'src/types/**',
        'src/index.ts',
      ],
      thresholds: {
        lines: 90,
        functions: 95,
        branches: 80,
        statements: 90,
      },
    },
    testTimeout: 10000,
    hookTimeout: 10000,
  },
});
