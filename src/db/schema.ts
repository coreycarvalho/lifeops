import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * Conventions for this schema:
 *
 * - Ids are UUID text. The app ships no auth (SPEC: network-level access control only),
 *   so dump ids appear in URLs and must not be enumerable.
 * - Instants are ISO-8601 UTC text ("2026-07-30T19:00:00.000Z"). Lexicographic order is
 *   chronological order, so plain SQL stays readable — see AGENTS.md on inspectability.
 * - Calendar dates are "YYYY-MM-DD" text, times of day "HH:MM". Events are date-first
 *   because SPEC allows date-only events and the dashboard's date lens filters on the date.
 * - Enums are text plus a CHECK constraint. Drizzle's `enum` option is types only; the
 *   CHECK is what actually enforces the guarantee at the storage layer.
 * - Every extracted record carries `dump_id` for provenance (SPEC data model) — except
 *   entities, which span dumps and carry provenance in `entity_mentions` instead.
 */

export const EXTRACTION_STATUSES = [
  "pending",
  "processing",
  "done",
  "failed",
] as const;

export const dumps = sqliteTable(
  "dumps",
  {
    id: text("id").primaryKey(),
    createdAt: text("created_at").notNull(),
    rawText: text("raw_text").notNull(),
    source: text("source", { enum: ["web", "api"] }).notNull(),

    extractionStatus: text("extraction_status", { enum: EXTRACTION_STATUSES })
      .notNull()
      .default("pending"),
    extractionVersion: integer("extraction_version"),
    extractionAttempts: integer("extraction_attempts").notNull().default(0),
    extractionError: text("extraction_error"),
    extractedAt: text("extracted_at"),

    /** One-line summary of what was captured. The trust mechanism (SPEC hard req 3). */
    echo: text("echo"),
    /** Set by the one-tap "wrong" affordance. Feeds the extraction-precision metric. */
    flaggedWrongAt: text("flagged_wrong_at"),
  },
  (t) => [
    check("dumps_source", sql`${t.source} in ('web', 'api')`),
    check(
      "dumps_extraction_status",
      sql`${t.extractionStatus} in ('pending', 'processing', 'done', 'failed')`,
    ),
    // The worker's claim query: oldest pending dump first.
    index("dumps_status_created_idx").on(t.extractionStatus, t.createdAt),
  ],
);

/**
 * The one table with no `dump_id`. An entity mentioned by two dumps is one row here, so
 * ownership by a dump is exactly the thing it cannot have — see `entity_mentions` and the
 * decision-log entry that supersedes M1's dump-owned entities.
 *
 * `name` and `notes` are set by whichever dump created the row and are not rewritten by a
 * later one; the later dump contributes aliases.
 */
export const entities = sqliteTable(
  "entities",
  {
    id: text("id").primaryKey(),
    createdAt: text("created_at").notNull(),
    name: text("name").notNull(),
    type: text("type", {
      enum: ["person", "provider", "property", "company", "account", "other"],
    }).notNull(),
    notes: text("notes"),
  },
  (t) => [
    check(
      "entities_type",
      sql`${t.type} in ('person', 'provider', 'property', 'company', 'account', 'other')`,
    ),
    index("entities_name_idx").on(t.name),
  ],
);

/**
 * One row per (dump, entity, alias): "this dump referred to this entity by this name".
 *
 * Does two jobs that turn out to be the same job. It is the provenance link that replaces
 * `entities.dump_id` — every dump that mentioned an entity stays traceable from it — and it
 * is the index dedupe matches against. An entity's alias set is the distinct union of its
 * mentions, which is why re-extracting a dump forgets the aliases only that dump claimed
 * instead of leaving them behind forever.
 */
export const entityMentions = sqliteTable(
  "entity_mentions",
  {
    id: text("id").primaryKey(),
    entityId: text("entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
    dumpId: text("dump_id")
      .notNull()
      .references(() => dumps.id, { onDelete: "cascade" }),
    /** The alias as the dump wrote it. This is what a human reads. */
    alias: text("alias").notNull(),
    /** Casefolded, whitespace-collapsed. Matching reads this; nothing displays it. */
    aliasNormalized: text("alias_normalized").notNull(),
  },
  (t) => [
    uniqueIndex("entity_mentions_entity_dump_alias_idx").on(
      t.entityId,
      t.dumpId,
      t.aliasNormalized,
    ),
    // Dedupe's lookup: which entity has already been called this?
    index("entity_mentions_alias_idx").on(t.aliasNormalized),
    // Provenance the other way round: everything one dump mentioned.
    index("entity_mentions_dump_idx").on(t.dumpId),
  ],
);

export const threads = sqliteTable(
  "threads",
  {
    id: text("id").primaryKey(),
    dumpId: text("dump_id")
      .notNull()
      .references(() => dumps.id, { onDelete: "cascade" }),
    createdAt: text("created_at").notNull(),
    name: text("name").notNull(),
    status: text("status", { enum: ["open", "closed"] })
      .notNull()
      .default("open"),
    // `last_activity_at` is deliberately NOT stored. SPEC calls it derived, and the
    // dashboard is derived views only (invariant 7). M4 computes it from member records.
  },
  (t) => [
    check("threads_status", sql`${t.status} in ('open', 'closed')`),
    index("threads_dump_idx").on(t.dumpId),
  ],
);

export const events = sqliteTable(
  "events",
  {
    id: text("id").primaryKey(),
    dumpId: text("dump_id")
      .notNull()
      .references(() => dumps.id, { onDelete: "cascade" }),
    createdAt: text("created_at").notNull(),
    title: text("title").notNull(),
    /** "YYYY-MM-DD". Always present; SPEC permits date-only events. */
    occursOn: text("occurs_on").notNull(),
    /** "HH:MM", null when the event is date-only. */
    occursAtTime: text("occurs_at_time"),
    location: text("location"),
    status: text("status", { enum: ["upcoming", "done", "cancelled"] })
      .notNull()
      .default("upcoming"),
    prepRequirements: text("prep_requirements"),
    threadId: text("thread_id").references(() => threads.id, {
      onDelete: "set null",
    }),
  },
  (t) => [
    check(
      "events_status",
      sql`${t.status} in ('upcoming', 'done', 'cancelled')`,
    ),
    index("events_dump_idx").on(t.dumpId),
    index("events_occurs_on_idx").on(t.occursOn),
  ],
);

export const eventEntities = sqliteTable(
  "event_entities",
  {
    eventId: text("event_id")
      .notNull()
      .references(() => events.id, { onDelete: "cascade" }),
    entityId: text("entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.eventId, t.entityId] }),
    index("event_entities_entity_idx").on(t.entityId),
  ],
);

export const commitments = sqliteTable(
  "commitments",
  {
    id: text("id").primaryKey(),
    dumpId: text("dump_id")
      .notNull()
      .references(() => dumps.id, { onDelete: "cascade" }),
    createdAt: text("created_at").notNull(),
    description: text("description").notNull(),
    /** `owed_to_me` is the first-class case — see SPEC data model. */
    direction: text("direction", {
      enum: ["owed_to_me", "owed_by_me"],
    }).notNull(),
    counterpartyEntityId: text("counterparty_entity_id").references(
      () => entities.id,
      { onDelete: "set null" },
    ),
    /** "YYYY-MM-DD", null when the commitment has no stated deadline. */
    dueDate: text("due_date"),
    status: text("status", { enum: ["open", "done", "dropped"] })
      .notNull()
      .default("open"),
    resolvedAt: text("resolved_at"),
    threadId: text("thread_id").references(() => threads.id, {
      onDelete: "set null",
    }),
  },
  (t) => [
    check(
      "commitments_direction",
      sql`${t.direction} in ('owed_to_me', 'owed_by_me')`,
    ),
    check(
      "commitments_status",
      sql`${t.status} in ('open', 'done', 'dropped')`,
    ),
    index("commitments_dump_idx").on(t.dumpId),
    // Powers "Waiting On" and the owed_to_me escalation rule.
    index("commitments_direction_status_due_idx").on(
      t.direction,
      t.status,
      t.dueDate,
    ),
  ],
);

export const decisions = sqliteTable(
  "decisions",
  {
    id: text("id").primaryKey(),
    dumpId: text("dump_id")
      .notNull()
      .references(() => dumps.id, { onDelete: "cascade" }),
    createdAt: text("created_at").notNull(),
    decision: text("decision").notNull(),
    reasoning: text("reasoning"),
    /** "YYYY-MM-DD" the decision was made, which may predate the dump. */
    decidedOn: text("decided_on").notNull(),
    threadId: text("thread_id").references(() => threads.id, {
      onDelete: "set null",
    }),
  },
  (t) => [
    index("decisions_dump_idx").on(t.dumpId),
    index("decisions_decided_on_idx").on(t.decidedOn),
  ],
);

export const decisionEntities = sqliteTable(
  "decision_entities",
  {
    decisionId: text("decision_id")
      .notNull()
      .references(() => decisions.id, { onDelete: "cascade" }),
    entityId: text("entity_id")
      .notNull()
      .references(() => entities.id, { onDelete: "cascade" }),
  },
  (t) => [
    primaryKey({ columns: [t.decisionId, t.entityId] }),
    index("decision_entities_entity_idx").on(t.entityId),
  ],
);

/**
 * Written by M3's scheduler. Powers dismissal suppression and per-rule trigger precision.
 * `subject_id` is polymorphic across events/commitments/threads, so it carries no FK.
 */
export const triggerFires = sqliteTable(
  "trigger_fires",
  {
    id: text("id").primaryKey(),
    rule: text("rule").notNull(),
    firedAt: text("fired_at").notNull(),
    subjectType: text("subject_type", {
      enum: ["event", "commitment", "thread"],
    }).notNull(),
    subjectId: text("subject_id").notNull(),
    status: text("status", { enum: ["fired", "dismissed", "acted"] })
      .notNull()
      .default("fired"),
  },
  (t) => [
    check(
      "trigger_fires_subject_type",
      sql`${t.subjectType} in ('event', 'commitment', 'thread')`,
    ),
    check(
      "trigger_fires_status",
      sql`${t.status} in ('fired', 'dismissed', 'acted')`,
    ),
    index("trigger_fires_subject_idx").on(t.subjectType, t.subjectId, t.rule),
  ],
);

/**
 * Instrumentation is a feature (invariant 8). The table exists from M1; M4 and M5 write to it.
 * `success` is nullable because it is user-flagged after the fact, not known at query time.
 */
export const retrievalLog = sqliteTable(
  "retrieval_log",
  {
    id: text("id").primaryKey(),
    createdAt: text("created_at").notNull(),
    query: text("query"),
    mode: text("mode", {
      enum: ["search", "trigger", "dashboard_tap"],
    }).notNull(),
    success: integer("success", { mode: "boolean" }),
    notes: text("notes"),
  },
  (t) => [
    check(
      "retrieval_log_mode",
      sql`${t.mode} in ('search', 'trigger', 'dashboard_tap')`,
    ),
    index("retrieval_log_created_idx").on(t.createdAt),
  ],
);
