#!/usr/bin/env bash
set -euo pipefail
source "$(dirname -- "$0")/scripts/docker-common.sh"
sterra_check
sterra_compose_args
sterra_compose stop
echo 'Stack gestoppt. Alle Volumes bleiben erhalten.'
