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
- **KI-Änderungen:** Unter **Einstellungen → KI-Dateiänderungen** zwischen **Auto Accept – direkt einfügen** (Standard) und **Review – vor Übernahme prüfen** wählen. Chatkarten und das Rückgängig-Symbol neben dem Speicherstatus öffnen historische Diffs beziehungsweise gespeicherte Vorschläge. Die unabhängige Historie bleibt auch nach dem Entfernen von Chatnachrichten erreichbar.
- **Ausführen:** `Strg+Enter` führt die aktive Datei im Workspace aus. Das Terminal unterstützt Befehle, Programmeingaben und das Stoppen vollständiger Prozessbäume. Beim Löschen einer Session werden deren Prozesse beendet.
- **Ablauf ansehen:** Zeichnet die aktuelle Python-Datei nach dem Speichern auf, optional mit ausdrücklich ausgewählten lokalen Hilfsdateien und vorab festgelegter stdin-Eingabe. Zeitleiste, Wiedergabe, Vorwärts-/Rückwärtsschritte, Fehlersprung, Aufrufstack und Variablen zeigen den unveränderlichen Originalstand. Eine freiwillige Vorhersage funktioniert ohne KI; „Trace im Chat vorbereiten“ legt eine Frage zum gespeicherten Lauf in das Eingabefeld.
- **Web-Vorschau:** Eine HTML-Datei öffnen und **Web-Vorschau** wählen. Lokale Stylesheets und klassische JavaScript-Dateien, DOM-Ereignisse, Canvas und eingebettetes SVG funktionieren ohne KI. Erfolgreiches Autosave aktualisiert nach kurzer Verzögerung; automatische Aktualisierung lässt sich pausieren. **Neu laden** erzeugt einen neuen Snapshot und leert das Log. Fehlerverweise öffnen die Quelle; **Im Chat vorbereiten** legt ausschließlich einen Entwurf an.
- **Lernplan:** Themen selbst oder mit dem KI-Tutor bearbeiten und abhaken. Nach Abschluss erscheint einmalig eine Anschlussfrage.
- **Layout:** Bereiche per Maus oder fokussierter Trennlinie mit Pfeiltasten anpassen. Unter 1280 px wird die Seitenleiste überlagert; unter 960 px sind Editor und Chat umschaltbare Ansichten.
- **Kontext:** `/usage` zeigt die Modellnutzung und Messqualität; das funktioniert auch offline mit gekennzeichneten Schätzwerten. `/compact` oder `/compress` komprimiert ältere Gesprächsabschnitte ohne Tutorantwort. Der vollständige Chat und alle Werkzeugergebnisse bleiben gespeichert. Der Editor-Menüpunkt zur Zusammenfassung verwendet dieselbe Aktion.

## Diff-Inspector und KI-Vorschläge

**Auto Accept** schreibt KI-Dateiänderungen unmittelbar; **Review** speichert zunächst nur einen Vorschlag. Beide Modi verwenden dieselben Versionsprüfungen und dieselbe Rücknahmehistorie. Die Einstellung gilt für folgende `write_file`-Aufrufe; bereits offene Vorschläge bleiben zur Entscheidung erhalten. Sie betrifft Dateiwerkzeuge, nicht die separat freigegebene Ausführung von Terminalbefehlen.

**Änderung ansehen** öffnet einen schreibgeschützten Monaco-Vergleich: nebeneinander in breiten Fenstern, zusammengeführt unter 900 px. „Nächster Unterschied“, die Hunk-Auswahl und alle Entscheidungen sind per Tastatur erreichbar; Escape schließt die Ansicht und gibt den Fokus zurück. Eigene Vergleichsmodelle werden beim Schließen freigegeben. Die vier Themes werden übernommen.

Im Review lassen sich alle oder einzelne **Teiländerungen** auswählen und gemeinsam übernehmen oder der Vorschlag ablehnen. Vor Übernahme speichert die Oberfläche offene Editoränderungen. Stimmen Datei und ursprüngliche Basis anschließend nicht mehr überein, folgt ein Konflikt statt eines automatischen Merges. Umbenannte, gelöschte oder zurückgenommene Dateien überschreibt der Vorschlag ebenfalls nicht. Nach Teilübernahme sind die übrigen Hunks geschlossen; weitere Änderungen benötigen einen neuen Vorschlag auf dem aktuellen Stand. Eine Übernahme erzeugt genau einen KI-Historieneintrag mit sicherem Undo.

Der Server berechnet feste Hunks aus den gespeicherten Texten. Änderungen mit weniger als sechs unveränderten Zwischenzeilen bilden einen gemeinsamen Block. Neu eingeführte Bezeichner, die in anderen Blöcken vorkommen, erzeugen konservative Auswahlabhängigkeiten. Diese Prüfung ersetzt keine semantische Codeanalyse; insbesondere nach Teilübernahme selbst prüfen und vorhandene Tests ausführen. Begründungen sind Erklärungen des Tutors, keine Korrektheitsbeweise. Der Client übermittelt ausschließlich Hunk-IDs, keine Patchtexte oder Zeilenpositionen.

Neue Änderungseinträge (Schema 2) bewahren Vorher- und Nachher-Inhalt, ursprünglichen Pfad, KI-Herkunft, Übernahmeaktion und gegebenenfalls Vorschlags-ID. Spätere Dateiänderungen verändern den historischen Vergleich nicht. Alte Einträge bleiben lesbar: Nur wenn der aktuelle Dateiinhalt die gespeicherte Nachher-Version besitzt, wird er als Nachher-Inhalt verwendet; andernfalls erscheint ein Hinweis auf die fehlende historische Grundlage.

Vorschläge (Schema 1) liegen unter `proposals/<Session-UUID>/`, Änderungen unter `changes/<Session-UUID>/` im Datenverzeichnis. Beide bleiben bis zur Sessionlöschung erhalten und werden mit deren Sicherung aufbewahrt. Vorschläge enthalten unveränderliche Basis- und Zieltexte, Hunks, Statusereignisse und einen Wiederaufnahmebeleg für die Übernahme. Neuladen oder ein neuer Serverprozess startet keinen zusätzlichen Schreibvorgang. Nach einem unterbrochenen Commit wird ein vorhandener Historieneintrag anhand seiner ID und Version zugeordnet. Abgelehnte und bereits entschiedene Vorschläge werden nicht erneut angewendet. Die Listenansicht liefert bis zu 100 Vorschläge, offene zuerst; einzelne IDs bleiben direkt abrufbar.

Grenzen: UTF-8-Text, höchstens 2 MiB pro Datei. Bei mehr als 1.000.000 Vergleichszellen oder insgesamt 10.000 Zeilen wird die Änderung als ein vollständiger Hunk angeboten. Monaco erhält maximal zwei Sekunden für die Diff-Berechnung. Mehrdatei-Transaktionen, semantische Refactorings und automatische Dreiwege-Merges sind nicht enthalten.

API unter `/api/workspaces/:sessionId` (bestehender Authentifizierungs-, Origin- und Pfadschutz gilt):

| Methode und Pfad                     | Bedeutung                                                                   |
| ------------------------------------ | --------------------------------------------------------------------------- |
| `GET /changes`                       | Historienübersicht                                                          |
| `GET /changes/:changeId`             | Historische Snapshots, `diffAvailable` und `historicalPath`                 |
| `POST /changes/:changeId/undo`       | Versionsgeprüfte, wiederholbare Rücknahme                                   |
| `GET /proposals`                     | Offene und zuletzt bearbeitete Vorschläge                                   |
| `GET /proposals/:proposalId`         | Basis, Zieltext, Hunks, Abhängigkeiten und aktueller Status                 |
| `POST /proposals/:proposalId/apply`  | `{operationId, expectedVersion, selectedHunkIds?}`; ohne Auswahl alle Hunks |
| `POST /proposals/:proposalId/reject` | Vorschlag dauerhaft ablehnen; identische Wiederholung bleibt wirkungsgleich |

`operationId` bei Übernahme ist eine UUID. Derselbe Vorgang mit identischer Auswahl schreibt höchstens einmal; eine anders verwendete Kennung oder eine veraltete Basis ergibt `409`. Eine explizite Auswahl muss gültig, eindeutig, nicht leer und abhängigkeitsvollständig sein. Eine nur teilweise übernommene Änderung meldet `partially_applied`; weitere Zustände sind `pending_review`, `applied`, `rejected`, `stale` und `undone`. Ein unveränderter Vorschlag ohne Hunks kann abgelehnt werden.

Der Tutor erhält im Review ausdrücklich `status: "proposed"`, `proposalId`, Pfad und Basisversion statt einer behaupteten Dateischreibung. Sein Turn kann danach enden; es bleibt keine Verbindung für die Entscheidung offen. Aktuelle Vorschlagszustände werden auch nach Kontextkomprimierung aus den dauerhaften Datensätzen gelesen. Tests beziehen sich stets auf die tatsächlich gespeicherten Dateien. Ein neuer Tutor-Turn sieht die inzwischen getroffene Entscheidung; eine automatische Fortsetzung wird nicht gestartet.

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

### Isolierte Web-Vorschau

In jeder bestehenden Session kann eine `.html`- oder `.htm`-Datei als Einstieg dienen. Der Vorschauknopf erscheint beim Öffnen einer solchen Datei. Ab 1600 px stehen Editor und Vorschau nebeneinander; unter 960 px schaltet **Editor anzeigen / Vorschau anzeigen** zwischen beiden um. Schließen entfernt den iframe; erneutes Öffnen erfasst den aktuellen Stand. Die Vorschau benötigt weder Modellverbindung noch installierte Sprachlaufzeit.

HTML wird mit `parse5`, CSS mit `css-tree` aufbereitet. Relative `.css`-Stylesheets (auch mehrere) und klassische `.js`-Skripte werden aus versionsgeprüften Workspace-Dateien eingebettet. Inline-JavaScript erhält eigene Daten-URLs mit ursprünglichen Dateinamen und Zeilennummern; `</script>` in einer externen JavaScript-Datei kann dadurch kein HTML einschleusen. Relative Pfade dürfen `./`, aber kein `..`, absolute Adressen, URL-Schemata oder Symlinks enthalten. Alle benötigten Quellen müssen mit SHA-256-Versionen angegeben werden. Bei geänderten oder fehlenden Versionen antwortet die API mit `409`; bereits angezeigte Ergebnisse bleiben ausdrücklich als veraltet markiert. Die bestehende UTF-8-Text-API und ihr Binärdatei-Dialog bleiben unverändert.

Bilder funktionieren als eingebettetes SVG oder Bild-Daten-URL; CSS-`url()` unterstützt Bild-Daten-URLs und SVG-IDs. Nicht unterstützt sind Module/Importmaps, Bundler, TypeScript, externe CDNs, CSS-`@import`, lokale Binärassets und Inline-Ereignisattribute wie `onclick` (stattdessen `addEventListener` verwenden). Die Aufbereitung weist diese Fälle zurück oder zeigt eine begrenzte Diagnose für entfernte Attribute/Elemente. Basis-URLs, Meta-Refresh, Frames und Plugins werden entfernt. Eine eigene Web-Sessionvorlage bleibt ein späterer Ausbau.

Die authentifizierte Dokumentroute liefert eine eigene CSP mit `sandbox allow-scripts`, ohne `allow-same-origin`, sowie `no-store`, `no-referrer` und eine restriktive Permissions Policy. Die Haupt-App-CSP wird nicht gelockert. Skripte und Styles werden nur als aufbereitete Daten eingebunden; `eval`, `fetch`/WebSocket, externe Ressourcen, weitere Frames, Worker, Formulare, Popups und Top-Navigation im iframe sind gesperrt. Cookies, App-DOM und App-Speicher bleiben getrennt. Auch direkt aufgerufene Dokumente behalten den Sandbox-Header; die Oberfläche bietet keinen Knopf zum Öffnen in einem neuen Tab. `Origin: null` erhält keinen API-Zugriff.

Die Sandbox ist keine vollständige Netzwerk- oder CPU-Isolation: JavaScript kann grundsätzlich eine Navigation seines eigenen Browsing-Kontexts versuchen; CSP `connect-src` ist keine Navigationssperre. Aufbereitete Links und Meta-Refresh werden entfernt, und normale Link-Klicks werden abgefangen. Beliebiger feindlicher Browsercode und Endlosschleifen gehören nicht zum Sicherheitsversprechen. Entfernen des iframe ist kein garantiertes CPU-Hardlimit.

Console-Bridge und Empfänger begrenzen Meldungen auf 200 Einträge, 256 KiB Textpuffer, 2.000 Zeichen je Nachricht und 40 Nachrichten je Sekunde. Eine Logflut erhält den Hinweis **Weitere Meldungen zusammengefasst**. Empfangene Nachrichten müssen aus dem aktuellen iframe stammen, Lauf- und Render-ID sowie das exakte Schema erfüllen. Alles erscheint als Text. Diagnosen sind nicht vertrauenswürdig und können keine Dateien ändern, Aufgaben abschließen oder Werkzeuge aufrufen. Quellverweise öffnen die aktuelle Datei; diese kann inzwischen vom ursprünglichen Snapshot abweichen.

API unter `/api/workspaces/:sessionId`:

- `POST /preview-runs`: `{entry, expectedVersions}` erfasst einen Snapshot und antwortet mit `201`, `previewRunId`, `renderId`, Manifest, Diagnosen und Ablaufzeit.
- `GET /preview-runs/:previewRunId`: Manifest, `ready`/`expired`, `stale` und `changedFiles` lesen; fremde Sessions können den Lauf nicht lesen.
- `GET /preview-runs/:previewRunId/document`: geschütztes HTML mit eigener Policy. Abgelaufene Dokumente ergeben `410`, bereits aufgeräumte Läufe `404`.

Grenzen: 50 Quelldateien, zusammen 2 MiB UTF-8-Text, maximal 8 MiB gespeicherte Aufbereitung, 10.000 HTML-Knoten, 100 Verschachtelungsebenen, 100 Skripte und 200 Aufbereitungsdiagnosen. Die UI berücksichtigt bis zu 50 HTML/CSS/JS-Dateien im Workspace; das Manifest enthält die tatsächlich benötigten Dateien. Unter `previews/<Session-UUID>/` bleiben höchstens zehn Snapshots für 30 Minuten gültig. Neuladen erzeugt neue IDs und verwirft alte Lognachrichten. Serverneustarts ändern vorhandene Dokumente nicht; beim Start, stündlich und beim nächsten Vorschauauftrag werden abgelaufene Artefakte aufgeräumt. Die UI entfernt abgelaufene iframes. Beim Löschen einer Session werden Vorschauartefakte entfernt; sie gehören nicht zur dauerhaften Lernhistorie.

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

## Lernprofil und freiwillige Wiederholungen

Über **Lernprofil** in der Kopfzeile öffnest du die auch ohne KI nutzbare Konzeptansicht. Das bestehende Opt-in `crossChatProfileEnabled` bleibt standardmäßig ausgeschaltet. Beim Aktivieren werden alte Sessions nicht automatisch ausgewertet. Eine gesondert bestätigte Übernahme kennzeichnet frühere Abschlüsse als historische Angaben. Aufgaben und Tests funktionieren unabhängig vom Profil.

Der versionierte Katalog enthält Variablen, Bedingungen, Schleifen, Listen, Funktionen und Zeichenketten für Python und JavaScript. Aliase wie „Loops“, „Schleifen“ und „for-Schleifen“ werden sprachbezogen zusammengeführt. Neue Aufgaben dürfen nur passende Katalog-IDs verwenden; ohne passende Konzepte bleibt die Liste leer. Gruppen und Voraussetzungen dienen als Orientierung und beweisen keine weiteren Fähigkeiten. Die Ansicht zeigt Belege, letzte Übung, nächste passende Übung, eigene Korrekturen, Lernziel und mögliche Analogien zwischen Sprachen. Es gibt keine vermeintlich präzise Kompetenzquote.

Belege unterscheiden Tests, Tutorbeurteilungen, Selbsteinschätzungen, Lösungen mit Hilfe und Altbestand. Beim Aufgabenabschluss lässt sich Lösungshilfe ausdrücklich angeben; „selbstständig“ ist eine eigene Angabe. Seit Aufgabenbeginn protokollierte KI-Dateiänderungen werden konservativ als Hilfe behandelt. Ohne Angabe wird keine Selbstständigkeit angenommen. Ein Aufgabenpunkt zählt auch nach mehrfachen Abschlüssen und Versionswechseln nur einmal. Sessionzähler beruhen auf eindeutigen Session-IDs. V1-Profilzähler und freie Konzeptbezeichnungen bleiben gesondert als historische Angaben erhalten; daraus werden keine exakten Übungszeitpunkte oder fälligen Wiederholungen erfunden. Beschädigte oder doppelte Ereignisse melden einen Fehler und lassen die Originaldatei erhalten.

**Leitner-Version 1:** Die fünf konfigurierbaren Intervalle sind zunächst 1, 3, 7, 14 und 30 Kalendertage. Zeitpunkte der Ereignisse sind UTC; Wiederholungstage (`nextReviewAt`, `dueDay`) sind bewusst lokale Datumswerte in der gewählten IANA-Zeitzone, standardmäßig `Europe/Berlin`. So gelten auch bei Sommerzeitwechseln lokale Tagesgrenzen. Eine fällige, eigenständig testgeprüfte Katalogwiederholung erhöht die Stufe höchstens um eins; dieselbe Aufgabe am selben Tag vervielfacht keinen Fortschritt. Ein fachlicher Wiederholungsfehler setzt die Stufe zurück und plant den nächsten Tag. Selbsteinschätzung verändert keine Leitner-Stufe. Hilfe verschiebt eine selbstständige Kontrolle höchstens auf den nächsten Tag und verlängert keinen schon früher fälligen Termin. Timeout, Abbruch und Laufzeitausfall senken keine Stufe. Lernpausen senken ebenfalls keine Stufe.

Je Einstieg erscheinen höchstens drei freiwillige Vorschläge. **Heute überspringen** blendet einen Vorschlag bis morgen aus, **In drei Tagen erinnern** für drei lokale Tage; beides verändert keine Kompetenzbelege. Für Python gibt es sechs geprüfte, sichtbare Funktionsaufgaben. **Wiederholung starten** öffnet eine eigene Session und überschreibt keine bestehende Lösung. Wiederholte Startanfragen finden dieselbe offene Aufgabe. JavaScript bietet Konzeptübersicht und Selbsteinschätzung; ein ausführbarer JavaScript-Testadapter sowie Wissensgraph, Radar und Streak bleiben spätere Erweiterungen.

Unter `profiles/user.json` liegt Profilversion 2 mit Ereignissen, historischer Migration und Planung. Profilabschlüsse werden über die dauerhaften Sessionbelege wiederaufgenommen; fachliche Wiederholungsfehler zusätzlich aus den Testlaufbelegen. **Profil exportieren** liefert die vollständigen Profildaten als JSON. **Profil zurücksetzen** benötigt die markierte Löschbestätigung, löscht Kompetenzverlauf und Planung und behält nur technische Sperrmarken gegen die Wiederaufnahme bereits gelöschter Belege. Ursprüngliche Sessionabschlüsse und vorhandene Sicherungen werden dadurch nicht gelöscht. Bei deaktiviertem Profil werden keine neuen sessionübergreifenden Lernbelege gesammelt; Export und bewusstes Zurücksetzen bleiben möglich.

Die aufklappbare Datenschutzansicht zeigt genau die begrenzte Profilzusammenfassung, die der ausgewählte KI-Anbieter für die nächste Tutorantwort erhält. Rohereignisse und vollständige Testläufe werden nicht automatisch an den Tutor übermittelt. Das lesende Tutorwerkzeug erhält dieselbe begrenzte Zusammenfassung und respektiert das Opt-in.

Profil-API (hinter denselben Authentifizierungs- und Originprüfungen wie die übrige Anwendung):

- `GET /api/profile`: freigegebene Übersicht; deaktiviert nur `{ enabled: false }`.
- `PATCH /api/profile`: `goal`, `timeZone` und/oder fünf `intervals` speichern.
- `GET /api/profile/reviews`: höchstens drei fällige Vorschläge.
- `POST /api/profile/reviews/:reviewId/start`: geprüfte Python-Wiederholung in eigener Session öffnen.
- `POST /api/profile/reviews/:reviewId/results`: `action: "skip" | "snooze" | "submit"`; `submit` benötigt `sessionId`, `testRunId` und optional `assistance`. Ergebnisse werden aus dem gespeicherten Testlauf geprüft, nicht aus einer behaupteten Erfolgsangabe übernommen. Der normale Aufgabenabschluss verarbeitet Wiederholungen ebenfalls.
- `POST /api/profile/concepts/:conceptId/self-assessments`: `operationId` und `outcome: "unsure" | "confident"`; gleiche ID mit anderen Daten liefert `409`.
- `GET /api/profile/export`: vollständiger JSON-Export.
- `DELETE /api/profile`: bewusstes Zurücksetzen mit `{ confirm: true }`.
- `POST /api/profile/import-history`: gesonderte historische Übernahme mit `{ confirm: true }`.

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
