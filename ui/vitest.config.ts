import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      lexical: path.resolve(__dirname, "./node_modules/lexical/dist/Lexical.mjs"),
    },
  },
  test: {
    environment: "node",
    css: { include: [/motion-tokens\.css/] },
    // Explicit naming contract: unit tests live next to their source and use
    // the .test suffix. Browser/e2e suites under tests/ use .spec instead.
    include: ["src/**/*.test.{ts,tsx}", "storybook/**/*.test.{ts,tsx}"],
    setupFiles: ["./vitest.setup.ts"],
  },
});
