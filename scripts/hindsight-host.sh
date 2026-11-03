#!/usr/bin/env bash
# Start, stop and inspect a local Hindsight container.
# Usage: hindsight-host.sh start|stop|status|logs
# Configuration comes from HINDSIGHT_* variables in the environment, plus an optional
# env file at ${XDG_CONFIG_HOME:-$HOME/.config}/dmn/hindsight.env. See docs/hindsight.md.
set -euo pipefail

container_name="hindsight"
volume_name="hindsight-data"
image="${HINDSIGHT_IMAGE:-ghcr.io/vectorize-io/hindsight:latest}"
health_url="${HINDSIGHT_HOST_URL:-http://127.0.0.1:8888}/health"

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

collect_env_flags() {
	env_flags=()
	local name
	while IFS= read -r name; do
		env_flags+=(-e "$name")
	done < <(compgen -e | grep '^HINDSIGHT_API_' || true)
}

cmd_start() {
	load_env_file
	if [ -z "${HINDSIGHT_API_LLM_PROVIDER:-}" ]; then
		echo "HINDSIGHT_API_LLM_PROVIDER is not set (set it in the environment or in the dmn hindsight.env file)" >&2
		exit 2
	fi
	if docker ps -a --filter "name=^${container_name}\$" --format '{{.Names}}' | grep -qx "$container_name"; then
		docker start "$container_name" >/dev/null
		echo "started existing container ${container_name}"
		return
	fi
	collect_env_flags
	# Optional: reuse an existing `claude` login by mounting its config directory
	# (read-write, the CLI refreshes tokens there). Alternative: a `claude setup-token`
	# token in HINDSIGHT_API_LLM_API_KEY.
	mount_flags=()
	if [ -n "${HINDSIGHT_CLAUDE_DIR:-}" ]; then
		mount_flags=(-v "${HINDSIGHT_CLAUDE_DIR}:/home/hindsight/.claude")
	fi
	docker run -d --name "$container_name" --restart unless-stopped \
		--shm-size=1g --stop-timeout 75 \
		-p 127.0.0.1:8888:8888 -p 127.0.0.1:9999:9999 \
		-v "${volume_name}:/home/hindsight/.pg0" \
		${mount_flags[@]+"${mount_flags[@]}"} \
		${env_flags[@]+"${env_flags[@]}"} \
		"$image" >/dev/null
	echo "created container ${container_name}"
}

cmd_stop() {
	docker stop "$container_name" >/dev/null
	echo "stopped ${container_name} (volume ${volume_name} kept)"
}

cmd_status() {
	local code
	code="$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "$health_url" || true)"
	if [ "$code" = "200" ]; then
		echo "healthy"
		return 0
	fi
	echo "unhealthy (GET ${health_url} -> ${code:-none})"
	return 1
}

cmd_logs() {
	exec docker logs -f --tail 100 "$container_name"
}

case "${1:-}" in
start) cmd_start ;;
stop) cmd_stop ;;
status) cmd_status ;;
logs) cmd_logs ;;
*)
	echo "usage: $0 start|stop|status|logs" >&2
	exit 64
	;;
esac
