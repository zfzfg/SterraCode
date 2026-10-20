#!/usr/bin/env bash
# Compatible with the Bash 3.2 shipped with macOS. No host Node.js or Git needed.
set -euo pipefail
install_dir="$HOME/.sterracode" bind_ip='' port=3000 project=sterracode noninteractive=false
while [ "$#" -gt 0 ]; do
  case "$1" in
    --directory) install_dir=${2:?Directory required}; shift 2 ;;
    --bind-ip) bind_ip=${2:?IPv4 address required}; shift 2 ;;
    --port) port=${2:?Port required}; shift 2 ;;
    --project) project=${2:?Project name required}; shift 2 ;;
    --non-interactive) noninteractive=true; shift ;;
    *) printf 'Unknown option: %s\n' "$1" >&2; exit 1 ;;
  esac
done
fail() { printf 'SterraCode: %s\n' "$1" >&2; exit 1; }
os=$(uname -s)
case "$os" in Linux|Darwin) ;; *) fail 'Use install.ps1 on Windows. This platform is not supported.' ;; esac
if ! command -v docker >/dev/null 2>&1; then
  echo 'Docker is not installed. Install it, start it, then run this installer again.'
  if [ "$os" = Darwin ]; then
    if command -v brew >/dev/null 2>&1; then echo '  brew install --cask docker'; fi
    echo '  https://docs.docker.com/desktop/setup/install/mac-install/'
  else
    distro=$(sed -n 's/^ID=//p' /etc/os-release 2>/dev/null | tr -d '"' || true)
    case "$distro" in
      ubuntu|debian)
        printf 'Run the following commands for %s:\n' "$distro"
        printf '  sudo apt-get update\n  sudo apt-get install -y ca-certificates curl\n  sudo install -m 0755 -d /etc/apt/keyrings\n'
        printf '  sudo curl -fsSL https://download.docker.com/linux/%s/gpg -o /etc/apt/keyrings/docker.asc\n' "$distro"
        echo '  sudo chmod a+r /etc/apt/keyrings/docker.asc'
        printf '  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/%s $(. /etc/os-release && echo "$VERSION_CODENAME") stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null\n' "$distro"
        printf '  sudo apt-get update\n  sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin\n'
        ;;
      fedora)
        printf '  sudo dnf -y install dnf-plugins-core\n  sudo dnf config-manager addrepo --from-repofile=https://download.docker.com/linux/fedora/docker-ce.repo\n  sudo dnf install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin\n  sudo systemctl enable --now docker\n'
        ;;
      *) echo 'Docker installation instructions for your distribution:' ;;
    esac
    echo '  https://docs.docker.com/engine/install/'
    echo 'After installation, ensure your user can run docker info. Do not run downloaded scripts as root.'
  fi
  exit 1
fi
docker compose version >/dev/null 2>&1 || fail 'Docker Compose v2 is missing. Install the Docker Compose plugin.'
docker_error=$(mktemp)
if ! docker_info=$(docker info --format '{{.OSType}} {{.Architecture}}' 2>"$docker_error"); then
  if LC_ALL=C grep -qi 'permission denied' "$docker_error"; then
    rm -f -- "$docker_error"; fail 'Docker access denied. Configure Docker access for your user, log in again, and retry.'
  fi
  rm -f -- "$docker_error"; fail 'Docker daemon is unavailable. Start Docker Desktop or the Docker service and retry.'
fi
rm -f -- "$docker_error"
case "$docker_info" in linux\ x86_64|linux\ amd64|linux\ aarch64|linux\ arm64) ;; *) fail 'A Linux Docker daemon on AMD64 or ARM64 is required. Windows containers and 32-bit systems are unsupported.' ;; esac
command -v curl >/dev/null 2>&1 || fail 'curl is required. Install curl with your system package manager.'
case "${DOCKER_HOST:-}" in tcp:*|ssh:*) fail 'Run this installer on the Docker host; remote Docker daemons are unsupported.' ;; esac
docker_endpoint=$(docker context inspect --format '{{.Endpoints.docker.Host}}' 2>/dev/null || true)
case "$docker_endpoint" in tcp:*|ssh:*) fail 'Run this installer on the Docker host; remote Docker contexts are unsupported.' ;; esac
if ! [[ $port =~ ^[0-9]+$ ]] || [ "$port" -lt 1 ] || [ "$port" -gt 65535 ]; then fail 'Port must be between 1 and 65535.'; fi
[[ $project =~ ^[a-z][a-z0-9-]{0,39}$ ]] || fail 'Project name must contain lowercase letters, digits and hyphens.'
[ ! -L "$install_dir" ] || fail 'Installation directory must not be a symbolic link.'
if [ -d "$install_dir" ] && [ ! -f "$install_dir/installation.json" ]; then
  remaining=$(ls -A "$install_dir" | LC_ALL=C grep -v '^[.]download$' || true)
  [ -z "$remaining" ] || fail 'Installation directory is not empty. Choose another directory or follow the explicit migration instructions.'
fi
[ ! -L "$install_dir/.download" ] || fail 'Download directory must not be a symbolic link.'
if [ -z "$bind_ip" ] && [ ! -f "$install_dir/installation.json" ]; then
  addresses=()
  address_count=0
  if [ "$os" = Darwin ]; then
    while IFS= read -r ip; do addresses[$address_count]=$ip; address_count=$((address_count + 1)); done < <(ifconfig | awk '/inet / && $2 !~ /^(127\.|169\.254\.)/ {print $2}' | sort -u)
  else
    while IFS= read -r ip; do addresses[$address_count]=$ip; address_count=$((address_count + 1)); done < <(ip -o -4 addr show scope global 2>/dev/null | awk '$2 !~ /^(docker|br-|veth|virbr|vbox|tailscale|tun|wg)/ {split($4,a,"/");print a[1]}' | sort -u)
  fi
  if [ "$address_count" -eq 1 ]; then bind_ip=${addresses[0]};
  elif $noninteractive || [ ! -r /dev/tty ]; then fail 'Use --bind-ip to select a LAN address when no terminal or multiple addresses are available.';
  else
    printf 'Select a LAN address (or enter 127.0.0.1 for local access):\n' > /dev/tty
    printf '  %s\n' "${addresses[@]:-}" > /dev/tty
    printf 'IPv4 address: ' > /dev/tty
    read -r bind_ip < /dev/tty
  fi
fi
bind_ip=${bind_ip:-127.0.0.1}
[[ $bind_ip =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail 'A concrete IPv4 address is required.'
[ "$bind_ip" != 0.0.0.0 ] || fail 'Select a concrete address instead of all interfaces.'
umask 077
mkdir -p -- "$install_dir"
install_dir=$(cd -- "$install_dir" && pwd -P)
mkdir -p -- "$install_dir/.download"
download="$install_dir/.download"
echo 'Downloading the latest published stable SterraCode release...'
curl --proto '=https' --tlsv1.2 -fsSL 'https://github.com/zfzfg/SterraCode/releases/latest/download/release.json' -o "$download/release.json"
# The publisher emits pretty-printed JSON. Full validation runs inside the pinned updater.
version=$(sed -n 's/^[[:space:]]*"version": "\([0-9][0-9.]*\)",*/\1/p' "$download/release.json")
image=$(sed -n 's/^[[:space:]]*"updater": "\(ghcr.io\/zfzfg\/sterracode-updater@sha256:[a-f0-9]*\)".*/\1/p' "$download/release.json")
checksum=$(sed -n 's/^[[:space:]]*"packageSHA256": "\([a-f0-9]*\)".*/\1/p' "$download/release.json")
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+$ && $image =~ ^ghcr\.io/zfzfg/sterracode-updater@sha256:[a-f0-9]{64}$ && $checksum =~ ^[a-f0-9]{64}$ ]] || fail 'Invalid release metadata. Nothing was executed.'
curl --proto '=https' --tlsv1.2 -fsSL "https://github.com/zfzfg/SterraCode/releases/download/v$version/installer.zip" -o "$download/installer.zip"
if command -v sha256sum >/dev/null 2>&1; then actual=$(sha256sum "$download/installer.zip" | awk '{print $1}'); else actual=$(shasum -a 256 "$download/installer.zip" | awk '{print $1}'); fi
[ "$actual" = "$checksum" ] || fail 'Installation package checksum mismatch.'
zone=${TZ:-}
if [ -z "$zone" ]; then zone=$(cat /etc/timezone 2>/dev/null || true); fi
if [ -z "$zone" ]; then zone=$(readlink /etc/localtime 2>/dev/null | sed 's|.*/zoneinfo/||' || true); fi
case "$zone" in *[!A-Za-z0-9_+./-]*|'') zone=UTC ;; esac
options=$(printf '{"bindIP":"%s","port":%s,"project":"%s","timeZone":"%s"}' "$bind_ip" "$port" "$project" "$zone")
echo 'Pulling verified release images. This can take several minutes.'
docker pull "$image"
docker run --rm --init --mount "type=bind,source=$install_dir,target=/installation" -v /var/run/docker.sock:/var/run/docker.sock -e "STERRA_INSTALL_OPTIONS=$options" "$image" setup
