# LifeOps — Product Spec

Single-user, self-hosted personal assistant / external memory system. The owner dumps
unstructured information into a single inbox with **zero organizational decisions**; the
system extracts structure into typed tables and gives back three things:

1. **Query** — natural-language questions answered over the store ("what's the deal with the furnace guy?")
2. **Triggers** — proactive pushes at the right moment ("cardiology appointment in 8 days, symptom log stale for 12")
3. **Dashboard** — a glanceable "what's happening in my life" orientation view

Not a product for others. Design for exactly one user.

## Design philosophy (justifies the hard requirements)

- **Extended mind (Clark & Chalmers):** value = retrieval friction + trust, not storage
  volume. If the owner can't trust that capture worked, he keeps shadow-remembering and
  the system's value collapses.
- **Filing vs. piling (Malone):** classification at capture time is the failure mode of
  every prior tool. The LLM classifies; the schema is an internal detail.
- **Prospective vs. retrospective memory:** search only answers questions the owner
  already thought to ask. The high-value feature is the trigger — surfacing what he'd
  forgotten exists.
- **Transactive memory (Wegner):** the owner must be able to *stop remembering* the moment
  he dumps — hence visible confirmation of extraction (capture echo).
- **Orienteering (Teevan):** the dashboard exists because search can't solve unknown unknowns.

## Hard requirements

1. **Zero-decision capture.** One text box / one endpoint. No categories, tags, or folders
   at capture time, ever.
2. **Dumps are immutable.** Stored raw with timestamp. Extraction writes new records; it
   never mutates the dump.
3. **Capture echo is non-negotiable.** After extraction, a one-line summary of what was
   captured — e.g. `Got it: tilt table → Jun 22; furnace quote due Fri (contractor)` —
   shown in-UI for web captures and pushed via notifier for API captures, with a one-tap
   "wrong" affordance (correction UX can be crude in MVP). This is the trust mechanism.
4. **Data sovereignty.** All data at rest stays local (SQLite + sqlite-vec on the owner's
   homelab). LLM API calls are acceptable; the LLM sits behind a provider interface so a
   local model is a config change.
5. **Hybrid retrieval, not pure RAG.** "All open commitments older than 2 weeks" is a SQL
   query, not a similarity search. An LLM router picks structured query / semantic search /
   both, then synthesizes.
6. **Trigger thresholds are config, not code.**
7. **Instrumentation from day one.** This project is explicitly an experiment.

## Scope

**MVP (life admin):** single capture inbox (text first; voice/photo/email later) → async
LLM extraction → typed records; capture echo; scheduler-driven triggers; four-zone
dashboard; NL query; metrics instrumentation.

**Explicitly deferred (intellectual partner):** knowledge/belief tracking, reading notes,
claim versioning. Raw dumps may be captured and embedded, but build NO structure for this
yet — building the fun knowledge layer first is how these projects die; the admin layer
forces daily contact.

**Non-goals:** multi-user anything; auth beyond basic homelab access control; email/
calendar *automation* (memory system, not an agent); mobile app (responsive web +
notifications suffice); perfect NLP (extraction errors are fine IF the echo makes them
visible).

## Data model (starting point — expect iteration)

All records link back to their source dump (`dump_id`) for provenance.

- **dumps**: id, created_at, raw_text, source (web/api/…), extraction_version, extraction_status
- **entities**: id, name, type (person | provider | property | company | account | other),
  aliases[], notes. Examples: "Dr. Alvarez (provider)", "12 Maple St (property)".
  Extraction dedupes against existing entities by alias matching.
- **events**: id, title, datetime (or date-only), entity_ids[], location?,
  status (upcoming | done | cancelled), prep_requirements? (free text or links to commitments)
- **commitments**: id, description, direction (**owed_to_me** | owed_by_me),
  counterparty_entity_id, due_date?, created_at, status (open | done | dropped), resolved_at.
  **`owed_to_me` is first-class — tracking other people's promises is the highest-leverage
  feature and the main gap in commercial tools.**
- **decisions**: id, decision, reasoning, date, related_entity_ids[]. Two sentences at
  decision time; disproportionately valuable months later.
- **threads**: id, name, status (open | closed), last_activity_at (derived). Groups related
  records ("medical workup", "rental conversion"). Extraction assigns records to threads;
  the LLM may propose new threads.
- **retrieval_log** (instrumentation): id, timestamp, query,
  mode (search | trigger | dashboard_tap), success (bool, user-flagged or inferred), notes

Embedding index: sqlite-vec over `dumps.raw_text` (optionally record descriptions).

## Dashboard

Single screen, four zones, ~10-second attention budget. Nothing below the fold; no "all
items" view. Date-range lens at top: **this week / next 30 / next 90**. Every zone is one
query over the typed tables — zero state, zero curation. If the dashboard ever needs
manual curation, the design has failed.

1. **Needs You (max 3).** Urgent ∩ actionable: prep-gaps and overdue `owed_to_me` only.
   E.g. "Neuro appt in 8 days — symptom thread stale 12 days".
2. **This Week.** Chronological events, one line each. No commentary.
3. **Waiting On.** Open `owed_to_me` commitments by age. Subtle age indicator — NOT
   alarm-red (anti-guilt-wall: if opening the dashboard feels bad, it gets abandoned).
4. **Going Stale.** 2–3 open threads with `last_activity_at` > 14 days.

Zone taps that lead to action are loggable (one-tap "this was useful") → prospective-hit metric.

## Trigger rules (initial set)

- Event upcoming (T-7d, T-1d) — suppress if already surfaced and dismissed
- `owed_to_me` past due → escalate at +1d, +3d, +7d, then weekly
- `owed_by_me` approaching due (T-2d)
- Thread stale > 14d (weekly digest, not individual pings)
- Prep-gap: event within 7d AND linked thread stale > 7d

Calibration > coverage: useful enough to keep notifications on, rare enough not to be
muted. Log every fire + whether acted on.

## Instrumentation (day one)

- **Refind success + time-to-retrieval:** log every query; one-tap success/fail flag
- **Prospective hits:** trigger/dashboard item that changed an action; one-tap logging
- **Duplicate-work rate:** manual "I just re-researched something" button
- **Trigger precision:** fired vs. acted-on per rule
- **Extraction precision:** echo corrections / total extractions

Evaluation: ~6 weeks of real use. Success = prospective hits meaningfully > 0, refind
success high, maintenance near zero. Chronic Needs-You emptiness or ignored triggers =
verdict against.

## Deployment constraints (not inferable from code — respect these)

- Homelab: Raspberry Pi 5 / Beelink N150, shared with other services. Modest footprint;
  multi-arch images (arm64 + amd64); Docker Compose packaging.
- All state (SQLite file, config) under ONE mounted volume so backups are a volume copy.
- Notifier and LLM provider are pluggable interfaces; concrete choices are config.

## Build order — start at M1

Deliberate order: **triggers and dashboard deliver value even if query is weak;
query-first is the standard mistake** (rebuilds "chat with notes," which fails the
unknown-unknowns problem). Don't reorder without a decision-log entry. Each milestone
ships behavior + tests in the same PR.

- **M1 — Capture core.** Schema/migrations; dump via web box or `POST /api/dumps`, raw +
  immutable; async extraction → typed records with `dump_id` provenance and stored
  `extraction_version` (re-processing idempotent); echo with "wrong" flag; retrieval_log
  table exists.
- **M2 — Extraction quality.** Iterate the prompt against ~20 real captures; alias-based
  entity dedupe (same provider mentioned two ways → one entity); thread assignment;
  corrections recorded.
- **M3 — Scheduler + ntfy.** Notifier interface; event-upcoming + owed_to_me escalation
  rules first; thresholds in config; every fire logged with acted-on status.
- **M4 — Dashboard.** Four zones, one query each; date lens; one-tap "useful" logging.
- **M5 — Hybrid query.** NL endpoint; LLM router (SQL / semantic / both); sqlite-vec
  index; every query logged with success/fail flag.
- **M6 — Instrumentation polish.** One-tap affordances everywhere; metrics view.

**Parking lot (do not start):** voice/photo/email capture, local LLM provider swap,
knowledge/belief layer.
