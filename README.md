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
runs anywhere Docker runs, sized for a Raspberry-Pi-class box. **Nothing you capture leaves
your network.** Data at rest stays on your host, and extraction runs against a local
OpenAI-compatible endpoint you point it at (Ollama is what's verified) — so inference can
live on a machine with a GPU while LifeOps itself stays small enough for a Pi. No API keys,
no third-party inference.

## Local development

Prerequisites: **Node 24** (what CI pins) and, if you want to exercise extraction against a
real model, **[Ollama](https://ollama.com)**. Nothing else is bundled — there is no model
in this repo and none in the Docker image.

```bash
npm install
npm test        # needs nothing running; the LLM is stubbed at the provider interface
npm run dev
```

Extraction talks to an OpenAI-compatible endpoint, so running it for real means pointing at
one:

```bash
LIFEOPS_DB_PATH=./data/lifeops.db
LLM_BASE_URL=http://localhost:11434/v1   # ollama serve
LLM_MODEL=qwen3:4b                       # whatever `ollama list` reports
```

### Pick the model for the job you're doing

Testing that the pipeline works and judging whether extraction is any good are different
jobs, and they want different models. Conflating them is how you end up waiting on a model
your laptop can't hold.

| Question | Model to use | Why |
|---|---|---|
| Does the pipeline work end to end? | smallest thing that runs | Quality is irrelevant. You want fast iteration and real bytes over the wire. |
| Is the extraction actually good? | what you deploy against | The real question — and it belongs to M2, on the box that runs it. |

**Check the model fits before pulling it.** If weights approach your available RAM the
machine swaps on every token and throughput collapses. Measured on an 8 GB M2: an 8.83 GB
model ran at **0.1 tok/s — 60 seconds to emit one word.** It is not subtly slow, it is
unusable, and it looks like a hang rather than an error.

A 3–4B model at Q4 (~2.5 GB) is the sweet spot for a laptop. `ollama ps` reports resident
size once loaded; compare that against free memory, not against total memory.

## License

[MIT](LICENSE)
