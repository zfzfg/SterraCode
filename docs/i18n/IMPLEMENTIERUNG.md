# i18n-Implementierung und Prüfung

Release 1.1.0: Englisch ist jetzt der Standard für Neuinstallationen und neue Browser, bestehende Sprachwahlen bleiben erhalten. Die englische Hauptdokumentation steht unter [README.md](README.md). Die ursprüngliche Prüfungsrunde und ihre Zahlen bleiben nachfolgend als historische Abnahme erhalten; aktuelle Release-/Ubuntu-Ergebnisse stehen in [ABNAHME.md](../../docker/ABNAHME.md).

Stand: 20.10.2026. Die Umsetzung verwendet i18next **26.5.3**, lokal ausgeliefert und als Produktionsabhängigkeit festgeschrieben. Der ursprüngliche Plan und die beiden Inventare bleiben erhalten. Die Implementierung wurde nach einer gemeinsamen Start-/Login-Grundlage auf getrennte Zuständigkeiten für Featureoberfläche, Servermeldungen und Lerninhalte aufgeteilt; abschließend erfolgte eine unabhängige Quell- und Übersetzungsprüfung. Die kontextabhängigen Begriffe stehen im [Glossar](GLOSSAR.md).

## Sprachwerte und Erweiterung

`shared/i18n/locale.js` ist die Registry: `de/de-DE`, `en/en-GB`, `es/es-ES`, jeweils mit Anzeigename, Richtung und Monaco-NLS. Deutsch bleibt Standard und Rückfall. Die Anwendung verwendet keine automatische Browsererkennung. Weitere Sprachen benötigen einen Registryeintrag und vollständige Namensräume unter `shared/i18n/locales/<locale>/`; die Manifest-/Katalogrouten entdecken die Namensräume beim Serverstart. Kataloge und die ESM-Bibliothek kommen vom eigenen Server; beliebige Node-, Shared- oder Serverdateien werden dadurch nicht öffentlich.

Die browserlokale Oberfläche (`sterracode.uiLocale`), `session.tutorLocale`, Programmiersprache und materialisierte `contentLocale` sind getrennt. Gesperrter oder nur lesbarer Web Storage verwendet den aktuellen Tab über `history.state`. Eine erfolgreiche reguläre Speicherung entfernt den vorübergehenden Taboverride. Die Auswahl vor Monaco übersetzt Login/Einrichtung unmittelbar und erhält eingegebene Passwörter.

Monaco 0.47.0 bleibt unverändert. Seine AMD-NLS-Konfiguration stammt vor dem ersten Editorladen aus derselben Registry; Englisch verwendet `i-default`. Eigene Aktionen, Diff- und Traceansichten verwenden die Anwendungskataloge beziehungsweise dieselbe bereits geladene Monaco-Instanz.

## Sprachwechsel und Datenbestand

Nach dem Start prüft `localeSwitch.js` offene Dialoge, laufende Mutationen, Chat, Tests, Traces, Terminaleingabe/-prozesse, Vorschauarbeit und Paketaktionen. Alle Editorrecords werden vor dem kontrollierten Reload gespeichert; Versionskonflikte verhindern den Wechsel. Editoransicht, Session/Datei, Chat-/Frage-/Journalentwürfe, Abschnitte, Seitenleisten- und Terminalansicht werden vorübergehend gesichert. Passwörter, API-Schlüssel, Terminal-stdin, ausgeführte Befehle und Ausgaben gehören nicht in diese Wiederherstellungsdaten.

Terminalwiederaufnahme liest nur vorhandene Prozess-IDs per GET. Sie startet keine Befehle. Abgelaufene Ergebnisse sind ausdrücklich sichtbar. Vorübergehende Wiederherstellungsfehler erhalten den Marker für einen erneuten Versuch; eine deutsche Katalogrückfallsprache verwirft keine gültigen Entwürfe. Nach erfolgreicher Wiederherstellung wird der Marker entfernt.

Sessions behalten `schemaVersion: 2` für den bestehenden Workspacevertrag und erhalten eine getrennte, explizite **`localeSchemaVersion: 1`**. Diese Migration läuft einmal unter der bestehenden Sessionqueue und erhält den Löschschutz. Bestehende Sessions ohne Sprachfeld bekommen `tutorLocale: null` für den historischen Nutzersprachenmodus. Neue Sessions speichern eine erlaubte Tutorsprache. Die Migration übersetzt weder Verlauf noch Dateien oder Aufgaben und führt die alte Workspace-Migration nicht erneut aus. Eine tatsächliche Tutoränderung invalidiert abgeleitete Kontextnutzung; ein UI-Wechsel ändert Modellhistorie und Quelldigests nicht.

Neue Anwendungsschablonen besitzen Herkunft, kanonische Texte und stabile Optionskennungen. Nur belegte Anwendungsschablonen werden für die Anzeige neu übersetzt. Alte Nutzer-/Modelltexte und alte nicht zuordenbare Jobs bleiben Originaldaten. Einzelheiten zu Promptversionen, Vorlagen, Wiederholungen, Import/Export und Idempotenz stehen in [INHALTE.md](INHALTE.md).

## Meldungen und sichere Ausgabe

REST und SSE tragen `Accept-Language`. Der Server arbeitet mit festen Übersetzern pro Anfrage und ändert keine globale Sprache. Eigene Fehler behalten Status und Codes und ergänzen `messageKey`/skalare `params`. Die zentrale Fehlerantwort validiert diese Parameter und begrenzt Strings auf 4096 Zeichen. Übersetzungsoptionen werden nicht aus Parametern übernommen. Native JSON-Parser-/Dateisystemfehler und unbekannte interne Fehler erhalten sichere bekannte Meldungen.

Der Runner bleibt ohne i18next-Abhängigkeit. Er liefert Deskriptoren für Fehler, Runtimegründe, Programmbeschreibungen und die sechs Arbeitsschritte. Originalpaketlogs und Programmausgabe bleiben separat. Pythonmarker und Vorschau-Brückenmeldungen sind ausdrücklich von Nutzerstrings unterschieden. Lokale Pythonstarts verwenden ausdrücklich UTF-8 (`-X utf8`), damit Windows-Pipes dieselbe Kodierung wie der Prozessdecoder liefern; echte Datei-/Traceläufe prüfen Umlaute, Spanisch und Emoji. Die konkreten geprüften Ausgabepfade und Grenzen stehen in [SERVER-TEXTFLUESSE.md](SERVER-TEXTFLUESSE.md).

Übersetzungen gehen in Textknoten und definierte Textattribute. Sie werden nicht als HTML ausgeführt. Plurale verwenden `count` und die jeweiligen Intl-Kategorien, einschließlich Spanisch `_many`; Zahlen, Prozent und Zeitdarstellung folgen der Oberfläche, Profilzeitzonen bleiben erhalten. Die Bootstrapnotfallanzeige ist eine bewusst dreisprachige Ausnahme vor verfügbarer Übersetzungsinitialisierung.

## Audit und Regressionen

`npm run audit:i18n` erhält das ungefilterte Inventar, Fingerprints, Quellprüfsummen, Unsicherheiten und dynamischen Grenzen. Ein vorhandener deutscher Kompatibilitätsfallback oder eine niedrige Fundzahl ist kein Fertigstellungsbeweis. Es gibt keine pauschale Ausnahmebaseline. Die ergänzende [Inventarzuordnung](ZUORDNUNG.md) mit [maschinenlesbaren Einzelbelegen](zuordnung.json) verändert die offenen Auditbefunde nicht. `node scripts/review-i18n.mjs` prüft Quellen gegen ihre Audithashes; ungeklärte und veraltete Quellen sind getrennte Fehlerzustände. Jeder dynamische Pfad behält seinen Herkunftsvertrag und ausdrücklich `staticCompletenessClaim: false`.

`npm run check:i18n` prüft Katalogparität, leere/duplizierte Schlüssel, Platzhalter, Pluralformen, statische Aufrufe und explizite Meldungsdeskriptoren. Der Auditor berücksichtigt nun auch die importierte Serversignatur `t(locale, key, params)`; eine eigene Regression verhindert deren Verwechslung mit dem ersten Localeargument. Vitest verwendet für importierbare Browserhelfer dieselbe Bibliothek und echte Katalogressourcen.

Die neue Browserverifikation prüft die tatsächlichen englischen/spanischen Beschriftungen, Monaco, alle vier Breiten 800/1024/1366/1920 in vier Themes, Entwürfe, Konflikte, aktive Arbeit, gelöschte Sessions und Storage-/Katalog-/Wiederherstellungsausfälle. Bestehende Tests haben einen ausdrücklich deutschen Ausgangszustand. Zwei geänderte deutsche 1920-px-Baselines wurden nach Sichtung aktualisiert; die anderen Baselines bleiben erhalten.

Die Sprachmatrix ergänzt die vorhandenen fachlichen Regressionen mit folgenden tatsächlichen UI-Pfaden. Unabhängige erwartete Texte stehen im Testcode; sie werden nicht aus denselben Produktkatalogen eingelesen.

| Browserpfad                                                                                                            | Sprache und Ausführungsart                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Einrichtung, Sprachwahl, neue Session, fehlerhaftes Passwort, Passwortwechsel, Ab-/Anmeldung                           | `i18n-auth-proposals`: de/en/es, echte isolierte Serverauth einschließlich Versions-/Cookie-/Tokenwirkung                                                          |
| Vorschlag prüfen, übernehmen, rückgängig machen, ablehnen und nach Reload lesen                                        | `i18n-auth-proposals`: de/en/es, echte Vorschlags-/Datei-API mit lokalem Modellfixture; Originalquellen und Versionen geprüft                                      |
| Lokalen Editorstand retten, speichern, Konflikt als Datei sichern, Stream abbrechen/fortsetzen, offline weiterarbeiten | `i18n-workspace`: de/en/es, echte Workspace-/Chat-API mit lokalem SDK-/Streamfixture                                                                               |
| Monaco Suchen/Ersetzen und eigene Kontextaktion, `lang` und Fokus                                                      | `i18n-workspace`: de/en/es, tatsächliche lokale Monaco-NLS; Tracerdialog gibt Fokus zurück                                                                         |
| Sechs Paketstufen, Reparatur, Cache, Restartjournal ohne erneute Aktion, fehlende Runtime und Terminalfehler           | `i18n-runtime`: de/en/es, echte Browserverbraucher mit simulierten Runnerantworten; native Logs bleiben Originaldaten. Kein Paket wird auf dem Host installiert    |
| Fehlerhafte/korrekte Offlineaufgabe, Testnachweis/Abschluss, Journal, Projektexport und Tracer mit Originalexception   | `i18n-learning`: de/en/es, tatsächliche lokale Pythonkindprozesse und Datei-/Test-/Journal-API                                                                     |
| Vorlagenimport, einzelne Hinweise, Profil, Tracereinstieg und Webvorschau                                              | `i18n-features`: en/es zusätzlich zu den bestehenden deutschen Featuretests; neu materialisiertes Vorschau-HTML besitzt die gewählte Sprache                       |
| Sprachreload und Störungen                                                                                             | `i18n.spec.js`: Wechsel de → en → es → de mit erhaltenen Entwürfen/Versionen/Originalausgaben; gezielte Storage-, Konflikt-, Aktivitäts-, Lösch- und Recoveryfälle |
| Layout und lange Übersetzungen                                                                                         | en/es bei 800/1024/1366/1920 px in vier Themes; künstlich verlängerte Testkataloge in derselben Größen-/Themematrix                                                |

Fällige Profilwiederholungen werden zusätzlich in `i18n-auth-proposals` für de/en/es gegen die echte isolierte Profil-/Review-API gestartet. Alte Testbelege bleiben unverändert; neue Aufgaben besitzen die gewählte Tutor-/Inhaltssprache. Zwei parallele Wiederholungsstarts liefern dieselbe Session und erzeugen genau eine Instanz.

**Ausgeführt auf Windows, Node 24.19.0:**

- `npm test`: **39 Dateien, 599 bestandene Tests, 5 Skips**, erneut vollständig nach der Windows-UTF-8-Korrektur ausgeführt. Darin enthalten sind echte Pluralwahl und die Erweiterungsprobe mit einer vierten Testlocale.
- `npm run test:e2e`: **77/77 bestanden** im gemeinsamen abschließenden Lauf (**4,3 Minuten**). Die oben beschriebene Sprachmatrix einschließlich echter Auth-/Reviewabläufe, Pythonausführung, Vorschlagsentscheidungen, Konfliktsicherung, Monaco, Paketprotokollfixtures und künstlich verlängerter Übersetzungen ist Bestandteil dieses Laufs.
- Nach der letzten Meldungsweitergabe- und Katalogheaderkorrektur bestehen die gezielten API-/Runnervertragssuiten **24/24**, einschließlich erlaubter Ressourcenpfade, tatsächlicher Katalogsprache und spanischer Sessiondefaults.
- `npm run test:i18n-audit`: **43/43 bestanden**. `npm run check:i18n` prüft **30 Kataloge und 398 explizite Deskriptorreferenzen**. `npm run audit:i18n` erfasst **262 physische / 20 eingebettete Quellen, 38.938 Literale, 12.273 offene Befunde und 546 dynamische Grenzen**, ohne Parser-/Analysefehler oder ausgeschöpfte Graphbudgets. Die ergänzende Zuordnung hat **0 ungeklärte und 0 veraltete Quellen**, bei weiterhin **0 akzeptierten Auditbefunden**. `npm run format:check` und `git diff --check` erfolgreich.
- Die fünf Vitest-Skips betreffen **Bash, Go, C++, Lua** und das Linux-spezifische Parent-Pinning beim Austausch eines Verzeichnisses gegen einen externen Symlink. Tatsächlich lokal ausgeführt wurden unter anderem Python, JavaScript, Rust, C# und Java. Ein Skip wird nicht als Laufzeitnachweis gezählt.

Repräsentative geprüfte Bilder: [English 800/dark](screenshots/en-800-dark.png), [Español 1024/light](screenshots/es-1024-light.png), [English 1366/high-contrast](screenshots/en-1366-high-contrast.png), [Español 1920/Solarized](screenshots/es-1920-solarized.png). Die dargestellten deutschen Aufgaben-/Dateiinhalte sind absichtlich erhaltene Originaldaten einer zuvor erstellten Vorlage.

## Auslieferung und Grenzen

Beide Dockerfiles kopieren `shared/` ausdrücklich. App enthält i18next; Runner importiert weiterhin nur paketfreie Meldungs-/Laufzeitverträge. `docker compose build` wurde aufgerufen und scheitert am nicht erreichbaren Docker-Desktop-Linux-Daemon. `npm run test:docker` meldet denselben Zustand als ausdrücklichen Skip. Es gibt für diesen i18n-Stand **keine behauptete Container-/Linuxabnahme** und keine Änderung der bestehenden entfernten Installation. Betriebsergebnisse werden in [ABNAHME.md](../../docker/ABNAHME.md) ergänzt.

Echte neue KI-Anfragen mit kostenpflichtigem Schlüssel oder LAN-Modell wurden nicht ausgeführt. Beide Anbieter werden mit isolierten Fixtures einschließlich Sprachwechsel nach Komprimierung geprüft. Alte Artefakte ohne Herkunftsmetadaten behalten ihren ursprünglichen Klartext. Installer-/CLI- und Dokumentationsübersetzungen bleiben entsprechend der optionalen Etappe 7 außerhalb der Produktsprachmodi. Ein Downgrade auf alte Validatoren kann neue Locale-/Herkunftsfelder verlieren; verlustfreie Rückwärtskompatibilität wird nicht behauptet.
