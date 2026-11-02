import { defineConfig } from 'vitest/config';

// Deliberately separate from the full suite: no CLI binaries, live daemon, model or Lark.
export default defineConfig({
  test: {
    include: ['test/topic/**/*.test.ts', 'test/dashboard-sessions-ui.test.ts'],
    globalSetup: ['./test/unit-global-setup.ts'],
    setupFiles: ['./test/unit-setup.ts', './test/topic/offline-setup.ts'],
    maxWorkers: 2,
    testTimeout: 10_000,
  },
});
