# Runner v1

Der Runner startet nur unter Linux als Steuerbenutzer root. Nutzerprogramme laufen
über den kompilierten `launch.c`-Helfer als UID `10002`, Primärgruppe `10001`, ohne
Zusatzgruppen und mit `no_new_privs`. Der Helfer bleibt als Subreaper bestehen und
beendet auch doppelt geforkte Kinder und eigene Prozessgruppen. Die gemeinsame
Ausführungs-UID isoliert Lern-Sessions nicht gegeneinander.

Auch Versionsprüfungen starten unter der Ausführungs-UID mit derselben bereinigten
Umgebung. `XDG_RUNTIME_DIR` liegt in einem der UID gehörenden Verzeichnis mit
Modus `0700` auf dem Werkzeugcache. Dies berücksichtigt die im Oktober 2026
geänderte .NET-Named-Mutex-Verwaltung, die sonst beim passwd-Home `/nonexistent`
an `NuGet-Migrations` scheitern kann ([.NET Runtime #135726](https://github.com/dotnet/runtime/issues/135726)).

Jeder HTTP-Aufruf, einschließlich `/v1/health`, benötigt `Authorization: Bearer`
mit dem Schlüssel aus `STERRACODE_RUNNER_SECRET_FILE`. Der Schlüssel wird weder
als Prozessargument noch in einer Kindprozessumgebung übergeben. App und Runner
senden `X-Runner-Protocol: 1`; abweichende Protokolle werden abgewiesen.

## Interne API

| Methode und Pfad                             | Zweck                                                            |
| -------------------------------------------- | ---------------------------------------------------------------- |
| `GET /v1/health`                             | Minimale Prozessgesundheit                                       |
| `GET /v1/status`                             | Betriebszustand, aktive Aufträge und gesperrte Sessions          |
| `GET /v1/runtimes`                           | Installationsstand aller neun Sprachadapter                      |
| `POST /v1/jobs`                              | Auftrag mit UUID `id`, Session und relativen Quelldaten annehmen |
| `GET /v1/jobs/:id/output?sessionId=&offset=` | Neue Ausgabe mit UTF-8-Byteoffset                                |
| `POST /v1/jobs/:id/input`                    | `{sessionId,input}` zeilenweise eingeben                         |
| `DELETE /v1/jobs/:id`                        | `{sessionId}` kontrolliert stoppen                               |
| `POST /v1/sessions/:id/block`                | Dauerhafte Startsperre setzen und Prozesse stoppen               |
| `DELETE /v1/sessions/:id/block`              | Startsperre ausdrücklich aufheben                                |
| `POST /v1/sessions/:id/stop`                 | Prozesse der Session stoppen                                     |
| `POST /v1/maintenance`                       | Neue Ausführungen sperren; optional `stopRunning`                |
| `DELETE /v1/maintenance`                     | Wartung beenden, sofern kein Paketjob läuft                      |
| `GET /v1/programs`                           | Katalog, Programmzustand und aktiver Paketauftrag                |
| `POST /v1/programs/:id/actions`              | `install`, `remove`, `repair` oder `retry`                       |
| `GET /v1/program-jobs/:id`                   | Paketauftrag lesen                                               |
| `POST /v1/program-jobs/:id/cancel`           | Noch wartenden Paketauftrag abbrechen                            |
| `GET /v1/cache`                              | Größen und freier Speicher                                       |
| `DELETE /v1/cache`                           | Nicht mehr benötigte Paketcaches bereinigen                      |

Auftragsjournal und Sollmanifest werden mit Dateisynchronisierung, atomarem
Umbenennen und Verzeichnissynchronisierung geschrieben. Ein fehlgeschlagener
Journalzugriff verhindert den Start. Wiederholte IDs mit gleichem kanonischen
Inhalt liefern denselben Auftrag; geänderter Inhalt ergibt
`409 IDEMPOTENCY_CONFLICT`. Nach einem Neustart werden unfertige Aufträge als
`interrupted` protokolliert und nicht erneut gestartet. Ausgabe verfällt nach
fünf Minuten, der dauerhafte Identitätsnachweis bleibt erhalten.

Die Reservierung von einem Auftrag je Session, vier Aufträgen insgesamt und zwei
kompilierenden Aufträgen erfolgt im selben serialisierten Annahmeabschnitt.
Wartung sperrt Starts vor dem Warten auf laufende Prozesse. Ein wartender Paketjob
kann abgebrochen werden oder nach ausdrücklichem `stopRunning` fortfahren.

## Paketquellen und Updates

`catalog/versions.lock` bindet die Debian-Suite, Architektur, Basisimage und
Katalogversion. Die primären Debian-/Microsoft-Pakete haben genaue Versionen und
SHA-256-Prüfsummen aus den offiziellen Paketindizes. apt prüft signierte Quellen;
Microsofts öffentlicher Schlüssel ist mitgeliefert. Go verwendet ein festes
Herstellerarchiv, SHA-256 und die offiziellen Go-Downloadmetadaten. Rust verwendet
feste Compiler-, Cargo- und Standardbibliotheksarchive, deren URL und Prüfsumme
gegen das GPG-verifizierte Hersteller-Manifest geprüft werden. Kein Browseraufruf
kann Paket-URLs oder Installationsskripte vorgeben.

Jede erfolgreiche Installation speichert die tatsächlich aufgelöste komplette
Paketabhängigkeit mit Version, Architektur und Cacheprüfsumme. Beim Ersetzen des
Containers werden diese Pakete aus dem Cache installiert; fehlende Cachedateien
werden ausschließlich mit den gespeicherten exakten Versionen nachgeladen.
Beschädigte Pakete werden abgewiesen. Entfernte Programme werden nicht durch
Settings-Backups oder eine erneut gesetzte Initialprogrammliste wiederhergestellt.
Architektur- und Suitewechsel erfordern eine ausdrückliche Manifestmigration.
`linux/arm64` ist bis zur vollständigen Adapterprüfung gesperrt.

Für einen Releasewechsel: Basisimage-Digest und Katalogquelle prüfen, genaue
Paket-/Archivversionen und Prüfsummen aktualisieren, Manifestwiederherstellung
prüfen und sämtliche Sprach-Smokes auf der freizugebenden Architektur ausführen.

## Prüfungen

`npm test` führt die Runner-Vertrags-, Client- und Paketmanifesttests aus.
`npm run test:docker` installiert und entfernt die optionalen Laufzeiten wirklich.
Zusätzlich prüft `tests/docker/runner-live.mjs` im Runner echte Zeitlimits,
UTF-8-Ausgabegrenzen, große stdin-Eingaben, konkurrierende Symlinkwechsel und einen
durch das Container-PID-Limit begrenzten Fork-Sturm. Dieser native Test startet
erst nach abgeschlossener Paketwartung und entfernt ausschließlich seine eigene
zufällige Session sowie die eigene Testdatei im Zustandsvolume.
