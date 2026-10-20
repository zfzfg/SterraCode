# Changelog

## 1.1.0 — 2026-10-20

- Add English, German, and Spanish product modes, including setup/sign-in, accessible labels, Monaco, REST/SSE, runner progress, Python helpers, and preview diagnostics.
- Default fresh browsers/settings/sessions to English while preserving saved language choices, custom prompts, original conversations/source, and legacy content contracts.
- Safely reload language changes with saving, draft/view recovery, and active-work guards; never replay commands/stdin.
- Separate interface, tutor, programming, and materialized content languages; add provenance/migration and localized templates/offline reviews without changing test values or hashes.
- Preserve native logs and Unicode Python output over Windows pipes.
- Add catalog/descriptor/provenance checks and expanded tests without suppressing audit findings.
- Maintain user, operations, runner, and i18n documentation in English by default, retaining German historical guides.
- Version app/runner images, installer/admin references, and container fixtures together as 1.1.0.

See [acceptance records](docker/ABNAHME.md) for actual validation/deployment evidence and limitations.
