import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit is used for generating migrations only (`npm run db:generate`).
 * Migrations are applied at runtime by `src/db/migrate.ts` — see AGENTS.md.
 */
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/db/schema.ts",
  out: "./drizzle",
});
