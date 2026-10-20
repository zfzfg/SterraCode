# Tiefer i18n-Scan für SterraCode

Diese Werkzeuge prüfen fest eingebaute Texte und ihre Wege zu Ausgabestellen, ohne SterraCode oder untersuchten Quellcode auszuführen. Sie ergänzen den ersten wortbasierten Scanner unter `scripts/audit-i18n.mjs`. Die Anwendung selbst wird nicht übersetzt oder verändert.

## Starten

Die Produktumstellung ist inzwischen implementiert; der [Implementierungsbericht](../../docs/i18n/IMPLEMENTIERUNG.md) beschreibt die tatsächlich geprüften Laufzeitpfade. Der Auditor bleibt bewusst konservativ und unverändert sichtbar. Ergänzend prüfen `npm run check:i18n` die Katalog-/Meldungsverträge und `node scripts/review-i18n.mjs` die getrennte Inventarzuordnung nach einem aktuellen Vollscan. Letzteres setzt keine Auditor-Ausnahmen, behält Fingerprints und dynamische Grenzen und meldet veränderte Quellprüfsummen beziehungsweise ungeklärte Herkunft ausdrücklich.

`translationSignatures` in der Konfiguration beschreibt importierte Helfer mit anderer Argumentreihenfolge. Aktuell wird `t(locale, key, params)` aus `server/services/i18n.js` anhand des tatsächlichen Imports erkannt; der gewöhnliche Browseraufruf bleibt `t(key, params)`. Die eigene Regression prüft, dass die Locale nicht irrtümlich als Übersetzungsschlüssel behandelt wird.

Im Workspace-Hauptverzeichnis:

```powershell
npm run audit:i18n
npm run test:i18n-audit
```

Der Scan schreibt fünf Dateien unter [docs/i18n/deep](../../docs/i18n/deep):

| Datei                                                               | Inhalt                                                                                                                                                        |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [BERICHT.md](../../docs/i18n/deep/BERICHT.md)                       | Zusammenfassung und sämtliche Befunde mit Quelltext und Belegen.                                                                                              |
| [ZUSAETZLICHE-FUNDE.md](../../docs/i18n/deep/ZUSAETZLICHE-FUNDE.md) | Vergleich mit dem ersten Scan; bereits untersuchte Dateien, neue Quellen und eingebettete Inhalte getrennt.                                                   |
| [befunde.json](../../docs/i18n/deep/befunde.json)                   | Befunde, stabile Fingerprints, Ausgabestellen, Helfer und Übersetzungsaufrufe.                                                                                |
| [literale.json](../../docs/i18n/deep/literale.json)                 | Ungefiltertes Inventar aller extrahierten Textvorkommen, einschließlich kurzer/leerer Werte, technischer Tokens, expliziter Eigenschaftsnamen und Kommentare. |
| [coverage.json](../../docs/i18n/deep/coverage.json)                 | Untersuchte/ausgeschlossene Dateien, SHA-256, verwendete Parser, eingebettete Quellen, Laufzeitgrenzen und tatsächliche Analysefehler.                        |

Voraussetzungen sind die in `package.json` erlaubte Node-Version, die vorhandenen npm-Entwicklungsabhängigkeiten, Python 3 und PowerShell für die jeweiligen nativen Parser. Es werden keine neuen npm- oder Python-Pakete benötigt. Fehlt ein Parser, bleibt das ein sichtbarer Abdeckungsfehler mit Exitcode 2. `--scope product` benötigt derzeit keinen PowerShell-Parser, weil die Betriebsskripte dabei ausdrücklich ausgeklammert werden.

Weitere Aufrufe:

```powershell
# Oberfläche, Server und Runner prüfen, ohne vorhandene Berichte zu ersetzen
node tools/i18n/audit.mjs --scope product --no-report

# Zusätzlich Betreiber-/Installationspfade in einen eigenen Bericht schreiben
.\tools\i18n\run.ps1 --scope operations --output docs/i18n/deep-operations

# Erkannte Funktionen mit Ausgabepfaden auflisten
node tools/i18n/audit.mjs --list-helpers --no-report

# Strenger Migrationscheck: vorhandene harte Produkttexte führen aktuell zu Exit 1
npm run audit:i18n:strict -- --no-report

# Nur bestimmte Regeln für den Strict-Gate berücksichtigen
node tools/i18n/audit.mjs --only HARDCODED,FIXED_LOCALE --strict --no-report

# Alle Optionen
node tools/i18n/audit.mjs --help
```

`--only` begrenzt Auswahl/Zählung für den Gate; das vollständige Inventar und die Berichtsdateien behalten alle Befunde. `--scope` begrenzt dagegen die tatsächlich untersuchten Quellbereiche. Ohne `--no-report` werden die bekannten fünf Berichtsdateien im angegebenen Ausgabeordner ersetzt. Die alten Berichte des ersten Scans bleiben erhalten.

| Exitcode | Bedeutung                                                                       |
| -------- | ------------------------------------------------------------------------------- |
| 0        | Scan ausgeführt; ohne `--strict` dürfen dabei offene Befunde bestehen.          |
| 1        | Offene Befunde erfüllen die mit `--strict`/`--fail-on` gewählte Schwelle.       |
| 2        | Konfigurations-, Parser-, Lese- oder Analysefehler; keine vollständige Abnahme. |

## Was aus dem Java-Beispiel übernommen wurde

Die Auditsuite im Referenzprojekt `Event-PVP-Plugin-1.1.0-BetaPurpur/tools` diente als Entwurfsvorlage. Gelesen wurden insbesondere `README.md`, `AUDIT_DOKUMENTATION.md`, die Konfiguration, `detectors/hardcoded.py`, `resolvers.py`, `context.py`, `findings.py` sowie die Hardcode-Regressionstests. Das Referenzprojekt wurde weder verändert noch ausgeführt.

| Referenzansatz                                                       | Umsetzung hier                                                                                                                                                                              |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D6: direkte Nachrichten-Senken und registrierte eigene Wrapper       | Konfigurierbare Ausgabestellen plus Erkennung von DOM-Zuweisungen, Textattributen, Dialogen, Fehlern, API-Ausgaben und Konsole.                                                             |
| Helferketten statt bloßer Suche im selben Quelltextabschnitt         | JavaScript-Graph mit lexikalischen Scopes, lokalen Import-/Exportbindungen, Aliasen, Funktionsparametern, Rückgaben und Objekt-/Arrayprojektionen.                                          |
| Mehrzeilige und gemischte Anweisungen nicht pauschal ausschließen    | Echte ASTs; `t("key") + " fester Rest"` bleibt ein Befund. Kommentare sind eigene Knoten.                                                                                                   |
| D7: Resttexte neben bekannten Ausgabewegen prüfen                    | Vollinventar ohne Sprach-/Mindestlängenfilter; zusätzliche Prosa-/Einwortprüfung dient nur der Einordnung.                                                                                  |
| D1/D2/D4/D8/D9: Schlüssel, Rückfälle, Platzhalter und Bundle-Parität | JSON-Prüfungen für zukünftige i18next-Kataloge; aktuell als `not-present` ausgewiesen, solange Produktkataloge fehlen.                                                                      |
| Baseline/Fingerprints und begründete Ausnahmen                       | Fingerprints verwenden vollständigen Text und sind unabhängig von Zeilennummern. Ausnahmen benötigen einen konkreten Fingerprint und eine Begründung; akzeptierte Befunde bleiben sichtbar. |
| Regressionstests für bekannte Blindstellen                           | Eigene Vitest-Fixtures unter `tests/i18n-audit.test.js`, auch für CLI-Gates, Parsefehler, Sicherheitsgrenzen und Reproduzierbarkeit.                                                        |

Bewusst anders ist die Behandlung von Exceptions: Das Java-Beispiel nimmt Exception-Familien teilweise aus. SterraCode gibt `AppError`, `RunnerError`, `APIError` und verschiedene allgemeine Fehlermeldungen direkt weiter. Diese Texte werden hier erfasst. Auch die dortige Vorgabe für englische Konsolenmeldungen wurde nicht übernommen; Betreibertexte sind ein eigener Kanal für die spätere Sprachentscheidung.

## Analyse und Grenzen

### JavaScript

Der Babel-AST wird einmal je Quelle gelesen. Der Textgraph verbindet Literalquellen mit Variablen, importierten Funktionen, Rückgaben, Objektfeldern, Arrayelementen, Destrukturierung, `for … of`, `map`/`flatMap` und ausgewählten Stringoperationen. Auch eigene Ausgabehelfer lassen sich dadurch über mehrere Dateien verfolgen. Feste Laufzeit-/Statuskennungen und unübersetzte Labels bleiben im Inventar unterscheidbar.

Die Analyse ist **konservativ und kontextunabhängig**: Unterschiedliche Aufrufe einer Funktion liefern zusammen mögliche Parameterwerte. `possible-call-union` bedeutet deshalb eine mögliche Verbindung, keine bewiesene Ausführung. Solche indirekten Flüsse werden als Warnungen behandelt. Ein direkter syntaktischer/static-flow-Beleg kann die Priorität erhöhen. Die vollständige Unsicherheitsmarkierung bleibt erhalten, auch wenn der angezeigte Belegpfad gekürzt wird.

Es gibt keine Behauptung, beliebigen dynamischen JavaScript-Code perfekt statisch entscheiden zu können. Unter anderem bleiben unbekannte Bibliotheksaufrufe, Reflection, dynamische Imports, nicht modellierte Methoden, Browser-/Nutzerdaten, Exceptions über unbekannte Callbackpfade und komplexe Alias-/Kontrollflusskorrelationen Laufzeitgrenzen. Ein Text kann sowohl eine eigene Erklärung als auch technische Originaldaten darstellen. Diese Zuordnung muss überprüft werden.

### Weitere Formate und eingebetteter Code

- **HTML/SVG:** parse5 liest sichtbare Texte, zugängliche Attribute und Dokumentensprache. Inline-JavaScript/-CSS wird mit dem passenden Parser weiter untersucht. `data-i18n`-Defaults bleiben als gebundene Grundtexte erhalten und erzeugen Schlüsselreferenzen.
- **CSS:** css-tree unterscheidet sichtbares `content` von Fonts, Selektoren und anderen technischen Strings.
- **JSON:** Dekodierte Stringtokens, Feldpfade und doppelte Schlüssel werden erfasst; ein gewöhnliches `JSON.parse()` allein würde Duplikate verdecken.
- **YAML:** Der vorhandene Prettier-YAML-Parser verarbeitet auch Blockskalare und dekodierte Quotes. Compose-Fehlertexte innerhalb von `${…}` erscheinen als eigene Prüfregel.
- **Python:** Das Python-`ast`-Modul liest Konstanten, f-Strings, Ausnahmetexte, Datenfelder und direkte Ausgabeaufrufe. Es importiert die untersuchten Python-Dateien nicht. Eine JavaScript-gleichwertige interprozedurale Python-Analyse wird nicht behauptet.
- **PowerShell:** Der native PowerShell-Parser liest Zeichenketten, Here-Strings, Kommentare und Ausgabe-/Throw-Kontext. Die Quelltexte kommen über stdin als Daten; es wird nichts dot-gesourct. Erweiterbare Zeichenketten werden von bloßen Variablennamen unterschieden. Auch hier gibt es keine vollständige interprozedurale Textflussanalyse.
- **Bash, Batch, C und Direktiven:** Quote-/kommentarbewusste lexikalische Erfassung, Heredocs und erkennbare unquotierte Ausgaben. Diese Dateien sind ausdrücklich `lexical-coverage`, kein vorgetäuschter AST-/Datenflussbeweis. Unquotierte Zuweisungen, beliebige Shellgrammatik und eigene Shellwrapper können zusätzliche manuelle Prüfung benötigen.
- **Vorlagen:** Statische HTML/CSS/JS/Python-Quelltexte in bekannten `files[].content`-Strukturen sowie erkennbare `node -e`-Inhalte werden ohne Ausführung rekursiv geparst. Dynamische Vorlagen werden als offene Abdeckungsstelle dokumentiert. Virtuelle Dateinamen behalten die Zuordnung zur physischen Quellstelle.

Alle extrahierten Werte bleiben gespeichert, auch wenn sie technisch, einsprachig unverändert, unaufgelöst oder nicht für eine Übersetzung geeignet sind. Bei den lexikalischen Formaten ist die Extraktionsgrenze selbst Teil des Berichts. Die Spracheinschätzung ist lediglich ein Hinweis und entscheidet nicht, ob ein Wert im Inventar verbleibt.

### Katalogprüfung für die spätere Implementierung

Unter den in `config.json` angegebenen Katalogwurzeln werden `de`, `en` und `es` nach Namensräumen verglichen. Geprüft werden fehlende/zusätzliche Schlüssel, leere/TODO-Werte, doppelte JSON-Schlüssel, Platzhalter, Aufrufparameter und passende Pluralformen. Spanisch kann insbesondere `_many` benötigen. Singular und Plural dürfen unterschiedliche Platzhalter besitzen, wenn die entsprechende deutsche Ausgangsform dies ebenfalls tut.

Statische `t()`-/`i18n.t()`- und HTML-Schlüssel werden mit den Ressourcen abgeglichen. Ein fehlendes `count`, unübergebene Platzhalter und einfache Helfer, die ihren Schlüssel als Fallback zurückgeben, sind eigene Regeln. Dynamische Schlüssel/Optionen sind ausdrücklich nicht vollständig aufgelöst. `POSSIBLY_UNUSED_KEY` ist keine Löschfreigabe. Übersetzungsgleichheit mit Englisch ist ein Prüfhinweis und kein automatischer Beweis einer falschen Übersetzung.

Test-Fixtures und testinterne Helfer namens `t()` werden nicht als Live-Katalogverbraucher der Anwendung ausgegeben. Ohne echte Anwendungskataloge gibt es **keinen bestandenen Paritätstest**, sondern `not-present`.

## Regeln und Einordnung

| Regelgruppe                                             | Bedeutung                                                                                                       |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `HARDCODED`                                             | Literalquelle mit registriertem Ausgabepfad; direkte Produktpfade kritisch, unsichere Helferflüsse Warnung.     |
| `SCHEMA_TEXT`                                           | Möglicher Text in einem Objekt-/API-Datenfeld; allein kein Beweis einer UI-Ausgabe.                             |
| `CONTENT`                                               | Mitgelieferte Prompts, Quellvorlagen und Testwerte; Sprache und fachlichen Vertrag getrennt beurteilen.         |
| `INVARIANT_DISPLAY`                                     | Explizit begründete unveränderte Bezeichnungen, etwa Produkt-/Programmiersprachnamen; sichtbar als Information. |
| `FIXED_LOCALE`                                          | Feste Zahlen-/Datumsformatierung beziehungsweise Dokumentensprache; interne Logik von UI unterscheiden.         |
| `PROSE_REVIEW`, `LITERAL_REVIEW`                        | Noch nicht anders zugeordnete Literale; die Wortheuristik sortiert nur, sie entfernt nichts.                    |
| `CONFIG_INTERPOLATION`                                  | Mögliche eigene Betreibertexte in Konfigurationsinterpolation.                                                  |
| `CATALOG_*`, `MISSING_KEY`, `DUPLICATE_KEY`             | Struktur, Inhalte, Varianten und referenzierte Schlüssel der Kataloge.                                          |
| `CALL_PLACEHOLDERS`, `PLURAL_COUNT_MISSING`             | Fehlerhafte statische Übersetzungsaufrufe.                                                                      |
| `KEY_FALLBACK`                                          | Helfer kann einen rohen Schlüssel als sichtbaren Fallback liefern.                                              |
| `DYNAMIC_KEY`, `DYNAMIC_OPTIONS`, `POSSIBLY_UNUSED_KEY` | Nicht bewiesene Schlüsselauflösung/-nutzung.                                                                    |
| `STALE_EXCEPTION`                                       | Eine gespeicherte Ausnahme passt zu keinem aktuellen Befund mehr.                                               |

Ein Literal kann mehrere Ausgabekanäle erreichen. Deshalb sind Befundzahl, Zahl verschiedener Literalquellen und spätere Übersetzungsschlüssel **unterschiedliche Größen**. Die Ausgaben enthalten ausdrücklich keine „100 % übersetzt“-Kennzahl.

## Konfiguration und begründete Ausnahmen

[config.json](config.json) enthält Quellwurzeln, Ausgabeaufrufe mit Argumentpositionen, Textfelder/-attribute, Katalogkonventionen, bekannte unveränderte Namen und endliche Analysebudgets. Neue projektspezifische Helfer lassen sich registrieren. Ein Name allein beweist seine Semantik nicht; die Konfiguration ist deshalb Teil der zu überprüfenden Analyseannahmen.

Eine konkrete, überprüfte Ausnahme sieht beispielsweise so aus:

```json
{
  "fingerprint": "vollständiger SHA-256-Fingerprint aus befunde.json",
  "reason": "Technisches Ausgabeformat; muss für den dokumentierten Parser bytegleich bleiben."
}
```

Sie wird ausdrücklich unter `exceptions` eingetragen. Es gibt keinen automatisch akzeptierten Schuldenstand, keine pauschalen Exception-Ausschlüsse und keine unterdrückende Behandlung bloßer `i18n-ignore`-Kommentare aus dem Java-Beispiel. Veraltete Ausnahmefingerprints werden gemeldet. Die Standardkonfiguration hat keine akzeptierten Befunde.

Die Budgets begrenzen Auflösungsdurchgänge, Rekursionstiefe und besuchte Graphknoten. Erreichte Budgets sind Analysefehler mit Exit 2; sie werden nicht in einen scheinbar erfolgreichen Nullbefund umgewandelt.

## Dateien und Verifikation

| Modul                                         | Aufgabe                                                                   |
| --------------------------------------------- | ------------------------------------------------------------------------- |
| `audit.mjs`, `run.ps1`                        | CLI und PowerShell-Start.                                                 |
| `sources.mjs`                                 | Sichere Dateiauswahl einschließlich unversionierter Quellen.              |
| `javascript.mjs`                              | Babel, Scopes, Importbindungen, Textgraph, Ausgabestellen und Helfer.     |
| `formats.mjs`                                 | HTML, CSS, JSON, YAML, lexikalische Formate und native Parser-Anbindung.  |
| `extract-python.py`, `extract-powershell.ps1` | Ausschließlich Parsing über stdin; keine Ausführung untersuchter Dateien. |
| `catalogs.mjs`                                | Katalog-/Schlüssel-/Platzhalterprüfung.                                   |
| `model.mjs`                                   | Inventar, Befundmodell, Priorität und Fingerprints.                       |
| `core.mjs`, `report.mjs`                      | Ablauf, Einordnung, Vergleich und Berichte.                               |
| `tests/i18n-audit.test.js` im Workspace       | Unabhängige Regressionen mit temporären synthetischen Projekten.          |

Die Dateiauswahl folgt keinen Symlinks/Junctions und liest keine persönlichen `server/data`-Workspaces, echten `.env`-Dateien, Secrets oder Abhängigkeiten. Berichte dürfen nur unterhalb der ausgewählten Projektwurzel geschrieben werden; Verzeichnis-/Dateilinks als Ausgabeziel werden abgewiesen. Es werden keine Dienste, Container oder Programme der Anwendung gestartet.

Reproduzierbare Berichte enthalten keine wechselnden Zeitstempel. Quellprüfsummen und das vollständige Literalinventar machen die Eingaben nachvollziehbar. Parser-/Analyseerfolg und bestandene Werkzeugtests ersetzen die spätere Laufzeitprüfung der tatsächlichen Oberfläche nicht.
