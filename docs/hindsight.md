# Running Hindsight locally

Contract tests and day-to-day use need a running [Hindsight](https://github.com/vectorize-io/hindsight).
`scripts/hindsight-host.sh` runs the official Docker image with a persistent volume, local
embeddings and reranker, and the LLM provider taken from your environment. Nothing leaves the
machine except the calls the LLM provider itself makes.

## Prerequisites

- Docker, with permission to run containers.
- Disk: the full image is about 4 GB on arm64 and about 9 GB on amd64. The embedding and reranker
  models are bundled, so there is no separate model download on first start; first start still
  takes a minute or two while the embedded database initialises.
- RAM: about 1 GB idle, 1.5 GB under load for the API, plus the UI and database. Give the machine
  at least 2 GB free.
- An LLM provider (see below).

## Configuration

The script passes every `HINDSIGHT_API_*` variable in its environment to the container, after
sourcing an optional env file at `${XDG_CONFIG_HOME:-$HOME/.config}/dmn/hindsight.env`. The file
lives outside the repository on purpose; keep it `chmod 600` since it may hold a token.

`HINDSIGHT_API_LLM_PROVIDER` is required: `start` exits 2 without it.

Example `hindsight.env` for a developer machine (the file is sourced by the shell, so `$HOME`
and other variables expand):

```sh
HINDSIGHT_API_LLM_PROVIDER=claude-code
HINDSIGHT_API_LLM_MODEL=claude-sonnet-5-5
HINDSIGHT_API_LLM_TIMEOUT=300
HINDSIGHT_API_LLM_API_KEY=<token from `claude setup-token`>
```

Script-level variables, also read from the env file but not passed to the container:

| Variable               | Meaning                                                                                               | Default                 |
| ---------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------- |
| `HINDSIGHT_CLAUDE_DIR` | Opt-in: a directory mounted read-write at `/home/hindsight/.claude` (see the warning under providers) | unset                   |
| `HINDSIGHT_HOST_URL`   | Base URL `status` probes                                                                              | `http://127.0.0.1:8888` |

The script forwards only `HINDSIGHT_API_*` variables to the container.

## Commands

```sh
bash scripts/hindsight-host.sh start    # create or restart the container "hindsight"
bash scripts/hindsight-host.sh status   # prints "healthy" and exits 0 when GET /health is 200, else exits 1
bash scripts/hindsight-host.sh logs     # follow the container logs
bash scripts/hindsight-host.sh stop     # stop the container; the volume "hindsight-data" is kept
```

The container is named `hindsight`, uses the named volume `hindsight-data` (embedded database at
`/home/hindsight/.pg0`), runs with `--shm-size=1g` and restarts unless stopped. The API (8888)
and UI (9999) bind to `127.0.0.1` only. The container is created once and reused: environment
changes need `docker rm -f hindsight` before the next `start`. Data survives that, because it
lives in the volume.

## LLM providers

| Provider                                        | Setup                                                                                                                                                                                                                                               |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude-code` (default for a developer machine) | Uses your Claude subscription. The image bundles the `claude` CLI but no login. Default: run `claude setup-token` on the host and put the token in `HINDSIGHT_API_LLM_API_KEY`. Opt-in alternative: `HINDSIGHT_CLAUDE_DIR` (see the warning below). |
| `anthropic`, `openai`, others                   | `HINDSIGHT_API_LLM_PROVIDER`, `HINDSIGHT_API_LLM_MODEL` and `HINDSIGHT_API_LLM_API_KEY`. See the Hindsight configuration docs for the full list.                                                                                                    |

Notes for `claude-code`:

- Each LLM turn drives the CLI and takes several seconds, so retain is slow; raise
  `HINDSIGHT_API_LLM_TIMEOUT` as shown above.
- **Warning: `HINDSIGHT_CLAUDE_DIR`.** Mounting your `~/.claude` exposes every session
  transcript (which can hold secrets), `settings.json` hooks, `CLAUDE.md` and MCP config to the
  container, and the container's `claude` writes its own sessions into your host
  `~/.claude/projects`, the corpus the replay harness reads. Prefer the token. If you mount, use a
  dedicated directory that holds only a copied credential.
- Use a model id your account can access. A wrong id fails retain with "issue with the selected
  model".

## Check it works

```sh
curl -s -X POST http://127.0.0.1:8888/v1/default/banks/smoke/memories \
  -H 'content-type: application/json' \
  -d '{"items":[{"content":"The smoke test uses the claude-code provider.","tags":["smoke-tag"]}]}'

curl -s -X POST http://127.0.0.1:8888/v1/default/banks/smoke/memories/recall \
  -H 'content-type: application/json' \
  -d '{"query":"which provider does the smoke test use","tags":["smoke-tag"]}'
```

The first returns `"success":true`; the second returns the item in `results`.

## Pointing dmn at it

```sh
export DMN_STORE_URL=http://127.0.0.1:8888
```

Run the contract test (the file arrives with the store-core unit):

```sh
DMN_STORE_URL=http://127.0.0.1:8888 bun test src/store/hindsight.contract.test.ts
```

CI does not run Hindsight.
