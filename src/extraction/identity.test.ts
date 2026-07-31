import { eq, sql } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDump } from "@/capture";
import { commitments, dumps, entities, entityMentions } from "@/db/schema";
import type { Extraction } from "@/llm/extraction";
import { createTestDb, type TestDb } from "@/test/db";
import { extraction, stubLlm } from "@/test/llm";
import { extractDump } from "./run";

/**
 * Cross-dump entity identity — issue #7.
 *
 * The store fragments quietly as it grows if the furnace guy is three rows, and retrieval
 * gets worse the more the user captures. These are about the two halves of that: the same
 * provider named two ways is one entity, and separating identity from provenance did not
 * cost the idempotency M1 relied on.
 */

let ctx: TestDb;

beforeEach(() => {
  ctx = createTestDb();
});

afterEach(() => {
  ctx.close();
});

const TZ = "America/Toronto";

let captureCount = 0;

/** Each dump a minute later than the last, so "oldest first" means something. */
function capture(rawText: string) {
  captureCount += 1;
  return createDump(ctx.db, {
    rawText,
    source: "web",
    now: new Date(Date.UTC(2026, 5, 1, 9, captureCount)),
  });
}

/** Capture a note and extract the entities the model found in it, in one step. */
async function captured(rawText: string, found: Extraction["entities"]) {
  const dump = capture(rawText);
  await extractDump(
    ctx.db,
    stubLlm(() => extraction({ entities: found })),
    dump.id,
    TZ,
  );
  return dump;
}

function person(name: string, aliases: string[] = []) {
  return { name, type: "person" as const, aliases, notes: null };
}

function provider(name: string, aliases: string[] = []) {
  return { name, type: "provider" as const, aliases, notes: null };
}

function allEntities() {
  return ctx.db.select().from(entities).all();
}

/** Every dump that mentioned this entity, oldest first. */
function dumpsMentioning(entityId: string) {
  return ctx.db
    .all<{ id: string }>(
      sql`select d.id as id
          from dumps d
          join entity_mentions m on m.dump_id = d.id
          where m.entity_id = ${entityId}
          group by d.id
          order by d.created_at`,
    )
    .map((r) => r.id);
}

/** Every way the store knows this entity can be named. */
function aliasesOf(entityId: string) {
  return ctx.db
    .all<{ alias: string }>(
      sql`select distinct alias_normalized as alias from entity_mentions
          where entity_id = ${entityId} order by alias_normalized`,
    )
    .map((r) => r.alias);
}

describe("the same person named two ways across dumps", () => {
  it("is one entity, not two", async () => {
    // The dump that names him both ways is the evidence. Asking "what's the deal with the
    // furnace guy" has to find the Rick notes too, or the store fragments as it grows.
    await captured("furnace guy is sending a quote", [provider("the furnace guy")]);
    await captured("Rick, the furnace guy, came by", [
      provider("Rick", ["the furnace guy"]),
    ]);

    const rows = allEntities();
    expect(rows).toHaveLength(1);
    // Created by the first dump, so it keeps that dump's name; the second contributed a way
    // of naming it, not a rewrite.
    expect(rows[0].name).toBe("the furnace guy");
    expect(aliasesOf(rows[0].id)).toEqual(["rick", "the furnace guy"]);
  });

  it("keeps every dump that mentioned it traceable", async () => {
    const first = await captured("furnace guy is sending a quote", [
      provider("the furnace guy"),
    ]);
    const second = await captured("Rick @ Mainline Heating came by", [
      provider("Rick @ Mainline Heating", ["the furnace guy", "Rick"]),
    ]);
    const third = await captured("Rick still has not sent it", [provider("Rick")]);

    const [entity] = allEntities();
    expect(dumpsMentioning(entity.id)).toEqual([first.id, second.id, third.id]);
  });

  it("matches on a name the dump wrote differently", async () => {
    // Casing and stray whitespace are the model's, not the user's.
    await captured("mainline heating quoted", [provider("Mainline Heating")]);
    await captured("MAINLINE  HEATING invoiced", [provider("mainline   heating")]);

    expect(allEntities()).toHaveLength(1);
  });

  it("resolves a later dump's commitment onto the entity the first dump created", async () => {
    // The point of the whole exercise: records from different dumps land on one thing.
    const first = await captured("the furnace guy", [provider("the furnace guy")]);
    const [entity] = allEntities();

    const second = capture("Rick still owes me the quote");
    await extractDump(
      ctx.db,
      stubLlm(() =>
        extraction({
          entities: [provider("Rick", ["the furnace guy"])],
          commitments: [
            {
              description: "send the furnace quote",
              direction: "owed_to_me",
              counterpartyName: "Rick",
              dueDate: null,
            },
          ],
        }),
      ),
      second.id,
      TZ,
    );

    const [commitment] = ctx.db
      .select()
      .from(commitments)
      .where(eq(commitments.dumpId, second.id))
      .all();
    expect(commitment.counterpartyEntityId).toBe(entity.id);
    expect(dumpsMentioning(entity.id)).toEqual([first.id, second.id]);
  });
});

describe("people who are not the same person", () => {
  it("keeps two similar names apart", async () => {
    // Nothing fuzzy. A wrong merge is invisible and hard to undo; a missed one costs a row.
    await captured("Rick Torres is doing the furnace", [person("Rick Torres")]);
    await captured("Rick Nguyen called from the bank", [person("Rick Nguyen")]);

    expect(allEntities().map((e) => e.name).sort()).toEqual([
      "Rick Nguyen",
      "Rick Torres",
    ]);
  });

  it("keeps a shared name apart when the two are different kinds of thing", async () => {
    await captured("Maple needs a new roof", [
      { name: "Maple", type: "property", aliases: [], notes: null },
    ]);
    await captured("Maple sent the invoice", [
      { name: "Maple", type: "company", aliases: [], notes: null },
    ]);

    expect(allEntities()).toHaveLength(2);
  });

  it("does not merge two entities that were already stored separately", async () => {
    // Out of scope by design: a backfill is its own question. A dump that names both ways
    // attaches to one of them rather than silently collapsing the pair.
    await captured("Rick Torres is doing the furnace", [person("Rick Torres")]);
    await captured("the furnace guy has not called", [person("the furnace guy")]);
    expect(allEntities()).toHaveLength(2);

    await captured("Rick Torres, the furnace guy, called", [
      person("Rick Torres", ["the furnace guy"]),
    ]);

    expect(allEntities()).toHaveLength(2);
  });
});

describe("re-extracting a dump", () => {
  it("leaves an entity another dump still refers to alone", async () => {
    // The constraint M1 left behind. Deleting by dump_id here would have destroyed an
    // entity the second dump is pointing at.
    const first = await captured("the furnace guy is sending a quote", [
      provider("the furnace guy"),
    ]);
    const second = await captured("Rick, the furnace guy, came by", [
      provider("Rick", ["the furnace guy"]),
    ]);
    const [before] = allEntities();

    await extractDump(
      ctx.db,
      stubLlm(() => extraction({ entities: [provider("the furnace guy")] })),
      first.id,
      TZ,
    );

    const after = allEntities();
    expect(after).toHaveLength(1);
    // Same row, not a replacement: the id is what everything else points at.
    expect(after[0].id).toBe(before.id);
    expect(dumpsMentioning(after[0].id)).toEqual([first.id, second.id]);
  });

  it("leaves the same records behind when nothing changed", async () => {
    const first = await captured("the furnace guy is sending a quote", [
      provider("the furnace guy"),
    ]);
    await captured("Rick, the furnace guy, came by", [
      provider("Rick", ["the furnace guy"]),
    ]);

    const entitiesBefore = allEntities();
    const mentionsBefore = ctx.db.select().from(entityMentions).all().length;

    await extractDump(
      ctx.db,
      stubLlm(() => extraction({ entities: [provider("the furnace guy")] })),
      first.id,
      TZ,
    );

    expect(allEntities()).toEqual(entitiesBefore);
    expect(ctx.db.select().from(entityMentions).all()).toHaveLength(mentionsBefore);
  });

  it("forgets an alias the new extraction no longer claims", async () => {
    // Aliases have provenance now, so a re-run does not leave behind a name it no longer
    // stands behind — which is what would make the store drift toward wrong merges.
    const dump = await captured("Rick, the furnace guy", [
      provider("Rick", ["the furnace guy"]),
    ]);
    const [entity] = allEntities();
    expect(aliasesOf(entity.id)).toEqual(["rick", "the furnace guy"]);

    await extractDump(
      ctx.db,
      stubLlm(() => extraction({ entities: [provider("Rick")] })),
      dump.id,
      TZ,
    );

    expect(aliasesOf(allEntities()[0].id)).toEqual(["rick"]);
  });

  it("removes an entity no dump mentions any more", async () => {
    const dump = await captured("Rick came by", [provider("Rick")]);
    expect(allEntities()).toHaveLength(1);

    await extractDump(ctx.db, stubLlm(() => extraction({})), dump.id, TZ);

    expect(allEntities()).toEqual([]);
    expect(ctx.db.select().from(entityMentions).all()).toEqual([]);
  });

  it("still echoes the entity it shares with an earlier dump", async () => {
    await captured("the furnace guy is sending a quote", [provider("the furnace guy")]);
    const second = await captured("Rick came by", [
      provider("Rick", ["the furnace guy"]),
    ]);

    const [row] = ctx.db.select().from(dumps).where(eq(dumps.id, second.id)).all();
    expect(row.echo).toBe("Got it: noted the furnace guy");
  });
});

describe("deleting a dump", () => {
  it("takes its mentions but not an entity another dump shares", async () => {
    const first = await captured("the furnace guy is sending a quote", [
      provider("the furnace guy"),
    ]);
    const second = await captured("Rick, the furnace guy, came by", [
      provider("Rick", ["the furnace guy"]),
    ]);
    const [entity] = allEntities();

    ctx.db.delete(dumps).where(eq(dumps.id, first.id)).run();

    expect(allEntities()).toHaveLength(1);
    expect(dumpsMentioning(entity.id)).toEqual([second.id]);
  });
});
