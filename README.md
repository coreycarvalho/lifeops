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
LLM_MODEL=qwen3.5:2b-q4_K_M              # whatever `ollama list` reports
```

### Pick the model for the job you're doing

Testing that the pipeline works and judging whether extraction is any good are different
jobs, and they want different models. Conflating them is how you end up tuning a prompt
against a model you were never going to deploy.

| Question | Model | Why |
|---|---|---|
| Does the pipeline work end to end? | `qwen3.5:2b-q4_K_M` (1.9 GB) | Quality is irrelevant here. Smallest thing that loads fast and emits valid JSON. |
| Is the extraction any good? | whatever your endpoint serves | The real question, and it belongs to M2 — on the box that runs it, not your laptop. |

Anything that speaks OpenAI-compatible works; these are just the tags that have been
verified. A 2–4B model at Q4 is enough to develop against, and **modest hardware is not the
constraint people expect** — on an 8 GB Apple-silicon laptop, `qwen3.5:2b-q4_K_M` holds
1.6 GB resident and runs at ~45 tok/s, and `gemma4:e2b-it-qat` (4.3 GB) holds 3.6 GB at
~33 tok/s. Both are GPU-accelerated with room to spare.

**Prefer a QAT tag when the model has one.** Quantization-aware-trained builds are
substantially smaller than the default tag for the same model and quality — `gemma4:e2b-it-qat`
is 4.3 GB against 7.2 GB for plain `gemma4:e2b`. The default tag is not always the small one.

### Two things that look like bugs and are not

**Extraction taking 15–70 seconds is normal.** Current small models reason before answering,
and those tokens cost real time. It is not a hang. Extraction runs in the worker and never
in a request handler, so this costs throughput you are not using — leave reasoning on, since
every model tested extracts worse without it. `reasoning_effort: "none"` turns it off if you
need a fast loop; note that `chat_template_kwargs: {enable_thinking: false}` is silently
ignored over `/v1`.

**A wedged Ollama is indistinguishable from a slow model.** A stuck server accepts the
connection and returns nothing, which reads exactly like a model too large to load — and
will burn an afternoon if you take it at face value. Before concluding anything about size:

```bash
ollama ps                          # is a runner actually resident?
ps aux | grep "ollama run"         # stale CLI processes block the scheduler
brew services restart ollama       # or: pkill ollama && ollama serve
```

If `ollama ps` is empty while a request is in flight, the server is the problem, not the
model.

## License

[MIT](LICENSE)
