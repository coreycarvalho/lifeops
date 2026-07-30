# Roadmap

Build order is deliberate: **triggers and dashboard deliver value even if query is weak;
query-first is the standard mistake** (it rebuilds "chat with notes," which fails the
unknown-unknowns problem). Do not reorder without recording a decision.

Each milestone ships behavior + tests in the same PR. A milestone is done when its
acceptance criteria pass against real usage, not when the code merges.

## M1 — Capture core

Schema + migrations; dumps table; extraction job; capture echo. CLI or bare web form is fine.

- Dump via web box or `POST /api/dumps`; raw text stored immutably with timestamp
- Async extraction produces zero or more typed records per dump, linked by `dump_id`
- `extraction_version` stored per dump; re-processing is idempotent
- Echo returns a one-line summary of extracted records with a "wrong" flag affordance
- `retrieval_log` table exists and query/trigger/dashboard events can be written to it

## M2 — Extraction quality loop

Typed tables populated end-to-end from real dumps.

- Iterate the extraction prompt against ~20 real captures from the owner
- Entity dedupe by alias matching works (the same provider mentioned two ways yields one entity)
- Thread assignment works; LLM can propose new threads
- Extraction corrections are recorded (crude UX acceptable)

## M3 — Scheduler + notifications

- ntfy notifier behind the `Notifier` interface
- Event-upcoming (T-7d, T-1d) and `owed_to_me` escalation rules live
- All thresholds in config, not code
- Every trigger fire logged with acted-on status

## M4 — Dashboard

- Four zones (Needs You / This Week / Waiting On / Going Stale), one query per zone
- Date-range lens: this week / next 30 / next 90
- Nothing below the fold; Waiting On uses subtle age indicators, never alarm-red
- One-tap "this was useful" logging on zone items

## M5 — Hybrid query

- NL query endpoint; LLM router picks SQL / semantic / both and synthesizes
- Embedding index over dumps via sqlite-vec
- Every query logged with one-tap success/fail flag

## M6 — Instrumentation polish

- One-tap affordances everywhere metrics need them (logging itself exists from M1)
- Metrics view: refind success, prospective hits, trigger precision per rule,
  extraction precision, manual duplicate-work log

## Post-MVP (parking lot — do not start)

- Voice / photo / read-only email capture surfaces
- Local LLM provider (config swap)
- Knowledge/belief layer ("intellectual partner") — explicitly deferred by design
