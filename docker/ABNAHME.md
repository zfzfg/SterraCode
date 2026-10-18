# Docker-Abnahmeprotokoll

Datum: 18.10.2026, Europe/Berlin. Dieses Protokoll trennt tatsächlich ausgeführte Prüfungen von noch fehlenden Umgebungsnachweisen. Der ursprüngliche Umbauplan beschreibt weiterhin die Anforderungen und ist kein Testergebnis.

## Umgebung

- Windows-Arbeitskopie: Docker CLI 29.8.1, Compose 5.5.1; Linux-Docker-Daemon nicht aktiv. `npm run test:docker` meldet hier ausdrücklich übersprungen. **Windows-Docker-/LAN-Abnahme bleibt auf ausdrücklichen Nutzerwunsch offen.**
- Ubuntu-Testserver `zfzfg@192.168.178.104`: Ubuntu 26.04.1 LTS, x86_64; Docker Engine 29.5.2, Compose 5.1.4. Vor dem Deployment ausschließlich lesende Bestandsaufnahme. Bekannte SSH-Hostschlüssel wurden mit `StrictHostKeyChecking=yes` verwendet.
- Verzeichnis `/home/zfzfg/sterracode-test`; beim ersten Erheben 69 GiB freier Datenträger, rund 11 GiB verfügbarer RAM. Port 3000 frei. Vorhandene Container etwa für n8n, Seafile, Immich und Caddy wurden erhalten. Testprojekte verwenden ausschließlich eindeutige `sterra-smoke-*`-Namen und eigene Volumes.
- Basis für App und Runner: `node:24-bookworm-slim@sha256:a5f4366e834695d5f363b920c104953a535d3a9864d1bdf74566a0ebe01daee5`, Digest direkt bei Docker Hub geprüft. Im Container Node 24.22.0. Katalog `2026.10.18.1`, Debian Bookworm, freigegebene Architektur amd64.
- Caddy `2.10.2-alpine@sha256:4c6e91c6ed0e2fa03efd5b44747b625fec79bc9cd06ac5235a779726618e530d`, Digest direkt bei Docker Hub geprüft.

## Bereits tatsächlich geprüft

- App-/Runner-Images auf Ubuntu gebaut; produktives `npm ci --omit=dev` im Linux-Build. `.dockerignore` schließt echte lokale Daten, Host-Dependencies und `.env` aus.
- Compose-Konfiguration für LAN, Hostproxy, Dockerproxy und Caddy erfolgreich validiert. PowerShell-Skripte durch den nativen Parser geprüft; Shellskripte auf Ubuntu mit `bash -n` geprüft.
- Geschützte Einrichtung, Abweisung nicht angemeldeter APIs und ungültiger Setupschlüssel; erfolgreiche HTTP-Anmeldung mit Sitzungscookie. Ein erneuter Setuphelper verändert ein bestehendes Passwort nicht.
- Echte JavaScript-Ausführung im Runner; Bash-spezifische Syntax und UTF-8-Ausgabe. Python und Java tatsächlich installiert, kompiliert/ausgeführt, deaktiviert, aktiviert und entfernt.
- Nutzerbefehle laufen als UID 10002, Primärgruppe 10001 ohne Zusatzgruppen. Runner-Geheimnis und Programmmanifest sind nicht lesbar; App-Daten sind nicht vorhanden. Vererbte Umgebung enthält keine App-, Token-, Secret- oder Paketmanager-Variablen.
- stdin mit Umlauttext, vollständiger Stop einer mit `setsid` getrennten Enkelprozessgruppe. Nach Stop mit `/proc` geprüft: keine überlebenden Prozesse der Ausführungs-UID.
- Idempotenz-ID mehrfach gesendet: gleicher Auftrag, genau ein Zählereintrag. Veränderte Nutzdaten derselben ID liefern Konflikt. App mit SIGKILL beendet und wieder gestartet: laufender Runnerauftrag bleibt unter derselben ID abfragbar und endet erfolgreich.
- Container mit erhaltenen Volumes neu erstellt; Anmeldung und alte Session bleiben verfügbar.
- Sicherungscontainer erzeugt echte konsistente Daten-/Workspace-/Manifest-/Secretarchive bei gestopptem Stack. Die erste Abnahme deckte Host-Dateirechte auf; Sicherungen werden jetzt mit Modus 0600 dem aufrufenden Hostbenutzer zugeordnet, Zielverzeichnis 0700.
- 14 gezielte Archive-Tests erfolgreich: reguläre/PAX-Dateien, UTF-8, Traversal, Windows-Pfade, Symlinks/Hardlinks/Spezialdateien, doppelte Pfade und Prüfsummenfehler.
- Echte LM-Studio-SDK-Verbindung zu `http://192.168.178.64:1234`, Modell `ternary-bonsai-2-27b`: native Modellabfrage, Kontextlänge 48128, Tokenisierung mit 6 Tokens und kurze Inferenz erfolgreich. Zunächst lokal auf Windows, nach der vom Benutzer ausgeführten engen Firewallfreigabe am 18.10. um 20:58 Uhr auch aus dem gebauten App-Container im Ubuntu-Compose-Netz nachgewiesen. LM Studio lauscht auf `0.0.0.0:1234`.

## Noch laufende beziehungsweise umgebungsabhängige Nachweise

Der vollständige Ubuntu-Katalog-/Restore-Smoke läuft während der Umsetzung und wird nach seinem tatsächlichen Abschluss in diesem Protokoll ergänzt. Frühere Smokeabbrüche entstanden durch inzwischen korrigierte Testabläufe: alter HTTP-Keepalive nach Containerneuerstellung, zu frühes Weitergehen vor abgeschlossenem Paketjob und Hostleserechte für rootgeschriebene Sicherungsdateien. Diese Teilabbrüche werden nicht als vollständige Abnahme gezählt.

Die erste Ubuntu-Verbindung zu LM Studio lief in ein TCP-Zeitlimit. Aktiviertes CORS änderte daran nichts. Das Eintragen der engen Windows-Firewallregel benötigte Administratorrechte; nach Ausführung des bereitgestellten Skripts durch den Benutzer gelang der reale Container-Nachweis einschließlich nativer WebSocket-Verbindung, Tokenisierung und Inferenz. Dieser Netzwerkpunkt ist abgeschlossen.

Eine tatsächliche OpenAI-Verbindung benötigt einen bereitgestellten API-Schlüssel. Ohne Schlüssel werden die Provider-/Secret-/Responses-Verträge mit isolierten Tests geprüft; eine echte Anfrage wird nicht behauptet. IPv6 und öffentlich gültige HTTPS-Zertifikate erfordern die passende Netz-/DNS-Umgebung. Windows-Docker bleibt ausdrücklich offen.
