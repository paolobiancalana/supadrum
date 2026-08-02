import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      enabled: false,
      provider: "v8",
      all: true,
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.d.ts"]
    },
    environment: "node",
    testTimeout: 10_000
  }
});
