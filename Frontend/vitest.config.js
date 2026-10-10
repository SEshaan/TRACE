import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.{js,jsx}'],
    environment: 'node',
    globals: false,
    setupFiles: ['./src/test/setup.js'],
    reporters: ['default'],
    coverage: {
      provider: 'v8',
      // `--cov` (a.k.a. --coverage) turns this on; report uncovered lines via
      // term-missing so the frontend suite can be checked for gaps.
      include: ['src/**/*.{js,jsx}'],
      exclude: [
        '**/node_modules/**',
        '**/*.test.js',
        '**/*.test.jsx',
        '**/setup.js',
        'src/test/**',
      ],
      // `term-missing` is a jest flag name; vitest/istanbul exposes the same
      // info via the `text` reporter (per-file table listing uncovered lines).
      reporter: ['text-summary', 'text'],
    },
  },
});
