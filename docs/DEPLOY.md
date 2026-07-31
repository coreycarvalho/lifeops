# Deploying LifeOps

Three containers, one volume, no secret, no third party. LifeOps runs on your hardware and
talks to a model endpoint on your own network. Nothing you capture leaves it.

## What you need

- **A host that runs Docker.** A Raspberry-Pi-class box is the sizing target. Published
  images are multi-arch, so arm64 and amd64 both work.
- **An OpenAI-compatible model endpoint, somewhere else on your network.** LifeOps does not
  ship one and does not run one: the box that runs LifeOps is deliberately too small to run
  a model that extracts reliably, and model weights have no business on the state volume.
  [Ollama](https://ollama.com) on a machine with a GPU is what's verified — anything that
  speaks the same API works.
- Nothing else. No account, no API key, no managed database.

Before you start, on the machine running the model:

```bash
ollama pull qwen3.5:2b-q4_K_M   # or whatever you intend to run
ollama list                     # LLM_MODEL has to match one of these exactly
```

If the model server is not on the same host as LifeOps, it has to listen on more than
loopback — for Ollama that is `OLLAMA_HOST=0.0.0.0`. And raise `OLLAMA_CONTEXT_LENGTH` from
its 4096 default: with reasoning left on, these models will spend the whole 4096 tokens
thinking and never answer. See the README for why.

## Bring it up

```bash
curl -O https://raw.githubusercontent.com/coreycarvalho/lifeops/main/docker-compose.yml
curl -o .env https://raw.githubusercontent.com/coreycarvalho/lifeops/main/.env.example
$EDITOR .env          # LLM_BASE_URL and LLM_MODEL are the only two that matter
docker compose up -d
```

Then open `http://<host>:3000`, dump something, and watch the echo go from "Captured.
Working out what's in it…" to a summary of what was stored. That summary is the point: it is
how you know the system heard you, and it comes with a "wrong" button for when it didn't.

`docker compose logs -f worker` shows extraction happening. A dump takes seconds to minutes
depending on the model and whether reasoning is on — capture confirms immediately either way,
which is why extraction is a separate process.

## What the three containers are

| | what it does |
|---|---|
| `init` | Checks your endpoint, applies migrations, exits. Runs on every start. |
| `web` | The capture box and the API. Never calls the model. |
| `worker` | Extraction. Never serves a request. |

`web` and `worker` both wait for `init` to *succeed*, which is what makes migrations happen
exactly once with nothing racing them — and what stops the web process from accepting
captures when the endpoint is misconfigured.

## Configuration

Every variable is documented in [`.env.example`](../.env.example), which is the file you
copied. The short version:

| Variable | Required | Notes |
|---|---|---|
| `LLM_BASE_URL` | yes | Your endpoint, **including the API path** (`…:11434/v1`). Must be on your own network. |
| `LLM_MODEL` | yes | Exactly as `ollama list` reports it. |
| `LIFEOPS_TIMEZONE` | no, but set it | The zone you live in. Defaults to the container's, which is UTC. |
| `LLM_API_KEY` | no | Only for an endpoint behind a proxy that wants one. Empty is normal. |
| `LLM_REASONING_EFFORT` | no | Unset = the endpoint's default (better, slower). `none` = fast and worse. |
| `LLM_TIMEOUT_MS` | no | Abandons a wedged endpoint. Default 10 minutes. |
| `WORKER_POLL_MS` | no | Default 2000. |
| `EXTRACTION_MAX_ATTEMPTS` | no | Default 3. |
| `LIFEOPS_PORT` | no | Host port for the capture box. Default 3000. |
| `LIFEOPS_IMAGE_TAG` | no | `latest`, or `sha-<commit>` to pin. |

`LIFEOPS_DB_PATH` is pinned to `/data/lifeops.db` by `docker-compose.yml` and ignores what
you put in `.env`. That is deliberate — see "Backups" below.

## `localhost` is not your host

The single most common way to get this wrong. Inside a container, `localhost` is *the
container*, so `LLM_BASE_URL=http://localhost:11434/v1` points at a port nothing is
listening on. Two things that work:

- **Model server on the same host as LifeOps:** `http://host.docker.internal:11434/v1`.
  Compose already maps that name to the host gateway.
- **Model server elsewhere:** its address on your network —
  `http://192.168.1.50:11434/v1`, or a Tailscale name like `https://gpu.tail1a2b.ts.net/v1`.

LifeOps checks this at startup and refuses to run rather than accept captures it can never
extract, so you find out in `docker compose logs init` and not three weeks of notes later.
The check also verifies your endpoint actually serves `LLM_MODEL`, and prints what it does
serve when it doesn't.

`LLM_BASE_URL` must be on your own network — loopback, a private/link-local/CGNAT address,
or a name only a local resolver can answer. `https://api.openai.com/v1` is rejected, and
there is no flag to allow it. Nothing you capture leaves your network.

## Backups

Everything LifeOps stores is in one volume, `lifeops-data`: the SQLite file, its WAL
sidecars, and (from M3) the config file. Backing LifeOps up is copying that volume.

```bash
docker compose down                       # a cold copy, so WAL is checkpointed
docker run --rm -v lifeops_lifeops-data:/data -v "$PWD:/out" \
  busybox tar czf /out/lifeops-backup.tgz -C /data .
docker compose up -d
```

There is deliberately no built-in backup yet — the strategy is open (issue #1). The one
constraint that is locked is the one above: one volume, so whatever gets chosen later is a
copy rather than a migration.

**Using a bind mount instead of a named volume?** The container runs as uid 1000, and a
named volume inherits that ownership from the image while a host directory does not. Run
`chown -R 1000:1000 /your/path` first, or the stack starts and cannot write.

## Access control

**LifeOps ships no authentication and no TLS, by design.** It is a single-user system and
the assumption is network-level access control: a LAN, a VPN, or a reverse proxy that
handles auth. Publish port 3000 to a private interface, never to the internet.

If you want it reachable from outside the house, put it on a VPN overlay (Tailscale or
similar) rather than opening a port. That also gives you an endpoint address LifeOps
accepts for `LLM_BASE_URL`.

## Upgrading

```bash
docker compose pull
docker compose up -d
```

`init` re-runs on every start: it re-checks the endpoint and applies any new migrations
before `web` or `worker` come back. Pin `LIFEOPS_IMAGE_TAG=sha-<commit>` if you would rather
choose your moment.

## When something is wrong

```bash
docker compose logs init      # startup gate: the endpoint and the migrations
docker compose logs -f worker # extraction, one line per dump
docker compose ps             # if web and worker are missing, init failed — read its log
```

**`init` exits 1 and nothing starts.** Read its log; every message names the variable to
change. It is the gate doing its job.

**Dumps stay "Captured. Working out what's in it…" forever.** The worker is not running or
is stuck. `docker compose logs worker`. If the model server is wedged it accepts connections
and never answers, which looks exactly like a slow model — check `ollama ps` on that machine
before concluding anything about model size.

**"Extraction failed, trying again".** The dump is safe and will be retried while attempts
remain. The message carries the endpoint's own error.

**Captures are fine but extraction quality is poor.** Expected, for now — a small local model
is what M2 is for. The echo exists so you can see it happening rather than trusting it
blindly.
