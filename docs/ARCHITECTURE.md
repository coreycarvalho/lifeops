# Architecture

## System shape

```
[capture surfaces] → [dumps table (raw, immutable)] → [extraction job (LLM, async)]
                                                          ↓
                                          [typed tables] + [embedding index over raw dumps]
                                                          ↓
                    [scheduler → triggers/notifications]  +  [query API (LLM router)]  +  [dashboard (derived views)]
```

## Stack (decided — see docs/DECISIONS.md for rationale)

| Concern | Choice |
|---|---|
| App framework | Next.js (App Router), TypeScript, single container via standalone output |
| Database | SQLite via better-sqlite3; plain SQL for complex queries, Drizzle for schema/migrations |
| Embeddings | sqlite-vec, local index over `dumps.raw_text` |
| LLM layer | Vercel AI SDK; `@ai-sdk/anthropic` now, Ollama-compatible provider swappable via config |
| Scheduler | node-cron (or equivalent) in a long-running worker alongside the web process |
| Notifications | ntfy behind a pluggable `Notifier` interface |
| Packaging | Docker Compose; one app container + one volume for SQLite + config |

## Components

1. **Capture inbox.** One endpoint (`POST /api/dumps`) + one UI box. Accepts free text
   (MVP). Every dump stored raw + immutable with timestamp. Owner rule: "when in doubt,
   dump it in."
2. **Extraction job.** Async worker; LLM parses each dump into zero or more typed records.
   Multiple record types can come from one dump. Idempotent; stores `extraction_version`
   so dumps can be re-processed when prompts improve.
3. **Capture echo.** After extraction, a one-line summary of what was captured is shown
   in-UI (for web captures) and pushed via the notifier (for API captures). One-tap
   "wrong" affordance flags the extraction for correction.
4. **Hybrid retrieval.** NL query → LLM router decides: structured query (SQL over typed
   tables), semantic search (embeddings over raw dumps), or both, then synthesizes an
   answer. Never pure RAG.
5. **Scheduler.** Cron-style loop evaluating trigger rules from config, pushing via the
   Notifier interface, logging every fire.
6. **Dashboard.** Server-rendered, four zones, each a single query over typed tables.
   Zero state of its own.

## Key interfaces (keep these boundaries)

- **`LLMProvider`** — extraction + query synthesis go through one interface (the AI SDK
  provider abstraction). Model/provider chosen by env config. A local model must be a
  config change, not a code change.
- **`Notifier`** — `notify(message, opts)`. ntfy is the first implementation.
- **Trigger rules** — thresholds (T-7d, staleness windows, escalation ladder) read from
  config, not hardcoded.

## Deployment constraints

- Homelab: Raspberry Pi 5 / Beelink N150, shared with other services (Immich, Jellyfin,
  arr stack). Keep the resource footprint modest. Build multi-arch images (arm64 + amd64).
- Docker Compose is the packaging. All state under a single mounted volume
  (SQLite file, config) so it slots into existing backup practices.
- Data at rest never leaves the homelab. LLM API calls carry dump text to the configured
  provider (acceptable; provider is swappable for a local model).
