import { fileURLToPath } from "node:url";

import { configDefaults, defineConfig } from "vitest/config";
import { vitestRetryCount } from "../../scripts/ci/vitest-retry.mjs";

const retry = vitestRetryCount();
const timingReporter = fileURLToPath(
  new URL("../../scripts/ci/package-test-timing-reporter.mjs", import.meta.url),
);

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    ...(retry > 0 ? { retry } : {}),
    ...(process.env.CI ? { reporters: [...configDefaults.reporters, timingReporter] } : {}),
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      thresholds: { lines: 50, functions: 40, branches: 30, statements: 50 },
    },
  },
});
