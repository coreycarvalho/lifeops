import { randomUUID } from "node:crypto";
import { and, eq, gte, lt, or, sql } from "drizzle-orm";
import type { Db } from "@/db/client";
import {
  commitments,
  decisions,
  entityMentions,
  eventEntities,
  events,
  dumps,
} from "@/db/schema";
import type { Extraction } from "@/llm/extraction";
import type { LlmProvider } from "@/llm/provider";
import { localDate } from "@/time";
import { renderSummary } from "./echo";
import {
  deleteUnmentionedEntities,
  normalizeAlias,
  resolveEntity,
} from "./identity";

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
 * extraction that produced them.
 *
 * 2: entities are resolved across dumps rather than created per dump. The model's answer is
 * unchanged, but the same answer now produces different entity rows, which is the thing
 * this number exists to distinguish. M2's prompt rewrite bumps it again.
 */
export const EXTRACTION_VERSION = 2;

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
 *
 * The attempt limit applies to `pending` as well as `failed`, not just the obvious retry
 * case: a worker that dies on its last allowed attempt leaves a row that `requeueStuckDumps`
 * puts back, and a limit that only covered `failed` would hand it out again forever.
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
      and(
        or(
          eq(dumps.extractionStatus, "pending"),
          eq(dumps.extractionStatus, "failed"),
        ),
        lt(dumps.extractionAttempts, maxAttempts),
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
 * Hand a claimed dump back to the queue without spending the attempt.
 *
 * The attempt counter exists to bound a worker that keeps crashing, and a graceful shutdown
 * is not a crash: `docker compose down` is the documented first step of both a backup and an
 * upgrade, and routine maintenance must not be able to spend the last attempt of a capture
 * that was never going to fail. Compose's ten-second grace period expires long before a
 * reasoning-on extraction finishes, so this is the normal path, not an edge case.
 *
 * Conditional on `processing`, so an extraction that completed in the moment between the
 * signal arriving and this running keeps its result. A crash still spends the attempt —
 * nothing calls this on the way out of a crash.
 */
export function releaseDump(db: Db, dumpId: string): boolean {
  const released = db
    .update(dumps)
    .set({
      extractionStatus: "pending",
      // Never below zero, so a hand-edited row cannot make the counter meaningless.
      extractionAttempts: sql`max(${dumps.extractionAttempts} - 1, 0)`,
    })
    .where(and(eq(dumps.id, dumpId), eq(dumps.extractionStatus, "processing")))
    .run();

  return released.changes === 1;
}

/**
 * Deal with anything left mid-flight. A worker killed between claiming and finishing would
 * otherwise leave a dump `processing` forever, which is the one status nothing retries.
 *
 * Two outcomes, because a dump that has run out of attempts must not be parked in `pending`:
 * `pending` renders as "working out what's in it", so it would look like extraction was
 * still coming when nothing would ever pick it up again. The attempts already spent are
 * never refunded, so a crash loop still terminates.
 */
export function requeueStuckDumps(
  db: Db,
  maxAttempts: number,
  now = new Date(),
): { requeued: number; abandoned: number } {
  const abandoned = db
    .update(dumps)
    .set({
      extractionStatus: "failed",
      extractionError: "The worker stopped before extraction finished",
      extractedAt: now.toISOString(),
    })
    .where(
      and(
        eq(dumps.extractionStatus, "processing"),
        gte(dumps.extractionAttempts, maxAttempts),
      ),
    )
    .run().changes;

  const requeued = db
    .update(dumps)
    .set({ extractionStatus: "pending" })
    .where(eq(dumps.extractionStatus, "processing"))
    .run().changes;

  return { requeued, abandoned };
}

/**
 * Every timestamp written here is taken *after* the model returns, never before it is
 * called. Extraction runs into the minutes, so a clock read at the top of this function
 * would stamp `extracted_at` — and every extracted record's `created_at` — with the moment
 * the attempt started, putting the whole model latency between what the row says and what
 * happened. That is the number M2 will be reading to judge a model.
 */
export async function extractDump(
  db: Db,
  provider: LlmProvider,
  dumpId: string,
  timeZone: string,
): Promise<void> {
  const [dump] = db
    .select({ id: dumps.id, rawText: dumps.rawText, createdAt: dumps.createdAt })
    .from(dumps)
    .where(eq(dumps.id, dumpId))
    .all();
  if (!dump) throw new Error(`No dump ${dumpId}`);

  // The day the note was written where the operator lives — not the UTC day the instant
  // happens to fall on. Every relative date in the note resolves against this.
  const capturedOn = localDate(dump.createdAt, timeZone);

  let extraction: Extraction;
  try {
    extraction = await provider.extract({ rawText: dump.rawText, capturedOn });
  } catch (error) {
    // Only the model call is caught here. A wedged endpoint, a refused connection or a
    // response that will not validate is an ordinary extraction failure, and retrying it is
    // the right answer.
    const message = error instanceof Error ? error.message : String(error);
    db.update(dumps)
      .set({
        extractionStatus: "failed",
        extractionError: message.slice(0, MAX_ERROR_LENGTH),
        // When it gave up, which for a timeout is ten minutes after it started.
        extractedAt: new Date().toISOString(),
      })
      .where(eq(dumps.id, dumpId))
      .run();
    return;
  }

  // Storing is deliberately outside the catch. A broken migration, a missing table or a bug
  // in the echo is not an extraction failure, and dressing it up as one would mark every
  // dump as the model's fault while the worker carried on doing it. Let it escape to the
  // worker's fatal handler instead — no silent exceptions (AGENTS.md).
  //
  // Note what is NOT updated: raw_text and created_at. The dump is immutable (invariant 2);
  // extraction only ever adds records and moves status.
  store(db, dump.id, capturedOn, extraction, new Date());
}

function store(
  db: Db,
  dumpId: string,
  capturedOn: string,
  extraction: Extraction,
  completedAt: Date,
): void {
  const createdAt = completedAt.toISOString();
  const dump = { id: dumpId };

  db.transaction((tx) => {
    // Re-extraction replaces rather than appends. Deleting the dump's own records is what
    // makes a second run leave the same records behind instead of a second copy; the
    // junction rows go with them via ON DELETE CASCADE.
    for (const table of [events, commitments, decisions]) {
      tx.delete(table).where(eq(table.dumpId, dump.id)).run();
    }

    // Entities are the exception: they span dumps, so there is nothing here this dump owns
    // outright. What this dump owns is its *mentions* — those go, and an entity left with
    // no mentions at all goes with them. An entity another dump still refers to survives.
    tx.delete(entityMentions).where(eq(entityMentions.dumpId, dump.id)).run();
    deleteUnmentionedEntities(tx);

    /** Every name and alias the model used, pointing at the entity it resolved to. */
    const byName = new Map<string, string>();

    for (const entity of extraction.entities) {
      const resolved = resolveEntity(tx, dump.id, entity, createdAt);
      if (!resolved) continue;
      for (const alias of resolved.aliases) {
        // First entity to claim a name keeps it, within this dump.
        if (!byName.has(alias.normalized)) byName.set(alias.normalized, resolved.id);
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
        const entityId = byName.get(normalizeAlias(name));
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
          counterpartyEntityId: commitment.counterpartyName
            ? (byName.get(normalizeAlias(commitment.counterpartyName)) ?? null)
            : null,
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
    // An entity this dump named may have been created by an earlier one, so the echo reads
    // through the mentions rather than off the entity row. Ordered by first mention, so the
    // echo lists them in the order the dump introduced them either way.
    entities: db.all<{ name: string }>(
      sql`select e.name as name
          from entities e
          join entity_mentions m on m.entity_id = e.id
          where m.dump_id = ${dumpId}
          group by e.id
          order by min(m.rowid)`,
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
