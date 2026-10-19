# SterraCode

Coding-Lernumgebung mit Monaco-Editor, Dateiverwaltung, Lernplan, Terminal und einem KI-Tutor über LM Studio oder die OpenAI API. Lokal per npm oder als geschützter Docker-Server im LAN. Die Oberfläche verwendet lokale SVG-Icons und vier Themes.

## Docker-Server unter Windows und Linux

Voraussetzung: Docker Engine mit Compose oder Docker Desktop mit **Linux-Containern**. Node, Compiler und zusätzliche Sprachlaufzeiten werden im Container verwaltet. Die erste unterstützte Architektur ist `linux/amd64`.

```powershell
.\install.ps1
```

```sh
bash install.sh
```

Der Installer ermittelt eine LAN-Adresse, erzeugt `.env`, baut die Images und zeigt einen einmaligen Einrichtungsschlüssel. Im Browser ein Administratorpasswort setzen und unter **Einstellungen → Programme** zusätzliche Laufzeiten installieren. Ein erneuter Installer-Aufruf erhält Konfiguration, Volumes und Passwort. Ohne LM Studio funktionieren Sessions, Dateien und Programmausführung.

Starten und Stoppen: `start-docker.ps1` / `stop-docker.ps1` beziehungsweise `bash start-docker.sh` / `bash stop-docker.sh`. [DOCKER-BETRIEB.md](DOCKER-BETRIEB.md) beschreibt Konfiguration, Domains, LM Studio, Import, Sicherung und Wiederherstellung sowie die noch offenen Plattformnachweise. Der bisherige lokale Start bleibt erhalten.

## Starten

Empfohlen: Node.js 24 LTS. Unterstützt werden Node 22 ab 22.12, Node 24 und Node ab 26.

```powershell
npm install
npm start
```

Anschließend `http://localhost:3000` öffnen. Alternativ `start.bat` oder `start.ps1` verwenden. Der Server bindet ausschließlich an `127.0.0.1`. `npm run dev` startet den Node-Watchmodus.

In LM Studio einen erreichbaren Server starten und ein Modell mit Tool-Unterstützung laden. Es kann auf diesem Rechner, einem anderen LAN-Rechner oder hinter einer externen HTTPS-Adresse laufen. Alternativ unter Einstellungen die OpenAI API auswählen, den Schlüssel unter **KI-Zugangsdaten** hinterlegen und die gewünschte Modell-ID wählen. Sessions, Dateien und Lernpläne funktionieren auch offline.

## Bedienung

- **Neue Session:** Sprache auswählen; die einmalige Lernplanfrage kann auch offline beantwortet werden.
- **Dateien:** Dateien und Ordner erstellen, öffnen, umbenennen und löschen. Änderungen werden automatisch gespeichert. `Strg+S` speichert sofort; Datei- und Sessionwechsel warten auf das Speichern.
- **Speicherkonflikte:** Der Speicherstatus öffnet einen Vergleich. Lokale Änderungen können als separate Datei gesichert werden. Neuere Serverstände werden nicht still überschrieben. Ungespeicherter Text wird zusätzlich im lokalen Browserspeicher gesichert.
- **KI-Änderungen:** Direkt in der jeweiligen Chatkarte rückgängig machen. Das Rückgängig-Symbol neben dem Speicherstatus öffnet die unabhängige Änderungshistorie, auch nach dem Entfernen von Chatnachrichten.
- **Ausführen:** `Strg+Enter` führt die aktive Datei im Workspace aus. Das Terminal unterstützt Befehle, Programmeingaben und das Stoppen vollständiger Prozessbäume. Beim Löschen einer Session werden deren Prozesse beendet.
- **Ablauf ansehen:** Zeichnet die aktuelle Python-Datei nach dem Speichern auf, optional mit ausdrücklich ausgewählten lokalen Hilfsdateien und vorab festgelegter stdin-Eingabe. Zeitleiste, Wiedergabe, Vorwärts-/Rückwärtsschritte, Fehlersprung, Aufrufstack und Variablen zeigen den unveränderlichen Originalstand. Eine freiwillige Vorhersage funktioniert ohne KI; „Trace im Chat vorbereiten“ legt eine Frage zum gespeicherten Lauf in das Eingabefeld.
- **Lernplan:** Themen selbst oder mit dem KI-Tutor bearbeiten und abhaken. Nach Abschluss erscheint einmalig eine Anschlussfrage.
- **Layout:** Bereiche per Maus oder fokussierter Trennlinie mit Pfeiltasten anpassen. Unter 1280 px wird die Seitenleiste überlagert; unter 960 px sind Editor und Chat umschaltbare Ansichten.
- **Kontext:** `/usage` zeigt die Modellnutzung und Messqualität; das funktioniert auch offline mit gekennzeichneten Schätzwerten. `/compact` oder `/compress` komprimiert ältere Gesprächsabschnitte ohne Tutorantwort. Der vollständige Chat und alle Werkzeugergebnisse bleiben gespeichert. Der Editor-Menüpunkt zur Zusammenfassung verwendet dieselbe Aktion.

## Kontextkomprimierung

Der integrierte Kern von context-compressor 0.8.3 arbeitet direkt im SterraCode-Backend. Das separate LM-Studio-Plugin muss nicht installiert werden. Herkunft und Anpassungen stehen in [ORIGIN.md](server/services/context/ORIGIN.md).

SterraCode verbindet sich über das native LM-Studio-SDK 2.1.0 mit der eingestellten Serveradresse. Die Modellauswahl zeigt geladene Modelle. Vor jedem Modellaufruf wird der tatsächliche Prompt mit dem Modelltemplate einschließlich Werkzeugdefinitionen tokenisiert. Das Antwortlimit wird als Reserve freigehalten. Fehlen genaue Messwerte oder passt der minimale Auftrag nicht, stoppt die Antwort mit einem Lösungshinweis; Datei- und Sessionarbeit bleiben verfügbar.

Automatische Komprimierung startet standardmäßig bei 75 % und verkleinert den Kontext möglichst auf 55 %. Das gilt auch zwischen Werkzeugrunden. Neuere Inhalte bleiben möglichst wörtlich; die aktuelle Nutzeranweisung bleibt immer wörtlich erhalten. Der ursprüngliche Nutzerauftrag wird zusätzlich direkt als historischer Beleg bewahrt, soweit das Budget reicht (höchstens 1.024 Tokens); Onboarding-Antworten sind davon ausgenommen. Standardbudgets: 6.000 Tokens neuester Kontext, 16.000 je Quellabschnitt, 1.500 je Zusammenfassung und 12.000 insgesamt. Werkzeugausgaben erhalten 4.000 Tokens je Ergebnis und 20.000 insgesamt pro Runde. Kleine Kontextfenster verwenden entsprechend verkleinerte Budgets; `/usage` zeigt die effektiven Werte. Einstellungen stehen unter „Erweiterte Einstellungen“.

Große Werkzeugergebnisse werden nur in der Modellansicht gekürzt. `read_tool_result` macht das gespeicherte Original portionsweise lesbar. Aufgaben, Lernpläne, offene Fragen, Dateiänderungen und Prozessstatus werden zusätzlich strukturiert erhalten. Historische Belege erteilen keine neuen Ausführungsfreigaben. Beendete Aktionen werden beim Wiederholen eines gespeicherten Turns nicht erneut gestartet; bei unterbrochener Ausführung mit unbekanntem Ergebnis wird dieser Zustand ausdrücklich vermerkt.

Zusammenfassungen werden pro Session unter `context/<Session-UUID>/cache.json` gespeichert. Der Cache ist atomar geschrieben und begrenzt; nach Bearbeiten, Löschen oder Rückgängig werden nur noch passende Verlaufsprefixe verwendet. Alte Session-Zusammenfassungen bleiben als Altdaten erhalten. Bei der ersten Übernahme werden Einstellungen und Session gesichert; die alten nachrichtenbasierten Komprimierungswerte werden durch die neuen Defaults ersetzt. Das Workspace-Schema bleibt unverändert. Beim Löschen einer Session wird auch ihr Cache gesichert und aus dem aktiven Kontextverzeichnis entfernt.

## Daten und Migration

Alle persönlichen Daten liegen unter `server/data/` und werden von Git ausgeschlossen. `STERRACODE_DATA_DIR` kann ein anderes, absolutes Datenverzeichnis vorgeben; Tests verwenden eigene temporäre Verzeichnisse.

Bestehende Sessions werden beim ersten Öffnen übernommen:

1. Session und bisheriger Workspace werden unter `backups/` gesichert.
2. Dateien werden in `workspaces/<Session-UUID>/` kopiert. Alte Ordner bleiben erhalten; gleiche Sessionnamen erhalten getrennte Workspaces.
3. Editor-Snapshots werden in die passende Startdatei übernommen. Bei abweichendem Inhalt entsteht `recovered-editor-N.<Endung>`.
4. Ein Migrationsjournal ermöglicht das Fortsetzen nach einem unterbrochenen Commit. Bei uneindeutigen oder veränderten Daten stoppt die Migration mit einer Fehlermeldung.

Neue Speicherungen betreffen echte Dateien. `changes/` enthält die dauerhafte KI-Änderungshistorie einschließlich vorheriger Inhalte. Dateien und Sessions werden vor dem Löschen gesichert. Explizites Timeout `0` bleibt erhalten; neue Installationen verwenden 30 Sekunden Ausführungs- und 60 Sekunden Kompilierungszeit.

Vor einer manuellen Wiederherstellung den Server beenden und den gesamten Datenordner kopieren. Die Sicherungsordner enthalten die ursprüngliche Session-JSON und den zugehörigen Workspace. Sicherungen und alte Ordner werden nicht automatisch entfernt.

## Ausführung

Unterstützt: Python, JavaScript/Node.js, Bash, Go, Rust, C++, C# mit .NET SDK ab Version 6 und Java mit JDK. Fehlende oder deaktivierte Laufzeiten werden angezeigt. Die Anwendung installiert keine Sprachlaufzeiten automatisch.

Pro Session läuft höchstens ein Prozess. Kompilierung und Ausführung verwenden denselben Prozessdienst wie KI-Befehle. Die kombinierte Ausgabe ist auf 1 MiB begrenzt; bei Erreichen des Limits wird der Prozessbaum beendet. Quelldateien bleiben im Workspace, temporäre Compilergebnisse liegen unter `runs/`.

Die Ausführung verwendet die Rechte des lokalen Benutzers; sie ist keine Betriebssystem-Sandbox. KI-Terminalbefehle können in den Einstellungen deaktiviert werden. Host- und Ursprungsprüfungen begrenzen API-Zugriffe auf die lokale Oberfläche.

### Aufgezeichnete Python-Abläufe

Der Tracer beobachtet den Hauptthread und ausschließlich die ausgewählten Python-Quellen. Ein Zeilenereignis zeigt den Zustand **vor** der markierten Zeile; eine aufgetretene Ausnahme kann später abgefangen werden. Erst das Gesamtergebnis unterscheidet einen unbehandelten Programmfehler. Gemeinsam referenzierte Container behalten dieselbe Objekt-ID. Eigene `repr`-Methoden, Properties und Iteratoren benutzerdefinierter Objekte werden zur Darstellung nicht aufgerufen. Interne Variablen mit `__` am Anfang werden ausgeblendet.

Pro Snapshot gelten höchstens 20 Python-Dateien und insgesamt 1 MiB UTF-8-Quelltext. Die Aufzeichnung endet bei 1.000 Ereignissen oder 2 MiB Trace-Daten; ein externer Wächter beendet den Prozessbaum nach zehn Sekunden, auch bei normalem Ausführungs-Timeout `0`. Die Wertansicht begrenzt Tiefe auf vier, Container auf 20 Einträge, Texte auf 250 Zeichen und den Stack auf 30 Frames; zusätzlich gilt ein Budget von 200 dargestellten Werten pro Ereignis. Kürzungen sind gekennzeichnet. Threads, asynchrone Abläufe und native Bibliotheksdetails sind nicht vollständig beobachtbar. Rückwärtsschritte führen keinen Code erneut aus und machen keine Seiteneffekte rückgängig.

Lokale Ausführung und Docker-Runner verwenden denselben festen Wrapper unter `runner/tracer/`, einen eigenen Trace-Modus und getrennte Programm-/Trace-Ausgaben. Python muss installiert und freigegeben sein. Die Laufzeit meldet ihre `modes`; ältere Runner ohne `trace`-Fähigkeit werden ausdrücklich abgewiesen. App und Runner gemeinsam aktualisieren. Ein belegter Session-Prozess wird nicht automatisch beendet.

`POST /api/workspaces/:sessionId/traces` erhält `operationId` (UUID), `entry`, `expectedVersions` (Pfad → SHA-256) und optional `stdin`. Die Antwort ist `202`. `GET .../traces` listet die letzten 20 Vorgänge, `GET .../traces/:traceRunId` liefert Status und Snapshot, `GET .../events?fromStep=1&limit=50` höchstens 50 Schritte und `POST .../cancel` stoppt den Lauf idempotent. Gleiche Operations-ID mit anderem Inhalt ergibt `409`; gleiche Anfrage startet keinen zweiten Prozess. Neuladen, Verbindungsfehler und Neustarts lesen vorhandene Belege nach. Der Tutor kann mit `inspect_execution_trace` zunächst die Zusammenfassung und anschließend begrenzte Ausschnitte lesen; dieses Werkzeug startet keinen Lauf.

Unter `traces/<Session-UUID>/` werden Metadaten und Operationsbelege getrennt von Quellsnapshot und Ereignis-/Ausgabeartefakten gespeichert. Ereignisse werden während des Laufs laufend gesichert. Abgebrochene oder beschädigte Aufzeichnungen bleiben ausdrücklich unvollständig. Fertige Artefakte verfallen nach 24 Stunden; beim Starten/Listen werden höchstens die neuesten 20 fertigen Artefakte erhalten, zusätzlich läuft stündlich eine Bereinigung. Aktive Vorgänge bleiben erhalten. Bei Ablauf verbleiben Status `expired`, Operationsbeleg und Dateimanifest. Beim Löschen einer Session werden Traces mitgesichert und aus den aktiven Daten entfernt. Der Tracer ist ein Diagnosewerkzeug und erweitert die Ausführungsisolation nicht.

### Aufgaben mit Python-Funktionstests

Aufgaben können über `create_task` eine sichtbare `testSuite` erhalten. Die Aufgabenkarte bietet **Lösung prüfen**, erwartete und erhaltene Werte samt Typ, Fehlernavigation, Abbruch, gespeicherte Läufe und **Aufgabe abschließen**. Das funktioniert ohne Modellverbindung. Unter „Python-Quelldateien im Snapshot auswählen“ werden die Einstiegsdatei und benötigte lokale Module ausgewählt. Die Oberfläche speichert offene Änderungen vor dem Start. Auf kleinen Fenstern liegt die Aufgabenkarte im Tab **KI-Tutor**. „Testergebnis im Chat vorbereiten“ übergibt die Lauf-ID freiwillig an den Tutor.

Die Suite verwendet `schemaVersion: 1`, `version: 1`, `language: "python"`, `entry: {path: "main.py", function: "reverse_string"}`, `comparison: {kind: "strict-json"}` und `cases`. Jeder Fall enthält beispielsweise `{id: "word", name: "Wort", args: ["hello"], expected: "olleh", visibility: "public", required: true}`. Ein zweiter Randfall verwendet `args: [""]` und `expected: ""`. `conceptIds` und `assessmentMode: "tests"` sind optionale Aufgabenfelder. Alte Aufgaben ohne Suite behalten einen als `manual` gekennzeichneten Abschluss; historische Tutorabschlüsse erhalten keinen nachträglichen Testnachweis.

Jeder Fall läuft in einem frischen Python-Prozess mit eigener Kopie desselben Quellsnapshots. Die ganze Suite reserviert einen Prozess-Slot. Grenzen: 20 Fälle, 256 KiB Suite/JSON-Daten, 20 Python-Quellen mit zusammen 1 MiB, zwei Sekunden je Fall und 30 Sekunden je Suite, jeweils 64 KiB Rückgabe und Programmausgabe pro Fall. Ausgabe wird gekürzt und weiter abgeleitet. Ein fester Wrapper außerhalb des Workspace schreibt Rückgabedaten getrennt von stdout; erwartete Werte vergleicht ausschließlich der Server. Strings und Reihenfolgen werden exakt verglichen, Boolesche Werte von Zahlen unterschieden. Unterstützt sind null, Boolesche Werte, Strings, endliche Zahlen im sicheren JSON-Bereich, Listen und Objekte mit Stringschlüsseln (Tiefe höchstens 20). Mengen, Tupel, Zyklen und nicht endliche Zahlen erzeugen einen Serialisierungsfehler. Interaktives `input()` und verdeckte Tests gehören nicht zu diesem Format.

Die API unter `/api/workspaces/:sessionId` bietet:

- `POST /tasks/:taskId/test-runs`: `operationId` (UUID), `taskVersion` und `expectedVersions` (Pfad → SHA-256); antwortet mit `202` und `testRunId`. Derselbe Auftrag startet auch nach einem Neustart keinen zweiten Lauf.
- `GET /tasks/:taskId/test-runs`, `GET /test-runs/:testRunId` und `POST /test-runs/:testRunId/cancel`: Historie, freigegebene Ergebnisse und idempotenter Abbruch. `current: false` kennzeichnet veraltete Belege.
- `PATCH /tasks/:taskId`: Änderungen mit der bisherigen `taskVersion`; Aufgaben-/Suiteversion werden erhöht, der vorherige Stand in `taskHistory` archiviert.
- `POST /tasks/:taskId/complete`: `taskVersion`, bei Testaufgaben zusätzlich `testRunId`, optional `feedback`. Abschluss nur bei bestandenen erforderlichen Fällen und unverändertem Aufgaben-, Suite- und Quellstand; Konflikte liefern `409`.

`run_task_tests` verwendet denselben Dienst und respektiert die Sperre für KI-Terminalausführung; `read_task_test_results` liest vorhandene Ergebnisse ohne Neustart. Kontextkomprimierung erhält Lauf-IDs und Wiederaufnahmehinweise. Abschlüsse erzeugen einen dauerhaften Session-/Aufgabenbeleg. Profilaktualisierungen respektieren das bestehende Opt-in, zählen dieselbe Aufgabe auch nach Versionswechseln nur einmal und werden nach einem unterbrochenen Profilcommit innerhalb einer Minute nachgeholt. Technische Fehler und bloße Versuche erhöhen die Erfolgsstatistik nicht.

Unter `test-runs/<Session-UUID>/` bleiben Quellsnapshot, Definition und begrenzte Ergebnisse gespeichert. Fertige Artefakte verfallen nach 24 Stunden; höchstens die neuesten 20 fertigen Läufe behalten ihre großen Daten. Bereinigung erfolgt beim Starten/Listen und jede Minute. Operationsbeleg, Versionen, Zusammenfassung und Abschlussnachweis bleiben erhalten, abgelaufene Artefakte werden als `expired` angezeigt. Aktive Läufe werden nicht gelöscht. Session-Löschung sichert die Testläufe mit und entfernt sie aus den aktiven Daten.

Lokal und im Docker-Runner heißt der Modus `test`, Fähigkeit `testAdapterVersion: 1`; App und Runner gemeinsam aktualisieren. Die vorhandenen Ausführungsrechte bleiben bestehen: Das Harness liefert Lernfeedback und ist kein manipulationssicheres Prüfungssystem.

## Tests

```powershell
npm test
npx playwright install chromium
npm run test:e2e
npm run format:check
npm run test:context:live
node tests/docker/trace-smoke.mjs
node tests/docker/grading-smoke.mjs
```

Vitest prüft Migration, Pfadgrenzen, Schreibkonflikte, Rückgängig, Chat-Streaming mit simuliertem LM Studio und Prozesse. Installierte Sprachlaufzeiten erhalten echte Ausführungstests; fehlende Laufzeiten werden ausdrücklich übersprungen und zusätzlich über den Fehlerpfad geprüft.

Die Kontextprüfungen umfassen die übernommenen Compressor-Kerntests sowie native SDK-Vertragstests für Budgetgrenzen, Abbruch, Neustart, Verlaufskorrekturen, Wiederherstellung gekürzter Ergebnisse und lange Werkzeugketten. Der Live-Test benötigt das ausgewählte geladene Modell und verwendet ausschließlich ein temporäres Datenverzeichnis. Er prüft eine Konversation über der Kontextgrenze, Erinnerung an drei festgelegte Fakten sowie echtes Datei-Schreiben und Rückgängig. `npm run test:context:live -- --load` lädt bei Bedarf das konfigurierte, bereits lokal vorhandene Modell als temporäre 8k-Testinstanz und entlädt diese anschließend.

Playwright prüft Bedienabläufe, Offlinezustände, Tastaturdialoge, verspätete Antworten sowie Screenshotvergleiche für vier Fenstergrößen und vier Themes. Die Referenzbilder liegen plattformspezifisch neben den Browsertests. Nach absichtlichen Designänderungen Referenzen mit `npm run test:e2e -- --update-snapshots` aktualisieren und visuell prüfen.

## API-Grundlagen

- Dateiinhalt liefert `version`; Schreiben benötigt `expectedVersion`. Konflikte antworten mit HTTP `409`.
- Sessions verwenden `schemaVersion`, `revision`, `activeFile` und `openFiles`.
- Chat verwendet stabile Nachrichten-, Fragen- und Turn-IDs. Wiederholte abgeschlossene Turn-IDs führen Tools nicht erneut aus.
- `GET /api/workspaces/:sessionId/changes` und `POST /api/workspaces/:sessionId/changes/:changeId/undo` verwalten KI-Dateiänderungen.
- Terminalprozesse haben eigene `processId`-Werte und sind an eine Session gebunden. `GET /api/runtimes` liefert Verfügbarkeit und konkrete Fehlergründe.
- Chat-Endpunkte akzeptieren optional `contextAction: "compact" | "usage"`. Antworten enthalten `contextUsage` mit Promptgröße, Kontextfenster, Antwortreserve, Restbudget, Messqualität und Komprimierungsstand; `tokenCount` bleibt als Kompatibilitätswert erhalten. SSE ergänzt `context-progress`, `context-usage` und `context-report`. Kontextberichte sind gespeicherte UI-Ereignisse und werden nicht an das Modell zurückgesendet.
