import { defineConfig } from "vitest/config";

export default defineConfig({
  // Resolves the `@/*` alias from tsconfig.json natively, no plugin needed.
  resolve: { tsconfigPaths: true },
  test: {
    // Node by default — the pipeline, the routes and the provider are all node-side. The
    // one component test opts into jsdom with a `@vitest-environment` docblock.
    environment: "node",
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
