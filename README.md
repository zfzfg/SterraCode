# SterraCode

Lokale Coding-Lernumgebung mit Monaco-Editor, Dateiverwaltung, Lernplan, Terminal und einem KI-Tutor über LM Studio. Die Oberfläche verwendet lokale SVG-Icons und vier Themes.

## Starten

Empfohlen: Node.js 24 LTS. Unterstützt werden Node 22 ab 22.12, Node 24 und Node ab 26.

```powershell
npm install
npm start
```

Anschließend `http://localhost:3000` öffnen. Alternativ `start.bat` oder `start.ps1` verwenden. Der Server bindet ausschließlich an `127.0.0.1`. `npm run dev` startet den Node-Watchmodus.

In LM Studio einen lokalen Server starten und ein Modell mit Tool-Unterstützung laden. URL und Modell lassen sich in den Einstellungen auswählen. Sessions, Dateien und Lernpläne funktionieren auch offline.

## Bedienung

- **Neue Session:** Sprache auswählen; die einmalige Lernplanfrage kann auch offline beantwortet werden.
- **Dateien:** Dateien und Ordner erstellen, öffnen, umbenennen und löschen. Änderungen werden automatisch gespeichert. `Strg+S` speichert sofort; Datei- und Sessionwechsel warten auf das Speichern.
- **Speicherkonflikte:** Der Speicherstatus öffnet einen Vergleich. Lokale Änderungen können als separate Datei gesichert werden. Neuere Serverstände werden nicht still überschrieben. Ungespeicherter Text wird zusätzlich im lokalen Browserspeicher gesichert.
- **KI-Änderungen:** Direkt in der jeweiligen Chatkarte rückgängig machen. Das Rückgängig-Symbol neben dem Speicherstatus öffnet die unabhängige Änderungshistorie, auch nach dem Entfernen von Chatnachrichten.
- **Ausführen:** `Strg+Enter` führt die aktive Datei im Workspace aus. Das Terminal unterstützt Befehle, Programmeingaben und das Stoppen vollständiger Prozessbäume. Beim Löschen einer Session werden deren Prozesse beendet.
- **Lernplan:** Themen selbst oder mit dem KI-Tutor bearbeiten und abhaken. Nach Abschluss erscheint einmalig eine Anschlussfrage.
- **Layout:** Bereiche per Maus oder fokussierter Trennlinie mit Pfeiltasten anpassen. Unter 1280 px wird die Seitenleiste überlagert; unter 960 px sind Editor und Chat umschaltbare Ansichten.

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

## Tests

```powershell
npm test
npx playwright install chromium
npm run test:e2e
npm run format:check
```

Vitest prüft Migration, Pfadgrenzen, Schreibkonflikte, Rückgängig, Chat-Streaming mit simuliertem LM Studio und Prozesse. Installierte Sprachlaufzeiten erhalten echte Ausführungstests; fehlende Laufzeiten werden ausdrücklich übersprungen und zusätzlich über den Fehlerpfad geprüft.

Playwright prüft Bedienabläufe, Offlinezustände, Tastaturdialoge, verspätete Antworten sowie Screenshotvergleiche für vier Fenstergrößen und vier Themes. Die Referenzbilder liegen plattformspezifisch neben den Browsertests. Nach absichtlichen Designänderungen Referenzen mit `npm run test:e2e -- --update-snapshots` aktualisieren und visuell prüfen.

## API-Grundlagen

- Dateiinhalt liefert `version`; Schreiben benötigt `expectedVersion`. Konflikte antworten mit HTTP `409`.
- Sessions verwenden `schemaVersion`, `revision`, `activeFile` und `openFiles`.
- Chat verwendet stabile Nachrichten-, Fragen- und Turn-IDs. Wiederholte abgeschlossene Turn-IDs führen Tools nicht erneut aus.
- `GET /api/workspaces/:sessionId/changes` und `POST /api/workspaces/:sessionId/changes/:changeId/undo` verwalten KI-Dateiänderungen.
- Terminalprozesse haben eigene `processId`-Werte und sind an eine Session gebunden. `GET /api/runtimes` liefert Verfügbarkeit und konkrete Fehlergründe.
