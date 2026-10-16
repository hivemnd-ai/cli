import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Git provenance fixtures launch bounded subprocesses; avoid coverage pool contention.
    maxWorkers: 1,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: ["src/index.ts"],
      thresholds: {
        branches: 100,
        functions: 100,
        lines: 100,
        statements: 100,
      },
    },
  },
});
