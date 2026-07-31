import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import { entities, entityMentions } from "@/db/schema";
import type { Extraction } from "@/llm/extraction";

/**
 * Cross-dump entity identity — the same provider named two ways is one thing.
 *
 * Deliberately deterministic code rather than a prompt change. Two reasons: `npm test`
 * needs nothing running (AGENTS.md), so an identity rule the model decides is a rule with
 * no test; and the operator never sees any of this, so a rule that can be read off the page
 * beats one that can only be observed. The model's job is to say what a dump called each
 * entity — including every alias the dump itself used — and that is the evidence matched on.
 *
 * The matching rule, in full:
 *
 * - Two entities are the same when their normalised alias sets overlap **and** their types
 *   agree. Nothing fuzzy: no edit distance, no substring, no article stripping. A wrong
 *   merge is invisible and hard to undo; a missed merge costs one duplicate row and is
 *   fixed by the next dump that names both ways at once. That asymmetry is the whole
 *   argument for being this strict (issue #7, open question).
 * - Ties go to the oldest entity, so re-running an extraction lands on the same row.
 * - An extraction whose aliases overlap two existing entities attaches to one of them and
 *   leaves the other alone. Merging two already-stored entities is out of scope, and doing
 *   it silently here would be the wrong-merge case at its most expensive.
 */

/** Casefold, collapse internal whitespace, trim. Mirrored by drizzle/0001's backfill. */
export function normalizeAlias(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

export type Alias = { alias: string; normalized: string };

/**
 * Every distinct way this extraction named one entity, the canonical name first. Blank
 * strings are dropped rather than stored: a model that emits `""` as an alias would
 * otherwise create an alias every entity matches on.
 */
export function aliasesOf(entity: Extraction["entities"][number]): Alias[] {
  const seen = new Map<string, Alias>();
  for (const alias of [entity.name, ...entity.aliases]) {
    const normalized = normalizeAlias(alias);
    if (normalized === "" || seen.has(normalized)) continue;
    seen.set(normalized, { alias: alias.trim(), normalized });
  }
  return [...seen.values()];
}

/** The transaction surface this file needs. */
type Tx = Pick<Db, "all" | "run" | "insert">;

/**
 * The entity this extracted one *is* — an existing row when the aliases and type match,
 * a new row otherwise — with this dump recorded as having mentioned it either way.
 * `undefined` when the model named the entity nothing at all.
 *
 * Plain SQL for the match because it is a join with a variable IN list (AGENTS.md).
 */
export function resolveEntity(
  tx: Tx,
  dumpId: string,
  entity: Extraction["entities"][number],
  createdAt: string,
): { id: string; aliases: Alias[] } | undefined {
  const aliases = aliasesOf(entity);
  // A model that emitted an entity with no usable name at all has emitted nothing.
  if (aliases.length === 0) return undefined;

  const [match] = tx.all<{ id: string }>(sql`
    select e.id as id
    from entities e
    join entity_mentions m on m.entity_id = e.id
    where e.type = ${entity.type}
      and m.alias_normalized in (${sql.join(
        aliases.map((a) => sql`${a.normalized}`),
        sql`, `,
      )})
    order by e.created_at, e.id
    limit 1
  `);

  const id = match?.id ?? randomUUID();
  if (!match) {
    tx.insert(entities)
      .values({
        id,
        createdAt,
        name: entity.name.trim(),
        type: entity.type,
        notes: entity.notes,
      })
      .run();
  }

  for (const alias of aliases) {
    tx.insert(entityMentions)
      .values({
        id: randomUUID(),
        entityId: id,
        dumpId,
        alias: alias.alias,
        aliasNormalized: alias.normalized,
      })
      // Two extracted entities in one dump can resolve to the same row and share an alias.
      .onConflictDoNothing()
      .run();
  }

  return { id, aliases };
}

/**
 * Entities no dump mentions any more.
 *
 * This is what keeps re-extraction idempotent now that deleting by `dump_id` is not an
 * option: the dump's mentions go, and an entity left with none was only ever this dump's.
 * An entity another dump still mentions keeps its row, its id, and everything pointing at
 * it — which is the behaviour the whole schema change exists for.
 *
 * Deliberately not scoped to the dump being extracted. An entity with no mentions is
 * reachable from nothing, so there is no such thing as sweeping someone else's: the only
 * other way one appears is a deleted dump, which no longer takes its entities with it now
 * that no foreign key ties them together.
 */
export function deleteUnmentionedEntities(tx: Tx): number {
  return tx.run(sql`
    delete from entities
    where not exists (
      select 1 from entity_mentions m where m.entity_id = entities.id
    )
  `).changes;
}
