import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "@/db/client";
import { runMigrations } from "@/db/migrate";
import { migrationsThrough } from "@/test/db";

/**
 * What an upgrade does to a database that already has captures in it.
 *
 * M1 ends with the app deployed on a real host, so by the time M2 ships there are real
 * dumps in the volume and `docker compose pull && up` runs these migrations over them. A
 * migration that drops what was there is indistinguishable, to the user, from the system
 * forgetting — the failure the whole thing exists to prevent.
 *
 * These run 0000 on its own, write the rows the M1 release would have written, and then run
 * the upgrade for real. Raw SQL throughout: the TypeScript schema describes today's shape,
 * and the point here is yesterday's.
 */

let dir: string;
let db: Db;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "lifeops-upgrade-"));
  db = openDb(path.join(dir, "lifeops.db"));
  runMigrations(db, migrationsThrough("0000_init"));
});

afterEach(() => {
  db.$client.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

const NOW = "2026-07-30T12:00:00.000Z";

/**
 * What SQLite actually objected to. Drizzle wraps a raw `db.run` failure in "Failed to run
 * the query …", so asserting on the outer message would pass for any failure at all.
 */
function refusalFor(write: () => void): string {
  try {
    write();
  } catch (error) {
    const cause = (error as { cause?: Error }).cause;
    return cause?.message ?? (error as Error).message;
  }
  throw new Error("expected the write to be refused");
}

/** One dump, one entity with one alias, and the records that point at that entity. */
function seedM1Data() {
  db.run(sql`insert into dumps (id, created_at, raw_text, source, extraction_status)
             values ('d1', ${NOW}, 'Rick sent the furnace quote', 'web', 'done')`);
  db.run(sql`insert into entities (id, dump_id, created_at, name, type, notes)
             values ('e1', 'd1', ${NOW}, 'Rick', 'provider', 'does the furnace')`);
  db.run(sql`insert into entity_aliases (id, entity_id, alias)
             values ('a1', 'e1', 'the furnace guy')`);
  db.run(sql`insert into events (id, dump_id, created_at, title, occurs_on)
             values ('ev1', 'd1', ${NOW}, 'furnace service', '2026-08-01')`);
  db.run(sql`insert into event_entities (event_id, entity_id) values ('ev1', 'e1')`);
  db.run(sql`insert into commitments
               (id, dump_id, created_at, description, direction, counterparty_entity_id)
             values ('c1', 'd1', ${NOW}, 'send the quote', 'owed_to_me', 'e1')`);
}

describe("upgrading an M1 database", () => {
  it("keeps the entity and everything pointing at it", async () => {
    seedM1Data();

    runMigrations(db);

    expect(db.all(sql`select id, name from entities`)).toEqual([
      { id: "e1", name: "Rick" },
    ]);
    expect(db.all(sql`select event_id, entity_id from event_entities`)).toEqual([
      { event_id: "ev1", entity_id: "e1" },
    ]);
    expect(
      db.all(sql`select counterparty_entity_id as e from commitments`),
    ).toEqual([{ e: "e1" }]);
  });

  it("turns the entity's dump and its aliases into mentions", async () => {
    // Both halves of the old shape — `entities.dump_id` and `entity_aliases` — have to
    // arrive as mentions, or the first re-extraction deletes an entity as unmentioned.
    seedM1Data();

    runMigrations(db);

    expect(
      db.all(
        sql`select dump_id, alias, alias_normalized from entity_mentions
            where entity_id = 'e1' order by alias_normalized`,
      ),
    ).toEqual([
      { dump_id: "d1", alias: "Rick", alias_normalized: "rick" },
      {
        dump_id: "d1",
        alias: "the furnace guy",
        alias_normalized: "the furnace guy",
      },
    ]);
  });

  it("normalises a legacy alias the way today's matching does", async () => {
    // The migration's SQL and normalizeAlias() have to agree, or a pre-upgrade alias never
    // matches anything again — silently.
    seedM1Data();
    db.run(sql`insert into entity_aliases (id, entity_id, alias)
               values ('a2', 'e1', '  Mainline   HEATING ')`);

    runMigrations(db);

    expect(
      db.all(
        sql`select alias_normalized as a from entity_mentions where id != '' and alias like '%Mainline%'`,
      ),
    ).toEqual([{ a: "mainline heating" }]);
  });

  it("leaves entities that were stored separately separate", async () => {
    // Merging them is a backfill, and a backfill is its own question (issue #7).
    seedM1Data();
    db.run(sql`insert into dumps (id, created_at, raw_text, source)
               values ('d2', ${NOW}, 'the furnace guy again', 'web')`);
    db.run(sql`insert into entities (id, dump_id, created_at, name, type)
               values ('e2', 'd2', ${NOW}, 'the furnace guy', 'provider')`);

    runMigrations(db);

    expect(db.all(sql`select count(*) as n from entities`)).toEqual([{ n: 2 }]);
  });

  it("drops the column and table that identity replaced", async () => {
    runMigrations(db);

    expect(
      db.all<{ name: string }>(sql`pragma table_info(entities)`).map((c) => c.name),
    ).not.toContain("dump_id");
    expect(
      db.all<{ name: string }>(
        sql`select name from sqlite_master where type = 'table'`,
      ).map((t) => t.name),
    ).not.toContain("entity_aliases");
  });

  it("keeps the type constraint alive through the table rebuild", async () => {
    // The rebuild renames __new_entities to entities, and the CHECK names its own table.
    // If SQLite did not rewrite that, the guarantee would be gone and nothing would say so.
    runMigrations(db);

    expect(
      refusalFor(() =>
        db.run(sql`insert into entities (id, created_at, name, type)
                   values ('e9', ${NOW}, 'Rick', 'spaceship')`),
      ),
    ).toMatch(/CHECK constraint failed: entities_type/i);
  });

  it("restores foreign key enforcement afterwards", async () => {
    // They are off for the duration of the migration by necessity. Leaving them off would
    // disable every cascade the schema relies on for the rest of the process's life.
    runMigrations(db);

    expect(db.$client.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(
      refusalFor(() =>
        db.run(sql`insert into entity_mentions
                     (id, entity_id, dump_id, alias, alias_normalized)
                   values ('m9', 'nope', 'nope', 'x', 'x')`),
      ),
    ).toMatch(/FOREIGN KEY constraint failed/i);
  });
});
