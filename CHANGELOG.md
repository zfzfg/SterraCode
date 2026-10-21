# Changelog

## 1.2.0 — 2026-10-21

- Introduce phase-scoped learning plan skills (`planCreationSkill` and `planContinuationSkill`) to guide AI tutor plan generation and continuation with a structured four-level progression (Level 1 basics, Level 2 practice, Level 3 deepening, Level 4 capstone project).
- Dynamically inject plan skills into the tutor system prompt only when a plan is actively requested (`create_plan` during onboarding or `continue_plan` upon plan completion) and automatically retire the skill once a plan is established, saving context tokens during normal conversation turns.
- Provide a standardized plan structure schema (8–12 topics, strictly ascending difficulty, action-oriented titles, kebab-case IDs, and task difficulty mapping) while honoring custom structure requests from the learner.
- Update `update_learning_plan` tool documentation to guide plan creation according to the system prompt guidelines and ensure progress state (`done`) is preserved across revisions.
- Add comprehensive test suite covering phase-scoped skill activation, continuation transitions, and prompt determinism without wasting snapshot tokens.

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
