# Plan: SterraCode auf Deutsch, Englisch und Spanisch umstellen

**Release 1.1.0:** Die spätere Benutzerentscheidung setzt Englisch als Standard für neue Browser und Neuinstallationen. Gespeicherte Sprachwahlen bleiben erhalten; Deutsch bleibt sekundärer Katalog-/Bootstrap-Rückfall. Nachfolgende Aussagen zum ursprünglich geplanten deutschen Standard sind historisch. Aktuelle englische Dokumentation: [i18n overview](docs/i18n/README.md).

Stand: **20.10.2026**. Untersuchte Ausgangsrevision: `ffb1adb5cff42bc6d3a7d03bae8b1d0ad615325f`.

**Implementierungsstand 20.10.2026:** Die Produktumstellung auf Deutsch, Englisch und Spanisch ist implementiert. Der ursprüngliche Plan und seine historischen Scanwerte bleiben nachfolgend als Referenz erhalten. Architektur, Datenverträge und tatsächlich ausgeführte Prüfungen stehen in [IMPLEMENTIERUNG.md](docs/i18n/IMPLEMENTIERUNG.md); die abschließende Verifikation wird dort und in [docker/ABNAHME.md](docker/ABNAHME.md) festgehalten. Die optionale Betreiber-/Dokumentationsübersetzung bleibt eine gesonderte Etappe.

| Etappe       | Erreichter Stand                                                                             | Nachweis                                                                                                                            |
| ------------ | -------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| 0            | Inventar nach Herkunft zugeordnet, dynamische Grenzen einzeln dokumentiert, Begriffe geprüft | [Zuordnung](docs/i18n/ZUORDNUNG.md), [Glossar](docs/i18n/GLOSSAR.md)                                                                |
| 1            | Registry, i18next, lokale Kataloge, Bootstrap, Einrichtung/Login und Vertragscheck           | `i18n-core`, `i18n-check`, `i18n-api`, `i18n-bootstrap`, `i18n-auth-proposals`                                                      |
| 2            | Sicherer Reload mit Entwürfen und Versionsschutz, Storage-/Katalogfallback, Monaco-NLS       | `i18n.spec.js`, `i18n-workspace.spec.js`                                                                                            |
| 3            | Produktmodule, ARIA, Dialoge, Zahlen/Datum und Zustände lokalisiert                          | [Implementierungsbericht](docs/i18n/IMPLEMENTIERUNG.md), `i18n-features`, `i18n-long`                                               |
| 4            | REST/SSE, Runnerphasen/-fehler, Pythonmarker und Vorschau-Bridge                             | [Textflüsse](docs/i18n/SERVER-TEXTFLUESSE.md), API-/Runner-/Transporttests, `i18n-runtime`                                          |
| 5            | Separate Tutor-/Inhaltssprache, Migration, Optionskennungen, Vorlagen und Import/Export      | [Inhalte](docs/i18n/INHALTE.md), `i18n-content`, `i18n-learning`                                                                    |
| 6            | Übersetzungsreview und lokale Regression-/Browser-/Layoutabnahme; beide Dockerfiles ergänzt  | [Prüfergebnisse und Grenzen](docs/i18n/IMPLEMENTIERUNG.md); Dockerbuild tatsächlich versucht, mangels Linux-Daemon nicht ausführbar |
| 7 (optional) | Installer-/CLI- und Dokumentationsübersetzung bleibt späterer Umfang                         | Kein Bestandteil der Produktsprachabnahme                                                                                           |

## Historischer Planungsnachtrag: vertiefter Scan und Werkzeugordner

Der Folgescan vom 20.10.2026 ist unter [tools/i18n](tools/i18n/README.md) dokumentiert. Als Vorbild diente die Java-Auditsuite des genannten Event-PVP-Plugins; die Umsetzung hier verwendet passende JavaScript-, HTML-, CSS-, YAML-, JSON-, Python- und PowerShell-Parser sowie ausdrücklich begrenzte lexikalische Prüfungen.

Der damalige tiefe Ausgangsscan erfasste **204 physische Quelldateien**, **25 eingebettete Quellen** und **24.745 extrahierte Text-/Literalvorkommen einschließlich technischer Werte, Eigenschaftsnamen und Kommentare**. Er enthielt zusätzlich zu direkten Ausgaben auch Verbindungen über Variablen, Scopes, Importe, Helfer, Rückgaben und Objekt-/Arraytabellen. Der damalige Vergleich mit dem ersten Scan wies **724 zusätzliche physische Ausgabetext-Fundstellen in bereits vorher geprüften Dateien** aus; das war keine Zahl bestätigter neuer Übersetzungsschlüssel. [Bericht](docs/i18n/deep/BERICHT.md) und [Vergleich](docs/i18n/deep/ZUSAETZLICHE-FUNDE.md) werden durch den Abschlussaudit auf den Implementierungsstand aktualisiert.

Diese damalige Vollprüfung lief ohne Parser-/Analysefehler und ohne ausgeschöpfte Graphbudgets. **42 Werkzeug-Regressionstests** bestanden. Offen ausgewiesen waren **12 nur lexikalisch geprüfte Dateien** und **498 Ausgabepfade mit zumindest teilweise dynamischen Daten**. Vollständige statische Entscheidbarkeit beliebigen Programmcodes wurde und wird nicht behauptet. Die Katalogprüfung stand vor der Implementierung auf `not-present`; der aktuelle Stand ist `checked` und besitzt eine zusätzliche Serversignaturregression.

Für die weitere Implementierung gelten der tiefe Bericht, das [ungefilterte Literalinventar](docs/i18n/deep/literale.json) und die [Abdeckungsdaten](docs/i18n/deep/coverage.json) als ergänzende Arbeitsgrundlage. Die nachfolgenden Zahlen und Tabellen des ersten Scans bleiben als historische Bestandsaufnahme erhalten. Erneute Aufrufe: `npm run audit:i18n` und `npm run test:i18n-audit`. Produktivfunktionen wurden durch die Scanwerkzeuge nicht umgestellt.

## 1. Ziel und grundlegende Entscheidungen

SterraCode erhält drei wählbare Oberflächensprachen: **Deutsch (`de`), English (`en`) und Español (`es`)**. Deutsch bleibt Standard und Rückfallsprache. Eine weitere Sprache soll später durch einen Registry-Eintrag, ihre Kataloge und entsprechende Prüfungen hinzukommen können, ohne neue Sprachbedingungen in sämtlichen Funktionen einzubauen.

Die Umstellung umfasst die Oberfläche einschließlich Login/Ersteinrichtung, zugängliche Beschriftungen, Dialoge, Statusanzeigen, eigene Fehlermeldungen, Lernhilfen, mitgelieferte Aufgaben und Projektvorlagen. Die vom Nutzer gewünschte Tutorsprache wird gesondert behandelt. Fremde Programmausgaben, vorhandener Quellcode, persönliche Texte und alte Chatantworten bleiben Originaldaten.

| Thema                  | Entscheidung für die Umsetzung                                                                                                                              |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Übersetzungsbibliothek | **i18next**, mit semantischen Schlüsseln und JSON-Katalogen. Keine eigene Plural- oder Übersetzungsengine entwickeln.                                       |
| Frontend               | Bestehende ES-Module und DOM-Helfer beibehalten; kein Frameworkwechsel und kein neuer Frontend-Build erforderlich.                                          |
| Auslieferung           | Bibliothek und Sprachdateien ausschließlich vom eigenen Server ausliefern. Keine CDN-Abhängigkeit beim Programmstart.                                       |
| Standard               | Ohne gespeicherte Auswahl weiterhin Deutsch. Die Browsersprache stellt bestehende Installationen nicht ungefragt um.                                        |
| Oberflächensprache     | Pro Browserprofil/Origin speichern; nicht in die für alle Geräte gemeinsamen KI-Einstellungen schreiben.                                                    |
| Tutorsprache           | Bei neuen Sessions aus der gewählten Oberflächensprache übernehmen; danach als eigene Sessioneinstellung speichern.                                         |
| Sprachwechsel          | Für die erste Version kontrolliertes Neuladen nach Sicherung und Zustandsprüfung, damit auch die Monaco-Menüs zuverlässig wechseln. Details in Abschnitt 5. |
| Fehlermeldungen        | Stabile Fehlercodes beibehalten; zusätzlich Übersetzungsschlüssel und sichere Parameter transportieren.                                                     |
| Runner                 | Sprachneutrale Meldungsbeschreibungen liefern. Keine i18next-Abhängigkeit im schlanken Runner erzwingen.                                                    |
| Datenbestand           | Bestehende Sessions und Projekte weiter öffnen; Anzeigeübersetzungen ändern keine Prüfsummen, Dateiversionen oder Testergebnisse.                           |
| Englisch/Spanisch      | Verständliche, direkte Ansprache; neutrales Spanisch mit konsistenter `tú`-Ansprache. Regionalformen bei Bedarf später ergänzen.                            |
| Betriebsskripte        | Vollständig im Inventar erfasst; ihre Übersetzung ist eine gesonderte, optionale Ausbaustufe.                                                               |

i18next unterstützt die hier benötigten ES-Modul-/Node-Varianten, Namensräume und Sprachrückfälle. Diese Fähigkeiten sind in der offiziellen Dokumentation beschrieben: [Einbindung](https://www.i18next.com/overview/getting-started), [Namensräume](https://www.i18next.com/principles/namespaces), [Fallback](https://www.i18next.com/principles/fallback). Die konkrete Version wird zu Implementierungsbeginn geprüft, festgeschrieben und im Lockfile gesichert.

## 2. Ergebnis der Bestandsaufnahme

### 2.1 Dateien und Größenordnung

Die Prüfung arbeitet auf den versionierten Dateien und dem tatsächlichen Inhalt des Arbeitsverzeichnisses. Sie berücksichtigt **207 Quell-/Konfigurationsdateien** und indexiert zusätzlich **15 Dokumentationsdateien**. JavaScript wurde in **167 Dateien** mit einem AST-Parser untersucht; HTML/SVG, CSS und Python wurden ebenfalls strukturell gelesen. Es gab **keinen Parserfehler**.

| Bereich                              | Prüfkandidaten | Davon mit deutschem Wort-/Umlautsignal | Dateien mit Kandidaten |
| ------------------------------------ | -------------: | -------------------------------------: | ---------------------: |
| Browseroberfläche                    |            904 |                                    639 |                     21 |
| Server                               |            687 |                                    457 |                     54 |
| Runner einschließlich Python-Helfern |            206 |                                    124 |                     12 |
| Betrieb/Installer/Diagnose           |            198 |                                    181 |                     21 |
| Weitere Konfiguration                |              9 |                                      1 |                      2 |
| Tests und Testdaten                  |          1.913 |                                    755 |                     55 |
| **Gesamt**                           |      **3.917** |                              **2.157** |                **165** |

**Diese Zahlen zählen Fundstellen, nicht eindeutige deutsche Texte oder fertige Übersetzungsschlüssel.** Doppelte Beschriftungen, englische Texte, technische Konstanten, Testtitel und einige Kommentare sind bewusst enthalten. Allein in Browser, Server und Runner liegen 1.797 Prüfkandidaten. Die tatsächliche Schlüsselzahl entsteht erst nach der semantischen Zuordnung und sinnvollen Zusammenfassung gleicher Beschriftungen.

Das vollständige Arbeitsinventar liegt separat, damit dieser Plan lesbar bleibt:

- [Alle erfassten Fundstellen mit vollständigen Texten und Zeilennummern](docs/i18n/BESTAND.md).
- [Maschinenlesbarer Bestand mit Parserangaben und Quellprüfsummen](docs/i18n/bestand.json).
- [Wiederholbarer Scanner](scripts/audit-i18n.mjs).

Der Scanner kombiniert Babel über die bereits vorhandene Prettier-Abhängigkeit, parse5, css-tree und Python `ast`. Er erfasst auch Template-Literale, verschachtelte Texte, HTML-Attribute und in JavaScript escapte Zeichen wie `pr\u00fcfen`. Für Shell, PowerShell, Batch, C und sonstige Konfiguration ergänzt er eine Rohzeilenprüfung. Eine zusätzliche Prüfung der nicht ausgewählten Wortliterale wurde zur Suche nach übersehenen Einwortbeschriftungen verwendet.

Bewusst ausgeschlossen sind persönliche Anwendungsdaten unter `server/data`, echte `.env`-Dateien, Geheimnisverzeichnisse, `node_modules`, Signaturschlüssel, Bilddateien und das Dependency-Lockfile. Damit wird auch die bereits versionierte Datei unter `server/data/workspaces/` nicht als mitgelieferter Übersetzungstext behandelt. Die neuen Planungsartefakte werden nicht selbst wieder eingescannt.

**Grenze der Automatik:** Die Spracherkennung und Einordnung sind Heuristiken. Vollständig ist das Verzeichnis der erfassten Kandidaten; eine vollständige semantische Erkennung aller Anzeigetexte kann ein statischer Sprachfilter nicht beweisen. Dynamisch erzeugte Inhalte, native Browsermeldungen und Monaco benötigen zusätzlich Laufzeitprüfungen. Deshalb gehören manuelle Zuordnung und eine Prüfung aller Anwendungsbereiche zum Abschluss der Implementierung.

### 2.2 Oberfläche: betroffene Module

| Dateien                                      | Gefundene Textarten und Umstellungsbedarf                                                                                   |
| -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `public/index.html`                          | Navigation, Willkommenstext, Toolbar, Dialoggerüste, Tooltips, `aria-label`, Platzhalter und festes `lang="de"`.            |
| `public/app.js`                              | Einstellungen, Verbindungszustände, Modellauswahl, Runtime-Einstellungen, Serverdialog und Startfehler.                     |
| `public/js/ui.js`                            | Gemeinsame Beschriftungen wie „Speichern“, „Abbrechen“, „Schließen“, „Bestätigen“ und „Erweiterte Einstellungen“.           |
| `public/js/setup.js`                         | Einrichtungsschlüssel, Administratorpasswort, Login, Passwortwechsel, KI-Zugangsdaten und Modellkonfiguration.              |
| `public/js/sessions.js`                      | Neue/umbenannte/gelöschte Sessions, Defaulttitel, Metadaten und Löschbestätigung.                                           |
| `public/js/workspace.js`                     | Datei-/Ordneraktionen, Pfadeingaben, Binär-/Versionszustände und Lernplanfortschritt.                                       |
| `public/js/editor.js`                        | Speicherstatus, Wiederherstellung, Versionskonflikte, Binärdateihinweise und die Monaco-Aktion „Code erklären“.             |
| `public/js/diffInspector.js`                 | Vorschlagszustände, Hunk-Entscheidungen, Vergleichserklärungen und Rücknahme.                                               |
| `public/js/chat.js`                          | Toolkarten, Fragen, Antworten, Kontext-/Tokenanzeigen, Aufgaben, Fortsetzungstexte, KI-Hinweise und Chataktionen.           |
| `public/js/terminal.js`                      | Prozesszustände, Ausführungsgründe, Eingabeplatzhalter, Quellen der Ausführung und Runtime-Hinweise.                        |
| `public/js/programs.js`                      | Programme, Zustände, Installieren/Entfernen/Reparieren, sechs Installationsschritte, Downloadgrößen und Logdetails.         |
| `public/js/tracer.js`                        | Aufzeichnung, Wiedergabe, Frames, Variablen-/Objektansicht, Gründe für Abbruch/Unvollständigkeit und historische Snapshots. |
| `public/js/preview.js`                       | Web-Vorschau, automatische Aktualisierung, Snapshotablauf, Loganzeige und Fehlermeldungen.                                  |
| `public/js/taskTests.js`                     | Sichtbare Testfälle, Erwartungen, Tests starten/stoppen, Beurteilung, alte Ergebnisse und Abschlussdialog.                  |
| `public/js/learningSupport.js`               | Hinweisleiter, Lösungshinweis, Journal und freiwilliger Abschluss.                                                          |
| `public/js/errorCatalog.js`, `errorCards.js` | Eigene Fehlererklärungen, Kategorien, Quellnavigation und Beschriftung der Originalmeldung.                                 |
| `public/js/profile.js`                       | Profilzustände, Selbsteinschätzung, Belege, Wiederholungen, Import, Export, Zurücksetzen und Zeitzone.                      |
| `public/js/projects.js`                      | Vorlagen, Importvorschau, Prüflisten, Export, Herkunftsangaben und Journalansicht.                                          |
| `public/js/api.js`                           | Netzwerk-/JSON-Fehler, REST-Fehler, SSE-Fehler und abgebrochene Streams.                                                    |
| `public/js/providerModels.js`                | Eigene Modell-ID, nicht mehr verfügbare Modelle und Auswahlhinweise.                                                        |

`icons.js`, `taskSections.js`, `state.js` und `uuid.js` enthalten nach der Prüfung keine eigenen offensichtlichen deutschen Anzeigetexte. Ihre Schnittstellen sind dennoch relevant, weil darüber Beschriftungen, Events und Zustände laufen. Die SVG-Dateien enthalten keine zu übersetzende deutsche Bildbeschriftung. `public/style.css` enthält keine erkannten deutschen CSS-Anzeigetexte; es muss wegen längerer Übersetzungen trotzdem geprüft werden.

### 2.3 Server und Runner: konkrete Quellen

| Bereich                   | Dateien und Beispiele                                                                                                                                                                                      |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Zentrale HTTP-Fehler      | `server/app.js`: Host-/Originfehler, Wartung, JSON-Pflicht, unbekannte API und interner Fehler. Diese Pfade liegen teilweise vor der Anmeldung.                                                            |
| Fehlerklassen/Validierung | `server/services/storage.js`: `AppError`, Session-ID, Einstellungen, Wertebereiche, Workspacezugriff und Löschzustand. Viele verschiedene Texte teilen bisher `INVALID_REQUEST`.                           |
| Routen                    | Unter anderem `server/routes/auth.js`, `sessions.js`, `chat.js`, `programs.js`, `profile.js`, `models.js`, `server.js`. Auch Routen ohne eigene Texte müssen Metadaten korrekt weiterreichen.              |
| Dateidaten                | `workspace.js`, `safeFiles.js`, `proposals.js`: Pfade, Größen, Speicherplatz, Konflikte, Vorschläge und Rücknahme.                                                                                         |
| Prozesse                  | `processes.js`, `localProcesses.js`, `runnerClient.js`, `terminalPages.js`: fehlende/deaktivierte Laufzeiten, Prozessstart, Abbruch, Runner-Verbindung und Cursorfehler.                                   |
| KI-Anbindung              | `teacher.js`, `lmStudio.js`, `openAI.js`, `providerCredentials.js`, `toolExecutor.js`, `tools.js`: Anbieterfehler, Werkzeuge, Grenzen und Wiederherstellungsfälle.                                         |
| Kontext                   | `context/prompt.js`, `history.js`, `workflow.js`, `index.js`, `results.js` und mehrere `context/core/*`-Dateien: Systemregeln, Snapshot-/Recoverytexte und Berichte; zusätzlich englische interne Prompts. |
| Sessions                  | `sessions.js`: „Neue Session“, Lernplanfrage beim Start und Fortsetzungsfrage nach einem abgeschlossenen Plan werden bereits in Nachrichten gespeichert.                                                   |
| Lernkatalog               | `concepts.js`: deutsche Konzepttitel, historische deutsche Aliase und sechs Arten von Python-Wiederholungsaufgaben samt Beispieltiteln.                                                                    |
| Lernprofil                | `profileManager.js`, `learningReviews.js`, `learningSupport.js`: Profile, Wiederholungen, Lernjournal und freigegebener Modellkontext.                                                                     |
| Tests/Tracer/Vorschau     | `testRunner.js`, `traces.js`, `previews.js`, `previewBridge.js`: Fehler, Status- und Hilfstexte, Snapshotgrenzen und isolierte Vorschaukommunikation.                                                      |
| Projektinhalte            | `projectTemplates.js`, `projects.js`: drei mitgelieferte Projekte, Aufgaben, Hinweise, Quellcodekommentare, Texte der Beispielwebseite und Import-/Exportvalidierung.                                      |
| Runner-Verwaltung         | `runner/index.js`, `common.js`, `jobs.js`, `runtime.js`, `catalog.js`, `programs.js`: Validierung, Status, Journale, Reparatur und Fortschritt.                                                            |
| Auswertungshelfer         | `runner/grading/*`, `runner/tracer/*`: eigene Fehlermeldungen und Platzhalter wie „Wertebudget erreicht“ oder „Objekt nicht ausgewertet“.                                                                  |

Der Einzeltext jedes Scannerfunds steht im [Bestand](docs/i18n/BESTAND.md); die Tabelle ersetzt dieses Inventar nicht.

### 2.4 Fest eingebaute Formate und weitere Sonderfälle

Es gibt im Frontend **22 Vorkommen von `"de-DE"` auf 17 Quellzeilen in acht Dateien**: `app.js`, `chat.js`, `preview.js`, `profile.js`, `projects.js`, `sessions.js`, `taskTests.js` und `tracer.js`. Damit wären bei einer reinen Textübersetzung Zahlen und Zeitangaben weiterhin deutsch formatiert.

Weitere konkrete Befunde:

- `public/index.html:2` setzt die Dokumentensprache fest auf Deutsch. Die HTML-Vorlage in `server/services/projectTemplates.js:119` tut dies ebenfalls für ein neues Nutzerprojekt.
- `public/js/editor.js:65` konfiguriert den AMD-Loader von Monaco ohne Oberflächensprache. Das installierte **Monaco 0.47.0** bringt deutsche und spanische NLS-Dateien bereits unter `node_modules/monaco-editor/min/vs/` mit.
- `server/services/context/prompt.js` prüft den Inhalt einer deutschen Regel mit `.includes("Beende den Turn nach einem Vorschlag")`. Auch `storage.js` erkennt einen historischen Prompt über deutschen Wortlaut. Solche Verhaltensentscheidungen dürfen nicht von übersetzten Texten abhängen.
- `public/js/chat.js` erzeugt ganze Nutzernachrichten auf Deutsch, etwa beim Fortsetzen nach einer Aufgabe. Das ist Teil der Tutorsprache, nicht nur eine Buttonbeschriftung.
- `public/js/profile.js`, `programs.js`, `tracer.js`, `terminal.js` und `diffInspector.js` besitzen Zustands-/Grundtabellen mit deutschen Werten. Die maschinellen Schlüssel sind bereits überwiegend sprachneutral und sollen erhalten bleiben.
- `server/services/previewBridge.js` wird als Funktion in ein isoliertes Dokument serialisiert. Ein gewöhnlicher Import von `t()` innerhalb dieser Funktion würde dort nicht funktionieren.
- `runner/tracer/python_tracer.py` schreibt eigene deutsche Ersatztexte in aufgezeichnete Werte. Diese Marker dürfen später nicht durch Vergleich mit dem deutschen Wortlaut erkannt werden.
- `server/services/profileManager.js:28` verwendet `Intl.DateTimeFormat("en", ...)` zum Aufbau eines internen Tageswertes. **Das ist keine deutsche UI-Fundstelle** und wird nicht durch eine Oberflächensprache ersetzt; die Wiederholungsplanung braucht stabile Tageswerte.
- Die Bezeichnung „Sprachprofil“ meint derzeit Lernfortschritt je **Programmiersprache**. Übersetzungen müssen diese Bedeutung erhalten; die UI kann durchgehend „Lernprofil“ verwenden, ohne bestehende Speicherschlüssel umzubenennen.
- Exportdateinamen wie `sterracode-lernprofil.json` und deutsche Defaulttitel sind zu prüfen. Bestehende Dateipfade oder vom Nutzer benannte Sessions werden dabei nicht automatisch umbenannt.

## 3. Vier unterschiedliche Arten von Sprache

Die vorhandenen Felder `session.language`, `LANGUAGES`, `allowedLanguages` und der Selektor `#language-select` stehen für Python, JavaScript, Java usw. Sie bleiben Programmiersprachen.

| Neues Konzept   | Beispiel | Speicherung/Wirkung                                                                                               |
| --------------- | -------- | ----------------------------------------------------------------------------------------------------------------- |
| `uiLocale`      | `es`     | Browserlokale Oberfläche einschließlich eigener Fehlerdarstellung.                                                |
| `formatLocale`  | `es-ES`  | Aus der Locale-Registry abgeleitet; Zahlen und Datum, keine neue globale Zeitzone.                                |
| `tutorLocale`   | `en`     | Sessionfeld für zukünftige Tutorerklärungen, KI-generierte Aufgaben und explizite automatische Fortsetzungstexte. |
| `contentLocale` | `de`     | Herkunftssprache einer neu importierten mitgelieferten Vorlage oder Offlineaufgabe. Bestandteil ihrer Provenienz. |

Vorgaben für Version 1:

1. `uiLocale` wird unter einem eigenen Schlüssel wie `sterracode.uiLocale` gespeichert. Zugriff auf Web Storage muss mit gesperrtem Speicher funktionieren; dann gilt die Auswahl nur für den aktuellen Tab.
2. Die Registry enthält `de → de-DE`, `en → en-GB`, `es → es-ES`. Die übersetzten spanischen Texte bleiben möglichst regional neutral. Zusätzliche regionale Formatwünsche können später separat angeboten werden.
3. Neue Sessions erhalten `tutorLocale = uiLocale`. Bestehende Sessions ohne dieses Feld behalten durch einen Kompatibilitätsmodus das bisherige Verhalten „in der Sprache des Nutzers antworten“. Ein Schema-Upgrade darf ihnen nicht pauschal Deutsch als bisherige Antwortsprache zuschreiben.
4. Ein expliziter Wechsel der Tutorsprache betrifft zukünftige Antworten. Er erzeugt keine Übersetzung des bisherigen Verlaufs und startet keine neue KI-Antwort ohne Nutzeraktion.
5. `contentLocale` wird beim Erstellen/Importieren gewählt und danach festgehalten. Ein anderer Browser mit einer anderen Oberfläche verändert ein vorhandenes Projekt nicht.
6. Die erlaubten Werte werden zentral validiert. Regionale Eingaben wie `en-US` können auf eine unterstützte Basissprache normalisiert werden; ungültige/unbekannte Eingaben fallen auf Deutsch zurück. Eine Locale wird nie ungeprüft als Dateipfad benutzt.

Für das Speicherschema kann `tutorLocale: null` den ausdrücklich dokumentierten Altmodus bezeichnen; neue Sessions speichern immer eine unterstützte Locale. POST/PATCH-Validatoren, `listSessions()` und interne Aufrufe von `createSession()` werden entsprechend ergänzt. Die Startfunktion für eine Wiederholungsaufgabe benötigt die gewählte Tutorsprache ebenfalls ausdrücklich, weil sie bisher nur eine Wiederholungs-ID entgegennimmt. Die Programmeinstellung `allowedLanguages` erhält dadurch keine neuen Werte.

Eine spätere Option „Browsersprache verwenden“ kann `navigator.languages` beziehungsweise `Accept-Language` auswerten. Sie ist für die erste Version nicht erforderlich und darf den deutschen Standard nicht still ändern.

## 4. Geplante Dateistruktur und Übersetzungsvertrag

Die folgenden Pfade sind ein Umsetzungsvorschlag und existieren teilweise noch nicht:

```text
shared/i18n/
  locale.js                    # erlaubte Locales, Normalisierung, Formate, Monaco-Zuordnung
  messages.js                  # sprachneutrale Meldungsbeschreibungen; ohne i18next-Import
  locales/
    de/
      common.json
      app.json
      auth.json
      workspace.json
      chat.json
      learning.json
      programs.json
      runner.json
      errors.json
      templates.json
    en/                        # dieselben fachlichen Schlüssel
    es/
public/js/
  bootstrap.js                 # Sprache laden, statisches HTML übersetzen, app.js starten
  i18n.js                      # t(), formatNumber(), formatDateTime(), DOM-Bindung
  localeSwitch.js              # kontrollierter Sprachwechsel und Zustandswiederherstellung
server/services/
  i18n.js                      # Kataloge laden, festen Übersetzer pro Request liefern
server/prompts/
  ...                          # mitgelieferte Tutor-/Technikprompts mit Herkunft/Version
scripts/
  audit-i18n.mjs                # vorhandenes Planungswerkzeug
  check-i18n.mjs                # später: Schlüssel-/Parameter-/Katalogprüfung
tests/
  i18n*.test.js
  e2e/i18n.spec.js
```

Die Namensräume dürfen bei der Umsetzung noch entlang tatsächlicher Modulgrößen geteilt werden; entscheidend sind eine gemeinsame Registry und klare Zuständigkeiten. Promptdateien gehören nicht in öffentlich ausgelieferte Browserkataloge. Die gemeinsamen UI-Kataloge enthalten ausschließlich mitgelieferte, nicht geheime Texte.

Node importiert i18next regulär aus der Produktionsabhängigkeit. Der Browser erhält die festgeschriebene ESM-Distribution über einen einzelnen erlaubten Pfad wie `/vendor/i18next.js` und das browserfähige Registry-Modul über `/i18n/locale.js`. Kataloge werden unter einer ausdrücklich begrenzten Route für erlaubte Locales/Namensräume angeboten. Ein kleiner eigener Ladeadapter reicht für die JSON-Dateien; zunächst sind weder Backend-/Browserdetector-Plugins noch ein ICU-Plugin erforderlich. Der Server liest seine Ressourcen einmal beim Start ein, der Browser lädt Deutsch und die gewählte Sprache vor der Verwendung. Die Ressourcen-/Startfehlerpfade werden vor dem eigentlichen Appstart geprüft.

### 4.1 Schlüssel und vollständige Sätze

Schlüssel beschreiben die Bedeutung: `common:actions.save`, `auth:password.mismatch`, `workspace:save.conflict`, `programs:progress.stage`, `errors:session.invalidId`. Deutsche Sätze werden nicht selbst als Schlüssel verwendet. Gleiche Wörter werden nur bei gleicher Bedeutung geteilt; „Öffnen“ für eine Datei und „Hinweis öffnen“ müssen nicht derselbe Schlüssel sein.

Beispiel einer Aufteilung nach Sprache:

```json
// de/common.json
{ "actions": { "save": "Speichern" } }
// en/common.json
{ "actions": { "save": "Save" } }
// es/common.json
{ "actions": { "save": "Guardar" } }
```

Dies ist ein schematisches Beispiel für drei Dateien, keine gemeinsam gültige JSON-Datei. Für längere Texte wird der ganze Satz übersetzt, etwa `t("programs:progress.stage", { current, total, description })`. Keine Grammatik aus übersetzten Wortstücken und Satzresten zusammensetzen. Technische Namen wie `Python`, `JavaScript`, `OpenAI` oder `strict-json` werden nicht frei übersetzt.

### 4.2 Pluralformen, Zahlen und Zeiten

- Mengen durch `count` und i18next-Pluralformen ausdrücken: Dateien, Schritte, Nachrichten, Hinweise, Themen und Tests.
- Die erforderlichen Kategorien je Locale mit `Intl.PluralRules` prüfen. Auf der vorhandenen Node-24-Laufzeit besitzt Spanisch auch **`many`**, beispielsweise bei 1.000.000; deshalb nicht pauschal nur `_one` und `_other` für jede Sprache voraussetzen.
- Eigene Helfer für Zahlen, Prozent, Datum, Uhrzeit und Größen verwenden. Nicht länger direkt `toLocaleString("de-DE")` in Modulen aufrufen.
- Prozentwerte als Verhältnis formatieren, statt eine schon mit 100 multiplizierte Zahl nochmals als Prozent zu formatieren. Grenzen und Rundung bleiben fachlich dieselben.
- Zeitstempel bleiben ISO/UTC-Daten. `profile.timeZone` bleibt unabhängig von der Oberflächensprache; ein Wechsel auf Spanisch darf Wiederholungen nicht auf eine andere Zeitzone verschieben.
- Technische Sortierung, Hashes und Versionsvergleiche bleiben deterministisch. Eine localeabhängige Sortierung eignet sich nur für tatsächlich angezeigte Namen.

Die i18next-Dokumentation beschreibt die `count`-Anforderung und die an `Intl` orientierten Pluralkategorien: [Pluralformen](https://www.i18next.com/translation-function/plurals). Die konkreten Kategorien oben wurden zusätzlich lokal mit Node 24 geprüft.

### 4.3 Sichere Anzeige und Ausfallverhalten

Übersetzungen werden über `textContent`, Textknoten und definierte Textattribute eingefügt. Die vorhandene sichere DOM-Erzeugung in `ui.js` und der Markdownrenderer bleiben erhalten. Für Textknoten kann Interpolation ohne HTML-Escaping verwendet werden, damit etwa `A&B.py` nicht als `A&amp;B.py` erscheint. Diese Konfiguration ist nur zusammen mit den sicheren Ausgabestellen zulässig; Übersetzungsstrings werden nicht als `innerHTML` ausgeführt und interpolierte Eingaben nicht erneut als Übersetzungsausdruck ausgewertet. Hintergrund: [i18next-Interpolation](https://www.i18next.com/translation-function/interpolation).

Ein fehlender Schlüssel soll in Entwicklungs-/CI-Prüfungen scheitern. Im Produktbetrieb wird auf den deutschen Eintrag und anschließend eine bekannte allgemeine Meldung zurückgefallen. Rohe Schlüssel wie `errors:session.invalidId` sind keine regulären Produkttexte. Fehlende Kataloge werden sichtbar diagnostiziert, ohne Zugriff auf Editor und Login durch eine endlose Ladeanzeige zu blockieren.

## 5. Browserstart, Sprachwahl und Monaco

### 5.1 Richtige Reihenfolge beim Start

`public/index.html` startet künftig ein externes ES-Modul `bootstrap.js`. Dieses liest die browserlokale Sprachwahl, initialisiert i18next, setzt `document.documentElement.lang`/`dir`, übersetzt das statische HTML und importiert erst danach `app.js`. Anschließend folgen wie bisher `ensureAccess()`, Server-/Einstellungsabfrage und Editorinitialisierung.

Dadurch sind auch Login, Einrichtung und sehr frühe Verbindungsfehler bereits in der gewählten Sprache verfügbar. Eine kleine fest ausgelieferte Notfallanzeige für einen fehlgeschlagenen Übersetzungsstart muss ebenfalls geplant und als absichtlicher Bootstrap-Sonderfall dokumentiert werden. Deutsch bleibt die funktionsfähige HTML-Grunddarstellung; ein kurzer Ladezustand verhindert bei gespeicherter Fremdsprache eine auffällige Mischung aus zwei Sprachen.

Statische Markierungen können etwa `data-i18n`, `data-i18n-title`, `data-i18n-aria-label` und `data-i18n-placeholder` sein. Beschriftungen neben SVGs oder Eingabefeldern erhalten eigene Textknoten/Spans. Ein Übersetzungslauf darf weder Icons noch Eingabefelder noch Eventhandler durch komplettes Ersetzen eines Elternelements entfernen.

Der Sprachwähler verwendet die Eigennamen **Deutsch / English / Español**, ist per Tastatur erreichbar und steht bereits bei der Anmeldung zur Verfügung. Vor dem Laden von Monaco können vorhandene Loginbeschriftungen unmittelbar umgestellt werden, ohne eingegebene Passwörter zu verlieren oder zu speichern.

### 5.2 Kontrollierter Wechsel nach dem Start

Ein einfacher Aufruf von `location.reload()` wäre hier unzureichend: Editorentwürfe liegen teilweise in localStorage, Journalentwürfe in einer `Map`, Chattexte im Eingabefeld und Terminalzuordnungen im Speicher. Außerdem würde ein Reload einen laufenden Chatstream unterbrechen.

Der Wechsel erhält deshalb einen eigenen Ablauf:

1. Auswahl prüfen und die benötigten Zielkataloge vorladen. Bei Ladefehler bleibt die bisherige Sprache aktiv.
2. Laufende KI-Antworten, aktive Tests/Trace-Aufzeichnungen, gestartete Terminalprozesse und noch auszuführende Formularaktionen berücksichtigen. Während eines solchen Vorgangs wird das Anwenden verständlich zurückgestellt; es werden keine Prozesse automatisch gestoppt oder Aktionen erneut gestartet. Andere offene Dialoge mit ungespeicherten Werten müssen zuerst regulär abgeschlossen werden.
3. Sämtliche offenen Editorrecords auf ungesicherte Änderungen prüfen. `flush()` speichert derzeit nur den aktuellen Record; für diesen Ablauf ist eine sichere Prüfung/Flush-Funktion über alle relevanten Records nötig. Bei Versionskonflikt bleibt die Seite unverändert und der vorhandene Vergleichsdialog übernimmt die Auflösung.
4. Aktive Session, Datei, Auswahl-/Scrollposition, Ansicht, Seitenleisten-Tab, Chatentwurf und offene Journalentwürfe pro Session vorübergehend sichern und nach dem Reload wiederherstellen. Dazu keine Passwort-/API-Key-Felder oder Terminal-stdin speichern. Bei nicht leerem Terminaleingabefeld das Anwenden bis zum Senden oder bewussten Leeren zurückstellen.
5. Für zuvor angezeigte Terminalergebnisse nur Prozess-ID/Ansichtsmetadaten sichern und die Originalausgabe über die vorhandene Prozess-API wieder lesen. Ein abgelaufenes Artefakt als solches anzeigen. Keine Ausgabe in übersetzten Text umwandeln und keine Befehle zur Wiederherstellung neu ausführen.
6. Sprachpräferenz erst nach erfolgreicher Vorbereitung übernehmen, kontrolliert neu laden und nach Anmeldung die bisherige Session wieder öffnen. Temporäre Wiederherstellungsdaten anschließend entfernen. Ein abgebrochener Sprachwechsel darf keine halbe Wiederherstellungsmarkierung zurücklassen.

Für diese erste Version ist ein verzögerter Wechsel während aktiver Arbeit bewusst vorgesehen. Vollständig unterbrechungsfreies Umstellen aller schon geöffneten Monaco- und Spezialdialoge kann später folgen; es ist keine Voraussetzung für drei vollständig nutzbare Sprachmodi.

### 5.3 Monaco gesondert konfigurieren

Das Projekt verwendet **Monaco 0.47.0 über AMD**. Für diese installierte Version wird vor `vs/editor/editor.main` die `vs/nls`-Konfiguration gesetzt: Deutsch und Spanisch verwenden ihre vorhandenen Sprachpakete, Englisch den Standard ohne Suffix beziehungsweise `i-default`. Eine Datei `editor.main.nls.en.js` ist hier nicht vorhanden und darf nicht angefordert werden.

Damit werden Editor, Kontextmenü, Suchen/Ersetzen und Monaco-interne Bedienhinweise erfasst. Auch Diff-Editor und Tracer-Quellansicht müssen dieselbe früh gesetzte Konfiguration nutzen. Eigene Aktionen wie „Code erklären“ kommen aus den SterraCode-Katalogen.

Die aktuelle Monaco-Dokumentation behandelt inzwischen auch andere NLS-Einbindungen und warnt vor auslaufender AMD-Unterstützung. Das ist **kein Anlass für ein gleichzeitiges Monaco-Upgrade**. Maßgeblich sind zunächst der installierte 0.47.0-Loader und die lokal geprüften Sprachdateien; ein Editorupgrade wäre ein eigener Auftrag. Siehe [offizielles Monaco-Repository](https://github.com/microsoft/monaco-editor).

## 6. HTTP, SSE und eigene Fehlermeldungen

### 6.1 Ein gemeinsamer Meldungsvertrag

Beispiel einer zukünftig vorgesehenen Fehlerantwort:

```json
{
  "error": "La sesión no es válida.",
  "code": "INVALID_REQUEST",
  "messageKey": "errors:session.invalidId",
  "params": {}
}
```

`code` und HTTP-Status bleiben die maschinelle Entscheidung. `messageKey` identifiziert den konkreten Text, weil beispielsweise `INVALID_REQUEST` bislang viele unterschiedliche Meldungen bezeichnet. Parameter enthalten ausschließlich für die Anzeige vorgesehene Werte. `.message` und das bisherige `error`-Feld bleiben während der Umstellung kompatible Klartextpfade; bei bekannten neuen Meldungen werden sie an der HTTP-Grenze lokalisiert.

Vorgesehene Änderungen:

- `AppError` um Meldungsmetadaten ergänzen oder einen kompatiblen Factory-Helfer anbieten. Alte Aufrufe nicht durch eine inkompatible Änderung der Positionsargumente brechen.
- Browseranfragen in **beiden** Transportfunktionen `api()` und `streamChat()` mit der gewählten Sprache versehen, beispielsweise über `Accept-Language: es`.
- Sprache früh und ohne Dateizugriff normalisieren, sodass auch Host-/Origin-/Setupfehler einen passenden Übersetzer erhalten. Authentifizierung, Originprüfung und Cachevorgaben bleiben wirksam.
- Auf dem Server die Kataloge einmal initialisieren und pro Request einen festen Übersetzer verwenden. **Kein globales `changeLanguage()` pro Anfrage**, sonst können gleichzeitige Browser einander die Sprache verstellen. i18next stellt dafür [Instanzen und `getFixedT`](https://www.i18next.com/overview/api) bereit.
- `APIError` neben `status`/`code` auch `messageKey`/`params` mitgeben. SSE-Fehler aktuell vom Typ `new Error(value.message)` auf denselben strukturierten Pfad bringen.
- Nicht nur geworfene Fehler erfassen: Auch erfolgreiche JSON-Antworten enthalten heute `error`, `reason`, Diagnosehinweise, Anbieterzustände und Runtime-Erklärungen. Diese Felder brauchen denselben Meldungsvertrag.
- Unbekannte interne Fehler weiterhin durch eine allgemeine Meldung ersetzen. Localeänderungen dürfen keine zusätzlichen Stacktraces, Schlüssel oder Serverpfade offenlegen.

Die API antwortet weiter mit `no-store`. Für localeabhängigen öffentlichen Text gegebenenfalls `Content-Language`/`Vary` korrekt setzen; die App-Grunddatei kann sprachneutral ausgeliefert und im Browser gebunden werden. Fehlerparameter sind Daten und werden nicht als zusätzliche Übersetzungsschlüssel interpretiert.

### 6.2 Runner, Fortschritt und Python

`runner/programs.js` speichert derzeit komplette deutsche Fortschrittstexte in Jobs/Journale. Die fachlichen Zustände sind bereits sprachneutral. Künftig zum Beispiel:

```json
{
  "state": "installing",
  "stage": { "current": 3, "total": 6 },
  "progressMessage": {
    "key": "runner:programs.downloadingPackages",
    "params": {}
  }
}
```

Die bestehenden sechs Arbeitsschritte und die Aussage „keine geschätzte Restzeit“ bleiben erhalten. Unterschiedliche Abläufe für APT-/Herstellerdownload, Entfernen, Wiederherstellung und Reparatur dürfen nicht alle auf denselben generischen Schritttext reduziert werden. Die UI übersetzt bekannte Zustände/Gründe und neue Meldungsbeschreibungen beim Anzeigen; alte persistierte Klartexte bleiben als Legacy-Fallback lesbar.

Der Runner enthält derzeit keine installierten Node-Paketabhängigkeiten. Deshalb zieht er **nicht** über einen gemeinsam importierten Helfer versehentlich i18next hinein. Er erzeugt nur stabile Meldungskennungen, Parameter und maschinelle Codes. Die App übersetzt Antworten für Menschen. Bei einer gestaffelten Auslieferung müssen zuerst die Verbraucher neue Metadaten verstehen; alte Jobs und gegebenenfalls alte Runnerantworten bleiben darstellbar.

Eigene Python-Tracer-/Gradingtexte werden ebenfalls als zusätzliche Markerkennung übertragen, getrennt vom tatsächlichen Programmwert. Vorhandene `type`, `kind`, `reason`, `value`, JSON-Typen und fachliche Resultate nicht ohne Schema-/Kompatibilitätsprüfung verändern. Historische Traceartefakte bleiben gültig. Rohe Python-Ausnahmen und vom Nutzer ausgegebene Strings werden nicht übersetzt.

### 6.3 Isolierte Web-Vorschau

`previewBridge()` kann keinen normalen Übersetzungsimport verwenden, weil sein Funktionskörper serialisiert wird. Seine eigenen Meldungen werden daher als bekannte Kennung plus Parameter an die Elternseite geschickt und dort übersetzt. Alternativ erforderliche reine Texte werden vor der Serialisierung ausdrücklich in `config` übergeben.

Eigene Brückenmeldungen und Nutzer-`console.log` bleiben unterscheidbar. Die bestehenden Prüfungen für Origin, Snapshot-/Render-ID, Größen-/Ratenbegrenzung, Sandbox und CSP gelten weiterhin. Eine Sprache darf weder neuen Netzwerkzugriff noch HTML-Ausführung in der Vorschau ermöglichen.

## 7. Gespeicherte Nachrichten, Tutor und Lerninhalte

### 7.1 Anwendungstexte von Nutzer-/Modelltexten trennen

Zukünftig erzeugte **anwendungseigene** Ereignisse erhalten eine bekannte Herkunft sowie einen Schlüssel und Parameter. Dazu gehören die Startfrage nach einem Lernplan und die Fortsetzungsfrage nach Abschluss aller Themen. Zusätzlich wird der zum Erstellungszeitpunkt verwendete Klartext als kanonischer Verlaufstext behalten.

Die Oberfläche kann diese bekannten Ereignisse in `uiLocale` darstellen. `modelHistory()`, `sourceHash()` und das Kontext-Workflow verwenden dagegen den gespeicherten kanonischen Inhalt. Ein Browser-Sprachwechsel darf nicht jedes Mal den Modellverlauf, die Cacheidentität oder alte OpenAI-Providerzustände verändern.

Multiple-Choice-Antworten erhalten für anwendungseigene Fragen stabile Optionskennungen, etwa `create_plan` oder `start_directly`. Die Anzeige ist übersetzt; die Antwortverarbeitung prüft die Kennung gegen die tatsächlich gestellte Frage. Das bestehende Freitextfeld bleibt möglich. Die bisherige Stringantwort-Schnittstelle und bereits beantwortete Fragen müssen lesbar bleiben. Für vom Modell frei erzeugte Fragen wird keine vermeintlich passende Anwendungsschablone geraten.

Alte Ereignisse werden nur anhand belastbarer Metadaten wie `onboarding: true` als eigene bekannte Schablone erkannt. **Keine pauschale Ersetzung gleicher deutscher Sätze im gesamten Chat.** Wenn die Herkunft nicht eindeutig ist, bleibt der Originaltext bestehen.

### 7.2 Tutorsteuerung und Prompts

Die Ausgabe-/Tutorsprache und die Sprache interner Technikregeln werden getrennt:

- Der eingestellte `tutorLocale` wird vor einem neuen Turn serverseitig aus der Session gelesen, validiert und als aktuelle Sprachvorgabe eingebunden. Er wird nicht aus einem wechselnden Browserheader für dieselbe Session abgeleitet.
- Neue Aufgaben, Fragen, Hinweise und automatisch erzeugte Fortsetzungsnachrichten verwenden die Tutorsprache. Programmiersprachen, Toolnamen, Dateipfade, JSON-Schemas und Statuswerte bleiben technisch unverändert.
- Die mitgelieferte sicht-/editierbare Tutorgrundanweisung erhält versionierte Sprachvarianten oder wird beim expliziten Zurücksetzen passend ausgewählt. Vom Nutzer geänderte `systemPrompt`-Texte werden niemals durch einen UI-Sprachwechsel überschrieben. Eine explizite Nutzeranweisung für eine konkrete Antwort kann weiterhin eine andere Sprache verlangen.
- Die automatische Erkennung schon eingebauter Regeln anhand deutschen Wortlauts durch einen ausdrücklichen, versionierten Promptvertrag ersetzen. Historische Promptmigrationen bleiben erhalten und werden separat geprüft.
- Recovery-, Ausführungs- und Snapshotregeln müssen inhaltlich unverändert bleiben: `proposed` bedeutet keine angewandte Dateiänderung, `applied` bleibt wirksam, unterbrochene Werkzeuge werden nicht blind wiederholt und gespeicherte Snapshots sind keine Ausführungsfreigabe.
- Interne Zusammenfassungs-/Technikprompts müssen nicht dreifach übersetzt werden. Ihre vorhandene bewusste Sprache wird dokumentiert und bei Bedarf aus Implementierungscode in versionierte Promptdateien ausgelagert. Sichtbare Status-/Hilfstexte daneben werden regulär übersetzt.
- Eine Änderung von `tutorLocale` wird vor dem nächsten Modellaufruf als neuer aktueller Zustand berücksichtigt. UI-Sprachwechsel allein verändern den Kontext nicht; geänderte tatsächliche Prompt-/Tutorvorgaben fließen kontrolliert in die dafür zuständigen Fingerprints ein. Alte Zusammenfassungen und opaque Providerzustände werden nicht nachträglich übersetzt oder umgeschrieben.

Zu prüfen sind beide Pfade: `ContextManager` für LM Studio und `OpenAIContext` für OpenAI. Auch nach Komprimierung muss die neue Sprachvorgabe wirksam bleiben. Der bestehende Quellverlauf bleibt bytegetreu; UI-Lokalisierung darf keine neue KI-Anfrage auslösen.

### 7.3 Konzepte und Offline-Wiederholungen

Die stabilen IDs wie `python.variables`, `python.conditions` und ihre fachlichen Gruppen bleiben erhalten. Konzepttitel werden bei der Anzeige über IDs lokalisiert. Historische deutsche Aliase bleiben für existierende Daten und Importauflösung verfügbar; für neue Modell-/Importeingaben können englische und spanische Aliase ergänzt werden, ohne mehrdeutige sprachübergreifende Treffer einzuführen.

Bei einer neuen Offline-Wiederholung werden Aufgabenbeschreibung, Hinweise und Fallnamen in `tutorLocale` materialisiert und zusammen mit ihrer Herkunftssprache gespeichert. Funktionen wie `double_value` oder `reverse_string`, Eingaben und erwartete Werte bleiben dieselben. Ein Browserwechsel ändert diese gespeicherte Aufgabe nicht.

Wichtig: `testRunner.js` bildet einen Digest über die **gesamte Testsuite**, einschließlich der Namen. Laufend andere Testfallnamen in dieselbe Suite zu schreiben würde einen bisherigen Testlauf als veraltet markieren. Deshalb nur die neue Instanz vor dem ersten Test lokalisieren oder nachweislich rein abgeleitete Anzeigelabels außerhalb des Digests verwenden. Für Version 1 ist das Materialisieren beim Erstellen die einfachere Regel.

### 7.4 Projektvorlagen und Codebeispiele

Die drei Projekte `guess-number`, `text-analysis` und `small-website` brauchen übersetzte Metadaten, Aufgaben, Hinweise, Checklisten und neue Quelltextkommentare. Die HTML-Vorlage erhält die passende Dokumentensprache. Übersetzte Texte der erzeugten Webseite müssen echte Nutzerdaten im neuen Projekt werden, nicht nachträglich durch die Hostoberfläche überlagert werden.

Besonders zu beachten ist das Zahlenratespiel: `beurteile_tipp(tipp, geheim)` und die erwarteten Rückgaben `"zu klein"`, `"zu groß"`, `"richtig"` sind heute Teil des sichtbaren Python-Vertrags. Für die erste Sprachversion bleiben diese Schnittstellen/Testrückgaben stabil; die englische/spanische Aufgabe erklärt sie in der jeweiligen Sprache und zeigt die exakten literalen Werte als Code. Ein vollständig anderssprachiger Funktionsvertrag wäre eine **neue, ausdrücklich versionierte Inhaltsvariante** mit angepassten Tests, kein automatisches Übersetzen der alten Datei.

Beim Vorlagenimport wird `contentLocale` ausdrücklich Teil des Requests, der Provenienz und der Idempotenzberechnung. Derselbe `operationId` darf bei wiederholter Anfrage nach einem Sprachwechsel kein anderes Paket erzeugen. Ein Import bereits vorhandener Fremdpakete übernimmt dessen Originalsprache und Inhalte.

Auch `projects.js` muss berücksichtigt werden: `cleanTask()`, Paketvalidierung und Export führen Felder bisher ausdrücklich auf. Neue Locale-/Provenienzfelder müssen gezielt validiert, bewahrt und exportiert werden; alleinige Änderungen an `projectTemplates.js` würden sie sonst verlieren. Dateihashes und Bytegrößen werden erst über den endgültig materialisierten Inhalt berechnet.

## 8. Persistenz und Kompatibilität

Für `tutorLocale`, Herkunftsinformationen und neue Ereignismetadaten ist eine ausdrückliche, kleine Schemaentwicklung einzuplanen. `sessions.js` hat bereits eine Migration auf Schema 2 und Reparatur-/Journalregeln; diese dürfen nicht umgangen werden.

| Datenart                                                               | Verhalten bei Sprachwechsel/Upgrade                                                    |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| Bestehende Nutzernachrichten, KI-Antworten, Lernziele und Journaltexte | Originaltext behalten.                                                                 |
| Vorhandene Dateiinhalte, Dateinamen, Sessiontitel                      | Unverändert laden; neue Defaulttitel werden lokalisiert.                               |
| Eigene neue UI-Ereignisse                                              | Schlüssel plus Herkunft und kanonischen Text speichern; Anzeige darf übersetzt werden. |
| Alte eindeutig erkennbare Onboarding-Ereignisse                        | Nichtdestruktive Anzeigezuordnung möglich; Rohdaten und Antworten erhalten.            |
| Alte Runnerjournale mit Klartext                                       | Legacy-Anzeige ermöglichen; keine historische Neuberechnung.                           |
| Testsuite, Quellsnapshot, `suiteDigest`, Dateiversionen                | Keine Änderung allein durch Oberflächensprache.                                        |
| Providerzustand, Kontextverlauf, Zusammenfassungen                     | Keine Übersetzung beim Anzeigen.                                                       |
| Neue Vorlagen-/Wiederholungsinstanz                                    | Inhaltssprache zum Erstellungszeitpunkt festschreiben.                                 |
| Backups und Projekt-/Profilexporte                                     | Bisherige Formate weiter lesen; neue Felder mit validierter Version bewahren.          |

Migrationen sind wiederholbar, erhalten `revision`-/`expectedVersion`-Regeln und führen keine Toolausführung aus. Ein Rückschritt auf eine alte Anwendung muss als eigener Kompatibilitätsfall beschrieben werden: Alte Validatoren akzeptieren neue Felder nicht automatisch. Eine unbestätigte problemlose Rückwärtskompatibilität wird nicht versprochen.

## 9. Umsetzung in prüfbaren Etappen

### Etappe 0 – Inventar zuordnen und Begriffe festlegen

Die 3.917 Kandidaten nach `übersetzen`, `technischer Vertrag`, `Originaldaten`, `internes Promptmaterial`, `Testbeschreibung` und `Betrieb/Dokumentation` sichten. Für auszunehmende Texte eine konkrete Begründung hinterlegen. Wiederkehrende Begriffe in einem kleinen Glossar festhalten: Session, Workspace, Lernplan, Lernprofil, Aufgabe, Wiederholung, Vorschlag, Übernehmen, Rückgängig, Ausführung und Snapshot.

**Ergebnis:** Deutsche Ausgangskataloge plus Zuordnung der Fundstellen zu Schlüsseln oder begründeten Ausnahmen. Die derzeitigen deutschen Formulierungen grundsätzlich erhalten; fachliche Umformulierungen getrennt bewerten.

### Etappe 1 – Gemeinsame Grundlage und frühe Initialisierung

Registry, Meldungsbeschreibung, i18next, lokale Auslieferung, Browserbootstrap, Formathelfer und Katalogprüfung anlegen. Statisches HTML und gemeinsame Dialog-/Toasttexte umstellen. Login/Einrichtung einbeziehen, bevor weitere Features angefasst werden.

**Ergebnis:** Ein vertikaler Ablauf „Start → Sprachwahl → Login/Einrichtung → neue Session“ funktioniert in allen drei Sprachen. Unbekannte Locales und Katalogausfälle sind abgefangen. Die Anwendung benötigt weiterhin keinen externen Übersetzungsdienst.

### Etappe 2 – Sprache anwenden und Monaco

Sicheren Reloadablauf einschließlich Draft-/Ansichtswiederherstellung implementieren. Monaco 0.47.0 mit vorhandenen NLS-Dateien konfigurieren. Erkläraktion, Diff- und Tracer-Editor mitprüfen.

**Ergebnis:** Wechsel `de → en → es → de`, anschließend Reload und erneute Anmeldung, jeweils ohne Verlust offener Texte. Aktive Arbeit wird verständlich berücksichtigt; keine KI-Antwort und kein Prozess wird durch die Auswahl selbst gestartet oder wiederholt.

### Etappe 3 – Browsermodule vollständig umstellen

Alle Module aus Abschnitt 2.2 überführen. Zustandskarten und Zahlenformate besonders prüfen. Übersetzungen nicht beim Modulimport dauerhaft auswerten: Zustandsmaps sollten Schlüssel speichern oder erst nach abgeschlossener Initialisierung innerhalb der Renderfunktionen übersetzen.

**Ergebnis:** Keine unbegründeten fest eingebauten Anwendungstexte in den geprüften UI-Pfaden; auch leere, laufende, gesperrte, fehlerhafte und historische Zustände sind erfasst. Alle zugänglichen Namen wechseln mit.

### Etappe 4 – API, Runner und besondere Ausgabepfade

Serverfehler, Antwortfelder, SSE, Runnerfehler/-fortschritt, Pythonmarker und Preview-Bridge umstellen. Auth-/Sicherheitsprüfungen und fachliche Codes erhalten. Alte Antworten/Artefakte als Kompatibilitätsfälle testen.

**Ergebnis:** Zwei Browser mit verschiedenen Sprachen erhalten gleichzeitig passende Meldungen. Dieselben Fehler behalten dieselben Codes und HTTP-Status. Fortschrittswerte und Rohlogs bleiben korrekt.

### Etappe 5 – Tutor, Sessions und Inhalte

`tutorLocale`, Ereignis-/Optionskennungen, migrationsfähige Herkunftsdaten, Promptversionen, Konzepte, Wiederholungen und Vorlagen umsetzen. Import/Export sowie Idempotenz aktualisieren.

**Ergebnis:** Neue englische/spanische Lernabläufe funktionieren mit beiden KI-Anbietern und ohne KI bei den Offlineaufgaben. Vorhandene Sessions und Testnachweise bleiben gültig. Inhaltssprache und UI-Sprache sind unabhängig nachvollziehbar.

### Etappe 6 – Übersetzungsreview, Layout und Paketprüfung

Englisch/Spanisch anhand des tatsächlichen Kontexts prüfen. Ausnahmen des Audits abgleichen, Testmatrix ausführen und Dockerimages einschließlich aller neuen gemeinsamen Dateien bauen. Plattform-/Containerresultate dokumentieren.

**Ergebnis:** Die Abschlusskriterien aus Abschnitt 11 sind erfüllt. Verbleibende Einschränkungen sind konkret aufgeführt; keine offene Kernfunktion wird hinter einer bloßen Katalogvollständigkeit versteckt.

### Optionale Etappe 7 – Installer, CLI und Dokumentation

`install.ps1`, `install.sh`, `start.ps1`, `check-dependencies.ps1`, `scripts/docker-common.*`, `scripts/docker-admin.*`, `docker/admin.mjs`, `docker/check-lm.mjs` und Diagnose-/Messskripte aus dem Inventar bei Bedarf zusätzlich lokalisieren. Dafür eine ausdrückliche CLI-Sprachauswahl mit deutschem Default vorsehen. Hostskripte müssen weiter ohne bereits laufenden Server funktionieren; PowerShell und Bash benötigen passende eigene Ladewege.

`README.md`, `DOCKER-BETRIEB.md`, `runner/README.md`, Konzepte und interne Pläne sind Dokumentation, keine wechselnde Produktoberfläche. Ihre Übersetzung ist separat zu pflegen. Dieser optionale Umfang blockiert die Browser-Sprachmodi nicht.

## 10. Arbeitsteilung für die spätere Ultra-Runde

In der Implementierung können **Root plus drei Subagents** parallel arbeiten. Zuerst werden gemeinsam verwendete Verträge und der funktionierende Startpfad durch Root angelegt. Danach erhalten die Subagents getrennte Dateizuständigkeiten und eigene Katalognamensräume. Der folgende Zuschnitt vermeidet gleichzeitige Bearbeitung derselben Kernmodule:

| Rolle                      | Zuständigkeit                                                                                                                                                                       | Eigene Prüfungen                                                                   |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| Root/Integration           | `shared/i18n/*`-Verträge, Bootstrap-/Loadergrundlage, Locale-Transport, zentrale Fehlerklassen, Session-Grundschema, Runner, Dockerfiles und Zusammenführung.                       | Kern-/Runnervertrag, Gesamtsuite, Container-/Plattformprüfung.                     |
| Subagent Oberfläche        | Nach Freigabe der technischen Schnittstellen die Featuremodule in `public/`, DOM-/ARIA-Bindungen, Layout und Sprachwechsel-UI. Keine eigenständige Änderung der zentralen Registry. | `tests/e2e/i18n.spec.js`, Browser-/Layoutpfade und Draftwiederherstellung.         |
| Subagent Servermeldungen   | Serverrouten/-services mit eigenen Fehler-/Statusmeldungen; ausgenommen die unten dem Inhaltsagenten zugeordneten Dateien und von Root reservierte Grundlagen.                      | `tests/i18n-api.test.js`, parallele Locales, REST/SSE, Sicherheits-/Versionsfälle. |
| Subagent Lerninhalte/Tutor | `concepts.js`, `projectTemplates.js`, `projects.js`, `learningReviews.js`, `teacher.js`, Kontext-Prompt-/Historyanpassung sowie Vorlagen-/Lernkataloge.                             | `tests/i18n-content.test.js`, Anbieterfixtures, Suite-/Hash-/Importregressionen.   |

Bevor die parallele Welle startet, werden insbesondere Änderungen in `sessions.js`, `storage.js`, `api.js`, `app.js`, `profileManager.js` und gemeinsamen Katalogen eindeutig zugeteilt oder sequenziell durchgeführt. Der Serveragent übersetzt nicht gleichzeitig die vom Inhaltsagenten bearbeiteten Dateien. Neue Tests bekommen getrennte Dateien; Baselines und globale Konfiguration bleiben unter einer Zuständigkeit.

Die englischen/spanischen Kataloge werden pro Namensraum vom jeweiligen Implementierer ergänzt und anschließend zusammen sprachlich geprüft. Kein Agent darf zum „Bereinigen“ der Texte Fehlercodes, IDs, Testwerte oder gespeicherte Originalinhalte umbenennen.

## 11. Prüfungen und Abschlusskriterien

### 11.1 Automatische Katalog-/Strukturprüfung

- Schlüssel auf fehlende/zusätzliche Einträge, leere Werte, gleiche Parameternamen und erforderliche Pluralkategorien prüfen. Pluralvarianten über ihren Basisschlüssel vergleichen, nicht blind dieselbe Anzahl von JSON-Schlüsseln je Sprache verlangen.
- JSON mit doppelten Schlüsseln zurückweisen; normales `JSON.parse()` allein erkennt diesen Fehler nicht. Hierfür einen geeigneten bestehenden Parser oder eine kleine Tokenprüfung einsetzen.
- Alle verwendeten statischen Schlüssel müssen existieren. Dynamische Status-/Fehlerschlüssel brauchen ausdrückliche erlaubte Tabellen und Prüfungen.
- Keine unbegründeten UI-Texte oder festen `de-DE`-Formatierungen außerhalb der dafür vorgesehenen Kataloge/Registry. Eine AST-/Ausgabestellenprüfung ergänzen; der aktuelle heuristische Scanner allein ist kein geeigneter harter „null Treffer“-Gate.
- Auf Katalogpfade, nicht erlaubte Locales und unbekannte Meldungsparameter prüfen. Kein `saveMissing`-Schreibendpunkt im Produktbetrieb.
- Erweiterung probeweise mit einer Testlocale prüfen: fachliche Module sollen dafür keine neue Verzweigung brauchen.

### 11.2 Regressionen für Daten, API und KI

| Prüfung                                                       | Erwartung                                                                                                                    |
| ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| Gleichzeitige HTTP-/SSE-Anfragen in Deutsch und Spanisch      | Keine globale Sprachvermischung; Fehlercodes/Status identisch.                                                               |
| Host-/Originfehler, fehlende Anmeldung und Einrichtung        | Lokalisierte eigene Meldungen bei unverändert wirksamen Prüfungen.                                                           |
| `CONFLICT`, Pfadfehler, Sessionlöschung, Abbruch/Recovery     | Fachliches Verhalten identisch, Aussagen in allen drei Sprachen korrekt.                                                     |
| Alte Session ohne Locale, alte Fragen und Klartext-Runnerjobs | Lesbar; keine schreibende Übersetzung des Verlaufs.                                                                          |
| Reiner UI-Sprachwechsel                                       | Quellhash, Suite-Digest, Dateiversionen und alter Modellverlauf unverändert.                                                 |
| Neue/wechselnde Tutorsprache                                  | Im nächsten LM-Studio-/OpenAI-Prompt korrekt, auch nach Komprimierung; keine neue Antwort allein durch Einstellungsänderung. |
| Nutzerdefinierter Prompt und alte Promptmigration             | Eigene Anweisung erhalten; keine Erkennung von Regeln über neu übersetzten Wortlaut.                                         |
| Vorlage erneut mit derselben `operationId` importieren        | Dasselbe Ergebnis; andere materialisierte Sprache unter derselben Operation erzeugt einen definierten Konflikt.              |
| Projekte exportieren/importieren                              | Locale-/Provenienzfelder bleiben gültig; Originaldateien und Hashes stimmen.                                                 |
| Alle lokalisierten Pythonaufgaben und Projektvarianten        | Gleiche fachliche Tests; erwartete Literale werden nicht versehentlich übersetzt.                                            |
| Tracer-/Previewmarker versus Nutzerstring                     | Nur eigene Metadaten werden lokalisiert; ein identischer vom Nutzer ausgegebener deutscher Satz bleibt Originaltext.         |

Die vorhandenen Vitest-Suiten für Sessions/Workspace, Programme/Runner, Grading, Profile, Vorschläge, Context und Token-Effizienz sind gezielt weiterzuverwenden. Fachtests sollten stabile Codes/Metadaten prüfen; eigene wenige Texttests prüfen die tatsächliche Übersetzung. Deutsche Testbeschreibungen müssen nicht aus Prinzip übersetzt werden.

### 11.3 Browser- und Layoutmatrix

Die bestehenden E2E-Tests erwarten viele deutsche zugängliche Namen. Ihre Sprache wird ausdrücklich auf Deutsch gesetzt, damit das Ergebnis nicht von der Host-/Browsereinstellung abhängt. Neue internationale Tests ergänzen die Abdeckung; nicht einfach alle Textprüfungen durch IDs ersetzen.

In allen drei Sprachen prüfen:

1. Start, Einrichtung/Login, fehlerhaftes Passwort, Passwortwechsel und Abmeldung.
2. Session erstellen/öffnen, Programmiersprache wählen, Dateien speichern, lokalen Stand wiederherstellen und Konflikte auflösen.
3. KI-Verbindung, Offlinebetrieb ohne Modell, Chatstream, Abbruch, Fortsetzung und Lernplanfragen.
4. Änderungen prüfen/übernehmen/ablehnen/rückgängig; lange Begründungen und Hunktexte.
5. Terminal und Runtimefehler; Programminstallation mit sechs Schritten, Reparatur, Cache und Neustartzustand.
6. Aufgaben, Testfälle, Hinweise, Journal, Wiederholung, Profil und Projektimport/-export.
7. Tracer, Web-Vorschau, historische/abgelaufene Artefakte, Originalfehlermeldung und Quellenavigation.
8. Sprachwechsel mit Editor-/Chat-/Journalentwurf, fehlgeschlagenem Speichern, leerem/gefülltem Terminaleingabefeld, aktiver Arbeit und erneutem Seitenaufruf.
9. Monaco-Suchen/Ersetzen, Kontextmenü und eigene Aktion in der richtigen Sprache.
10. `lang`, Fokus, Dialognavigation, Tooltips, Resizer-/Iconbeschriftungen und Fehlermeldungen für assistive Technik.

Native Browservalidierung ist ein eigener Fall: `reportValidity()` verwendet unter Umständen die Browsersprache. Für die wichtigen sichtbaren Feldfehler eigene lokalisierte Texte/`setCustomValidity()` einsetzen und bei Eingabe zurücksetzen; native Dateiauswahldialoge und Passwortmanager bleiben Browser-/Betriebssystemoberfläche.

Layout bei **800, 1024, 1366 und 1920 px**, in Dunkel, Hell, Hoher Kontrast und Solarized prüfen. Englisch/Spanisch und eine künstlich verlängerte Testdarstellung müssen in Header, Toolbar, Statusleiste, Dialogen und Fortschrittsanzeigen funktionieren. Die festen Höhen/Breiten und `white-space: nowrap` in `style.css` sind dabei gezielte Prüfpunkte.

Vorhandene deutsche Screenshotbaselines erhalten beziehungsweise nur nach visueller Prüfung aktualisieren. Gezielte englische/spanische Screenshots für enge Ansichten und große Dialoge ergänzen. Tests dürfen für die wesentlichen Übersetzungen nicht ausschließlich dieselben Katalogwerte als Erwartung laden, die die Implementierung verwendet; sonst blieben falsche Übersetzungen unentdeckt.

### 11.4 Auslieferung und Befehle

App- und Runner-Dockerfile kopieren ein neues Rootverzeichnis wie `shared/` derzeit nicht. Die Umsetzung muss die notwendigen Dateien ausdrücklich in die richtigen Images aufnehmen. Die App hat i18next als Produktionsabhängigkeit; der Runner bleibt ohne diese Paketabhängigkeit startfähig. Nur fest ausgewählte Bibliotheks-/Katalogpfade öffentlich ausliefern, nicht pauschal `node_modules` oder das gesamte `shared`-/Serververzeichnis freigeben.

Vorgesehene Prüfungen nach der Implementierung:

```powershell
node scripts/audit-i18n.mjs
node scripts/check-i18n.mjs
npm test
npm run test:e2e
npm run format:check
docker compose build
npm run test:docker
```

Die erforderlichen Voraussetzungen und die tatsächlich gestarteten Containerchecks werden vor Ausführung anhand von `DOCKER-BETRIEB.md` festgelegt. Für lokale/Windows-spezifische und Linux-/Docker-Prüfungen die Ergebnisse getrennt nennen; übersprungene Runtime-/Plattformfälle ausdrücklich dokumentieren. Betriebliche Abnahmen gehören nach `docker/ABNAHME.md`. Es sind keine Änderungen an Firewall, Secrets oder laufenden persönlichen Workspaces für die i18n-Prüfung nötig.

### 11.5 Definition von fertig

Die Implementierung ist fertig, wenn:

- Deutsch, Englisch und Spanisch für sämtliche hier eingeplanten Produktbereiche nutzbar sind, einschließlich Voranmeldung, Fehlern und Monaco.
- Die deutsche Ausgangsfunktion erhalten ist; Sprachwahl und Rückfall verlässlich funktionieren.
- Ein Sprachwechsel keine offenen Texte, Versionsschutzmechanismen oder Datenhistorie beschädigt und keine Aktionen wiederholt.
- Oberfläche, Tutorsprache und Programmiersprache unabhängig und verständlich sind.
- Neue Inhalte richtig lokalisiert erzeugt werden, alte Inhalte aber ohne automatische Umschreibung weiter funktionieren.
- Kataloge, Sicherheits-/Datenregressionen, relevante E2E-Abläufe und tatsächlich verfügbare Containerchecks bestanden sind.
- Das Inventar pro Fundstelle zugeordnet oder begründet ausgenommen ist und keine ungeklärten Textpfade übrig bleiben.
- Für eine zusätzliche Sprache Registry, Kataloge und Prüfungen genügen; Dateinamen-, Status- oder Programmiersprachenverträge dafür unverändert bleiben.

## 12. Historische Prüfung der Planungsrunde vor der Implementierung

Ausgeführt wurden Quelltextinventarisierung, strukturierte Extraktion aller berücksichtigten Dateien, ergänzende Suchen nach Anzeige-/Formatierungsstellen, Prüfung nicht ausgewählter Wortliterale, die lokale Prüfung der spanischen Pluralregeln sowie die Sichtung der vorhandenen Monaco-0.47.0-Sprachdateien und kritischer Speicher-/Hashpfade. Der Scanner lief ohne Parserfehler unter Node **24.19.0** und Python **3.12.10**. Quellprüfsummen, eindeutige Fundstellen-IDs, Summen und acht repräsentative Textpfade wurden separat geprüft; `npm run format:check` war erfolgreich.

Für die neue i18n-Implementierung wurden noch keine Funktions-, E2E- oder Docker-Abnahmen behauptet; die Anwendungsimplementierung ist Gegenstand der nächsten Runde. Der Scanner ist ein Planungswerkzeug und installiert keine neuen Abhängigkeiten. Er benötigt die bereits vorhandenen npm-Entwicklungsabhängigkeiten sowie Python für die zwei Python-Quelldateien.

Wiederholung der Bestandsaufnahme im Workspace-Hauptverzeichnis:

```powershell
node scripts/audit-i18n.mjs
```

Mit `node scripts/audit-i18n.mjs --print-unselected-words` lassen sich zusätzlich verbleibende Wortliterale prüfen. Neue, noch nicht versionierte Anwendungsdateien berücksichtigt diese Bestandsversion des Scanners nicht; vor einem späteren Abschluss entweder deren Git-Dateiliste aufnehmen oder die Dateiauswahl gezielt um sichere unversionierte Quellpfade erweitern. Die endgültige CI-Prüfung aus Etappe 1/6 braucht ohnehin einen strengeren Ausgabestellen-/Schlüsselvertrag als eine reine Deutschheuristik.
