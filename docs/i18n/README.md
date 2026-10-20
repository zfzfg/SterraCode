# Internationalization

Release 1.1.0 supports English, German, and Spanish. **English is the default for fresh browser profiles, settings, and new sessions.** Existing saved browser choices are retained. Browser/OS language does not silently change the interface.

## Independent language values

- `uiLocale`: browser/origin-local interface selection under `sterracode.uiLocale`. Restricted storage uses current-tab history state.
- `session.tutorLocale`: language for future tutor output; new sessions inherit interface selection. Old sessions migrate once to `null`, preserving historical user-language behavior.
- `session.language`: programming language, not human language.
- `contentLocale` and validated provenance: language used when a new template/offline task was materialized. Existing files, tasks, chats, suite digests, and literal test values are not subsequently translated.

`shared/i18n/locale.js` owns supported/default locales, native names, directions, format locales, and Monaco NLS. A new language needs a registry entry, complete catalogs, and tests. English uses Monaco `i-default`. German remains the secondary catalog/bootstrap fallback and historical catalog comparison base. Historical low-level template defaults remain German for compatibility; interactive new content explicitly supplies its selected language.

## Initialization and safe switching

The app serves pinned i18next 26.5.3, the registry, and catalogs locally through allowlisted routes, without a build step or translation CDN. Catalogs load before login/setup and Monaco. Static HTML is English; a loading state prevents mixed startup. A deliberately trilingual emergency message covers catalog failure.

Language changes check active chat/mutations/tests/traces, terminal input/processes, previews, package jobs, and unfinished dialogs. Editor models save using expected versions; conflicts abort. Controlled reload restores session/file, selection/scroll, drafts, layout, and existing terminal identity. Commands, stdin, output, passwords, and provider keys are not stored/replayed. Temporary restore failures retain recovery markers; expired work is shown explicitly.

## Server, runner, and data

REST/SSE sends `Accept-Language`. Translators are request-scoped, never globally switched. Own messages add `messageKey` and safe scalar `params`, retaining status/code. Parameters are not merged into translation-engine options. Output uses text nodes/approved attributes, not executable HTML.

The runner has no i18next dependency. It emits descriptors/phases while native package logs, compiler output, and learner text remain original. Python markers and serialized preview messages have explicit ownership. Local Python uses UTF-8 matching the pipe decoder on Windows. Both images include shared contracts.

Workspace schema remains 2, with independent `localeSchemaVersion: 1`. Known application questions use provenance/stable option IDs validated against the stored question. Future LM Studio/OpenAI prompts honor tutor language, including after compaction, without rewriting custom instructions or triggering an answer merely because the UI changed.

## Checks and reports

```sh
npm run check:i18n
npm run test:i18n-audit
npm run audit:i18n
node scripts/review-i18n.mjs
npm test
npm run test:e2e
```

Catalog checks cover missing/extra/empty/duplicate keys, placeholders, calls/descriptors, and plural categories including Spanish `many`. A fourth test locale verifies extensibility. Independently written browser expectations cover fresh English, authentication, recovery, Monaco, proposals, runtime consumers, real Python exercises/traces, reviews, and layouts.

The [audit tools](../../tools/i18n/README.md) retain all literals, hashes, fingerprints, uncertainty, and dynamic boundaries. The [separate provenance ledger](ZUORDNUNG.md) does not suppress findings; `reviewed-runtime-contract` is not a static completeness claim.

Detailed historical implementation reports remain German: [implementation](IMPLEMENTIERUNG.md), [content/tutor](INHALTE.md), [server flows](SERVER-TEXTFLUESSE.md), [glossary](GLOSSAR.md). Their planning-era German default is superseded by release 1.1.0, without rewriting old evidence. Actual deployment/platform results are in [acceptance records](../../docker/ABNAHME.md).
