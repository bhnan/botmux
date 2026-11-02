import { defineConfig } from 'vitest/config';

// Deliberately separate from the full suite: no CLI binaries, live daemon, model or Lark.
export default defineConfig({
  test: {
    include: ['test/topic/**/*.test.ts', 'test/dashboard-sessions-ui.test.ts', 'test/lark-message-pagination.test.ts'],
    globalSetup: ['./test/unit-global-setup.ts'],
    setupFiles: ['./test/unit-setup.ts', './test/topic/offline-setup.ts'],
    // Bun's Vitest external-module bridge loses zod's namespace re-export; execute the
    // installed dependency through Vite in both runtimes (no mock or alternate validator).
    server: { deps: { inline: ['zod'] } },
    maxWorkers: 2,
    testTimeout: 10_000,
  },
});
