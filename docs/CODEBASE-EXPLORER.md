# Importing and understanding code projects

Choose **Import code project** in Sessions. Import a ZIP file or a Git snapshot,
review the recommended selection, then open the project. Imports, file navigation,
saved overviews and tour navigation work without a model. **Analyze codebase** and
explicit tutor questions send selected source excerpts to the configured provider.
The overview names that provider, model, focus and estimated source budget before
you start. An estimate is not a billing quote.

Code projects have their own session mode, without a mandatory execution language,
generated main file or exercise onboarding. The existing session schema remains 2;
`codebase.schemaVersion: 1` versions the independent extension. Ordinary learning
sessions and JSON project packages retain their existing contracts.

## Files and selection

The default selection includes source, tests, documentation, manifests and small
configuration. Dependencies and generated output are initially deselected. You can
change folder rules even when only a page of descendants has been loaded. Search
changes the displayed results, not the selection. Git metadata, recognized secrets,
links and special files cannot be published. Inspect unfamiliar source for secrets;
filename checks cannot identify every embedded credential.

Archive and selected uncompressed sizes are different. Selecting strictly more
than **500,000,000 bytes** requires explicit confirmation of that exact manifest,
selection and byte count. This is a warning threshold, not a project size cap.
Operational limits still apply. Binary files can be stored unchanged; files above
2 MiB have metadata and a bounded text preview rather than an editable Monaco model.
Unknown text languages remain usable for static explanation.

## Analysis, references and tours

Analysis reads a bounded selection of README files, manifests, entry candidates,
interfaces and tests. It parses manifests without invoking package managers.
Source hashes are checked before publication, including changes made outside the
editor. The server validates the result shape and source references. This proves
that a reference addresses read source; it does not certify a model's interpretation.
Coverage and uncertain relationships remain visible.

A new analysis becomes current only after successful validation. Cancellation or
invalid output preserves the previous result. Restart interrupts unfinished model
work and never automatically retries it. Changed files mark the overview stale;
they do not trigger another request. Code links carry the session, path, line range
and file hash. A stale link offers the current file without silently revealing an
unrelated line. Selection explanations save the editor first, validate the version
and include the actual selected source in the explicit tutor request.

Tour selection and visit/understanding marks are local persisted progress, not
exercise completion or skill-profile evidence. The explanation-mode executor
enforces allowed capabilities independently of prompts and tool visibility.
README, comments and imported AGENTS.md files never grant execution rights.

## Git credentials and destinations

Git imports produce a snapshot of a resolved commit, without history, automatic
submodules, LFS downloads, checkout filters, hooks, pull or push. HTTPS and explicit
`ssh://` URLs are accepted. Authentication metadata and encrypted secrets are
managed in the existing Settings dialog. GET responses never contain the secret.
Credential use is bound to protocol, hostname, port and repository prefix.

Remote secret entry requires HTTPS. Loopback is allowed for local administration.
On an HTTP LAN installation, configure secrets through a secure local connection or
provide an administrator-managed setup; do not transmit a PAT over that connection.
SSH requires a trusted host public key; no automatic trust-on-first-use is used.
Encrypted SSH keys can be unlocked for one use for five minutes; their passphrase
is not persisted. Raw remote diagnostics are not exposed to the browser or tutor.

Destinations default to github.com, gitlab.com and bitbucket.org on HTTPS/443 and
SSH/22. `STERRACODE_GIT_ALLOWED_HOSTS` is a comma-separated exact `host:port` allowlist.
Private addresses additionally require the exact target in
`STERRACODE_GIT_PRIVATE_HOSTS`. Every resolved address is checked. HTTPS goes through
a single-destination proxy pinned to the checked address with TLS hostname
verification; SSH connects to the pinned address with the original host-key alias.
Redirects and inherited Git/SSH configuration are disabled. Keep independent
network filtering around administratively approved private destinations.

Secrets use AES-256-GCM with authenticated host/version metadata. The preferred
master key is a protected **32-byte binary file** outside application backups,
selected by `STERRACODE_GIT_KEY_FILE`. The optional `compose.git-secret.yaml` mounts
`STERRACODE_GIT_KEY_PATH` only into the app. Include that overlay explicitly when
using Compose directly; the installer does not automatically select it. UID 10001
must be able to read the file, without group/world access on Linux. Back it up
separately. Losing or changing it prevents decryption. The local fallback is
`DATA_DIR/credentials/.git-key`; a complete data backup contains both ciphertext
and this key and must be treated as sensitive. Windows protection depends on ACLs.

## Demos and runtime decisions

The tutor can propose a small standalone demo in a separate session. It never
copies or overwrites the imported workspace. Existing AI Review settings still
apply: `proposed` is not an applied file. Runtime installation and execution are
separate expiring action cards bound to the demo source hash. Decisions are durable
and idempotent. A conversational “yes” is never an action decision. Installation
uses the fixed program catalog, never silently stops existing work, and is
unavailable in local mode. Changed source or a changed catalog invalidates approval.

Demo execution uses the common process service and a dedicated bubblewrap adapter.
It exposes only one approved immutable source and read-only runtime assets, with
separate user/PID/network namespaces and bounded temporary storage, CPU, memory,
processes and wall time. It does not execute project dependency installers.
Capabilities are probed under the actual runner UID and security configuration.
If user namespaces or required isolation features are blocked, execution remains
unavailable; code and explanation still work. Do not enable privileged containers,
mount the Docker socket or disable security profiles to bypass this check. The
ordinary shared-UID runner is not a sandbox for imported code. Full-project builds
and dependency installation remain outside this feature.

## Resources, recovery and deletion

Defaults are operational budgets, configurable through the app environment:

| Variable                                  |                         Default |
| ----------------------------------------- | ------------------------------: |
| `STERRACODE_IMPORT_UPLOAD_BYTES`          |                           2 GiB |
| `STERRACODE_IMPORT_EXTRACTED_BYTES`       |                           8 GiB |
| `STERRACODE_IMPORT_ENTRIES`               |                         200,000 |
| `STERRACODE_IMPORT_DEPTH`                 |                              64 |
| `STERRACODE_IMPORT_DURATION_MS`           |          1,800,000 (30 minutes) |
| `STERRACODE_IMPORT_RETENTION_MS`          |      86,400,000 (24 hours idle) |
| `STERRACODE_IMPORT_ABSOLUTE_RETENTION_MS` | 259,200,000 (72 hours absolute) |

One heavy import phase runs at a time. Free-space checks and measured byte limits
remain active while materializing data. Tree pages default to 200 entries and are
capped at 500; literal search has bounded results and time. Compressed sizes,
entry counts, portable paths, collisions, CRCs and actual extracted bytes are
checked. Nested archives are never recursively extracted.

Durable receipts live under `DATA_DIR/codebase-imports`; private uploads/manifests
are in their UUID subdirectories. Committed analyses and tours live under
`DATA_DIR/codebases/<sessionId>` and the session JSON. Prepared files live in
`WORKSPACE_DIR/.codebase-staging/<importId>`, outside startable session roots.
A publication journal spans workspace rename and session metadata. Active jobs
participate in maintenance drain/shutdown; idle selection dialogs do not block an
update. Restart resolves committed publications and interrupts unfinished work.

Consistent backups include analyses, tour state, encrypted credentials and durable
action receipts. Temporary ZIP/Git payloads, manifests and workspace staging are
excluded. After restore an unfinished selection with omitted source expires and
requires another import. No model request, install or execution is replayed.
Session deletion blocks new work, cancels analysis, stops processes, and creates
the existing private deletion backup before removing active data. Demo sessions
are listed and retained independently. File deletion uses the existing workspace
backup/version behavior. Backups and previously transmitted provider data can
still contain copies; deletion is not a promise of erasure from every location.

## Verification

Run the ordinary unit, browser, catalog and formatting checks described in the
repository guidelines. New focused suites are `tests/codebase-imports.test.js`,
`tests/codebase-analysis.test.js`, `tests/git-imports.test.js`,
`tests/isolated-demos.test.js` and `tests/e2e/codebase.spec.js`.
`tests/docker/codebase.mjs` adds authenticated import, persistence, backup/restore
and lifecycle acceptance in disposable Compose projects. It accepts exact
`STERRACODE_TEST_APP_IMAGE` and `STERRACODE_TEST_RUNNER_IMAGE` identities.
Require Docker with `STERRACODE_DOCKER_REQUIRED=1` when collecting acceptance.
The seeded analysis artifact in that smoke verifies storage/restore, not provider
generation; mocked provider tests cover the manual generation contract.

See [the acceptance record](../docker/ABNAHME.md) for actual platform results and
remaining release gates. Native ARM64, macOS/Windows Desktop, all optional runtimes,
provider accounts and representative beginner usability must not be inferred from
a Linux/AMD64 smoke or a passing Compose configuration check.
