import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { openDb, type Db } from "@/db/client";
import { migrationsFolder, runMigrations } from "@/db/migrate";

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

/**
 * The migrations folder as it stood after `tag`, in a temp dir.
 *
 * Lets a test bring a database up to an older schema, put the data an earlier release
 * would have written into it, and then run the upgrade for real. The app is deployed on a
 * real host with real captures, so "the migration keeps what was there" is a behaviour,
 * not an assumption.
 */
export function migrationsThrough(tag: string): string {
  const source = migrationsFolder();
  const journal = JSON.parse(
    fs.readFileSync(path.join(source, "meta", "_journal.json"), "utf8"),
  ) as { entries: { tag: string }[] };

  const cut = journal.entries.findIndex((e) => e.tag === tag);
  if (cut < 0) throw new Error(`No migration tagged ${tag}`);
  const entries = journal.entries.slice(0, cut + 1);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lifeops-migrations-"));
  fs.mkdirSync(path.join(dir, "meta"));
  fs.writeFileSync(
    path.join(dir, "meta", "_journal.json"),
    JSON.stringify({ ...journal, entries }),
  );
  for (const entry of entries) {
    fs.copyFileSync(
      path.join(source, `${entry.tag}.sql`),
      path.join(dir, `${entry.tag}.sql`),
    );
  }
  return dir;
}
