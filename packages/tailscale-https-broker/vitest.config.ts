import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { configDefaults, defineConfig } from "vitest/config";
import { vitestRetryCount } from "../../scripts/ci/vitest-retry.mjs";

const root = dirname(fileURLToPath(import.meta.url));
const retry = vitestRetryCount();
const timingReporter = fileURLToPath(
  new URL("../../scripts/ci/package-test-timing-reporter.mjs", import.meta.url),
);

export default defineConfig({
  root,
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    ...(retry > 0 ? { retry } : {}),
    ...(process.env.CI ? { reporters: [...configDefaults.reporters, timingReporter] } : {}),
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      thresholds: { lines: 60, functions: 60, branches: 50, statements: 60 },
    },
  },
});
