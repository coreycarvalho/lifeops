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
sudo mkdir -p /opt/lifeops && cd /opt/lifeops
sudo curl -O https://raw.githubusercontent.com/coreycarvalho/lifeops/main/docker-compose.yml
sudo curl -o .env https://raw.githubusercontent.com/coreycarvalho/lifeops/main/.env.example
sudo $EDITOR .env     # four things to set; the file says which
sudo docker compose up -d
```

`/opt/lifeops` is not special — anywhere works — but the boot unit below expects the
compose file and `.env` to be in one known directory, so pick one and stay in it.

The four: `LLM_BASE_URL`, `LLM_MODEL`, `LIFEOPS_TIMEZONE` (UTC is the default and is wrong
for almost everyone — every date the system derives is computed in this zone), and
`LIFEOPS_BIND`, which is loopback until you say otherwise. See "Who can reach it" below.

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
| `LLM_MODEL` | yes | Exactly as `ollama list` reports it, capitalisation included. |
| `LIFEOPS_TIMEZONE` | set it | The zone you live in. Defaults to UTC, which is wrong for almost everyone. |
| `LIFEOPS_BIND` | set it | Which interface the capture box is on. Loopback by default. |
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

## Who can reach it

**LifeOps ships no authentication and no TLS, by design.** It is a single-user system and
the assumption is network-level access control: a LAN, a VPN, or a reverse proxy that
handles auth.

Because of that, the capture box is published on **loopback only** by default. Out of the
box you can reach it from the host itself and from nowhere else. Opening it up is
`LIFEOPS_BIND`, and it is deliberately a decision you make rather than one you inherit:

| `LIFEOPS_BIND` | Who can reach it |
|---|---|
| `127.0.0.1` (default) | only the host itself — SSH tunnel from your laptop, or a proxy on the same box |
| `192.168.1.10` | anything on that LAN. The usual answer for a Pi at home |
| `100.x.x.x` | your tailnet, if you run Tailscale or similar |
| `0.0.0.0` | every interface on the host. Only if you are certain all of them are private |

**Never `0.0.0.0` on a machine with a public IP.** The short `3000:3000` form that most
Compose files use does exactly that, which is why this one does not.

If you want it reachable from outside the house, put it on a VPN overlay rather than opening
a port. That also gives you an address LifeOps accepts for `LLM_BASE_URL`.

## Starting on boot

`docker compose up -d` sets `web` and `worker` to restart automatically, so they come back
after a reboot. **Compose's ordering is not part of that.** The Docker daemon restarts those
two from their own restart policies; it does not re-run the exited `init` and it does not
know about `depends_on`. So on a bare reboot:

- The worker re-checks the model endpoint itself before it will claim anything, so that half
  of the gate holds however the process was started.
- The **web** app does not, and a later `docker compose up` will not stop a container that is
  already running and healthy — so web can be serving while `init` runs, or after it failed.
- Migrations are not applied on a boot that follows an image change.

Put `compose up` back in the boot path, and make it start from a clean stop so the ordering
actually applies:

```ini
# /etc/systemd/system/lifeops.service
[Unit]
Description=LifeOps
Requires=docker.service
After=docker.service network-online.target

[Service]
Type=oneshot
RemainAfterExit=yes
WorkingDirectory=/opt/lifeops
# Whatever the daemon restarted on its own is stopped first, so `up` recreates everything
# in dependency order and init genuinely gates web. Leading `-` so a first boot, with
# nothing to stop, is not an error.
ExecStartPre=-/usr/bin/docker compose down
ExecStart=/usr/bin/docker compose up -d
ExecStop=/usr/bin/docker compose down

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl enable --now lifeops
```

`WorkingDirectory` has to be the directory holding `docker-compose.yml` and `.env` — the
quick start above uses `/opt/lifeops`. Without the unit, prefer `docker compose down &&
docker compose up -d` over a bare `up` after an unclean restart, for the same reason.

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

**`pull access denied` or `manifest unknown` on a clean host.** The GHCR package is private.
GitHub creates container packages private on first publish and there is no API to change it,
so it is a one-time manual step on the repo:
`https://github.com/coreycarvalho/lifeops/pkgs/container/lifeops` → *Package settings* →
*Change visibility* → **Public**. Until then, `docker login ghcr.io` with a token that has
`read:packages` also works.

**`init` exits 1 and nothing starts.** Read its log; every message names the variable to
change. It is the gate doing its job.

**The worker keeps restarting.** It checks the endpoint before it will claim a dump, so this
is the same failure as an `init` that will not pass — read its log for the reason. Dumps
stay `pending` and are extracted when the endpoint comes back; nothing is lost and no
attempts are spent.

**Dumps stay "Captured. Working out what's in it…" forever.** The worker is not running or
is stuck. `docker compose logs worker`. If the model server is wedged it accepts connections
and never answers, which looks exactly like a slow model — check `ollama ps` on that machine
before concluding anything about model size.

**"Extraction failed, trying again".** The dump is safe and will be retried while attempts
remain. The message carries the endpoint's own error.

**Captures are fine but extraction quality is poor.** Expected, for now — a small local model
is what M2 is for. The echo exists so you can see it happening rather than trusting it
blindly.
