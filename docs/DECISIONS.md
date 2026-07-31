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

## 2026-07-31 — One extraction gets one time bound (`LLM_TIMEOUT_MS`)

A wedged endpoint accepts the connection and then says nothing — the failure mode the README
already warns about — and an unbounded call leaves the dump in `processing` forever while the
single serial worker never reaches anything behind it. `generateObject` gets an
`AbortSignal.timeout`, so the stall surfaces as an ordinary failure and takes the existing
retry path.

The default is ten minutes, which is a stall detector rather than a latency budget:
reasoning-on extraction genuinely runs to about six. The signal covers the whole call
including the SDK's own retries, so one extraction gets one bound rather than one per attempt.

## 2026-07-31 — `LIFEOPS_TIMEZONE` arrives in M1, ahead of M3's config file

SPEC puts the timezone in the config file alongside M3's thresholds, and "M1 configuration is
environment-only" above deferred it. It cannot wait: M1 already has to tell the model what day
a note was written on, and `createdAt.slice(0, 10)` is the UTC day. A note written at 11pm on
July 31 in New York is stored as `2026-08-01T03:00:00Z`, so the model would be told August 1
and every "tomorrow" and weekday in the note would resolve a day out.

It arrives as an environment variable, which is consistent with M1 being env-only, and folds
into the config file when M3 introduces one. Defaults to the host zone; an unrecognised zone
throws at startup rather than silently falling back, because a silent fallback is exactly the
bug being fixed. `renderSummary` now requires its `asOf` date for the same reason — the
obvious default was UTC.

## 2026-07-31 — "Wrong" is only accepted once there is a summary to be wrong about

The flag is the extraction-precision metric (corrections over extractions), so it has to mean
"the summary was wrong". "Captured. Working out what's in it…" and "extraction failed" are the
system reporting on itself; a flag against either counts a bad extraction that never happened,
and would then hide the affordance when the real summary arrived. The endpoint answers 409
for anything that is not `done`, and the button is not rendered.

The client also rolls the flag back if the request fails. An affordance that shows "marked
wrong" for something the database never recorded is claiming a persistence it does not have,
which is worse than not offering it.

## 2026-07-31 — `LLM_BASE_URL` must be on the operator's own network, enforced at startup

Validating that the endpoint is a well-formed http(s) URL does not enforce invariant 4:
`https://api.openai.com/v1` is a perfectly good URL, and one typo in an env file would ship
every capture to a hosted provider with nothing else going wrong. The host is now checked
against loopback, the RFC1918 / link-local / ULA ranges, the CGNAT range that VPN overlays
hand out, and names only a local resolver can answer (`.local`, `.internal`, `.lan`,
`.home.arpa`, bare hostnames, and `*.ts.net` for Tailscale MagicDNS).

Syntactic, not a routing proof: a public DNS name pointing at a private address is rejected.
That is the safe direction to be wrong in, and the fix is to use the private name or address
directly.

**No override flag, deliberately.** An `LLM_ALLOW_REMOTE=1` would make the invariant
advisory, which is the opposite of what it is for. Reaching a hosted provider stays what "No
`LLM_PROVIDER` switch" above says it is: a code change with an entry here.

## 2026-07-31 — Only the model call is caught; storage failures kill the worker

`store()` used to sit inside the same `try` as `provider.extract()`, so a broken migration, a
missing table or a bug in the echo renderer became an ordinary "extraction failed", burned the
dump's attempts, and left the worker carrying on doing it to every dump behind it. A pipeline
bug reported as a model failure is the silent exception AGENTS.md forbids.

The catch now wraps the provider call alone. Anything `store()` throws escapes to the worker's
fatal handler, which exits non-zero and lets the restart policy surface it. The dump stays
`processing` and is requeued on the next start, bounded by the attempt limit as usual.

## 2026-07-31 — The echo says whether a failure is going to be retried

`claimNextDump` treats a failed dump as eligible while attempts remain, so "failed" is not a
terminal state and the capture box must not treat it as one — stopping there leaves the user
reading an error that the next attempt fixed until they happen to reload. `GET /api/dumps/:id`
now returns `retrying`, and the echo distinguishes "Extraction failed, trying again" from
"Captured, but extraction failed".

That means the web process needs the attempt limit, so `getMaxExtractionAttempts` is split out
the same way `getDbPath` already is: the web app never calls a model, and making it demand an
LLM endpoint to boot would be a lie about what it needs.

## 2026-07-31 — One image, three commands, and `next start` rather than standalone

The web app, the extraction worker and the `init` step run from the same published image with
different commands. Next's `output: "standalone"` prunes `node_modules` to what Next traced,
and the worker and both CLIs run from source through `tsx` — they need `drizzle-orm`,
`better-sqlite3`, `ai` and `tsx` itself, none of which Next traces. Two images or a standalone
bundle plus a second `node_modules` would both be more moving parts than a chunky image, and
issue #6 puts size explicitly out of scope: a Pi-class box can afford a large image more easily
than a fragile one.

## 2026-07-31 — The base image is Debian trixie, and this is load-bearing

`better-sqlite3`'s prebuilt bindings for linux/amd64 and linux/arm64 are linked against GLIBC
2.38. `node:24-slim` is bookworm, which ships 2.36: the image builds cleanly, passes every
test, and then dies on first database call with `libm.so.6: version GLIBC_2.38 not found`.
Found by running the thing, not by building it.

`node:24-trixie-slim` (GLIBC 2.41) is the fix. The alternative — `npm_config_build_from_source`
— removes the coupling entirely but pays for it with an emulated arm64 compile of sqlite3.c on
every lockfile change in CI. Recorded because the failure is invisible at build time and the
cause is two layers from the symptom; the compilers stay in the build stage as the fallback if
a future prebuild moves again.

## 2026-07-31 — Startup checks the model endpoint, and a bad one stops the whole stack

`loadConfig` proves `LLM_BASE_URL` is a well-formed URL on the operator's own network, and
`http://localhost:11434/v1` satisfies both while being wrong inside every container — localhost
is the container. The web process never reads LLM config at all (deliberately: it never calls a
model), so nothing would have caught it until the worker's first extraction, by which point
captures have been accepted for as long as the operator has been using it.

So `init` probes `{LLM_BASE_URL}/models` and checks the endpoint serves `LLM_MODEL` before it
applies migrations, and `web` and `worker` wait on it succeeding. Connection failures retry for
about half a minute, because a model box may be booting alongside this one; anything that
*answered* fails immediately, because a 404 does not fix itself.

Accepted cost: if the model box is down when the host boots, LifeOps stays down rather than
coming up degraded. That is the trade issue #6 asks for — "startup fails with a clear message
rather than accepting captures it can never extract" — and a capture the system silently cannot
extract is a direct hit on invariant 3, which is the whole trust mechanism.

## 2026-07-31 — Compose pins `LIFEOPS_DB_PATH`, overriding the operator's `.env`

Where state lives *inside* the container is a packaging fact, not a preference. An operator who
could point it somewhere other than the mounted volume could silently make "back up one volume"
false, and would find out at restore time. `environment:` beats `env_file:`, so `.env` documents
the variable and says it is ignored under Compose.

## 2026-07-31 — `yaml` (devDependency) so packaging behaviours are tested, not just written

"One volume", "migrations run once with nothing racing them", "web and worker are separate
processes" and "main publishes both architectures" are behaviours of `docker-compose.yml` and
the publish workflow. They are as load-bearing as anything in `src/` — a second service given
its own volume breaks backups and nobody notices until a restore — and hand-rolled regex over
YAML would rot at the first reformat. `src/packaging.test.ts` parses the real files.

What it cannot cover is that the image builds and runs, which is `docker buildx build
--platform linux/amd64,linux/arm64` and `docker compose up`, per issue #6's own note that the
real-host run is the operator's.
