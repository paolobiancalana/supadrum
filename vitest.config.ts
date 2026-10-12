import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Agent worktrees live under .claude/worktrees and carry their own copy of
    // the suite; running them from the main checkout multiplies every test.
    exclude: [...configDefaults.exclude, ".claude/**"],
    coverage: {
      enabled: false,
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts"]
    },
    environment: "node",
    setupFiles: ["test/setup.ts"],
    testTimeout: 10_000
  }
});
