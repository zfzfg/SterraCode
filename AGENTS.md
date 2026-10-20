# Repository Guidelines

## Project Structure & Module Organization

- `server/routes/`: HTTP endpoints; `server/services/`: workspace storage, processes, providers, and context management.
- `public/`: application HTML/CSS, `js/` feature modules, and local SVG assets.
- `runner/`: Docker job scheduling, runtime management, version catalog, and Python tracer.
- `docker/`: administration tools and acceptance records; root `Dockerfile*` and `compose*.yaml` define deployment.
- `installer/`: public bootstrap scripts, managed Docker installation/updater, release policy, and STRATO upload tooling; read `installer/README.md` before changing these flows.
- `tests/`: Vitest suites, Playwright flows in `e2e/`, and container checks in `docker/`.

Keep route handlers thin and domain behavior in services. Route program execution through the shared process service and its local or Docker adapter.

## Build, Test, and Development Commands

Use a Node version allowed by `package.json`; Node 24 is recommended.

- `npm ci`: install locked dependencies.
- `npm start`: serve locally at `http://localhost:3000`.
- `npm run dev`: restart the server when source files change.
- `npm test`: run Vitest; `npm run test:watch` enables watch mode.
- `npx playwright install chromium`: install the browser before initial E2E testing.
- `npm run test:e2e`: run Playwright with its dedicated test server.
- `npm run format:check`: verify Prettier formatting.
- `docker compose build`: build application and runner images.
- `npm run test:docker`: run isolated Linux-container acceptance checks.

There is no separate frontend build step.

## Coding Style & Naming Conventions

Use ES modules, two-space indentation, double quotes, and semicolons, following Prettier output. Format files with `npx prettier --write <paths>`. Use camelCase for functions and variables, PascalCase for classes, and filenames consistent with neighboring modules. Preserve the existing accessibility and i18n patterns: application strings belong in the German, English, and Spanish catalogs under `shared/i18n/locales/`. Installer terminal output must be English.

## Testing Guidelines

Name Vitest files `*.test.js` and Playwright files `*.spec.js`. Add focused regression coverage for changed behavior, especially version conflicts, path validation, cancellation, and recovery. Use temporary data directories instead of personal workspaces. No numeric coverage threshold is configured. Review screenshot changes visually before updating baselines. For runner changes, execute container checks when available and report skipped platform or runtime checks explicitly.

## Commit & Pull Request Guidelines

Recent commits use imperative subjects such as “Preserve requested removal when repairing interrupted package actions”; no mandatory prefix convention is evident. Keep commits focused. PR descriptions should explain the problem, resulting behavior, validation, and limitations. Link relevant issues and include screenshots for UI changes.

## Security & Configuration

Never commit `.env`, credentials, generated data, or backups. Preserve authentication, origin checks, safe filesystem access, and expected-version checks. Use disposable Compose projects for tests. Consult `DOCKER-BETRIEB.md` before operational changes and record platform results in `docker/ABNAHME.md`.

## Existing Ubuntu Deployment

Last verified on 2026-10-20; inspect the actual server state before future operations.

- SSH target: `zfzfg@192.168.178.104`; application URL: `http://192.168.178.104:3000`.
- Installation directory: `/home/zfzfg/sterracode-test`; Compose project: `sterracode-test`. This is a source-package deployment, **not a Git checkout or managed-updater installation**. Other unrelated services run on the same Docker host.
- Preserve `.env`, project identity, named volumes, administrator credentials, and workspaces. Never use `docker compose down -v` or global Docker pruning for an update. Do not silently migrate this stack into the managed installer; explicit migration uses a separate project/directory and new volume targets.
- Build new images before the service interruption. Before replacing containers, create a consistent offline backup with `bash scripts/docker-admin.sh backup /absolute/private/backup --offline --no-restart`. Check running work first, verify archive checksums, and retain previous source/configuration and image identities for recovery. `--no-restart` intentionally leaves services stopped until the chosen images are started.
- Source builds use `STERRACODE_VERSION=local`; `STERRACODE_BUILD_VERSION` comes from `package.json` through the common shell/PowerShell helpers. Old `:1.1.0` images may still exist; the helpers can alias the actual legacy container images when `:local` is absent. Do not assume those tags identify the current deployment.
- `SOURCE_COMMIT`, `SOURCE_TREE`, `DEPLOYMENT_RECORD_COMMIT`, and `.last-deployment-backup` are deployment records on this server. Keep them accurate when shipping source packages. `git archive HEAD` excludes uncommitted work; when deployment must precede a commit, explicitly review/stage the intended files and archive the resulting tree.
- Last deployment backup: `/home/zfzfg/sterracode-deploy-backups/20261020T205131Z` (`data/` contains the offline data/image backup, `source.tar.gz` the previous source/configuration). These contain secrets and must remain private. Check `.last-deployment-backup` for later deployments.
- Verify both Docker healthchecks **and** authenticated runner `/v1/status` readiness, initialization errors, package actions, and restored runtimes. Read runner keys only inside the relevant container; never print them. Check the public URL from another LAN machine. `/api/health` intentionally returns only `{ "ok": true }`; `/api/updates` requires authentication.
- Authentication rewrites session timestamps during ordinary browser activity. A changed whole-file `auth.json` checksum alone does not mean the password changed; compare password/version fields without exposing their contents.

## Installer, Release, and Hosting Boundaries

- GitHub Releases is the update authority; STRATO serves the landing page and bootstrap scripts at `https://sterra.online/code-install/`. Normal release updates do not require uploading the website again. Use root `package.json` as the application version source and `installer/release-policy.json` for explicit migration compatibility.
- Managed installations use immutable GHCR image digests and a separately pinned updater. Only the updater receives the Docker socket; app and runner must not receive it. Preserve authenticated fixed actions, durable operation journals, drain behavior, and rollback into new empty volumes. Do not bypass updater-version or migration checks.
- At the 2026-10-20 deployment, no stable GitHub release had been published. A source deployment or successful local test does not publish release images or enable automatic updates on the existing Ubuntu stack. Check actual release/registry state before promising that public installation commands work end to end.
- Public STRATO files live under `/home/www/public/wp-content/code-install`; `wp-content/mu-plugins/sterracode-installer.php` serves the fixed public URL allowlist. The SFTP account cannot access `/home/www/public` directly. Preserve the active theme `/home/www/public/wp-content/themes/sterra-vscode`, WordPress database, and root rewrites.
- Use `installer/upload.py` and its inspect/preview workflow for hosting operations. Verify the SFTP host key against trusted local records, back up replaced public files, and verify HTTPS bytes/content types afterward. `sftp.txt` is local, ignored credential input: never print it, commit it, put it in an archive, or include it in a Docker build context. Local upload backups under `installer/.upload-backups/` are also ignored.

## Verification and Platform Pitfalls

- On Windows, Python text I/O must specify UTF-8 explicitly. The system default can be CP1252 and corrupt German text. Preserve LF for shell scripts, Dockerfiles, and Compose files according to `.gitattributes`; check shell syntax after editing from PowerShell.
- LAN HTTP is not a secure browser context. Use the existing UUID helper in `public/js/uuid.js` instead of assuming `crypto.randomUUID()` exists. Update settings belong in the existing Settings dialog; preserve the established editor/header layout and screenshot baselines.
- A successful `docker compose config` validates configuration only. The local Windows Docker Linux daemon was unavailable during the last implementation; a skipped Docker test is not native acceptance. Set `STERRACODE_DOCKER_REQUIRED=1` when Docker availability must be mandatory.
- `tests/docker/smoke.mjs` supports `STERRACODE_TEST_APP_IMAGE` and `STERRACODE_TEST_RUNNER_IMAGE` to test the exact built images in disposable projects. Its default run covers Python execution, isolation, persistence, offline recovery, backup/restore, and old-data import. It does **not** prove all optional runtimes: that requires `STERRACODE_DOCKER_FULL=1`. Managed update/rollback/import acceptance is separate in `tests/docker/managed.mjs`.
- Native AMD64 default Docker smoke passed on the Ubuntu host on 2026-10-20. Native ARM64, Windows/macOS Docker Desktop, all-runtime acceptance, and managed registry-update acceptance remain separate checks; AMD64 emulation is not native ARM64 evidence. Record concrete results and remaining gaps in `docker/ABNAHME.md` rather than treating test counts as permanent requirements.
