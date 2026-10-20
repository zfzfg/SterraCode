#!/usr/bin/env bash
set -euo pipefail
STERRA_ROOT=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
cd "$STERRA_ROOT"
STERRACODE_BUILD_VERSION=$(sed -n 's/^[[:space:]]*"version": "\([^"]*\)".*/\1/p' "$STERRA_ROOT/package.json")
STERRACODE_VERSION=${STERRACODE_VERSION:-local}
export STERRACODE_VERSION STERRACODE_BUILD_VERSION
sterra_env() {
  local key=$1 fallback=${2-} line
  if [[ -f .env ]]; then
    while IFS= read -r line || [[ -n $line ]]; do
      line=${line%$'\r'}
      if [[ $line == "$key="* ]]; then printf '%s' "${line#*=}"; return; fi
    done < .env
  fi
  printf '%s' "$fallback"
}
sterra_check() {
  command -v docker >/dev/null || { echo 'Docker fehlt. Docker Engine und Compose installieren.' >&2; exit 1; }
  docker compose version >/dev/null || { echo 'Docker Compose Plugin fehlt.' >&2; exit 1; }
  local os
  os=$(docker info --format '{{.OSType}}' 2>/dev/null) || { echo 'Docker-Daemon nicht erreichbar. Docker starten und bestehende Zugriffsrechte prüfen.' >&2; exit 1; }
  [[ $os == linux ]] || { echo 'Linux-Container erforderlich. Docker Desktop auf Linux-Container umstellen.' >&2; exit 1; }
}
sterra_compose_args() {
  STERRA_COMPOSE=(-f compose.yaml)
  case $(sterra_env STERRACODE_PROXY_MODE off) in
    off) STERRA_COMPOSE+=(-f compose.lan.yaml) ;;
    caddy) STERRA_COMPOSE+=(-f compose.caddy.yaml) ;;
    host) STERRA_COMPOSE+=(-f compose.host-proxy.yaml) ;;
    docker) STERRA_COMPOSE+=(-f compose.docker-proxy.yaml) ;;
    *) echo 'Ungültiger STERRACODE_PROXY_MODE.' >&2; exit 1 ;;
  esac
  if [[ -n $(sterra_env STERRACODE_LM_STUDIO_TOKEN_PATH) ]]; then STERRA_COMPOSE+=(-f compose.lm-secret.yaml); fi
  if [[ -n $(sterra_env STERRACODE_ADMIN_PASSWORD_PATH) ]]; then STERRA_COMPOSE+=(-f compose.admin-secret.yaml); fi
  if [[ -n $(sterra_env STERRACODE_OPENAI_API_KEY_PATH) ]]; then STERRA_COMPOSE+=(-f compose.openai-secret.yaml); fi
}
sterra_compose() {
  local image_id project service target container_id
  project=$(sterra_env COMPOSE_PROJECT_NAME sterracode)
  # Preserve administration of legacy stacks when switching their source tag to local.
  if [[ $STERRACODE_VERSION == local ]]; then
    for service in app runner; do
      target="$project-$service:local"
      if ! docker image inspect "$target" >/dev/null 2>&1; then
        container_id=$(docker ps -aq --filter "label=com.docker.compose.project=$project" --filter "label=com.docker.compose.service=$service")
        if [[ -n $container_id && $container_id != *$'\n'* ]]; then
          image_id=$(docker inspect --format '{{.Image}}' "$container_id")
          docker tag "$image_id" "$target"
        fi
      fi
    done
  fi
  image_id=$(docker image inspect "$(sterra_env COMPOSE_PROJECT_NAME sterracode)-runner:${STERRACODE_VERSION}" --format '{{.Id}}' 2>/dev/null || true)
  if [[ -n $image_id ]]; then export STERRACODE_RUNNER_IMAGE_DIGEST=$image_id; fi
  docker compose "${STERRA_COMPOSE[@]}" "$@"
}
sterra_stopped() {
  if [[ -n $(sterra_compose ps --status running --quiet app runner) ]]; then
    echo 'App und Runner müssen für diesen Vorgang gestoppt sein: ./stop-docker.sh' >&2; exit 1
  fi
}
