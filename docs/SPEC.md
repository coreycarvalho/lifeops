# LifeOps — Product Spec

Single-user, self-hosted personal assistant / external memory system. The owner dumps
unstructured information into a single inbox with **zero organizational decisions**; the
system extracts structure into typed tables and gives back three things:

1. **Query** — natural-language questions answered over the store ("what's the deal with the furnace guy?")
2. **Triggers** — proactive pushes at the right moment ("cardiology appointment in 8 days, symptom log stale for 12")
3. **Dashboard** — a glanceable "what's happening in my life" orientation view

This is not a product for others. Design for exactly one user.

## Design philosophy

These are grounded in cognitive-science research and justify hard requirements below:

- **Extended mind thesis (Clark & Chalmers):** value = retrieval friction + trust, not
  storage volume. If the owner can't trust the system captured something, he keeps
  shadow-remembering it and the system's value collapses.
- **Filing vs. piling (Malone / PIM research):** classification at capture time is the
  failure mode of every prior tool (folders, Notion, etc.). Capture must require ZERO
  decisions. The LLM does classification; the schema is an internal implementation detail.
- **Prospective vs. retrospective memory:** search only answers questions the owner
  already thought to ask. The high-value feature is the system generating the trigger —
  surfacing things he'd forgotten exist.
- **Transactive memory (Wegner):** the owner must be able to *stop remembering* things the
  moment they're dumped. This requires visible confirmation of extraction (capture echo).
- **Orienteering (Teevan):** the dashboard exists because search can't solve unknown unknowns.

## Scope

### In scope (MVP — "life admin")

- Single capture inbox (text first; voice/photo/email later)
- LLM extraction pass → typed records
- Capture echo (confirmation of what was extracted)
- Query interface (NL → hybrid structured/semantic retrieval)
- Scheduler-driven triggers (notifications)
- Dashboard (single screen, four zones)
- Metrics instrumentation from day one

### Explicitly deferred ("intellectual partner")

Knowledge/belief tracking, reading notes, claim versioning. Raw dumps may be captured and
embedded, but build NO structure for this yet. Rationale: building the fun knowledge layer
first is how these projects die. The admin layer forces daily contact, which keeps the
system alive.

### Non-goals

- Multi-user anything. No auth beyond basic homelab access control.
- Email/calendar *automation* (sending, scheduling on owner's behalf). Read-only ingestion
  later, maybe. This is a memory system, not an agent.
- Mobile app. Web UI responsive enough for phone + notification channel is sufficient.
- Perfect NLP. Extraction errors are acceptable IF the capture echo makes them visible.

## Hard requirements

1. **Zero-decision capture.** One text box / one endpoint. No categories, tags, or folders
   at capture time, ever.
2. **Dumps are immutable.** Every dump stored raw with timestamp. Extraction writes new
   records; it never mutates the dump.
3. **Capture echo is non-negotiable.** After extraction, respond with a one-line summary of
   what was captured, e.g. `Got it: tilt table → Jun 22; furnace quote due Fri (contractor)`.
   Include a one-tap "wrong" affordance that flags the extraction for correction
   (correction UX can be crude in MVP). This is the trust mechanism.
4. **Data sovereignty.** All data at rest stays local (SQLite file + local embedding index
   on the owner's homelab). LLM API calls for extraction/query are acceptable; the LLM
   layer sits behind an interface so a local model can be swapped in.
5. **Hybrid retrieval, not pure RAG.** "All open commitments older than 2 weeks" is a SQL
   query, not a similarity search. An LLM router decides structured query vs. semantic
   search vs. both, then synthesizes.
6. **Trigger thresholds are config, not code.**
7. **Instrumentation from day one.** This project is explicitly an experiment (see
   Instrumentation section).

## Data model (starting point — expect iteration)

All records link back to their source dump (`dump_id`) for provenance.

- **dumps**: id, created_at, raw_text, source (web/api/…), extraction_version, extraction_status
- **entities**: id, name, type (person | provider | property | company | account | other),
  aliases[], notes. Examples: "Dr. Alvarez (provider)", "12 Maple St (property)",
  "furnace contractor (person)". Extraction should dedupe against existing entities by
  alias matching.
- **events**: id, title, datetime (or date-only), entity_ids[], location?,
  status (upcoming | done | cancelled), prep_requirements? (free text or links to commitments)
- **commitments**: id, description, direction (**owed_to_me** | owed_by_me),
  counterparty_entity_id, due_date?, created_at, status (open | done | dropped), resolved_at.
  **`owed_to_me` is a first-class concept — tracking other people's promises is the
  highest-leverage feature and the main gap in commercial tools.**
- **decisions**: id, decision, reasoning, date, related_entity_ids[]. Two sentences at
  decision time; disproportionately valuable months later.
- **threads**: id, name, status (open | closed), last_activity_at (derived from linked
  records). Groups related records ("medical workup", "rental conversion", "wedding
  planning"). Extraction assigns records to threads; the LLM may propose new threads.
- **retrieval_log** (instrumentation): id, timestamp, query,
  mode (search | trigger | dashboard_tap), success (bool, user-flagged or inferred), notes

Embedding index: over `dumps.raw_text` (and optionally record descriptions), stored in
sqlite-vec.

## Dashboard spec

Single screen, four zones, strict attention budget (~10 seconds). Nothing below the fold;
no "all items" view here. Date-range lens at top: **this week / next 30 / next 90**.

1. **Needs You (max 3 items).** Intersection of urgent + actionable: prep-gaps and overdue
   `owed_to_me` commitments only. Example items: "Neuro appt in 8 days — symptom thread
   stale 12 days" / "Furnace quote 4 days overdue (contractor)".
2. **This Week.** Chronological events, one line each. No commentary.
3. **Waiting On.** All open `owed_to_me` commitments sorted by age. Subtle age indicator —
   NOT alarm-red. (Anti-guilt-wall principle: if opening the dashboard feels bad, it gets
   abandoned. Orientation surface, not obligation surface.)
4. **Going Stale.** 2–3 open threads with `last_activity_at` > 14 days.

Every zone is a derived view over the typed tables — zero state of its own, zero curation.
One query per zone. If the dashboard ever needs manual curation, the design has failed.

Dashboard taps that lead to action should be loggable (one-tap "this was useful") → feeds
the prospective-hit metric.

## Trigger rules (initial set)

- Event upcoming (T-7d, T-1d) — suppress if the event was already surfaced and dismissed
- Commitment `owed_to_me` past due_date → escalate at +1d, +3d, +7d, then weekly
- Commitment `owed_by_me` approaching due_date (T-2d)
- Thread stale > 14d (weekly digest, not individual pings)
- Prep-gap: event within 7d AND linked thread stale > 7d

Calibration matters more than coverage: pushes must be useful enough to keep notifications
on, rare enough not to be muted. Thresholds live in config, not code. Log every trigger
fired + whether it was acted on.

## Instrumentation (day one)

- **Refind success rate + time-to-retrieval:** log every query, allow one-tap success/fail flag.
- **Prospective hits:** trigger or dashboard item that changed an action. One-tap logging.
- **Duplicate-work rate:** hard to automate; provide a manual "I just re-researched
  something" log button.
- **Trigger precision:** fired vs. acted-on ratio per rule.
- **Extraction precision:** echo corrections / total extractions.

Evaluation plan: ~6 weeks of real use across the owner's next-90-days threads. Success =
prospective hits meaningfully > 0, refind success high, and maintenance cost near zero.
Chronic Needs-You emptiness or ignored triggers = verdict against.

## Open questions

- Backup strategy (deliberately deferred — see docs/DECISIONS.md)
- Correction UX beyond "flag as wrong" in MVP
- Future capture surfaces: voice, photo, read-only email ingestion
