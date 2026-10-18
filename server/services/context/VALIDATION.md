# Validierung am 18.10.2026

Geprüft unter Windows mit Node.js 24.19.0 und `@lmstudio/sdk` 1.5.0.

| Prüfung                               | Ergebnis                                                          |
| ------------------------------------- | ----------------------------------------------------------------- |
| `npm test -- --reporter=dot`          | 324 bestanden, 4 optionale Laufzeittests übersprungen             |
| `npm run test:e2e -- --reporter=line` | 14 bestanden, einschließlich bestehender Layout-/Theme-Referenzen |
| `npm run format:check`                | Bestanden                                                         |
| `git diff --check`                    | Bestanden                                                         |
| `npm run test:context:live -- --load` | Bestanden mit `ternary-bonsai-2-27b`                              |

Der native Live-Test verwendete eine temporäre Modellinstanz mit 8.192 Tokens
und einen vollständig isolierten Datenordner. Der echte, mit dem Modelltemplate
gerenderte Prompt einschließlich Werkzeugdefinitionen schrumpfte von **15.342
auf 3.274 Tokens**. 49 ältere Nachrichten waren durch Zusammenfassungen
abgedeckt; der vollständige Originalverlauf blieb unverändert erhalten.
Der Verlauf selbst wurde mit dem Modelltokenizer auf etwa 13.495 Tokens
geschätzt (Nachrichten-Overhead ist hier eine Schätzung).

Nach Komprimierung und Konsolidierung wurden **3 von 3** ursprünglichen
Projektdaten korrekt erinnert. Anschließend schrieb das echte Modell mit
`write_file` eine Testdatei; ihr Inhalt und ihre dauerhafte Änderung wurden
überprüft. Rückgängig entfernte die neu angelegte Datei korrekt.

Die Live-Prüfung begründet zusätzliche Regressionstests: Der ursprüngliche
Nutzerauftrag wird unabhängig von generierten Zusammenfassungen begrenzt
erhalten. Provider-IDs werden über SDK-Runden hinweg eindeutig zugeordnet.
Die Zeichenkette `"null"` wird bei der KI-Dateiversion als JSON-null behandelt;
bei bereits existierenden Dateien bleibt die Versionsprüfung wirksam.

LM Studio meldete beim Beenden einer abgeschlossenen SDK-Werkzeugrunde eine
`Received channelSend for unknown channel`-Warnung. Die nachfolgende Antwort,
gespeicherte Dateiänderung und Rücknahme wurden trotzdem erfolgreich geprüft.
Die SDK-Version bleibt entsprechend dem Einbauplan auf 1.5.0 festgelegt.

Der Live-Test entlädt eine von ihm geladene Testinstanz und entfernt seinen
temporären Datenordner. Persönliche Sessions und Workspaces werden nicht benutzt.
