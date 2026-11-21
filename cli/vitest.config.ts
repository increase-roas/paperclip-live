import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Explicit naming contract: CLI unit tests use the .test suffix and live
    // beside the command or under src/__tests__.
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    hookTimeout: 30_000,
    teardownTimeout: 30_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts", "src/**/*.tsx"],
      exclude: ["src/**/*.test.ts", "src/**/*.test.tsx", "src/**/*.d.ts"],
      thresholds: { lines: 20, functions: 15, branches: 10, statements: 20 },
    },
  },
});
