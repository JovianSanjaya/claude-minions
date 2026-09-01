import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Agent workspaces can contain their own third-party test suites. They are
    // runtime evidence, not tests for this server package.
    include: ["src/**/*.test.ts"],
    exclude: [".data/**", "codex-home/**", "dist/**", "node_modules/**"],
  },
});
