<!-- BEGIN:nextjs-agent-rules -->
# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` before writing any code. Heed deprecation notices.
<!-- END:nextjs-agent-rules -->

# LifeOps — Agent Guide

This repo is built and maintained entirely by coding agents.

**Start here:** `docs/SPEC.md` is the product — requirements, data model, dashboard/
trigger specs, and the build order (currently at M1). `docs/DECISIONS.md` is the why.
Everything else (stack, layout, commands), infer from the code and `package.json`.

## Invariants (violating these is a design failure, not a style issue)

1. Capture requires zero organizational decisions from the user — no tags, categories, or
   folders at capture time. The LLM classifies; the schema stays internal.
2. Dumps are immutable. Extraction writes new records; it never mutates raw dumps.
3. Every capture path ships with a capture echo and a "wrong" affordance. This is the
   trust mechanism.
4. Nothing captured leaves the operator's network. Data at rest stays on-box, and through
   M6 inference runs against a local OpenAI-compatible endpoint — no hosted-provider calls,
   no off-box persistent storage.
5. Retrieval is hybrid — structured questions get SQL. Never funnel everything through
   similarity search.
6. Trigger thresholds live in config, not code.
7. The dashboard is derived views only — zero state, zero curation.
8. Instrumentation is a feature: queries, trigger fires, and dashboard taps get logged.

## Engineering rules

- Tests ship with the behavior, in the same PR. Test behaviors, not units.
- Don't build ahead of the current milestone; the parking lot in SPEC.md exists so you
  don't. Diagnose before coding.
- No hidden control flow; execution readable without chasing through more than one file.
  The two blessed interfaces are the LLM provider (via AI SDK) and `Notifier` — new
  abstractions need a decision-log entry and ≥3 call sites.
- Plain SQL for complex queries; Drizzle for schema/migrations only.
- Boring, maintainable choices — this must survive near-zero gardening on modest shared
  hardware (arm64 + amd64, Docker Compose, all state under one volume).
- New dependency, new interface, changed threshold semantics, or any spec deviation →
  append to `docs/DECISIONS.md` in the same PR. No silent exceptions.
- `npm run lint`, `npm run typecheck`, and `npm test` pass before any commit; CI stays green.
