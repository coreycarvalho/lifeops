<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# LifeOps — Agent Guide

This repo is built and maintained entirely by coding agents. Read this file plus the doc
that matches your task before writing code.

## Required reading

- `docs/SPEC.md` — what this is, hard requirements, data model, dashboard/trigger specs
- `docs/ARCHITECTURE.md` — components, stack, interface boundaries
- `docs/DECISIONS.md` — why choices were made; append here when you make a new one
- `docs/ROADMAP.md` — build order and acceptance criteria; do not reorder or skip ahead

## Invariants (violating these is a design failure, not a style issue)

1. Capture requires zero organizational decisions from the user. No tags, categories, or
   folders at capture time — the LLM classifies, the schema stays internal.
2. Dumps are immutable. Extraction writes new records; it never mutates raw dumps.
3. Every extraction produces a capture echo with a "wrong" affordance. This is the trust
   mechanism; never ship a capture path without it.
4. All data at rest stays local (SQLite + sqlite-vec on the owner's homelab). LLM API
   calls are fine; persistent storage off-box is not.
5. Retrieval is hybrid. Structured questions get SQL; do not funnel everything through
   similarity search.
6. Trigger thresholds live in config, not code.
7. The dashboard is derived views only — zero state, zero curation.
8. Instrumentation is a feature, not an afterthought: queries, trigger fires, and
   dashboard taps get logged.

## Engineering rules

- **Tests come with the behavior, in the same PR. Test behaviors, not units.** A milestone
  without passing acceptance-level tests is not done.
- Diagnose before coding; confirm root cause before writing a fix.
- Don't add code the current milestone doesn't require. The parking lot in
  `docs/ROADMAP.md` exists so you don't build it.
- Code must be locally understandable: no hidden control flow, no decorator magic, no
  config-driven behavior beyond the trigger thresholds. Execution readable without
  chasing through more than one file.
- Abstractions must be stable and used in ≥3 places before they exist. The two blessed
  interfaces are `LLMProvider` (via AI SDK) and `Notifier` — don't invent more without a
  decision log entry.
- Prefer the most inspectable representation: plain SQL for complex queries; Drizzle for
  schema/migrations only.
- Boring, maintainable choices. This must survive with near-zero gardening on shared
  homelab hardware (arm64 + amd64).
- New dependency, new interface, changed threshold semantics, or any deviation from the
  spec → append an entry to `docs/DECISIONS.md` in the same PR. No silent exceptions.

## Workflow

- `npm run lint`, `npm run typecheck`, and `npm test` must pass before any commit lands.
- CI runs lint + typecheck + test + build on every push/PR; keep it green.
- Conventional-ish commits are fine; clarity over ceremony.
