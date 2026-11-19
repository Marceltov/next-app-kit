import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    // Every test runs with DATA_DIR in a temporary directory of its own (conventions: code/tests-temp-dirs).
    setupFiles: ["./src/testing/setup.ts"],
    include: ["src/**/*.test.ts"],
  },
});
