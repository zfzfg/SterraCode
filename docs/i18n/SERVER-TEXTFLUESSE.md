# Server: geprüfte Textflüsse und dynamische Grenzen

Stand: 20.10.2026. Grundlage der Nachprüfung sind die Serverfundstellen aus
`deep/befunde.json` und `deep/literale.json` sowie die tatsächlich geänderten
Ausgabepfade. Die alten Fundstellen sind Suchbelege; ein noch vorhandener
deutscher Fallback ist allein weder ein offener Fehler noch ein Nachweis einer
fertigen Übersetzung. Maßgeblich sind Herkunft, Metadaten und Verbraucher.

| Ursprung und Ausgabepfad                                                       | Behandlung                                                                                                                                                          | Unveränderte Daten                                                                                                                                                    |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `services/auth.js`, Feature-`AppError`, `app.js`, `routes/chat.js` SSE-Fehler  | Explizite `messageKey`/`params`; HTTP und SSE übersetzen pro Anfrage. Unbekannte interne SSE-Fehler verwenden die allgemeine Servermeldung.                         | HTTP-Status und bestehende Fehlercodes. Deutsche Fehlermeldung im ursprünglichen Fehlerobjekt.                                                                        |
| `routes/server.js`, `routes/provider.js`, `routes/models.js`, Runtimeantworten | Bekannte Diagnose-, Warnungs-, Quellen- und Runtimefelder werden ausdrücklich lokalisiert.                                                                          | Modell-IDs, Runtimeversionen, Konfiguration, Verbindungszustände.                                                                                                     |
| `services/localProcesses.js`, `runner/jobs.js` über Terminal-/Execute-Routen   | Anwendungsergänzungen stehen getrennt in `systemMessages`; `messageOutput.js` übersetzt diese Einträge.                                                             | `output`, `traceData`, Befehle, Prozess-IDs und lokale Zeichen-/Runner-Byteoffsets.                                                                                   |
| `runner/programs.js` über `routes/programs.js`                                 | Fortschrittsdescriptor, Beschreibung und bekannte Fehler werden übersetzt. Fehlerparameter bleiben in Journal, Initialisierungsfehler und Programmeintrag erhalten. | Paketlog, Downloadbytes, Versionen, sechs Fortschrittsschritte, Jobzustände.                                                                                          |
| `services/processReasons.js`, Test-/Traceübersichten                           | Endliche Zuordnung bereits vorhandener maschineller Grund-IDs zu `reasonKey`/`reasonParams`.                                                                        | `reason` selbst bleibt für Statuslogik und Recovery unverändert. Unbekannte IDs werden nicht erraten.                                                                 |
| `services/previews.js`, `services/previewBridge.js`                            | Diagnosen tragen explizite Schlüssel. Die serialisierte Bridge erhält ihre eigenen nötigen Texte und sendet für eigene Meldungen Metadaten.                         | HTML-/CSS-/JS-Quellen, Ressourcenadressen, Nutzer-`console`-Ausgaben und tatsächliche Browserausnahmen. CSP, Origin-, Render-ID- und Größenprüfungen bleiben wirksam. |
| `services/proposals.js` über `routes/workspaces.js`                            | Neue Hunkzusammenfassungen erhalten `summaryKey`/`summaryParams`; nur die abgeleitete Antwort wird übersetzt.                                                       | Ersetzungsinhalt, Hunkschnitt, Abhängigkeiten, Datei- und Vorschlagsversionen.                                                                                        |
| `runner/tracer/python_tracer.py` über `services/traces.js`                     | Eigene Endmarker behalten ihre Herkunft. Für typisierte Markerdaten kommen `displayValue`/`displayMessage` in der HTTP-Ansicht hinzu.                               | Ursprüngliches `value`, `type`, Ausnahme-`message`, Ereignisse und gespeichertes Artefakt. Ein identischer Nutzerstring ohne Metadaten bleibt Original.               |
| Python-Grading über `services/testRunner.js`                                   | Eigene Resultat-/Serialisierungsmarker behalten `messageKey`/`params`; nur die Anzeige von Fallmeldungen wird lokalisiert.                                          | Tatsächliche/erwartete JSON-Werte, Testfall-IDs, bereits materialisierte Fallnamen, Suite-Digest und Programmausgabe.                                                 |
| `routes/chat.js`, `services/messageOutput.js`                                  | Flüchtige Hinweise, Kontextfehler und die separaten oberen `turn`-/`contextUsage`-Ansichten werden übersetzt.                                                       | `session.messages`, kanonischer Inhalt, Providerzustände und gespeicherte Turns. Die Anzeige wird nicht als Modellhistorie zurückgespeichert.                         |
| `routes/profile.js`, `services/profileManager.js`                              | GET und Mutationsergebnisse erhalten nur neu abgeleitete Titel/Gründe. Der sichtbare Datenschutztext verwendet `displayProfileContext`.                             | Originalereignisse, Lernziel, Zeitzone, Fälligkeit und interner `profileToPromptText` für das Modell.                                                                 |

## Konkrete Legacy- und Dynamikgrenzen

- Alte Runnerjobs, Vorschläge, Test-/Traceartefakte und Toolfehler ohne belegte
  Meldungsmetadaten behalten ihren gespeicherten Klartext. Es gibt keinen
  Vergleich deutscher Texte zum nachträglichen Erraten einer Herkunft.
- `messageOutput.js` behandelt ausdrücklich benannte Featurefelder. Der
  Tracepfad besucht nur die typisierten Felder `locals`, `stack[].locals`,
  `objects[].items`, `returnValue` und `exception`; er interpretiert keine
  Strings innerhalb eines Programmwertes als Übersetzungsauftrag.
- LM-Studio-SDK-Fehler in den drei vorhandenen Diagnosewrappern unter
  `services/context/index.js` bleiben dynamische Originaldiagnosen. Die neuen
  Parameter enthalten denselben Fehlertext, der zuvor bereits im kanonischen
  Wrapper enthalten war, keine zusätzlichen Fehlerobjekte oder Stacktraces.
  Eine vollständige semantische Geheimnisredaktion beliebiger SDK-Fehler wird
  durch die Lokalisierung nicht bewiesen.
- `services/tools.js`, `context/history.js`, technische Kontextprompts und der
  interne Profilprompt dienen dem Modell-/Wiederherstellungsvertrag. Ihre
  bewusst erhaltene Sprache ist keine übersehene sichtbare Schaltflächen-
  oder Fehlerübersetzung. Der tatsächlich sichtbare Profiltext ist getrennt.
- Start-/Konfigurationsdiagnosen in `server/index.js`, `server/config.js` und
  CLI-Startpfade des Runners gehören zur im Umstellungsplan gesonderten
  Betreiberstufe. Sie werden nicht durch einen HTTP-Sprachheader umgestellt.
- Native JSON-Parser- und Dateisystemfehler an der zentralen HTTP-Grenze wurden
  als eigene Code-/Typfälle nachgezogen: `entity.parse.failed`,
  `entity.too.large`, `ENOENT`, `EEXIST`, `EACCES` und `EPERM` erhalten sichere
  explizite Meldungen. Rohe interne Pfade und JSON-Ausschnitte werden dadurch
  nicht als Programmoriginaldaten ausgeliefert.

## Belege

`tests/i18n-api.test.js` prüft gleichzeitige REST-/SSE-Sprachen,
Authentifizierung, unveränderten Versionsschutz, Runnerfortschritt und Logs,
Profilereignisse sowie identische echte und anwendungserzeugte
Tracefehlermeldungen. `tests/i18n-runner-messages.test.js` prüft
Fehlerjournal-/Status-/Initialisierungsmetadaten, echte Kommandoausgabe,
Zeitlimit-/Signaturhinweise und Pfadfehler. Bestehende Server-, Profil-,
Vorschlags-, Grading-, Trace- und Runnerregressionen werden zusätzlich
ausgeführt. Linux-/Dockerabnahme ist davon getrennt und wird durch diese
Windows-/Node-Prüfungen nicht ersetzt.
