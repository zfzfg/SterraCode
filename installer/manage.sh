#!/usr/bin/env bash
set -euo pipefail
cd -- "$(dirname -- "$0")"
action=${1:-status}
case "$action" in status|check|install|recover|migrate|migrate-recover) ;; *) echo 'Usage: bash manage.sh [status|check|install|recover|migrate BACKUP_DIRECTORY|migrate-recover]' >&2; exit 1 ;; esac
project=$(sed -n 's/^[[:space:]]*"project": "\([a-z0-9-]*\)",*/\1/p' installation.json)
[[ -n $project ]] || { echo 'Installation identity not found.' >&2; exit 1; }
if [[ $action == migrate || $action == migrate-recover || $action == recover ]]; then
  image=$(sed -n 's/^[[:space:]]*"updaterImage": "\(ghcr.io\/zfzfg\/sterracode-updater@sha256:[a-f0-9]*\)".*/\1/p' installation.json)
  [[ $image =~ ^ghcr\.io/zfzfg/sterracode-updater@sha256:[a-f0-9]{64}$ ]] || { echo 'Invalid updater image.' >&2; exit 1; }
  options=()
  if [[ $action == recover ]]; then
    runner_key=$(sed -n 's/^[[:space:]]*"runner-key": "\([a-z0-9_-]*\)".*/\1/p' installation.json)
    [[ -n $runner_key ]] || { echo 'Runner key volume is missing.' >&2; exit 1; }
    options=(--network "${project}_backend" -v "${project}_updater-key:/run/updater:ro" -v "$runner_key:/run/runner:ro")
  fi
  if [[ $action == migrate ]]; then
    backup=${2:?An absolute offline backup directory is required.}
    [[ $backup == /* && -d $backup ]] || { echo 'An absolute offline backup directory is required.' >&2; exit 1; }
    options=(--mount "type=bind,source=$backup,target=/backup,readonly")
  fi
  docker run --rm --init --mount "type=bind,source=$PWD,target=/installation" -v /var/run/docker.sock:/var/run/docker.sock ${options[@]+"${options[@]}"} "$image" "$action"
  exit $?
fi
docker exec "${project}-updater" node /app/installer/runtime/cli.mjs "$action"
