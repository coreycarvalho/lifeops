import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { getDbPath } from "@/config";
import * as schema from "./schema";

export type Db = ReturnType<typeof openDb>;

/**
 * Open a connection and apply the pragmas this deployment depends on.
 *
 * The web and worker processes hold separate connections to the same file, so WAL and a
 * busy timeout are load-bearing, not tuning: without them the worker's extraction
 * transaction and a concurrent capture write would collide with SQLITE_BUSY.
 */
export function openDb(path: string) {
  const sqlite = new Database(path);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("busy_timeout = 5000");
  // Drives the ON DELETE CASCADE that keeps extracted records tied to their dump.
  sqlite.pragma("foreign_keys = ON");
  return drizzle(sqlite, { schema });
}

let cached: Db | undefined;

/**
 * The process-wide connection. Opened lazily on first use — opening at module load would
 * break `next build`, which imports route modules on a machine with no database volume.
 */
export function getDb(): Db {
  cached ??= openDb(getDbPath());
  return cached;
}
