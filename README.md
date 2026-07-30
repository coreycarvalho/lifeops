# LifeOps

A single-user, self-hosted personal assistant and **external memory system**. Dump
unstructured life-admin information into one inbox with zero organizational decisions; an
LLM extracts typed records, and the system gives back natural-language query, proactive
triggers, and a glanceable dashboard.

> Status: **pre-build**. The spec and architecture are settled; implementation follows
> the milestones in [docs/ROADMAP.md](docs/ROADMAP.md). This repo is developed 100% by
> coding agents — see [AGENTS.md](AGENTS.md).

## Why

Every prior tool (folders, Notion, task apps) fails at capture time by demanding
classification decisions. LifeOps inverts that: capture requires zero decisions, the LLM
does the filing, and the system proves it understood via a **capture echo**. The
highest-leverage feature is prospective memory — surfacing things you'd forgotten exist,
including other people's promises to you (`owed_to_me` is a first-class concept).

Grounded in cognitive-science design principles (extended mind, filing-vs-piling,
transactive memory) — see [docs/SPEC.md](docs/SPEC.md).

## Shape

```
capture inbox → raw immutable dumps → async LLM extraction → typed tables + local embeddings
                                                     ↓
                          triggers (ntfy) · NL query (hybrid SQL + semantic) · dashboard
```

- **Stack:** Next.js (TypeScript), SQLite + sqlite-vec, Vercel AI SDK (Anthropic now,
  local models swappable), ntfy notifications, Docker Compose.
- **Data sovereignty:** all data at rest stays on your hardware. LLM API calls are the
  only egress, and the provider is swappable for a local model.
- Details: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) ·
  decisions: [docs/DECISIONS.md](docs/DECISIONS.md)

## Development

```bash
npm install
npm run dev       # http://localhost:3000
npm run lint
npm run typecheck
npm test
```

Deployment target is Docker Compose on modest homelab hardware (arm64/amd64); packaging
lands with milestone M1.

## License

[MIT](LICENSE)
