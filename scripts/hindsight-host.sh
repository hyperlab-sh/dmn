#!/usr/bin/env bash
# Install, start, stop and inspect a native Hindsight API server.
# Usage: hindsight-host.sh install|start|stop|status|logs
# Configuration comes from HINDSIGHT_* variables in the environment, plus an optional
# env file at ${XDG_CONFIG_HOME:-$HOME/.config}/dmn/hindsight.env. See docs/hindsight.md.
set -euo pipefail

load_env_file() {
	local config_home="${XDG_CONFIG_HOME:-${HOME:-}/.config}"
	local env_file="${config_home}/dmn/hindsight.env"
	if [ -f "$env_file" ]; then
		set -a
		# shellcheck disable=SC1090
		. "$env_file"
		set +a
	fi
}

load_env_file

data_home="${XDG_DATA_HOME:-${HOME:-}/.local/share}"
state_home="${XDG_STATE_HOME:-${HOME:-}/.local/state}"
venv_dir="${data_home}/dmn/hindsight"
api_bin="${venv_dir}/bin/hindsight-api"
pid_file="${state_home}/dmn/hindsight.pid"
log_file="${state_home}/dmn/hindsight.log"
host_bind="${HINDSIGHT_HOST_BIND:-127.0.0.1}"
host_port="${HINDSIGHT_HOST_PORT:-8888}"

cmd_install() {
	if ! command -v uv >/dev/null 2>&1; then
		echo "uv is not on PATH; install it first (https://docs.astral.sh/uv/getting-started/installation/)" >&2
		exit 2
	fi
	if [ -x "$api_bin" ]; then
		echo "hindsight-api is already installed in ${venv_dir}"
		return 0
	fi
	mkdir -p "$(dirname "$venv_dir")"
	# hindsight-api's pinned transformers/tokenizers ship no wheels for the newest Pythons
	# (a fresh system may default to one); 3.12 always has them, and uv fetches 3.12 if missing.
	uv venv --python 3.12 "$venv_dir"
	uv pip install --python "${venv_dir}/bin/python" hindsight-api
	echo "installed hindsight-api into ${venv_dir}"
}

cmd_start() {
	if [ -z "${HINDSIGHT_API_LLM_PROVIDER:-}" ]; then
		echo "HINDSIGHT_API_LLM_PROVIDER is not set (set it in the environment or in the dmn hindsight.env file)" >&2
		exit 2
	fi
	if [ -f "$pid_file" ]; then
		local pid
		read -r pid <"$pid_file" || true
		if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
			echo "already running (pid ${pid})"
			return 0
		fi
	fi
	if [ ! -x "$api_bin" ]; then
		cmd_install
	fi
	mkdir -p "$(dirname "$pid_file")"
	# Detached (nohup, output appended to the log file) so the server outlives this script.
	nohup "$api_bin" --host "$host_bind" --port "$host_port" >>"$log_file" 2>&1 &
	local server_pid=$!
	printf '%s\n' "$server_pid" >"$pid_file"
	echo "started hindsight (pid ${server_pid})"
}

cmd_stop() {
	if [ ! -f "$pid_file" ]; then
		echo "not running (no pid file)"
		return 0
	fi
	local pid
	read -r pid <"$pid_file" || true
	if [ -z "$pid" ] || ! kill -0 "$pid" 2>/dev/null; then
		rm -f "$pid_file"
		echo "removed stale pid file (pid ${pid:-none} is not running)"
		return 0
	fi
	kill -TERM "$pid" 2>/dev/null || true
	local waited=0
	while kill -0 "$pid" 2>/dev/null && [ "$waited" -lt 75 ]; do
		sleep 1
		waited=$((waited + 1))
	done
	if kill -0 "$pid" 2>/dev/null; then
		kill -KILL "$pid" 2>/dev/null || true
	fi
	rm -f "$pid_file"
	echo "stopped hindsight"
}

cmd_status() {
	local code health_url
	health_url="${HINDSIGHT_HOST_URL:-http://${host_bind}:${host_port}}/health"
	code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$health_url" || true)"
	if [ "$code" = "200" ]; then
		echo "healthy"
		return 0
	fi
	echo "unhealthy (GET ${health_url} -> ${code:-none})"
	return 1
}

cmd_logs() {
	mkdir -p "$(dirname "$log_file")"
	touch "$log_file"
	exec tail -n 100 -f "$log_file"
}

case "${1:-}" in
install) cmd_install ;;
start) cmd_start ;;
stop) cmd_stop ;;
status) cmd_status ;;
logs) cmd_logs ;;
*)
	echo "usage: $0 install|start|stop|status|logs" >&2
	exit 64
	;;
esac
