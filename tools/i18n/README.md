# SterraCode internationalization audit

These tools inspect literal text and possible output paths without starting SterraCode or executing inspected source. They complement the original word-based `scripts/audit-i18n.mjs`. Product localization is implemented; see the [English architecture guide](../../docs/i18n/README.md). The [German historical tool guide](README.de.md) remains available.

## Commands and outputs

Run from the repository root:

```sh
npm run audit:i18n
npm run test:i18n-audit
npm run check:i18n
node scripts/review-i18n.mjs
```

The full scan writes five artifacts to `docs/i18n/deep`: `BERICHT.md` (findings/evidence), `ZUSAETZLICHE-FUNDE.md` (comparison with the original scan), `befunde.json` (findings/fingerprints), `coverage.json` (sources/parsers/limits/runtime boundaries), and `literale.json` (unfiltered inventory). Existing planning reports remain historical references. Report names and source snippets retain their original language.

```powershell
.\tools\i18n\run.ps1 --scope product --output docs/i18n/deep-product
.\tools\i18n\run.ps1 --scope operations --output docs/i18n/deep-operations
```

```sh
node tools/i18n/audit.mjs --list-helpers --no-report
npm run audit:i18n:strict -- --no-report
node tools/i18n/audit.mjs --only HARDCODED,FIXED_LOCALE --strict --no-report
node tools/i18n/audit.mjs --help
```

`--only` limits gate selection/counting, while the full inventory/reports retain all findings. `--scope` changes inspected source areas. Without `--no-report`, the five output files are replaced. Strict mode can fail on reviewed compatibility/technical literals; it is not a translation-percentage gate.

| Exit | Meaning                                                               |
| ---- | --------------------------------------------------------------------- |
| 0    | Scan completed; open findings are allowed without strict mode         |
| 1    | Open findings reach the configured strict/fail threshold              |
| 2    | Configuration, parser, read, or analysis error; incomplete acceptance |

## Analysis model and limits

Babel parses each JavaScript source once. A bounded graph connects literals to lexical variables, local imports/exports, aliases, parameters, returns, object/array fields, destructuring, loops, map/flatMap, and selected string operations. Helper flows can cross files. Technical runtime/status identifiers remain distinguishable from labels.

Analysis is **conservative and context-insensitive**. Separate calls can contribute alternative parameter values. `possible-call-union` is a possible connection, not proof of execution. Indirect flows retain warnings/uncertainty even when the displayed evidence path is shortened. Unknown libraries, reflection, dynamic imports, complex alias/control-flow correlations, callbacks, exceptions, and user/browser input remain explicit runtime boundaries. Successful parsing or a low finding count does not prove complete localization.

| Format                  | Coverage                                                                                                                                  |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| HTML/SVG                | parse5 text/accessibility attributes, document language, bindings; embedded JS/CSS recursively parsed                                     |
| CSS                     | css-tree distinguishes visible content from selectors/fonts/technical values                                                              |
| JSON                    | Decoded tokens, field paths, duplicate keys; ordinary JSON.parse alone is insufficient                                                    |
| YAML                    | Structured Prettier parser, block scalars/quotes, Compose interpolation diagnostics                                                       |
| Python                  | Native ast constants/f-strings/exceptions/output, without importing sources; no claim of JS-equivalent interprocedural analysis           |
| PowerShell              | Native parser over stdin data, including here-strings/comments/throw/output; nothing is dot-sourced                                       |
| Bash/Batch/C/directives | Quote/comment-aware lexical extraction, heredocs/recognizable output; explicitly lexical coverage rather than a claimed AST proof         |
| Templates               | Recognized static files[].content and node -e sources recursively parsed, without execution; dynamic templates remain coverage boundaries |

Every extracted value stays in the inventory, including technical, unchanged, unresolved, and non-translatable values. Language hints influence review priority only, never inventory inclusion. Lexical formats need additional manual review where grammar/wrapper behavior is not modeled.

## Catalog and call contracts

`config.json` describes sources, sinks/argument positions, text fields/attributes, namespace roots, invariant names, finite budgets, and explicit exceptions. `translationSignatures` recognizes imported server `t(locale, key, params)` by its actual import, separately from browser `t(key, params)`. A regression prevents interpreting the locale as a key.

Catalogs are compared across de/en/es for missing/extra/empty/TODO keys, duplicates, placeholders, call parameters, and locale-specific plural variants, including Spanish `many`. German remains the historical **catalog comparison base**, while **English is the fresh UI default**. These are separate contracts. Static calls and HTML bindings are checked; dynamic keys/options are not fully decidable. `POSSIBLY_UNUSED_KEY` does not authorize deletion. Equal wording across languages is a review hint, not automatic failure. Without catalogs, status is `not-present`, not a passed parity test; current product catalogs are `checked`.

`npm run check:i18n` gates catalog/call/descriptor contracts without hiding ordinary audit findings. `node scripts/review-i18n.mjs` separately records literal and dynamic-path provenance. It preserves fingerprints/findings and returns errors for unresolved origins or stale source hashes. `reviewed-runtime-contract` does not claim static completeness of all possible values. Text equality with a catalog is not provenance evidence.

## Rules and exceptions

| Rule group                                          | Meaning                                                                                                         |
| --------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| HARDCODED                                           | Literal reaching a registered sink; direct product paths and uncertain helper flows retain different priorities |
| SCHEMA_TEXT / CONTENT                               | Possible display fields or shipped content; independently review ownership and technical contracts              |
| INVARIANT_DISPLAY / FIXED_LOCALE                    | Explicitly justified unchanged names or fixed formatting/document locale                                        |
| PROSE_REVIEW / LITERAL_REVIEW                       | Remaining review inventory; word hints never remove values                                                      |
| CONFIG_INTERPOLATION                                | Possible operator messages in configuration                                                                     |
| CATALOG_* / MISSING_KEY / DUPLICATE_KEY             | Catalog structure/content/variants/references                                                                   |
| CALL_PLACEHOLDERS / PLURAL_COUNT_MISSING            | Invalid static call contracts                                                                                   |
| KEY_FALLBACK                                        | Helper may expose a raw key                                                                                     |
| DYNAMIC_KEY / DYNAMIC_OPTIONS / POSSIBLY_UNUSED_KEY | Unproven resolution/use                                                                                         |
| STALE_EXCEPTION                                     | Saved exception no longer matches current evidence                                                              |

The suite adapts sink/wrapper, helper-chain, rest-literal, and fingerprint ideas from the Event-PVP reference audit. Unlike exception-family exclusions in that reference, SterraCode audits AppError/RunnerError/APIError because they reach users. Operator texts are a separate channel, not assumed to be English UI.

An exception requires an exact fingerprint and a concrete, reviewable reason. It is registered in `exceptions`; accepted findings remain visible. There is no automatically accepted debt baseline, blanket exclusion, or suppressing treatment of `i18n-ignore` comments. The default configuration accepts no findings. Exhausted budgets produce exit 2 rather than a false clean result.

## Safety and reproducibility

`sources.mjs` selects tracked/untracked sources safely; `javascript.mjs` owns AST/graph analysis; `formats.mjs` handles other formats and native parsers; `catalogs.mjs` checks catalogs; `model.mjs`, `core.mjs`, and `report.mjs` assemble evidence. `extract-python.py` and `extract-powershell.ps1` parse stdin only. Independent synthetic-project regressions live in `tests/i18n-audit.test.js`.

Selection does not follow symlinks/junctions or read personal workspaces, real `.env`, secrets, dependencies, or generated test results. Output must stay below the selected root; linked output files/directories are rejected. No application, container, or inspected program is started. Reports have no changing timestamps and retain source hashes. Static analysis and tool tests complement rather than replace runtime/UI acceptance.
