# LifeOps

A single-user, self-hosted personal assistant and **external memory system**. Dump
unstructured life-admin information into one inbox with zero organizational decisions; an
LLM extracts typed records, and the system gives back natural-language query, proactive
triggers (prospective memory — including other people's promises to you), and a
glanceable dashboard.

> Status: **pre-build**, developed 100% by coding agents. Milestone M1 is next.

## Start here

- [docs/SPEC.md](docs/SPEC.md) — the product: requirements, data model, dashboard and
  trigger specs, build order
- [docs/DECISIONS.md](docs/DECISIONS.md) — why the non-obvious choices were made
- [AGENTS.md](AGENTS.md) — invariants and rules for the agents building this

Stack: Next.js/TypeScript, SQLite + sqlite-vec, Vercel AI SDK, ntfy, Docker Compose —
runs anywhere Docker runs, sized for a Raspberry-Pi-class box. All data at rest stays on
your host; LLM API calls are the only egress, and the provider is swappable for a local
model.

## License

[MIT](LICENSE)
