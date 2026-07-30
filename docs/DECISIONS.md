# Decision Log

Append-only. Two sentences at decision time. Record only decisions whose "why" a future
agent could NOT reconstruct from the code. Supersede by adding a new entry, not editing.

---

## 2026-07-30 — TypeScript full-stack (Next.js + Vercel AI SDK), not Python

One language and one toolchain for a repo maintained entirely by coding agents; Next.js
gives a real UI story without a second stack. Python's LLM-tooling edge is neutralized by
the AI SDK, which also keeps Anthropic → local-model a config change.

## 2026-07-30 — SQLite (better-sqlite3 + sqlite-vec), not Postgres

Single user, single writer, one file to back up, lowest footprint on modest shared
hardware. Drizzle for schema/migrations only; complex queries in plain SQL for
inspectability.

## 2026-07-30 — Build order is triggers/dashboard before query

Query-first rebuilds "chat with notes," which fails the unknown-unknowns problem the
system exists to solve. See Build order in SPEC.md; reordering requires an entry here.

## 2026-07-30 — Backup strategy deferred

Deliberately open (tracked in issue #1). Constraint locked now: all state under one
mounted volume, so any future choice (operator-managed restic/borg vs. built-in nightly
`sqlite3 .backup`) needs no app changes.

## 2026-07-30 — eslint 9 and TypeScript 5.9 held at current majors

eslint-config-next is built against eslint 9, and TS 7's native compiler is too new for a
zero-gardening repo. Revisit when Next moves.

## 2026-07-30 — Vitest as the test runner

Next's own testing guide recommends it, it needs no transform config for TypeScript, and
one runner covers both the node-side pipeline and (from M2) jsdom component tests.

## 2026-07-30 — Migrations applied at runtime by drizzle-orm, not the drizzle-kit CLI

`drizzle-kit` is a devDependency and is absent from the production image, so the
deployed migrate step uses `drizzle-orm/better-sqlite3/migrator` over the committed
`drizzle/` SQL. drizzle-kit stays a local authoring tool (`npm run db:generate`).

## 2026-07-30 — `tsx` runs the worker and migrate CLI in dev and prod

Avoids a second tsconfig and a separate build output for the non-Next processes, and keeps
dev and production invocation identical. Cost is one runtime dependency; the alternatives
(native Node type stripping, a parallel `tsc` build) both need exotic import conventions
that would break on a Next or Node minor.

## 2026-07-30 — Instants are ISO-8601 UTC text; calendar dates are `YYYY-MM-DD` text

Lexicographic order equals chronological order, so the plain-SQL queries M4 and M5 depend
on stay readable without epoch-to-date conversions. Events store `occurs_on` plus a
nullable `occurs_at_time` rather than one nullable timestamp, because SPEC allows date-only
events and the dashboard's date lens filters on the date either way.

## 2026-07-30 — Record collections are junction tables, not JSON columns

SPEC writes `aliases[]` and `entity_ids[]` as arrays, but M4's dashboard zones and M5's
structured queries are SQL over these links. Joins are inspectable and indexable;
`json_each` is neither.

## 2026-07-30 — Enums are text plus a CHECK constraint

Drizzle's `enum` option is compile-time only. The CHECK is what holds against a raw SQL
write, keeping the guarantee in the storage layer where it cannot be bypassed.

## 2026-07-30 — Entities are owned by the dump that created them (revisit in M2)

M1 has no cross-dump dedupe, so every extracted record including entities carries a
`dump_id` and is deleted when that dump is re-extracted — this is what makes re-processing
idempotent. M2's alias-based dedupe makes one entity span several dumps and will need an
entity-mentions table plus its own entry here.

## 2026-07-30 — M1 configuration is environment-only

SPEC's config *file* holds ntfy URL/topic, trigger thresholds, and timezone — none of which
exist before M3. Adding the file now would mean shipping an empty one; M3 introduces it
alongside the first thresholds it has to carry.
