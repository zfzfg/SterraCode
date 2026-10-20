# SterraCode installation, releases and recovery

All installer and management terminal messages are English. The application uses
its existing English/German/Spanish language settings.

## Public installation

Windows PowerShell 5.1 or 7:

```powershell
irm https://sterra.online/code-install/install.ps1 | iex
```

Linux or macOS (including macOS Bash 3.2):

```bash
curl -fsSL https://sterra.online/code-install/install.sh | bash
```

These commands require a **published GitHub stable release with installer assets**
and public GHCR packages. Uploading the website alone does not publish a release.
Docker must already be installed and running with Linux containers; otherwise the
installer prints instructions and exits. Host Git and Node.js are not required.
Allow at least 8 GiB free on the installation and Docker disks, plus space for
projects, optional SDKs, backups and recovery copies.

Default: `$HOME/.sterracode`, Compose project `sterracode`, port 3000. One suitable
LAN address is selected automatically; multiple addresses require a terminal choice
or an explicit parameter. No router or firewall rules are modified. For a custom
directory/port, download the script and invoke it with parameters:

```bash
bash install.sh --directory "$HOME/SterraCode" --bind-ip 192.168.178.50 --port 3000 --project sterracode --non-interactive
```

```powershell
.\install.ps1 -Directory "$HOME\SterraCode" -BindIP 192.168.178.50 -Port 3000 -Project sterracode -NonInteractive
```

Only architectures listed in the release metadata are installable. Native
Linux AMD64/ARM64 images serve Linux hosts and Docker Desktop on supported
Windows/macOS hosts, including Apple Silicon. Windows Server requires a Linux VM.
No 32-bit or transparent AMD64 emulation fallback is offered. A remote Docker
daemon is not a supported installation target: run the installer on that host.

Repeated installation preserves the managed installation's project, data, keys and
network settings and refreshes the independently versioned updater. It does not
silently upgrade the application. Use the application update button or management
command for that. Active recovery/import transactions must be resolved first.
The initial setup key is shown only in the installing terminal and expires after
30 minutes. It is not saved to updater logs.

## Architecture and management

The updater runs independently of app/runner and publishes no host port. Its
internal API requires a dedicated secret. **It has Docker daemon access**, which
is effectively administrative access to that Docker host. App and runner never
receive the Docker socket. Install only images released by the trusted publisher.

Persistent data uses labeled Docker named volumes. Private control files live in
the installation directory. Preserve that directory and its Docker volumes.
`installation.json` records immutable digests, volume assignments and identity;
`updates.json` records operations and automatic settings. Do not hand-edit these
files while the updater is running. This managed deployment initially uses direct
LAN publishing; an existing proxy/source deployment requires the explicit import
below. It never overwrites an existing Compose project with the same name.

```bash
cd "$HOME/.sterracode"
bash manage.sh status
bash manage.sh check
bash manage.sh install
```

```powershell
Set-Location "$HOME\.sterracode"
.\manage.ps1 status
.\manage.ps1 check
.\manage.ps1 install
```

Application update endpoints are authenticated and retain existing origin/JSON
checks. `/internal/updates` additionally requires the updater secret and accepts
only status/drain/resume. It is independent of browser authentication so the
updater can wait for active mutations and model turns before stopping services.

Automatic updates start **disabled**. Enable them under Settings → Updates. The
default window is 04:00â€“05:00 in the host's detected IANA time zone (Windows zone
IDs are converted using CLDR). The zone and start hour are editable. Compatible
stable major releases are included. Active browser work, unsaved editor models,
running programs, model turns and package actions postpone updates. New mutation
requests are blocked during draining. No running job is forcibly cancelled; after
30 minutes the attempt is deferred. One automatic attempt per release/local day
prevents retry loops, including repeated daylight-saving hours.

## Backup, rollback and recovery

Before replacing either application image, the updater stops app and runner and
makes a consistent **offline** backup including the package cache. It verifies
archive sizes and SHA256 checksums; restore additionally validates archive paths,
types, expanded sizes and empty targets. App and runner are always upgraded
together. Health checks, exact application version, runner protocol and actual
runner readiness must pass before work is unblocked.

On failure after replacement, backup data is restored into **new empty volumes**
with the old image pair. Original volumes and failed/migrated volumes are kept.
Interrupted restores use a new empty volume generation, up to three attempts.
If recovery fails, automatic updates stop and status includes the exact backup
verification command. An application starting during a transaction remains in
maintenance until its updater confirms success/recovery.

All update backups are retained, including at least the last three successful
updates. There is deliberately no automatic pruning of recovery points. If space
is insufficient, the update fails during preflight. Move/export old verified
backups yourself after testing restore; never use `docker system prune` or
`docker compose down -v` as an update procedure.

If the updater alone needs replacing, rerun the downloaded installer for the same
directory. If it cannot start, inspect its log locally:

```bash
docker logs sterracode-updater
```

For a failed update recovery, correct the reported disk/backup/permission problem,
then run `bash manage.sh recover` or `.\manage.ps1 recover` from the installation
directory. This is a local Docker administration command, not an HTTP action. It
retries from the saved checkpoint into another fresh empty volume generation,
preserves all previous volumes and pauses automatic updates. The failure banner
shows both commands. Check an old session and real execution before enabling
automatic updates again.

For a stopped recovery, preserve `installation.json`, `updates.json` and all labeled
volumes first. Read the operation's `before` image/volume mapping and `backup` name
in `updates.json`. Verify that named backup with the command in the operation
error. Do not restore into the failed volumes. Use `docker/admin.mjs restore` with
the old app image and new empty volume targets, as described in
[`DOCKER-BETRIEB.md`](../DOCKER-BETRIEB.md). Existing source deployments continue to
support their original administration commands.

## Explicit migration from a source installation

Use a new managed project and directory; never point a fresh installer at the old
repository or reuse its Compose project name. The commands below keep the old
stack stopped and preserve its complete offline backup. Substitute your real LAN
address and absolute backup path.

From the old source checkout:

```bash
bash scripts/docker-admin.sh backup /absolute/path/sterracode-offline-backup --offline --no-restart
bash /path/to/downloaded/install.sh --directory "$HOME/.sterracode-managed" --project sterracode-managed --bind-ip 192.168.178.50 --port 3002 --non-interactive
bash "$HOME/.sterracode-managed/manage.sh" migrate /absolute/path/sterracode-offline-backup
```

```powershell
.\scripts\docker-admin.ps1 backup -Path 'D:\SterraBackup\migration' -Offline -NoRestart
& 'C:\Downloads\install.ps1' -Directory "$HOME\.sterracode-managed" -Project sterracode-managed -BindIP 192.168.178.50 -Port 3002 -NonInteractive
& "$HOME\.sterracode-managed\manage.ps1" migrate -BackupDirectory 'D:\SterraBackup\migration'
```

The explicit `migrate` action imports into new empty managed volumes. It preserves
the old source volumes and the new installation's original volumes. Your old
administrator password, sessions, credentials and workspaces come from the backup.
The selected managed LAN URL/port remains the new access address. External secret
mounts, reverse proxy configuration and browser-local drafts must be migrated
separately; the source repository and its `.env` are not modified by this import.
Architecture/suite mismatches are rejected by runner recovery. Open an old session,
check history and execute a program before retiring the old installation.

An interrupted import keeps the updater stopped. Restore the previous managed
volume mapping with this command, then investigate the retained import volumes:

```bash
bash "$HOME/.sterracode-managed/manage.sh" migrate-recover
```

PowerShell: `.\manage.ps1 migrate-recover`. Repeating `migrate` while an import is
unfinished is rejected. Do not delete any original or partially restored volumes
to retry.

## Publishing a release

1. Update the single application version in root `package.json` and its lockfile.
   Update `installer/release-policy.json`: `upgradeFrom` is an explicit list of
   installed versions whose data migration has been tested, including supported
   older major versions. Increase `minUpdaterVersion` when the controller protocol
   requires it; updater version itself is in `shared/releases.js`.
2. Verify native AMD64 and ARM64 runtime changes. `scripts/catalog-arm64.py` derives
   exact ARM64 pins from signed Debian/Microsoft indexes, signed Rust metadata,
   Go metadata and the official .NET archive with SHA512 verification. Regeneration
   is explicit; users never resolve unpinned "latest" SDKs during install.
3. Push a matching `vX.Y.Z` tag. `.github/workflows/release.yml` runs unit/UI checks,
   builds on native AMD64/ARM64 runners, executes the full runtime/restore checks,
   and tests managed installation, update and rollback against provisional image
   digests. Failed architecture acceptance prevents a stable release.
4. Make the three GHCR packages (`sterracode-app`, `sterracode-runner`,
   `sterracode-updater`) **public** in GitHub package settings. GitHub does not make
   new packages public automatically. The final workflow verifies anonymous access
   before publishing the stable GitHub release. A first workflow run can stop here
   until package visibility is configured; rerun it after doing so.
5. The workflow creates multi-architecture digest references, `installer.zip` and
   `release.json`, then publishes a draft as stable only after all checks pass.
   Draft/prerelease releases are never installed. Do not overwrite an already
   published version; publish a new version for corrections.

The app/server fetches releases from the fixed `zfzfg/SterraCode` repository.
Only the publisher's digest-pinned GHCR image names and exact release asset paths
are accepted. HTTPS plus package hashes detect corruption; bootstrap trust still
depends on the publisher's HTTPS hosting/GitHub accounts. The bootstrap never
executes arbitrary commands supplied by release metadata.

## STRATO / WordPress hosting

Upload **only the contents of `installer/hosting/`** to a `code-install` directory
under the document root that actually serves `https://sterra.online`. Do not upload
the repository, `sftp.txt`, control files, backups or `installer/runtime/`.
The root URL serves `index.html`; `.ps1` and `.sh` are served as `text/plain` with
`nosniff` and revalidation headers. No subdomain, DNS change or domain forwarding
is required.

Prepare an isolated Python environment with `upload-requirements.txt`, then:

```bash
python installer/upload.py --inspect
python installer/upload.py --remote-root /actual/wordpress/root
python installer/upload.py --remote-root /actual/wordpress/root --apply
```

The second command is a **preview**. The final command proves the selected root
with a temporary random HTTPS marker, saves existing destination files locally
under ignored `installer/.upload-backups/`, replaces files through atomic SFTP
renames and verifies public response bytes and script Content-Types. A dry-run
performs no remote writes. The marker is removed after checking.

Defaults use host `5018480546.ssh.w2.strato.hosting`, user `su1216743`, and the
password read locally from ignored root `sftp.txt`. Empty credentials stop the
upload. Passwords are never printed or supplied as process arguments. Known SSH
host keys are checked; for a new host, obtain its SHA256 fingerprint from a trusted
STRATO channel before passing `--host-key SHA256:...`. On Windows, an existing
matching Ed25519 key in PuTTY/WinSCP is also accepted. Merely observing a key with
`ssh-keyscan` does not authenticate it.

For this account, the verified SFTP working directory is
`/home/www/public/wp-content`; the parent document root is not accessible. Use:

```bash
python installer/upload.py --remote-root /home/www/public/wp-content --wordpress-content
python installer/upload.py --remote-root /home/www/public/wp-content --wordpress-content --apply
```

This alternative places assets in `wp-content/code-install` and installs only
`installer/wordpress/sterracode-installer.php` into `wp-content/mu-plugins`.
The MU-plugin serves a fixed file allowlist at `/code-install/`, rejects other
methods/paths, and does nothing for other WordPress requests. It neither edits the
active `/home/www/public/wp-content/themes/sterra-vscode` theme nor changes the
database or root rewrite rules. Upload verification checks the original home page;
a failed route check restores/removes the MU-plugin. To remove the route, delete
only `mu-plugins/sterracode-installer.php`; its public assets can then be removed
separately. [WordPress MU-plugin documentation](https://developer.wordpress.org/advanced-administration/plugins/mu-plugins/).

Normally WordPress leaves a real `code-install` directory alone. If it does not,
back up the root `.htaccess` and add this exception **before and outside** the
managed WordPress block; leave its other rules intact:

```apache
<IfModule mod_rewrite.c>
RewriteEngine On
RewriteRule ^code-install(?:/|$) - [L]
</IfModule>
```

If STRATO disallows an `.htaccess` directive, remove only that unsupported
directive after checking the HTTP error; never replace WordPress's root file with
the bundled directory-specific `.htaccess`. Verify `/code-install/`, `install.ps1`
and `install.sh` over public HTTPS. Ordinary releases do not require another SFTP
upload; bootstrap improvements do.

## Verification

```bash
npm test
npm run format:check
npx prettier --check installer shared/releases.js .github/workflows/release.yml
npx playwright test tests/e2e/updates.spec.js
npm run test:docker
```

The release workflow additionally runs native managed-container acceptance using
`tests/docker/managed.mjs`. Missing Linux Docker is a recorded local skip, never
a release success. See [`docker/ABNAHME.md`](../docker/ABNAHME.md) for actual platform
results; Windows Desktop/macOS end-to-end results are separate from native Linux CI.
