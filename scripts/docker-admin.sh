#!/usr/bin/env bash
set -euo pipefail
source "$(dirname -- "$0")/docker-common.sh"
sterra_check
sterra_compose_args
operation=${1:?Befehl: backup | restore | import | reset-password | usage}
shift
case "$operation" in
  backup)
    target=${1:?Leeres Backupziel fehlt}; shift
    no_restart=false
    backup_args=()
    for option in "$@"; do if [[ $option == --no-restart ]]; then no_restart=true; else backup_args+=("$option"); fi; done
    mkdir -p -- "$target"; target=$(cd -- "$target" && pwd)
    sterra_compose stop
    images=$(sterra_compose images --format json)
    sterra_compose run --rm --no-deps -e "STERRACODE_BACKUP_IMAGES=$images" -e "STERRACODE_BACKUP_UID=$(id -u)" -e "STERRACODE_BACKUP_GID=$(id -g)" -v "$target:/backup" admin backup "${backup_args[@]}"
    if [[ " $* " == *' --offline '* ]]; then
      docker image save "$(sterra_env COMPOSE_PROJECT_NAME sterracode)-app:${STERRACODE_VERSION}" "$(sterra_env COMPOSE_PROJECT_NAME sterracode)-runner:${STERRACODE_VERSION}" -o "$target/images.tar"
      chmod 600 "$target/images.tar"
    fi
    if ! $no_restart; then sterra_compose up -d --remove-orphans; fi
    ;;
  restore)
    source_dir=${1:?Backupquelle fehlt}; source_dir=$(cd -- "$source_dir" && pwd)
    sterra_stopped
    sterra_compose run --rm --no-deps -v "$source_dir:/backup:ro" admin restore
    ;;
  import)
    source_dir=${1:?Altes Datenverzeichnis fehlt}; source_dir=$(cd -- "$source_dir" && pwd)
    sterra_stopped
    sterra_compose run --rm --no-deps -v "$source_dir:/import:ro" admin import
    ;;
  reset-password)
    sterra_stopped
    sterra_compose run --rm --no-deps --user 10001:10001 app node docker/admin.mjs reset-password
    echo 'Neuen Schlüssel zur Einrichtung verwenden; anschließend ./start-docker.sh.'
    ;;
  usage) sterra_compose run --rm --no-deps admin usage ;;
  *) echo 'Befehl: backup | restore | import | reset-password | usage' >&2; exit 1 ;;
esac
