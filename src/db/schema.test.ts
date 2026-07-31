import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { deleteUnmentionedEntities } from "@/extraction/identity";
import { createTestDb, type TestDb } from "@/test/db";
import { runMigrations } from "./migrate";
import {
  commitments,
  decisionEntities,
  decisions,
  dumps,
  entities,
  entityMentions,
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

/**
 * An entity plus the mention that ties it to a dump. Entities carry no `dump_id` — one can
 * outlive the dump that created it (see src/extraction/identity.ts) — so provenance is a
 * second row, and every caller here wants both.
 */
function insertEntity(dumpId: string, overrides: Record<string, unknown> = {}) {
  const row = {
    id: randomUUID(),
    createdAt: NOW,
    name: "Dr. Alvarez",
    type: "provider" as const,
    ...overrides,
  };
  ctx.db.insert(entities).values(row).run();
  ctx.db
    .insert(entityMentions)
    .values({
      id: randomUUID(),
      entityId: row.id,
      dumpId,
      alias: row.name,
      aliasNormalized: row.name.toLowerCase(),
    })
    .run();
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
        "entity_mentions",
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
      .insert(entityMentions)
      .values({
        id: randomUUID(),
        entityId: entity.id,
        dumpId: dump.id,
        alias: "Alvarez",
        aliasNormalized: "alvarez",
      })
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
      entityMentions,
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

  it("leaves an entity the deleted dump shared with another one", () => {
    // Entities are the one record a dump does not own, so deleting a dump takes its
    // mentions and stops there. That is the point: the other dump still refers to it.
    const first = insertDump();
    const entity = insertEntity(first.id);
    const second = insertDump();
    ctx.db
      .insert(entityMentions)
      .values({
        id: randomUUID(),
        entityId: entity.id,
        dumpId: second.id,
        alias: "the cardiologist",
        aliasNormalized: "the cardiologist",
      })
      .run();

    ctx.db.delete(dumps).where(eq(dumps.id, first.id)).run();

    expect(ctx.db.select().from(entities).all()).toHaveLength(1);
    expect(ctx.db.select().from(entityMentions).all()).toHaveLength(1);
  });

  it("leaves an entity nothing mentions for the next extraction to sweep", () => {
    // The residue of the above: an entity whose only dump is gone is unreachable rather
    // than deleted, because no foreign key ties it to a dump any more. Extraction sweeps
    // unmentioned entities on its way through, so it does not accumulate.
    const dump = insertDump();
    insertEntity(dump.id);

    ctx.db.delete(dumps).where(eq(dumps.id, dump.id)).run();
    expect(ctx.db.select().from(entities).all()).toHaveLength(1);

    expect(deleteUnmentionedEntities(ctx.db)).toBe(1);
    expect(ctx.db.select().from(entities).all()).toEqual([]);
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

  it("rejects the same dump claiming the same alias for one entity twice", () => {
    // The alias set is the union of the mentions, so a duplicate mention would be a
    // duplicate alias — and matching would start depending on how many rows agree.
    const dump = insertDump();
    const entity = insertEntity(dump.id);
    const mention = {
      id: randomUUID(),
      entityId: entity.id,
      dumpId: dump.id,
      alias: "Alvarez",
      aliasNormalized: "alvarez",
    };

    ctx.db.insert(entityMentions).values(mention).run();
    expect(() =>
      ctx.db
        .insert(entityMentions)
        // A different spelling of a name that normalises the same is the same mention.
        .values({ ...mention, id: randomUUID(), alias: "ALVAREZ" })
        .run(),
    ).toThrow(/UNIQUE constraint failed/i);
  });

  it("lets two dumps mention the same entity", () => {
    const first = insertDump();
    const entity = insertEntity(first.id);
    const second = insertDump();

    ctx.db
      .insert(entityMentions)
      .values({
        id: randomUUID(),
        entityId: entity.id,
        dumpId: second.id,
        alias: "the cardiologist",
        aliasNormalized: "the cardiologist",
      })
      .run();

    expect(ctx.db.select().from(entityMentions).all()).toHaveLength(2);
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
