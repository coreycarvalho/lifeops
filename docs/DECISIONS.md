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

## 2026-07-31 — AI SDK v7 + `@ai-sdk/openai-compatible` + zod

The AI SDK was already the committed path; `@ai-sdk/openai-compatible` is its provider for
exactly this transport, and zod is its peer dependency and the schema `generateObject`
wants. All three land together because none is useful without the others.

## 2026-07-31 — jsdom component tests arrive in M1, not M2

Supersedes the aside in the Vitest entry above. Two of issue #5's behaviours are the capture
box's — the summary replacing the confirmation, and "wrong" surviving a reload — and the
echo is the trust mechanism, so hand-verifying it was the wrong place to save three
devDependencies. Cost is `jsdom` and `@testing-library/react`; the one jsdom file opts in
with a `@vitest-environment` docblock so the rest of the suite stays node.

`@testing-library/user-event` was tried and dropped: its internal waits deadlock against
faked timers, and the polling interval has to be faked to be tested. `fireEvent` needs
neither and tests the same behaviours.

## 2026-07-31 — Agreed SPEC deviation: the echo is pulled, not pushed, for API captures

SPEC hard requirement 3 says API captures get their echo "pushed via notifier", but
`Notifier` is M3. M1 ships `GET /api/dumps/:id` instead and M3 adds the push. The web box
polls the same endpoint, so there is one place the echo is computed rather than two.

## 2026-07-31 — The echo is rendered from the stored records, never written by the model

Asking the model for a summary alongside the records costs nothing and reads better, and is
exactly wrong: the echo would then describe what the model *meant* to store rather than what
is in the database, and the trust mechanism becomes one more thing to distrust. It is a pure
function over the rows that were written, read back after the transaction.

## 2026-07-31 — A failed extraction is `failed` immediately, and retried while attempts remain

"Never silent" and "stops looping" both have to hold. So failure sets `failed` and an error
message straight away, and the claim query treats `failed` with attempts remaining as
eligible — the dump is visibly failed the whole time it waits for its next attempt, rather
than sitting in `pending` looking untouched.

The attempt counter increments at *claim*, not at failure, so a worker that dies
mid-extraction still spends an attempt and a crash loop still terminates. Anything left
`processing` is requeued at worker startup, because `processing` is the one status nothing
retries.

## 2026-07-31 — M1 extracts entities, events, commitments and decisions — no threads

Thread assignment is M2 (issue #5 says so explicitly). The `threads` table stays empty
through M1. Events carry entity links; decisions do not — `decision_entities` waits for M2,
because every extra array is another thing a 2B model fills with junk.

## 2026-07-31 — No `pattern` anywhere in the extraction schema

Ollama compiles the JSON Schema into a decoding grammar and cannot compile a regex: any
`pattern` returns `400 Failed to initialize samplers: failed to parse grammar`. Verified
against Ollama 0.32.5. Date shapes are therefore checked in `src/extraction/run.ts` when the
record is written, not by the schema — which is also the better place for them, because one
hallucinated date should cost one record rather than the whole dump.

## 2026-07-31 — Extraction latency: correcting the 15–70s figure, and a context-length floor

Measured against the real endpoint on the M1 schema, `qwen3.5:2b-q4_K_M`:

| reasoning | result |
|---|---|
| default (on), 4096 ctx | no answer — 3829 reasoning tokens, `finish_reason: length` |
| default (on), 16384 ctx | ~6 min, still consumes essentially the whole context |
| `none` | ~5s, schema-valid, poor quality (`gemma4:e2b-it-qat`: ~19s) |

So the earlier "15–70 seconds" is wrong for this schema: these models reason until they run
out of context rather than converging. Ollama also appears to treat `reasoning_effort` as
on/off — `low` behaved like the default, only `none` changed anything.

Two consequences. First, **`OLLAMA_CONTEXT_LENGTH` must be raised from its 4096 default** or
reasoning-on extraction cannot produce an answer at all; that is server-side operator
config, not something LifeOps can set over `/v1` (`options.num_ctx` is ignored there).
Second, `LLM_REASONING_EFFORT` keeps no default: on this hardware the real choice is minutes
per dump versus seconds, and neither is obviously right until M2 has real captures to judge
quality against.

Nothing in the architecture changes — extraction is still in the worker and capture still
echoes immediately, which is exactly why a six-minute extraction is survivable.
