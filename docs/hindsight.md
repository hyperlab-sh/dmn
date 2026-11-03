# Running Hindsight locally

Contract tests and day-to-day use need a running [Hindsight](https://github.com/vectorize-io/hindsight).
`scripts/hindsight-host.sh` installs and runs the `hindsight-api` pip package natively: the
embedded database lives under your home directory, the local embedding and reranker models are
bundled with the package, and the LLM provider is taken from your environment. Nothing leaves
the machine except the calls the LLM provider itself makes.

## Prerequisites

- `uv` on PATH (it creates the venv, and fetches the Python for it if the system one is
  unsuitable — the script pins Python 3.12, because Hindsight's pinned dependencies do not
  ship wheels for the newest Pythons).
- Disk: the venv with the package and the bundled models is about 6.5 GB; give the machine
  about 8 GB free.
- RAM: about 2 GB idle once the models are loaded, more under load; give the machine 4 GB free.
- An LLM provider (see below).

## Commands

```sh
bash scripts/hindsight-host.sh install   # create the venv and install hindsight-api into it
bash scripts/hindsight-host.sh start     # start the API detached on 127.0.0.1:8888
bash scripts/hindsight-host.sh status    # prints "healthy" and exits 0 when GET /health is 200, else exits 1
bash scripts/hindsight-host.sh logs      # follow the server log
bash scripts/hindsight-host.sh stop      # terminate the server and remove the pid file
```

- `install` creates the venv at `${XDG_DATA_HOME:-$HOME/.local/share}/dmn/hindsight` with
  `uv venv` and installs `hindsight-api` into it with `uv pip install`. A second `install` is
  a no-op that says so. Without `uv` on PATH it exits 2 naming it.
- `start` starts `hindsight-api --host <bind> --port <port>` detached from that venv, with the
  `HINDSIGHT_API_*` environment, and leaves it running when the shell exits. It writes the
  process id to `${XDG_STATE_HOME:-$HOME/.local/state}/dmn/hindsight.pid` and appends the
  server output to `hindsight.log` beside it. When the pid file names a live process it prints
  `already running (pid N)` and exits 0. When the venv is missing, `start` runs `install`
  first.
- The first `start` after installing takes roughly half a minute while the embedded database
  initialises and the models load; `status` answers `unhealthy` until then.
- `stop` sends TERM, waits up to 75 s, then removes the pid file. A pid file naming a dead
  process is removed with a message and exit 0.
- Run `start` from a shell; there is no service-manager unit yet (logging in and running
  `start` is the way to bring the service back after a reboot).

## Configuration

The script sources an optional env file at `${XDG_CONFIG_HOME:-$HOME/.config}/dmn/hindsight.env`
and passes every `HINDSIGHT_API_*` variable in its environment to the server. The file lives
outside the repository on purpose; keep it `chmod 600` since it may hold a token.

`HINDSIGHT_API_LLM_PROVIDER` is required: `start` exits 2 without it.

Example `hindsight.env` (the file is sourced by the shell, so `$HOME` and other variables
expand):

```sh
HINDSIGHT_API_LLM_PROVIDER=claude-code
HINDSIGHT_API_LLM_MODEL=claude-sonnet-5-5
HINDSIGHT_API_LLM_TIMEOUT=300
```

Script-level variables, also read from the env file but not server configuration:

| Variable              | Meaning                                            | Default                |
| --------------------- | -------------------------------------------------- | ---------------------- |
| `HINDSIGHT_HOST_BIND` | Address `start` binds                              | `127.0.0.1`            |
| `HINDSIGHT_HOST_PORT` | Port `start` binds                                 | `8888`                 |
| `HINDSIGHT_HOST_URL`  | Base URL `status` probes (overrides the two above) | `http://<bind>:<port>` |

Hindsight keeps its own data (the embedded `pg0` database) under `~/.hindsight`; it survives
`stop` and `start`.

## LLM providers

| Provider                                          | Setup                                                                                                                                                                      |
| ------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude-code` (default for a single-user machine) | Uses the Claude subscription of the user the server runs as. `claude` must be on PATH and logged in (`claude auth login`); no credential is copied or configured anywhere. |
| `anthropic`, `openai`, others                     | `HINDSIGHT_API_LLM_PROVIDER`, `HINDSIGHT_API_LLM_MODEL` and `HINDSIGHT_API_LLM_API_KEY`. See the Hindsight configuration docs for the full list.                           |

Notes for `claude-code`:

- Each LLM turn drives the `claude` CLI and takes several seconds, so retain is slow; raise
  `HINDSIGHT_API_LLM_TIMEOUT` as shown above.
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
