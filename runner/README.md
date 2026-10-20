# Runner protocol v1

Release 1.1.0. The runner controls Linux execution as root; learner programs run through the compiled `launch.c` helper as UID 10002 / primary GID 10001, without supplementary groups, with `no_new_privs`. The helper remains a subreaper and stops double-forked children and separate process groups. The shared execution UID does **not** isolate learning sessions from one another. [German historical guide](README.de.md).

Version probes use the same execution UID and cleaned environment. `XDG_RUNTIME_DIR` is an execution-UID-owned mode-0700 directory on the tool cache, including for .NET/NuGet initialization. App secrets and package-manager credentials are not inherited by programs.

Every HTTP request, including health, requires `Authorization: Bearer` using `STERRACODE_RUNNER_SECRET_FILE`. The key is never a child argument/environment value. App and runner send `X-Runner-Protocol: 1`; incompatible protocols are rejected.

## Internal API

| Method/path                                  | Purpose                                                |
| -------------------------------------------- | ------------------------------------------------------ |
| `GET /v1/health`                             | Minimal process health                                 |
| `GET /v1/status`                             | Operating state, active jobs, blocked sessions         |
| `GET /v1/runtimes`                           | Installation/capabilities of all nine adapters         |
| `POST /v1/jobs`                              | Admit a UUID job with session and relative source data |
| `GET /v1/jobs/:id/output?sessionId=&offset=` | Output using UTF-8 byte offsets                        |
| `POST /v1/jobs/:id/input`                    | `{sessionId,input}` stdin                              |
| `DELETE /v1/jobs/:id`                        | Stop with `{sessionId}`                                |
| `POST /v1/sessions/:id/block`                | Persistently block starts and stop jobs                |
| `DELETE /v1/sessions/:id/block`              | Explicitly unblock starts                              |
| `POST /v1/sessions/:id/stop`                 | Stop session processes                                 |
| `POST /v1/maintenance`                       | Block starts; optional `stopRunning`                   |
| `DELETE /v1/maintenance`                     | End maintenance if no package job is active            |
| `GET /v1/programs`                           | Catalog, installed state, current package job          |
| `POST /v1/programs/:id/actions`              | `install`, `remove`, `repair`, `retry`                 |
| `GET /v1/program-jobs/:id`                   | Package job state                                      |
| `POST /v1/program-jobs/:id/cancel`           | Cancel a waiting package job                           |
| `GET /v1/cache`                              | Sizes and free space                                   |
| `DELETE /v1/cache`                           | Clear disposable package downloads                     |

Journals and the desired manifest use file sync, atomic rename, and directory sync. Journal failure prevents execution. The same ID/canonical payload returns the same job; changed data produces `409 IDEMPOTENCY_CONFLICT`. Restart marks unfinished jobs `interrupted` without replay. Output expires after five minutes; durable identity evidence remains.

Admission reserves one job per session, four overall, and two compilation slots in one serialized section. Maintenance blocks starts before waiting. A waiting package job can be canceled or continue after explicit `stopRunning`.

## Packages and recovery

`catalog/versions.lock` pins Debian suite, architecture, base image, and catalog version. Debian/Microsoft packages have exact versions and SHA-256 values from signed indexes; the Microsoft public key is included. Go archives use pinned vendor metadata/checksums. Rust compiler/Cargo/library archives are checked against the GPG-verified vendor manifest. Browser callers cannot supply arbitrary package URLs or scripts.

Successful installs record resolved dependencies, versions, architecture, and cached checksums. Container replacement restores those exact packages; missing cache entries are fetched only at the saved exact versions. Corrupt downloads fail. Removed runtimes are not reintroduced by settings backups or initial-program settings. Suite/architecture changes require explicit manifest migration; Native ARM64 has its own `versions.arm64.lock` candidate catalog. Stable ARM64 releases require the complete native runtime, restore and managed-update acceptance in the release workflow.

Release changes require checking base/catalog sources, exact versions/checksums, manifest restoration, and all runtime smokes on the accepted architecture. The application release number is separate from protocol version 1 and catalog version `2026.10.19.1`.

## Localization and tests

The runner is independent of i18next. Own messages add stable `messageKey`/scalar `params` descriptors for the app to translate. Statuses, error codes, IDs, package logs, compiler diagnostics, learner stdout, and journal identities remain original data. Package progress describes six phases, rather than time remaining. Both app and runner images include shared contracts and must be upgraded together.

Python advertises `file`, `trace`, and `test` with adapter version 1. A test job validates `{type: "test", test: {suite, files}}` before reservation and occupies one ordinary slot. The grading adapter starts a fresh process per case, limited to two seconds per case / 30 seconds per suite. Bounded `testResults` are separate from stdout; the app determines assessment. Snapshot/case directories use the common safe cleanup. Cancellation/restart never automatically replays jobs. This is learning feedback, not a tamper-resistant examination system.

`npm test` covers protocol/client/manifest contracts. `npm run test:docker` uses disposable projects; `STERRACODE_DOCKER_FULL=1` additionally installs and exercises every optional runtime. `node tests/docker/grading-smoke.mjs` and `node tests/docker/trace-smoke.mjs` test their adapters. `tests/docker/runner-live.mjs` exercises real timeouts, UTF-8 output limits, large stdin, symlink races, and a fork storm bounded by the container PID limit, after package maintenance finishes. It removes only its own random session and test state file.
