#!/usr/bin/env bash
set -euo pipefail
source "$(dirname -- "$0")/scripts/docker-common.sh"
bind_ip='' public_url='' port=3000 all_interfaces=false noninteractive=false diagnose=false firewall=false
while (($#)); do
  case "$1" in
    --bind-ip) bind_ip=${2:?IP fehlt}; shift 2 ;;
    --port) port=${2:?Port fehlt}; shift 2 ;;
    --public-url) public_url=${2:?Öffentliche URL fehlt}; shift 2 ;;
    --all-interfaces) all_interfaces=true; shift ;;
    --non-interactive) noninteractive=true; shift ;;
    --diagnose) diagnose=true; shift ;;
    --firewall) firewall=true; shift ;;
    *) echo "Unbekannte Option: $1" >&2; exit 1 ;;
  esac
done
sterra_check
mapfile -t ips < <(ip -o -4 addr show scope global 2>/dev/null | awk '$2 !~ /^(docker|br-|veth|virbr|vbox|tailscale|tun|wg)/ {split($4,a,"/"); print a[1]}')
if $diagnose; then
  printf 'Konfiguriert: %s\nAktuelle LAN-Adressen: %s\n' "$(sterra_env STERRACODE_BIND_IP)" "${ips[*]:-keine}"
  if [[ " ${ips[*]} " != *" $(sterra_env STERRACODE_BIND_IP) "* ]]; then echo 'Adresse prüfen, .env anpassen und ./start-docker.sh ausführen.'; fi
  exit 0
fi
if [[ ! -f .env ]]; then
  if [[ -z $bind_ip ]]; then
    if ((${#ips[@]} == 1)); then bind_ip=${ips[0]};
    elif $noninteractive; then echo 'Mehrere/keine LAN-Adressen. --bind-ip explizit angeben.' >&2; exit 1;
    else
      ((${#ips[@]})) || { echo 'Keine LAN-Adresse gefunden; --bind-ip angeben.' >&2; exit 1; }
      PS3='LAN-Adresse auswählen: '; select bind_ip in "${ips[@]}"; do [[ -n $bind_ip ]] && break; done
    fi
  fi
  [[ $bind_ip =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || { echo 'Für die erste LAN-Stufe eine IPv4-Adresse angeben.' >&2; exit 1; }
  if [[ $bind_ip == 0.0.0.0 ]] && ! $all_interfaces; then
    $noninteractive && { echo 'Alle Interfaces erfordern --all-interfaces.' >&2; exit 1; }
    read -r -p 'Wirklich auf allen Interfaces veröffentlichen? [ja/NEIN] ' answer
    [[ $answer == ja ]] || exit 1
  fi
  [[ $port =~ ^[0-9]+$ && $port -gt 0 && $port -le 65535 ]] || { echo 'Ungültiger Port.' >&2; exit 1; }
  if [[ $bind_ip == 0.0.0.0 && -z $public_url ]]; then echo 'Bei allen Interfaces zusätzlich --public-url mit der konkreten LAN-/Domainadresse angeben.' >&2; exit 1; fi
  public_url=${public_url:-http://$bind_ip:$port}
  # Validate using the same server module, without a host Node installation.
  docker run --rm --network none --mount "type=bind,src=$STERRA_ROOT/server/config.js,dst=/validation/config.mjs,readonly" node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5 node --input-type=module -e 'import {loadConfig} from "/validation/config.mjs";import {isIP} from "node:net";const u=new URL(process.argv[1]);if(/\s/.test(process.argv[1])||isIP(process.argv[2])!==4||["0.0.0.0","[::]","::"].includes(u.hostname))throw new Error("Konkrete öffentliche URL und gültige IPv4-Bind-Adresse erforderlich.");loadConfig({STERRACODE_MODE:"docker",STERRACODE_PUBLIC_URL:process.argv[1]});' "$public_url" "$bind_ip"
  env_temp=$(mktemp .env-install.XXXXXX)
  trap 'rm -f -- "$env_temp"' EXIT
  while IFS= read -r line || [[ -n $line ]]; do
    line=${line%$'\r'}
    case "$line" in
      STERRACODE_BIND_IP=*) printf 'STERRACODE_BIND_IP=%s\n' "$bind_ip" ;;
      STERRACODE_PORT=*) printf 'STERRACODE_PORT=%s\n' "$port" ;;
      STERRACODE_PUBLIC_URL=*) printf 'STERRACODE_PUBLIC_URL=%s\n' "$public_url" ;;
      *) printf '%s\n' "$line" ;;
    esac
  done < .env.example > "$env_temp"
  chmod 600 "$env_temp"
  mv -- "$env_temp" .env
else
  echo 'Vorhandene .env und Zugangsdaten bleiben erhalten.'
fi
sterra_compose_args
sterra_compose config --quiet
free_kb=$(df -Pk . | awk 'NR==2 {print $4}')
if [[ ${free_kb:-0} -lt 8388608 ]]; then echo 'Hinweis: weniger als 8 GiB auf diesem Datenträger frei; Docker-Datenträger separat prüfen.' >&2; fi
sterra_compose build
# Binding in a host-network helper checks the actual address without host Node/Python.
if [[ -z $(sterra_compose ps --status running --quiet app) ]] && [[ $(sterra_env STERRACODE_PROXY_MODE off) == off ]]; then
  docker run --rm --network host --entrypoint node "$(sterra_env COMPOSE_PROJECT_NAME sterracode)-app:1.0.0" -e 'const n=require("node:net");const s=n.createServer();s.on("error",e=>{console.error("Port/Bind-Adresse nicht verfügbar: "+e.code);process.exit(1)});s.listen(Number(process.argv[2]),process.argv[1],()=>s.close())' "$(sterra_env STERRACODE_BIND_IP)" "$(sterra_env STERRACODE_PORT 3000)"
fi
sterra_compose run --rm --no-deps init
echo 'Einrichtungsschlüssel (30 Minuten gültig; vertraulich aufbewahren):'
sterra_compose run --rm --no-deps app node docker/admin.mjs setup-key
sterra_compose up -d --remove-orphans --wait --wait-timeout 180
printf '\nBrowser: %s\n' "$(sterra_env STERRACODE_PUBLIC_URL)"
firewall_bind=$(sterra_env STERRACODE_BIND_IP)
if [[ $firewall_bind == 0.0.0.0 ]]; then firewall_bind=any; fi
printf 'Beispiel Firewall (LAN-Netz passend ersetzen): sudo ufw allow from 192.168.178.0/24 to %s port %s proto tcp\n' "$firewall_bind" "$(sterra_env STERRACODE_PORT)"
if $firewall; then
  read -r -p 'IPv4-LAN-Netz in CIDR-Schreibweise für UFW: ' lan_cidr
  [[ $lan_cidr =~ ^[0-9.]+/[0-9]{1,2}$ ]] || { echo 'Ungültiges Netz.' >&2; exit 1; }
  read -r -p "UFW-Regel für $lan_cidr erstellen? [ja/NEIN] " answer
  if [[ $answer == ja ]]; then sudo ufw allow from "$lan_cidr" to "$firewall_bind" port "$(sterra_env STERRACODE_PORT)" proto tcp; fi
fi
echo 'DHCP-Reservierung und Zugriff von einem zweiten LAN-Gerät prüfen. Hinweise: DOCKER-BETRIEB.md'
