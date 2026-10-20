# SterraCode Docker operations

Release 1.1.0. Supported target: Linux/amd64 with Docker Engine and Compose. Windows uses Docker Desktop with Linux containers, preferably WSL 2; Windows Server requires a Linux VM. English is the fresh-install/browser default; saved browser choices remain unchanged. The [German historical guide](DOCKER-BETRIEB.de.md) and [acceptance records](docker/ABNAHME.md) remain available.

The deployment has one administrator and a shared runner. Programs share an execution UID and can read other sessions' workspaces. Additional isolation is required for mutually isolated users or untrusted tenants.

## Installation and restart

```sh
bash install.sh
# unattended installation on a known LAN address:
bash install.sh --bind-ip 192.168.178.50 --port 3000 --non-interactive
bash start-docker.sh
bash stop-docker.sh
```

```powershell
.\install.ps1 -BindIP 192.168.178.50 -Port 3000 -NonInteractive
.\start-docker.ps1
.\stop-docker.ps1
```

No host compilers or language runtimes are required. The installer checks the Linux daemon, Compose configuration, and port availability. It preserves `.env`, volumes, and passwords. Initial setup displays a key only in the terminal; the app stores its hash and it expires after 30 minutes. Re-running setup before password creation replaces that key. Set an administrator password of at least 12 characters in the browser.

The installer warns below approximately 8 GiB free space. Images, optional SDKs, and caches need additional space. RAM limits do not limit disk consumption. `bash scripts/docker-admin.sh usage` reports volume sizes and free space. Programs can clear package downloads without deleting sources/backups. The executable `runs` volume contains compiler output, is cleared at runner startup, and is not backed up.

Reserve stable LAN addresses in DHCP. `bash install.sh --diagnose` or `.\install.ps1 -Diagnose` compares interfaces/configuration. When changing ports, update `STERRACODE_PORT` and `STERRACODE_PUBLIC_URL` together. Re-run startup after `.env` changes: `docker compose restart` does not replace container parameters.

## Network, firewall, and proxies

Direct LAN mode publishes only the selected IPv4 address. Binding `0.0.0.0` requires explicit confirmation or `--all-interfaces` / `-AllInterfaces`; also specify a concrete browser URL using `--public-url` / `-PublicUrl`. No router forwarding is created. IPv6 requires its own publish rules and acceptance test.

For Linux UFW, adapt addresses to your network:

```sh
sudo ufw allow from 192.168.178.0/24 to 192.168.178.50 port 3000 proto tcp
```

Docker manages packet-filter rules; UFW alone may not filter published container ports as expected. Restrict the bind address and verify Docker/upstream filtering as needed. The optional installer firewall switch asks before changing rules. A local healthcheck does not prove access from a second LAN device.

`.env.example` contains non-secret configuration only. Never store passwords, setup keys, or tokens in `.env`. Base Compose publishes no ports. Startup selects one overlay:

| Proxy mode | Compose overlay             | Published endpoint               |
| ---------- | --------------------------- | -------------------------------- |
| `off`      | `compose.lan.yaml`          | Selected IPv4/host port          |
| `caddy`    | `compose.caddy.yaml`        | Caddy only, ports 80/443         |
| `host`     | `compose.host-proxy.yaml`   | App on 127.0.0.1                 |
| `docker`   | `compose.docker-proxy.yaml` | App on an existing proxy network |

```sh
docker compose -f compose.yaml -f compose.lan.yaml config --quiet
docker compose -f compose.yaml -f compose.lan.yaml up -d --remove-orphans
```

The app listens internally on `0.0.0.0:3000`. `STERRACODE_PUBLIC_URL` must be a root HTTP(S) URL without user information or subpath. Additional hosts/origins are explicit. Configure trusted proxy IPs/CIDRs with `STERRACODE_TRUSTED_PROXIES`; never trust arbitrary client networks. Switching proxy modes removes obsolete services with `--remove-orphans`.

Caddy requires `STERRACODE_DOMAIN`, an HTTPS public URL, and proxy mode `caddy`. `STERRACODE_TLS_MODE=internal` uses a local CA whose root certificate must be trusted on each client. For public ACME, leave TLS mode empty and configure DNS/reachability. Certificates persist in Caddy volumes. An existing proxy must allow 4 MiB JSON, DELETE request bodies, requests lasting at least 20 minutes, and unbuffered SSE. App/browser use no WebSockets; the app's native LM Studio connection does.

LAN HTTP uses an HttpOnly/SameSite-Lax cookie without Secure. A configured HTTPS URL enables Secure; direct HTTP access to that installation cannot retain authentication.

## AI providers and credentials

From the app container, use `http://host.docker.internal:1234` for LM Studio on the Docker host, a concrete LAN address for another machine, or an external HTTPS URL. Compose adds the Linux host gateway. LM Studio must listen on a reachable interface. `localhost` refers to the app container. Imported addresses are preserved and unsuitable local addresses are reported. The native SDK probe checks access, model/tokenization, and context; `/v1/models` alone is insufficient.

`STERRACODE_LM_STUDIO_URL` seeds new settings; saved settings take precedence afterward. `STERRACODE_LM_STUDIO_OVERRIDE_URL` is an explicit administrative override. `STERRACODE_LM_STUDIO_TOKEN_PATH` points to a protected host file and enables the app-only secret overlay. Token/address changes refresh the SDK client.

For OpenAI, save a key in Settings/credentials and select a model from the API list. Keys stay in private `provider-secrets.json` with mode 0600. General APIs do not return them, and they do not enter browser storage, runner environment, or Compose environment. Backups contain stored keys and must be protected.

Alternatively set `STERRACODE_OPENAI_API_KEY_PATH` to a protected host file. Startup adds the app-only overlay; the app reads `STERRACODE_OPENAI_API_KEY_FILE`. This override takes precedence and is read-only in the UI. Back up external secret files separately. On Linux, UID 10001 must be able to read each mount; mode 0600 owned by another UID usually prevents access. Windows uses host ACLs.

OpenAI requests target only `https://api.openai.com/v1`. Responses use tools, streaming, and `store: false`. Chat and compaction can incur costs. Connection testing lists models and counts input tokens without generating a model answer. Native compaction uses `context_management: [{ type: "compaction" }]` and `/responses/compact`; the model must support these. Local context/answer budgets apply only to LM Studio. Both providers retain complete tool results with paged retrieval. Interrupted streams are not automatically retried.

For unattended initial setup, `STERRACODE_ADMIN_PASSWORD_PATH` mounts a protected password file as `STERRACODE_ADMIN_PASSWORD_FILE`. It is used only when no administrator account exists and never replaces an existing password on restart. Password changes revoke older sessions. Setup/session keys are stored as hashes.

## Runtimes and limits

Programs manages Python, Java JDK 25, Go, Rust/Cargo, C/C++, .NET SDK, and Lua. Node/Bash are base components and can be disabled. Disable retains packages; remove updates the desired manifest and removes optional packages while preserving shared/base dependencies. `STERRACODE_INITIAL_PROGRAMS` is read only at initial manifest creation.

Catalog `2026.10.19.1` pins Microsoft `msopenjdk-25` version `25.0.3-1`. An existing Java 17 installation can be explicitly upgraded. Ordinary restart restores the exact saved version.

Progress has six phases, not an estimated time remaining: database/storage, signed package lists, downloads, installation, recovery cache, and version verification. Details show native logs. Maintenance blocks new starts; existing jobs finish or are explicitly stopped. Exact cached packages are restored after container replacement. Missing/corrupt downloads produce a repairable failure rather than success.

App limits: 1 GiB RAM / 128 processes. Runner: 2 GiB / 256 processes. `memswap_limit` equals `mem_limit`, preventing additional host swap. Admission allows four jobs overall, one per session, and two compilations. App UID/GID is 10001; programs run as UID 10002/GID 10001 without extra groups. Workspaces use setgid and umask 002. Runner control files/keys are protected; app data is not mounted there. Neither the Docker socket nor host system directories are exposed.

## Import existing data

Stop the old local server and separately copy its complete `server/data`. Finish interrupted migration journals in the old app first. Import rejects incomplete journals, symlinks/junctions, hardlinks, and special files. It mounts the source read-only, preserves an original copy, requires empty target volumes, and loads sessions to finish migrations. Use a separate Compose project for initial import.

```sh
cp .env.example .env
# Configure a new COMPOSE_PROJECT_NAME and correct LAN URL.
docker compose -f compose.yaml -f compose.lan.yaml build
bash scripts/docker-admin.sh import /absolute/path/to/old/server/data
bash install.sh
```

PowerShell uses `.\scripts\docker-admin.ps1 import -Path 'C:\Backup\server\data'`. Sessions, workspaces, histories, profiles, backups, and completed markers are preserved; `runs` is omitted. Browser-local drafts are not migrated. Check an old session, source, history, and undo afterward.

## Backup, restore, and password recovery

```sh
bash scripts/docker-admin.sh backup /absolute/path/to/empty/backup
# Optional image export for offline recovery:
bash scripts/docker-admin.sh backup /absolute/path/to/empty/backup --offline
```

PowerShell: `.\scripts\docker-admin.ps1 backup -Path 'D:\SterraBackup\release' -Offline`.

The helper stops app/runner for consistency, archives data/workspaces/manifests/secrets with checksums, then restarts the same stack. Protect the destination: it contains private source and credentials. External secrets need separate protection. Offline backup includes images. Compiler `runs` are excluded; package cache is required for offline runtime recovery.

First rehearse restore with a different project name/port. Targets must be empty and stopped. Build/tag matching images or load `images.tar`, configure `.env`, then run:

```sh
bash scripts/docker-admin.sh restore /absolute/path/to/backup
bash start-docker.sh
```

PowerShell uses `restore -Path`. Restore verifies checksums, paths, sizes, and types before extraction. Absolute/traversal paths, links, special files, duplicate paths, and more than 100 GiB expanded data per archive are rejected. Deliberately larger archives require `STERRACODE_ARCHIVE_MAX_BYTES` in the helper. An archive alone is not a restore acceptance: open an old session and execute restored source with its runtime.

Forgotten password, with the stack stopped:

```sh
bash stop-docker.sh
bash scripts/docker-admin.sh reset-password
bash start-docker.sh
```

This revokes old sessions and displays a new setup key. It is not an API backdoor or an exec into a stopped service.

## Updates, rollback, and verification

Back up **before** replacing sources/images. Preserve previous app/runner image IDs and release source. Pull or extract the intended release, build both images together, then start the existing project:

```sh
docker compose -f compose.yaml -f compose.lan.yaml build
bash start-docker.sh
```

Source builds use the stable `:local` image tag by default. Helper scripts derive the OCI version label from `package.json`; direct Compose builds can set `STERRACODE_BUILD_VERSION` explicitly. `STERRACODE_VERSION` overrides the local tag. Published managed releases use immutable registry digests instead. Do not change the Compose project name during updates: it identifies existing volumes. Never delete volumes or prune Docker to update. Rollback requires previous images and, for migrated data, the matching backup. Node 24/Bookworm is digest-pinned. Base-image/catalog changes require explicit checksum/version verification and architecture-specific runtime smokes.

Language is browser-local and available before authentication. English is the fresh default; saved German/Spanish choices remain. Old files/history do not change. The app needs packaged `shared/` and production i18next; the runner has no i18next dependency. Older validators may discard locale/provenance fields, so lossless downgrade is not assumed.

`npm test` needs no Docker. `npm run test:docker` uses disposable projects for authentication, execution, recreation, backup/restore, and cleanup. Missing Linux Docker skips explicitly; `CI=1` or `STERRACODE_DOCKER_REQUIRED=1` makes it a failure. `STERRACODE_DOCKER_FULL=1` installs/runs/disables/enables/removes every optional runtime. Tests must not use live project names or volumes.

Record platform results and deployment/image/backup identities in [docker/ABNAHME.md](docker/ABNAHME.md). Second-device LAN access, IPv6, public TLS, and real AI providers require their own available environment.

# Managed release installations

For the new one-command installer, native ARM64 release checks, optional automatic
updates and explicit offline-backup migration, see [installer/README.md](installer/README.md).
The source-based procedures below remain available. Only the optional managed
updater receives Docker daemon access; the application and runner do not.
