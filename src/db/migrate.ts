import path from "node:path";
import { sql } from "drizzle-orm";
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
 *
 * Foreign keys are off for the duration, which is SQLite's own documented ALTER procedure,
 * not a shortcut. SQLite cannot drop a column that a foreign key names, so any migration
 * that changes a table's shape has to rebuild it — copy to a new table, drop the old,
 * rename — and a `DROP TABLE` with foreign keys enforced cascades, taking every child row
 * with it. The `PRAGMA foreign_keys=OFF` drizzle-kit writes into the migration file cannot
 * prevent that: the migrator runs every statement inside one transaction, and the pragma is
 * a documented no-op there. Verified — it stays on, and the children go.
 *
 * So it belongs on the connection, outside the transaction, and the integrity check
 * afterwards is what stops this from being a silent exception: nothing enforced the
 * constraints while the migration ran, so they get checked rather than assumed.
 */
export function runMigrations(db: Db, folder = migrationsFolder()): void {
  db.$client.pragma("foreign_keys = OFF");
  try {
    migrate(db, { migrationsFolder: folder });
  } finally {
    db.$client.pragma("foreign_keys = ON");
  }

  const violations = db.all<{ table: string; parent: string }>(
    sql`pragma foreign_key_check`,
  );
  if (violations.length > 0) {
    const detail = [
      ...new Set(violations.map((v) => `${v.table} -> ${v.parent}`)),
    ].join(", ");
    throw new Error(
      `Migration left ${violations.length} orphaned row(s): ${detail}`,
    );
  }
}
