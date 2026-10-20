# Nachvollziehbare i18n-Inventarzuordnung

Dieser Bericht ergänzt den unveränderten Auditor. Er setzt keine `config.exceptions`, akzeptiert keine Befunde und behauptet keine statische Vollständigkeit dynamischen Codes. Die Referenzen verweisen auf Literal-IDs und originale Befundfingerprints in den drei Eingabedateien. **Textgleichheit mit einem Katalog ist kein Zuordnungskriterium.**

Erneuter Aufruf nach dem finalen Audit: `node scripts/review-i18n.mjs`. Die Ausgabe ist bei gleichen Eingaben und Quellen deterministisch. Quellhashabweichungen bleiben sichtbar und dürfen nicht als abgeschlossene aktuelle Quellprüfung ausgegeben werden.

## Ergebnis

- 38980 Literalquellen, 12290 Befunde und 546 einzeln referenzierte dynamische Grenzen.
- 0 Literalquellen ohne hinreichenden Herkunftsbeleg.
- 0 physische Quellen mit verändertem/fehlendem Quellhash gegenüber dem Audit.
- Auditorannahmen, offene Befunde und angenommene Ausnahmen bleiben unverändert; akzeptierte Auditbefunde: 0.

| Kategorie | Literale | Befunde |
| --- | ---: | ---: |
| Übersetzungskatalog | 3774 | 547 |
| gebundener Katalogtext oder Kompatibilitätsfallback | 560 | 505 |
| technischer Vertrag | 16971 | 3440 |
| Originaldaten | 118 | 12 |
| internes Promptmaterial | 617 | 547 |
| Testfixture | 14190 | 6006 |
| optionale Betriebsstufe | 2750 | 1233 |
| Ungeklärt | 0 | 0 |

## Belegarten

Gebundene Fallbacks benötigen einen nachprüfbaren AST-Coowner: `new AppError/RunnerError(message, status, code, {messageKey, params})`, ein Objekt mit eigenem Textfeld und zugehörigem Descriptorschlüssel oder benachbarte Zuweisungen an dasselbe Objekt im selben Block. HTML verwendet die tatsächlichen `data-i18n`-/Attributbindungen. Statische technische Rollen, Vergleichswerte und explizite Vertragsfelder werden getrennt ausgewiesen. Produktkataloge werden anhand ihres Ressourcenpfads erfasst, nicht anhand gleicher Formulierungen.

Dynamische Grenzen behalten pro Senke Quelldatei, Zeile, Ausgabebeschreibung, Ursachenliste, Quellausschnitt und referenzierten Herkunftsvertrag. `reviewed-runtime-contract` bedeutet eine überprüfte Laufzeitgrenze, keinen statischen Beweis aller möglichen Werte. Die Grenzen stehen vollständig in [zuordnung.json](zuordnung.json). Generische UI-/API-Helfer dürfen sowohl übersetzte Anwendungstexte als auch Originaldaten transportieren.

Die Inhalts-/Tutorverträge stehen in [INHALTE.md](INHALTE.md), die Server-/Runnerverbraucher in [SERVER-TEXTFLUESSE.md](SERVER-TEXTFLUESSE.md). Interne Prompt-/Snapshot-/Toolschemata werden nicht nachträglich in Modellhistorien übersetzt. Tests und optionale Betreiberstufe sind ausdrücklich getrennte Kategorien, keine stillen Ausnahmen.

## Ungeklärte Quellen

Die folgende Liste ist ein Arbeitsauftrag, keine pauschale Baseline. Für jede Stelle fehlt noch ein hinreichender Herkunfts-/Ausgabebeleg. Alle Einträge stehen mit vollständiger Literalreferenz im JSON.

| Quelle | Literal | Ausschnitt |
| --- | --- | --- |
