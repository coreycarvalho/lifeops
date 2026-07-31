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

## 2026-07-30 — Local inference only through M6; hosted providers parked

Supersedes the LLM half of "TypeScript full-stack" above and flips the SPEC parking lot:
local was the parked item, and is now the only option built. Extraction talks to an
OpenAI-compatible endpoint on the operator's network, so no capture ever leaves it — the
strongest reading of the data-sovereignty requirement, and it removes the API key as a
setup step and a running cost.

Accepted cost: a small local model extracts less well than a frontier one. SPEC already
takes this position ("perfect NLP" is a non-goal; errors are fine *if* the echo makes them
visible), so the trust mechanism carries more weight now, and M2 evaluates the model as
well as the prompt.

## 2026-07-30 — Inference is not co-located with LifeOps

A Raspberry-Pi-class box cannot run a model that does reliable structured extraction, so
Compose ships web + worker + migrate only and points at an endpoint elsewhere on the LAN.
Model weights stay out of the image and off the state volume, keeping "back up one volume"
true. Ollama is what gets verified; the transport is plain OpenAI-compatible, so another
server is a URL change.

## 2026-07-30 — No `LLM_PROVIDER` switch

With one transport and one code path, a provider enum would be a knob with a single valid
position. Config is `LLM_BASE_URL` + `LLM_MODEL`, plus an optional `LLM_API_KEY` for
endpoints behind a proxy that wants one. Adding a hosted provider later means adding a
package and an entry here — deliberately not a config flag.

## 2026-07-30 — Extraction reasons by default; latency is not a design constraint

Current small models emit reasoning tokens before answering, which puts structured
extraction at 15–70s per dump rather than 1–4s. Every model tested — `qwen3.5:2b`,
`gemma4:e2b` — extracts measurably worse with reasoning suppressed, fragmenting single
commitments into several junk records. Since extraction runs in the worker and never in a
request handler, that time is throughput nobody is waiting on: one operator dumping a dozen
notes a day spends minutes of idle background compute.

So reasoning is left at each model's default rather than forced off, and `reasoning_effort`
is exposed as configuration with no value set — M2 tunes it against real captures, which is
the first point we have evidence about what it should be.

The consequence lands on the capture UI, not the worker: the echo cannot wait on extraction
without showing a minute of spinner, so capture echoes immediately and extraction fills in
after. Invariant 3's trust mechanism fires on capture, not on completion.

## 2026-07-30 — Verified local models, and a correction

An earlier revision of the README concluded that an 8 GB machine could not run local
inference, from a model measured at 0.1 tok/s. That diagnosis was wrong. The Ollama server
was wedged behind a stale `ollama run` process and was returning empty replies, which is
indistinguishable from a model too large to load. On a working server the same class of
hardware runs `qwen3.5:2b-q4_K_M` at ~45 tok/s and `gemma4:e2b-it-qat` at ~33 tok/s, both
GPU-resident.

Recorded because the wrong conclusion is the expensive one: it argues for a bigger box or a
hosted provider, and the second of those would breach invariant 4. Check `ollama ps` before
believing anything about model size.
