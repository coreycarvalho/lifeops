import path from "node:path";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import type { Env } from "@/config";
import type { Db } from "./client";

/**
 * Where the generated SQL lives. Both containers run with WORKDIR=/app and the `drizzle`
 * folder copied alongside, so cwd-relative is correct there; the env var is the escape
 * hatch for anything that runs from elsewhere.
 */
export function migrationsFolder(env: Env = process.env): string {
  return env.LIFEOPS_MIGRATIONS_DIR ?? path.join(process.cwd(), "drizzle");
}

/**
 * Apply pending migrations. Uses drizzle-orm's runtime migrator rather than the
 * `drizzle-kit` CLI: drizzle-kit is a devDependency and is not present in the image.
 */
export function runMigrations(db: Db, folder = migrationsFolder()): void {
  migrate(db, { migrationsFolder: folder });
}
