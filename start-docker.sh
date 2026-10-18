#!/usr/bin/env bash
set -euo pipefail
source "$(dirname -- "$0")/scripts/docker-common.sh"
sterra_check
[[ -f .env ]] || { echo 'Zuerst ./install.sh ausführen.' >&2; exit 1; }
sterra_compose_args
sterra_compose config --quiet
sterra_compose up -d --remove-orphans --wait --wait-timeout 180 "$@"
printf 'SterraCode: %s\n' "$(sterra_env STERRACODE_PUBLIC_URL)"
