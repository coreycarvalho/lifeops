import { randomUUID } from "node:crypto";
import { and, eq, lt, or, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import {
  commitments,
  decisions,
  entities,
  entityAliases,
  eventEntities,
  events,
  dumps,
} from "@/db/schema";
import type { Extraction } from "@/llm/extraction";
import type { LlmProvider } from "@/llm/provider";
import { renderSummary } from "./echo";

/**
 * The extraction step: one dump in, typed records and an echo out.
 *
 * Two separate things live here on purpose:
 *
 * - `claimNextDump` is *scheduling* — which dump the worker picks up next, and when it
 *   stops picking one up. It is the only thing that increments the attempt counter.
 * - `extractDump` is the *work*. It runs on whatever dump it is handed, which is what makes
 *   re-processing a dump a plain second call rather than a special mode.
 *
 * Neither is ever called from a request handler (SPEC deployment constraints).
 */

/**
 * Bumped when the prompt or the schema changes, so a dump's records can be traced to the
 * extraction that produced them. M2 rewrites the prompt and will bump this.
 */
export const EXTRACTION_VERSION = 1;

/** Long enough to diagnose, short enough to render in a one-line echo. */
const MAX_ERROR_LENGTH = 300;

/**
 * "2026-6-2" -> "2026-06-02"; anything that is not a real calendar date -> null.
 *
 * All date discipline lives here rather than in the LLM schema: the endpoint cannot enforce
 * a regex (see src/llm/extraction.ts), and one hallucinated date should cost one record,
 * not the whole dump.
 */
export function toIsoDate(value: string | null): string | null {
  if (!value) return null;
  const match = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(value.trim());
  if (!match) return null;
  const [, year, month, day] = match;
  const iso = `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
  // Rejects 2026-02-31, which passes the shape test but is not a day.
  const parsed = new Date(`${iso}T00:00:00Z`);
  return parsed.toISOString().slice(0, 10) === iso ? iso : null;
}

function toTimeOfDay(value: string | null): string | null {
  if (!value) return null;
  const match = /^(\d{1,2}):(\d{2})$/.exec(value.trim());
  if (!match) return null;
  const [, hour, minute] = match;
  if (Number(hour) > 23 || Number(minute) > 59) return null;
  return `${hour.padStart(2, "0")}:${minute}`;
}

export type ClaimedDump = {
  id: string;
  rawText: string;
  createdAt: string;
};

/**
 * Take the oldest dump that still deserves an attempt, mark it in flight, and count the
 * attempt. Counting here rather than on failure is what bounds a worker that crashes
 * mid-extraction: the attempt is spent whether or not it finished.
 *
 * A dump that has failed is eligible again while it has attempts left — so it is *visibly*
 * failed the whole time it is waiting to be retried, rather than silently pending.
 */
export function claimNextDump(
  db: Db,
  maxAttempts: number,
): ClaimedDump | undefined {
  const eligible = db
    .select({
      id: dumps.id,
      rawText: dumps.rawText,
      createdAt: dumps.createdAt,
    })
    .from(dumps)
    .where(
      or(
        eq(dumps.extractionStatus, "pending"),
        and(
          eq(dumps.extractionStatus, "failed"),
          lt(dumps.extractionAttempts, maxAttempts),
        ),
      ),
    )
    .orderBy(dumps.createdAt)
    .limit(1)
    .all();

  const dump = eligible[0];
  if (!dump) return undefined;

  const claimed = db
    .update(dumps)
    .set({
      extractionStatus: "processing",
      extractionAttempts: sql`${dumps.extractionAttempts} + 1`,
    })
    .where(
      and(
        eq(dumps.id, dump.id),
        or(
          eq(dumps.extractionStatus, "pending"),
          eq(dumps.extractionStatus, "failed"),
        ),
      ),
    )
    .run();

  return claimed.changes === 1 ? dump : undefined;
}

/**
 * Put anything left mid-flight back in the queue. A worker that was killed between claiming
 * and finishing would otherwise leave a dump `processing` forever, which is the one status
 * nothing retries. The attempt it already spent is not refunded, so a crash loop still ends.
 */
export function requeueStuckDumps(db: Db): number {
  return db
    .update(dumps)
    .set({ extractionStatus: "pending" })
    .where(eq(dumps.extractionStatus, "processing"))
    .run().changes;
}

export async function extractDump(
  db: Db,
  provider: LlmProvider,
  dumpId: string,
  now = new Date(),
): Promise<void> {
  const [dump] = db
    .select({ id: dumps.id, rawText: dumps.rawText, createdAt: dumps.createdAt })
    .from(dumps)
    .where(eq(dumps.id, dumpId))
    .all();
  if (!dump) throw new Error(`No dump ${dumpId}`);

  try {
    const extraction = await provider.extract({
      rawText: dump.rawText,
      capturedOn: dump.createdAt.slice(0, 10),
    });
    // Note what is NOT updated: raw_text and created_at. The dump is immutable
    // (invariant 2); extraction only ever adds records and moves status.
    store(db, dump, extraction, now);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    db.update(dumps)
      .set({
        extractionStatus: "failed",
        extractionError: message.slice(0, MAX_ERROR_LENGTH),
        extractedAt: now.toISOString(),
      })
      .where(eq(dumps.id, dumpId))
      .run();
  }
}

function store(
  db: Db,
  dump: { id: string; createdAt: string },
  extraction: Extraction,
  now: Date,
): void {
  const createdAt = now.toISOString();
  const capturedOn = dump.createdAt.slice(0, 10);

  db.transaction((tx) => {
    // Re-extraction replaces rather than appends. Deleting the dump's own records is what
    // makes a second run leave the same records behind instead of a second copy; the
    // junction rows and aliases go with them via ON DELETE CASCADE.
    for (const table of [entities, events, commitments, decisions]) {
      tx.delete(table).where(eq(table.dumpId, dump.id)).run();
    }

    /** Every name and alias the model used, pointing at the entity row it created. */
    const byName = new Map<string, string>();

    for (const entity of extraction.entities) {
      const id = randomUUID();
      tx.insert(entities)
        .values({
          id,
          dumpId: dump.id,
          createdAt,
          name: entity.name,
          type: entity.type,
          notes: entity.notes,
        })
        .run();

      const aliases = new Set(
        [entity.name, ...entity.aliases]
          .map((a) => a.trim())
          .filter((a) => a !== ""),
      );
      for (const alias of aliases) {
        tx.insert(entityAliases)
          .values({ id: randomUUID(), entityId: id, alias })
          .run();
        // First entity to claim a name keeps it. Cross-dump identity is M2 (issue #7).
        const key = alias.toLowerCase();
        if (!byName.has(key)) byName.set(key, id);
      }
    }

    for (const event of extraction.events) {
      const occursOn = toIsoDate(event.occursOn);
      // An event is a thing that happens on a day. Without a usable day there is nothing
      // for the dashboard's date lens or the T-7 trigger to act on, so it is not stored.
      if (!occursOn) continue;

      const id = randomUUID();
      tx.insert(events)
        .values({
          id,
          dumpId: dump.id,
          createdAt,
          title: event.title,
          occursOn,
          occursAtTime: toTimeOfDay(event.occursAtTime),
          location: event.location,
        })
        .run();

      const linked = new Set<string>();
      for (const name of event.entityNames) {
        const entityId = byName.get(name.trim().toLowerCase());
        if (entityId && !linked.has(entityId)) {
          linked.add(entityId);
          tx.insert(eventEntities).values({ eventId: id, entityId }).run();
        }
      }
    }

    for (const commitment of extraction.commitments) {
      tx.insert(commitments)
        .values({
          id: randomUUID(),
          dumpId: dump.id,
          createdAt,
          description: commitment.description,
          direction: commitment.direction,
          counterpartyEntityId:
            byName.get(commitment.counterpartyName?.trim().toLowerCase() ?? "") ??
            null,
          dueDate: toIsoDate(commitment.dueDate),
        })
        .run();
    }

    for (const decision of extraction.decisions) {
      tx.insert(decisions)
        .values({
          id: randomUUID(),
          dumpId: dump.id,
          createdAt,
          decision: decision.decision,
          reasoning: decision.reasoning,
          // A note records the decision far more often than the day it was taken, so the
          // capture date is the honest fallback.
          decidedOn: toIsoDate(decision.decidedOn) ?? capturedOn,
        })
        .run();
    }

    tx.update(dumps)
      .set({
        extractionStatus: "done",
        extractionVersion: EXTRACTION_VERSION,
        extractionError: null,
        extractedAt: createdAt,
        // Rendered from what is now in the database, not from what the model said it was
        // doing — see src/extraction/echo.ts.
        echo: renderSummary(readStoredRecords(tx, dump.id), capturedOn),
      })
      .where(eq(dumps.id, dump.id))
      .run();
  });
}

/**
 * The records as stored, in one read. Plain SQL because the commitment line needs the
 * counterparty's name, which lives one join away (AGENTS.md: plain SQL for the joins).
 */
function readStoredRecords(db: Pick<Db, "all">, dumpId: string) {
  return {
    entities: db.all<{ name: string }>(
      sql`select name from entities where dump_id = ${dumpId} order by rowid`,
    ),
    events: db.all<{ title: string; occursOn: string }>(
      sql`select title, occurs_on as occursOn from events
          where dump_id = ${dumpId} order by rowid`,
    ),
    commitments: db.all<{
      description: string;
      direction: "owed_to_me" | "owed_by_me";
      dueDate: string | null;
      counterpartyName: string | null;
    }>(
      sql`select c.description, c.direction, c.due_date as dueDate,
                 e.name as counterpartyName
          from commitments c
          left join entities e on e.id = c.counterparty_entity_id
          where c.dump_id = ${dumpId} order by c.rowid`,
    ),
    decisions: db.all<{ decision: string }>(
      sql`select decision from decisions where dump_id = ${dumpId} order by rowid`,
    ),
  };
}
