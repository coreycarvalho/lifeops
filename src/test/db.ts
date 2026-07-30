import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type Db } from "@/db/client";
import { runMigrations } from "@/db/migrate";

export type TestDb = {
  db: Db;
  path: string;
  close: () => void;
};

/**
 * A real SQLite file with migrations applied, in a temp dir.
 *
 * Deliberately a file rather than `:memory:` — the behaviours under test include WAL
 * pragmas and cross-process visibility, and an in-memory database would quietly not
 * exercise them.
 */
export function createTestDb(): TestDb {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lifeops-test-"));
  const file = path.join(dir, "lifeops.db");
  const db = openDb(file);
  runMigrations(db);

  return {
    db,
    path: file,
    close: () => {
      db.$client.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}
