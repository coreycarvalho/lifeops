# Decision Log

Two sentences at decision time; disproportionately valuable months later. Append-only.
Format: date, decision, reasoning. Supersede by adding a new entry, not editing.

---

## 2026-07-30 — TypeScript full-stack (Next.js App Router)

One language and one toolchain for a repo maintained entirely by coding agents; Next.js
gives a genuinely good UI story without a second stack to garden. Python's LLM tooling
advantage is neutralized by the Vercel AI SDK covering extraction/structured output well.

## 2026-07-30 — SQLite (better-sqlite3) + sqlite-vec, not Postgres

Single user, single writer, one file to back up, lowest footprint on shared homelab
hardware. Drizzle handles schema/migrations; complex queries are written in plain SQL for
inspectability.

## 2026-07-30 — Vercel AI SDK as the LLM abstraction

Provider-agnostic interface with structured-output support; Anthropic
(`@ai-sdk/anthropic`) now, a local Ollama-compatible provider later as a config change.

## 2026-07-30 — ntfy as the first Notifier implementation

Self-hostable, trivial HTTP publish API, fits the homelab. Built behind a pluggable
`Notifier` interface so the channel is swappable.

## 2026-07-30 — Capture echo lands in-UI *and* via notification

Web captures echo inline; API captures (future voice/email surfaces) echo via the
notifier. Both paths keep the trust loop intact.

## 2026-07-30 — MIT license

Personal open-source tool; simplest permissive default, zero friction.

## 2026-07-30 — Backup strategy deferred

Deliberately open. Constraint recorded now: all state lives under one mounted volume so
any future choice (owner-managed restic/borg, or built-in nightly `sqlite3 .backup`)
slots in without app changes. Tracked as an open issue.
