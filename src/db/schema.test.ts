import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type TestDb } from "@/test/db";
import { runMigrations } from "./migrate";
import {
  commitments,
  decisionEntities,
  decisions,
  dumps,
  entities,
  entityAliases,
  eventEntities,
  events,
  retrievalLog,
  threads,
  triggerFires,
} from "./schema";

let ctx: TestDb;

beforeEach(() => {
  ctx = createTestDb();
});

afterEach(() => {
  ctx.close();
});

const NOW = "2026-07-30T12:00:00.000Z";

function insertDump(overrides: Partial<typeof dumps.$inferInsert> = {}) {
  const row = {
    id: randomUUID(),
    createdAt: NOW,
    rawText: "furnace guy said he'd send a quote by friday",
    source: "web" as const,
    ...overrides,
  };
  ctx.db.insert(dumps).values(row).run();
  return row;
}

function insertEntity(dumpId: string, overrides: Record<string, unknown> = {}) {
  const row = {
    id: randomUUID(),
    dumpId,
    createdAt: NOW,
    name: "Dr. Alvarez",
    type: "provider" as const,
    ...overrides,
  };
  ctx.db.insert(entities).values(row).run();
  return row;
}

describe("migrations", () => {
  it("create every table the data model needs", () => {
    const names = ctx.db
      .all<{ name: string }>(
        sql`select name from sqlite_master where type = 'table' order by name`,
      )
      .map((r) => r.name);

    expect(names).toEqual(
      expect.arrayContaining([
        "commitments",
        "decision_entities",
        "decisions",
        "dumps",
        "entities",
        "entity_aliases",
        "event_entities",
        "events",
        "retrieval_log",
        "threads",
        "trigger_fires",
      ]),
    );
  });

  it("are idempotent when applied twice", () => {
    // The migrate container runs on every `docker compose up`, so a second pass over an
    // already-migrated file has to be a no-op rather than an error.
    insertDump();
    expect(() => runMigrations(ctx.db)).not.toThrow();
    expect(ctx.db.select().from(dumps).all()).toHaveLength(1);
  });
});

describe("enum constraints", () => {
  it("reject an out-of-range dump source", () => {
    expect(() =>
      ctx.db
        .insert(dumps)
        .values({
          id: randomUUID(),
          createdAt: NOW,
          rawText: "x",
          // Bypasses the TypeScript enum on purpose: the CHECK constraint is the actual
          // guarantee, and it has to hold against a raw write.
          source: "sms" as "web",
        })
        .run(),
    ).toThrow(/CHECK constraint failed/i);
  });

  it("reject an out-of-range commitment direction", () => {
    const dump = insertDump();
    expect(() =>
      ctx.db
        .insert(commitments)
        .values({
          id: randomUUID(),
          dumpId: dump.id,
          createdAt: NOW,
          description: "send the quote",
          direction: "sideways" as "owed_to_me",
        })
        .run(),
    ).toThrow(/CHECK constraint failed/i);
  });

  it("reject an out-of-range retrieval mode", () => {
    expect(() =>
      ctx.db
        .insert(retrievalLog)
        .values({
          id: randomUUID(),
          createdAt: NOW,
          mode: "vibes" as "search",
        })
        .run(),
    ).toThrow(/CHECK constraint failed/i);
  });
});

describe("provenance", () => {
  it("refuses extracted records that point at no dump", () => {
    expect(() =>
      ctx.db
        .insert(events)
        .values({
          id: randomUUID(),
          dumpId: "does-not-exist",
          createdAt: NOW,
          title: "tilt table test",
          occursOn: "2026-06-22",
        })
        .run(),
    ).toThrow(/FOREIGN KEY constraint failed/i);
  });

  it("deletes every extracted record when its dump is deleted", () => {
    const dump = insertDump();
    const entity = insertEntity(dump.id);

    ctx.db
      .insert(entityAliases)
      .values({ id: randomUUID(), entityId: entity.id, alias: "alvarez" })
      .run();

    const thread = {
      id: randomUUID(),
      dumpId: dump.id,
      createdAt: NOW,
      name: "medical workup",
    };
    ctx.db.insert(threads).values(thread).run();

    const event = {
      id: randomUUID(),
      dumpId: dump.id,
      createdAt: NOW,
      title: "tilt table test",
      occursOn: "2026-06-22",
      threadId: thread.id,
    };
    ctx.db.insert(events).values(event).run();
    ctx.db
      .insert(eventEntities)
      .values({ eventId: event.id, entityId: entity.id })
      .run();

    const decision = {
      id: randomUUID(),
      dumpId: dump.id,
      createdAt: NOW,
      decision: "switch cardiologists",
      decidedOn: "2026-07-01",
    };
    ctx.db.insert(decisions).values(decision).run();
    ctx.db
      .insert(decisionEntities)
      .values({ decisionId: decision.id, entityId: entity.id })
      .run();

    ctx.db
      .insert(commitments)
      .values({
        id: randomUUID(),
        dumpId: dump.id,
        createdAt: NOW,
        description: "send the furnace quote",
        direction: "owed_to_me",
        counterpartyEntityId: entity.id,
      })
      .run();

    ctx.db.delete(dumps).where(eq(dumps.id, dump.id)).run();

    for (const table of [
      entities,
      entityAliases,
      events,
      eventEntities,
      decisions,
      decisionEntities,
      commitments,
      threads,
    ]) {
      expect(ctx.db.select().from(table).all()).toEqual([]);
    }
  });
});

describe("cross-record links", () => {
  it("keeps a commitment when its counterparty entity goes away", () => {
    // A commitment is the record that matters; losing the entity must not lose the fact
    // that someone owes you something.
    const dump = insertDump();
    const entity = insertEntity(dump.id);
    const id = randomUUID();

    ctx.db
      .insert(commitments)
      .values({
        id,
        dumpId: dump.id,
        createdAt: NOW,
        description: "send the furnace quote",
        direction: "owed_to_me",
        counterpartyEntityId: entity.id,
      })
      .run();

    ctx.db.delete(entities).where(eq(entities.id, entity.id)).run();

    const [row] = ctx.db
      .select()
      .from(commitments)
      .where(eq(commitments.id, id))
      .all();
    expect(row.description).toBe("send the furnace quote");
    expect(row.counterpartyEntityId).toBeNull();
  });

  it("rejects a duplicate alias on the same entity", () => {
    const dump = insertDump();
    const entity = insertEntity(dump.id);
    const alias = { id: randomUUID(), entityId: entity.id, alias: "alvarez" };

    ctx.db.insert(entityAliases).values(alias).run();
    expect(() =>
      ctx.db
        .insert(entityAliases)
        .values({ ...alias, id: randomUUID() })
        .run(),
    ).toThrow(/UNIQUE constraint failed/i);
  });
});

describe("defaults", () => {
  it("starts a dump pending, unextracted, and unflagged", () => {
    const dump = insertDump();
    const [row] = ctx.db.select().from(dumps).where(eq(dumps.id, dump.id)).all();

    expect(row.extractionStatus).toBe("pending");
    expect(row.extractionVersion).toBeNull();
    expect(row.extractionAttempts).toBe(0);
    expect(row.echo).toBeNull();
    expect(row.flaggedWrongAt).toBeNull();
  });

  it("records a trigger fire as fired until acted on", () => {
    const id = randomUUID();
    ctx.db
      .insert(triggerFires)
      .values({
        id,
        rule: "owed_to_me_overdue",
        firedAt: NOW,
        subjectType: "commitment",
        subjectId: randomUUID(),
      })
      .run();

    const [row] = ctx.db
      .select()
      .from(triggerFires)
      .where(eq(triggerFires.id, id))
      .all();
    expect(row.status).toBe("fired");
  });
});
