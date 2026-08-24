import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
    // Serialize test files: the isolated-vm red-team suite must not churn
    // isolates concurrently with other suites in the same worker.
    pool: "threads",
    poolOptions: { threads: { singleThread: true } },
    testTimeout: 20_000,
    hookTimeout: 20_000,
    sequence: { concurrent: false },
  },
});
