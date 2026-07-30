import { defineConfig } from "vitest/config";

export default defineConfig({
  // Resolves the `@/*` alias from tsconfig.json natively, no plugin needed.
  resolve: { tsconfigPaths: true },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
