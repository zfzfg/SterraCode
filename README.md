# SterraCode

A programming learning workspace with a Monaco editor, files, a learning plan, a terminal, and an AI tutor through LM Studio or the OpenAI API. Run it locally with npm or as an authenticated Docker server on your LAN. Sessions, files, exercises, and execution also work without an AI connection.

**Release 1.2.0 supports English, German, and Spanish. English is the default for fresh installations and browsers.** Existing browser language choices are preserved. Interface language, tutor language, programming language, and materialized exercise content are independent. Existing source files and conversations are never automatically translated.

Documentation is maintained in English by default. See the [Docker operations guide](DOCKER-BETRIEB.md), [runner protocol](runner/README.md), [i18n architecture](docs/i18n/README.md), and [release notes](CHANGELOG.md). The [previous German guide](README.de.md) remains available as a historical reference.

## Docker installation

Requires Docker Engine with Compose, or Docker Desktop using **Linux containers**. The accepted architecture is `linux/amd64`; ARM64 is not yet supported. Host Node.js, compilers, and additional language runtimes are unnecessary.

```sh
bash install.sh
```

```powershell
.\install.ps1
```

The installer selects a LAN address, creates `.env`, builds images, and displays a temporary setup key. Open the displayed URL, choose an administrator password, and install optional runtimes under **Settings → Programs**. Re-running the installer preserves configuration, volumes, and the password. Node.js and Bash are part of the runner base.

Start/stop with `bash start-docker.sh` / `bash stop-docker.sh`, or `start-docker.ps1` / `stop-docker.ps1`. Read the operations guide before updates, backups, restores, imports, proxy changes, or password recovery. Never use `down -v` or `docker system prune` to update an installation.

## Local development

Node.js 24 is recommended. Supported versions are Node 22 from 22.12, Node 24, and Node 26 or later.

```sh
npm ci
npm start
```

Open `http://localhost:3000`. Local mode binds to `127.0.0.1`; `start.ps1` and `start.bat` are alternatives. `npm run dev` enables Node's watch mode. There is no frontend build step. Local execution uses host-installed language runtimes.

For LM Studio, start a reachable server and load a model with tool support. It may run on the same host, elsewhere on the LAN, or behind HTTPS. In Docker, `localhost` refers to the app container; `host.docker.internal` addresses the Docker host. The native connection test checks SDK access, tokenization, and context size.

For OpenAI, choose the provider in Settings, save a key using the credential controls, and select a model from the API model list. Requests use the Responses API with tools, streaming, and `store: false`. Chat and compaction can incur costs. Credentials stay on the server and are not returned to the browser. The operations guide covers protected secret-file mounts and backups.

## Working in SterraCode

- **Sessions:** select a programming language and an independent tutor language. New sessions inherit the interface language for their tutor. The initial learning-plan question works offline.
- **Files:** create, open, rename, and delete files/folders. Changes autosave; Ctrl+S saves immediately. File/session navigation waits for saves. A conflict opens a comparison and allows saving the local text as another file. Newer server content is never silently overwritten. Browser storage provides an additional draft copy when available.
- **AI changes:** Settings offers **Auto Accept** and **Review**. Review stores a proposal without changing the file. The diff inspector supports selected hunks, rejection, and persistent undo. Acceptance checks source versions. Nearby hunks may have dependencies; test the result after partial acceptance. Explanations are not proof of correctness.
- **Execution:** Ctrl+Enter runs the active file. The terminal accepts commands/stdin and can stop process trees. Session deletion stops its processes. The terminal occupies the editor area; the tutor retains its full height.
- **Python step by step:** record an open `.py` file once, then explore its immutable source snapshot, timeline, stack, variables, errors, and optional predictions. Additional Python sources and stdin are selected explicitly. Going backwards does not undo filesystem effects. Native libraries, threads, and asynchronous operations are not fully observed.
- **Web preview:** HTML supports local CSS, classic JavaScript, DOM events, Canvas, and inline SVG. Successful saves refresh it; automatic updates can be paused. Reload creates a new snapshot. Diagnostics navigate only to confirmed workspace sources. Preparing a diagnostic in chat creates a draft, not an AI request.
- **Language:** English, Deutsch, and Español are available before sign-in. A later change saves editor models and reloads Monaco safely. Active chats, tests, terminal processes, package jobs, unfinished dialogs, or terminal input defer the change. Editor/chat/question/journal drafts are restored. Commands and stdin are not replayed. German remains the secondary catalog/bootstrap fallback if selected catalogs fail.
- **Layout:** four themes and keyboard-accessible splitters. The sidebar overlays below 1280 px; below 960 px, editor and chat are switchable views. Arrow keys resize focused splitters. Enter/Space toggles the focused terminal splitter.
- **Context:** `/usage` displays context usage and measurement quality, including marked offline estimates. `/compact` or `/compress` condenses older model context without a tutor answer. Complete source history and tool results remain stored. OpenAI uses native compaction; local context/response-budget settings apply to LM Studio.

## Exercises, projects, and journals

The project workshop includes Number guessing game, Text analysis, and My small website. Each opens a new session without installing software or executing commands. New content is materialized once in the selected language. Files, task versions, and test contracts then become original project data. Required function names and literal test values remain unchanged, including the number game's German return strings.

Python tasks can have visible function tests. Each case uses a fresh process with a two-second limit; a suite has a 30-second limit. Source snapshots, versions, suite digests, and results are stored. Completion requires a current passing run. Historical/expired results do not certify today's editor content. Runs can be canceled; interrupted jobs are not automatically repeated. This is learning feedback, not a tamper-resistant examination system.

Hints are revealed individually without editing files or starting AI requests. Opening a solution hint is explicit. Assistance is recorded without deducting points or claiming independence. Tasks without tests can be completed after your own review. Task and hint sections collapse independently. Follow-up actions can ask for the next task or another task on the same topic.

The optional journal stores up to 200 task versions per session and 2,000 characters per entry. Saving a journal and completing a task are separate actions. Empty text removes an entry; expected versions protect against delayed saves. Journal text is not automatically sent to the tutor, included in the cross-session profile, or exported with projects.

**Export project** includes explicitly selected UTF-8 sources, the visible task/tests, and checklist: up to 50 files, 2 MiB of source, and 3 MiB JSON. Import validates paths, manifest, byte lengths, and SHA-256 versions, then creates fresh task IDs without old completions or assistance evidence. Credentials, journals, profiles, backups, and execution artifacts are excluded. Inspect your selected source for personal information before sharing. A project package is not an application backup or reproducible runtime environment.

## Learning profile and optional reviews

The cross-session profile is **opt-in and disabled by default**. Enabling it does not silently import old sessions. Historical imports require separate confirmation. Evidence distinguishes tests, tutor assessment, self-assessment, assisted work, and legacy data; counts are deduplicated by task/session identity. There is no precise-looking mastery percentage.

The concept catalog covers variables, conditions, loops, lists, functions, and strings for Python and JavaScript. Python has six checked offline review exercises. A review opens its own session; duplicate starts return the same open task. JavaScript currently offers concepts and self-assessment without an executable review-test adapter.

Leitner version 1 uses configurable intervals of 1, 3, 7, 14, and 30 calendar days. Events are UTC; due dates use the selected IANA timezone, initially `Europe/Berlin`. Independent, test-checked due reviews advance at most one stage. A review failure resets the stage and schedules tomorrow. Self-assessment does not advance it; cancellations, timeouts, runtime failures, and breaks do not lower it. At most three reviews are offered. Skip and snooze affect scheduling rather than evidence.

Profile export includes complete stored data. Reset requires confirmation and retains technical suppression markers against reimporting deleted evidence; original session completions and backups are not erased. The privacy view shows the bounded summary available to the tutor, rather than automatically sharing raw events or full test runs.

## Data and API contracts

All API paths retain authentication, origin checks, safe filesystem access, and expected-version checks.

- File reads return `version`; writes require `expectedVersion`; conflicts return HTTP 409.
- Sessions use workspace `schemaVersion: 2`, `revision`, `activeFile`, and `openFiles`. Independent `localeSchemaVersion: 1` stores language metadata. Legacy sessions retain `tutorLocale: null` until explicitly changed.
- Chat has stable message/question/turn IDs. Completed-turn retries do not rerun tools. Application REST/SSE messages carry `messageKey` and scalar `params`; model messages and native output remain original data.
- Workspace `/changes` and `/proposals` expose persistent history and decisions. Acceptance/undo verify current source versions. A proposal is not an applied change.
- `/api/runtimes` reports availability and reasons. Terminal IDs are session-bound. Runner jobs and imports use durable idempotency records; changed data under the same ID conflicts.
- Project format is `sterracode-project`, schema 1. Files contain `path`, `content`, UTF-8 `bytes`, and SHA-256 `version`. Optional locale/provenance fields are preserved. Technical identities and suite digests are not translation targets.
- Large finished test artifacts expire after 24 hours; at most the newest 20 are retained. Operation identity, summaries, versions, and completion evidence remain. Active runs are not removed.
- Profile endpoints support configuration, export, confirmed reset, historical import, self-assessment, review start, and review results. Submitted success is checked against a stored test run, not trusted as a client claim.

## Verification and source layout

```sh
npm test
npx playwright install chromium
npm run test:e2e
npm run test:i18n-audit
npm run check:i18n
npm run audit:i18n
node scripts/review-i18n.mjs
npm run format:check
npm run test:docker
```

Tests use temporary data and provider fixtures. Available host runtimes receive real execution checks; missing runtimes are explicitly skipped and their error paths are tested. Browser tests cover workflows, recovery, accessibility, languages, and layouts in four sizes/themes. Screenshot baselines are platform-specific: inspect changes visually before updating them.

Docker checks use disposable Compose projects. `STERRACODE_DOCKER_FULL=1 npm run test:docker` exercises all optional runtimes. Additional checks: `node tests/docker/trace-smoke.mjs` and `node tests/docker/grading-smoke.mjs`. Normal tests do not send paid or LAN model requests. Actual results and limitations are recorded in [docker/ABNAHME.md](docker/ABNAHME.md).

`public/` contains the browser UI; `server/routes/` thin HTTP handlers; `server/services/` domain behavior and process adapters; `shared/i18n/` catalogs/contracts; `runner/` execution/packages; `tests/` regression, browser, and container suites.

## License

SterraCode is licensed under the [MIT License](LICENSE).

# Installation links and managed updates

The public Docker installer, STRATO upload files, release publishing workflow and
recovery/import instructions are documented in [installer/README.md](installer/README.md).
The download links become usable after the hosting files and first approved stable
release have been published. Existing source installations remain supported.
