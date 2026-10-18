# SterraCode im Dockerbetrieb

Stand: 18.10.2026. Unterstützt wird zunächst Linux/amd64 mit Docker Engine und Compose. Windows verwendet Docker Desktop mit Linux-Containern, vorzugsweise WSL 2. Windows Server benötigt eine Linux-VM. `npm start`, `start.ps1` und `start.bat` behalten den lokalen Entwicklungsbetrieb. Die Docker-Instanz hat einen Administrator und einen gemeinsamen Runner. Freie Programme teilen dieselbe UID und können die Workspaces anderer Sessions lesen. Für fremden Code oder mehrere getrennte Benutzer ist zusätzliche Isolation erforderlich.

## Installation und Neustart

```sh
bash install.sh
# ohne Rückfragen bei bekannter LAN-Adresse:
bash install.sh --bind-ip 192.168.178.50 --port 3000 --non-interactive
bash start-docker.sh
bash stop-docker.sh
```

```powershell
.\install.ps1
.\install.ps1 -BindIP 192.168.178.50 -Port 3000 -NonInteractive
.\start-docker.ps1
.\stop-docker.ps1
```

Hostvoraussetzungen sind Docker und Compose, keine Hostlaufzeiten. Der Installer prüft den Linux-Daemon, Compose-Konfiguration und Portbelegung. Bei mehreren LAN-Adressen wird eine Auswahl verlangt. Bei einem belegten Port die beiden Werte `STERRACODE_PORT` und `STERRACODE_PUBLIC_URL` in `.env` gemeinsam anpassen und erneut starten. Vorhandene `.env`, Volumes und Passwörter werden erhalten. Ein neuer Einrichtungsschlüssel entsteht nur bei offener Einrichtung und gilt 30 Minuten. Er wird ausschließlich auf dem Terminal angezeigt. Die App speichert seinen Hash. Ein Installer-Neustart vor Passwortvergabe ersetzt den vorherigen Schlüssel.

Unter etwa 8 GiB freiem Platz warnt der Installer. Die virtuelle Platte von Docker Desktop braucht zusätzlich Platz für Images, optionale SDKs und Projektcaches. Dateischreibmenge und Toolcaches werden durch RAM-Limits nicht begrenzt. `scripts/docker-admin.sh usage` beziehungsweise `scripts/docker-admin.ps1 usage` zeigt Volumegrößen und freien Platz. Paketcache lässt sich in der Programmverwaltung bereinigen, Quellcode und Backups werden dabei erhalten. Das ausführbare Named Volume `runs` enthält nur Compilergebnisse, wird beim Runnerstart geleert und nicht gesichert; seine Größe ist durch den Docker-Datenträger begrenzt.

Für dauerhaft erreichbare LAN-Adressen eine DHCP-Reservierung einrichten. `bash install.sh --diagnose` / `.\install.ps1 -Diagnose` vergleicht aktuelle Schnittstellen und Konfiguration. Nach Änderungen `.env` speichern und das Startskript erneut ausführen; ein reines `docker compose restart` übernimmt keine geänderten Containerparameter.

## Firewall und LAN

Standardmäßig wird genau die gewählte IPv4-Adresse veröffentlicht. `0.0.0.0` erfordert im Installer eine ausdrückliche Bestätigung oder `--all-interfaces` / `-AllInterfaces`. Es gibt keine automatische Routerfreigabe. IPv6 ist ein eigener Freigabetest mit zusätzlichen Publish-Einträgen und Firewallregeln.

Bei `--bind-ip 0.0.0.0` zusätzlich beispielsweise `--public-url http://192.168.178.50:3000` angeben; unter PowerShell entsprechend `-BindIP 0.0.0.0 -AllInterfaces -PublicUrl http://192.168.178.50:3000`. Die öffentliche URL bezeichnet eine konkrete erreichbare LAN-/Domainadresse. Der Installer prüft sie vor dem atomaren Anlegen von `.env`; eine Wildcardadresse wird nicht als Browseradresse übernommen.

Linux mit UFW, an eigenes Netz anpassen:

```sh
sudo ufw allow from 192.168.178.0/24 to 192.168.178.50 port 3000 proto tcp
```

Docker verwaltet eigene Paketfilterregeln; UFW allein kann veröffentlichte Containerports je nach Hostkonfiguration nicht filtern. Die konkrete Bind-IP begrenzt die veröffentlichten Interfaces. Betreiber müssen bei benötigter Netzfilterung auch die Docker-Firewall beziehungsweise vorgelagerte Netzregeln prüfen.

Windows als Administrator, ausschließlich privates Netz:

```powershell
New-NetFirewallRule -DisplayName SterraCode -Direction Inbound -Protocol TCP -LocalAddress 192.168.178.50 -LocalPort 3000 -RemoteAddress LocalSubnet -Profile Private -Action Allow
```

Der optionale Installerschalter `--firewall` / `-Firewall` fragt vor einer Regeländerung nach. Ohne erhöhte Rechte bleibt die Installation vorhanden und der Befehl kann separat ausgeführt werden. Auf einem zweiten LAN-Gerät die angezeigte Browseradresse öffnen, anmelden und eine Datei erstellen. Ein lokaler Healthcheck belegt diesen Zugriff nicht.

## Konfiguration und Domains

`.env.example` enthält ausschließlich nicht geheime Werte. Passwörter, Einrichtungsschlüssel und LM-Studio-Token gehören nicht in `.env`. Das Compose-Basisdokument veröffentlicht keinen Port. Die Startskripte wählen genau eine Ergänzung:

| `STERRACODE_PROXY_MODE` | Ergänzung | Portfreigabe |
| --- | --- | --- |
| `off` | `compose.lan.yaml` | Gewählte IPv4 und Hostport |
| `caddy` | `compose.caddy.yaml` | Nur Caddy auf 80/443 |
| `host` | `compose.host-proxy.yaml` | App ausschließlich 127.0.0.1 |
| `docker` | `compose.docker-proxy.yaml` | App nur am konfigurierten externen Proxynetz |

Direkter LAN-Aufruf:

```sh
docker compose -f compose.yaml -f compose.lan.yaml config --quiet
docker compose -f compose.yaml -f compose.lan.yaml up -d --remove-orphans
```

Die App lauscht intern immer auf `0.0.0.0:3000`. `STERRACODE_PUBLIC_URL` ist eine vollständige http-/https-URL an der Wurzel ohne Benutzerinformationen oder Unterpfad. Zusätzliche Hosts und Origins werden explizit erlaubt. Vertrauenswürdige Proxy-IP-Adressen/CIDRs stehen in `STERRACODE_TRUSTED_PROXIES`; eine pauschale Freigabe ist ungültig. Für den mitgelieferten Caddy kann das dedizierte Compose-Subnetz explizit konfiguriert oder die tatsächliche Caddy-IP eingetragen werden. Niemals beliebige Clientnetze als Proxy eintragen. Proxywechsel entfernen alte Dienste mit `--remove-orphans`.

Caddy benötigt `STERRACODE_DOMAIN=code.example.org`, `STERRACODE_PUBLIC_URL=https://code.example.org` und den Proxy-Modus `caddy`. `STERRACODE_TLS_MODE=internal` verwendet die lokale Caddy-CA, deren Rootzertifikat auf jedem zugreifenden Gerät vertraut werden muss. Für öffentlich gültige ACME-Zertifikate `STERRACODE_TLS_MODE=` setzen und DNS sowie eingehende Validierung passend konfigurieren. Eine Domain allein erzeugt keine Erreichbarkeit. Caddy persistiert Zertifikate in eigenen Volumes.

Ein bestehender Proxy muss 4 MiB JSON, DELETE mit JSON-Körper und Ausführungen bis mindestens 20 Minuten erlauben. SSE muss ungepuffert weitergereicht werden; im Beispiel Caddy ist `flush_interval -1` gesetzt. Browser und App verwenden keine WebSockets. Die native LM-Studio-WebSocket-Verbindung baut ausschließlich die App auf. HTTP im LAN verwendet ein HttpOnly-/SameSite-Lax-Cookie ohne Secure; eine konfigurierte HTTPS-URL setzt Secure. Eine HTTPS-URL bei anschließendem direkten HTTP-Zugriff kann deshalb keine Sitzung halten.

## LM Studio

| Standort | URL aus dem App-Container |
| --- | --- |
| Docker-Host | `http://host.docker.internal:1234` |
| Anderes LAN-Gerät | Dessen tatsächliche IPv4, etwa `http://192.168.178.20:1234` |
| HTTPS-Proxy | Etwa `https://llm.example.org` |

Compose ergänzt unter Linux `host.docker.internal:host-gateway`. LM Studio muss auf einer aus dem Container erreichbaren Adresse lauschen. `localhost` bezeichnet die App selbst. Importierte lokale Adressen werden gemeldet und erhalten. Die Diagnose prüft das native SDK, Modellzugriff und Tokenisierung; `/v1/models` allein belegt den SDK-WebSocketzugriff nicht. SDK 2.1.0 ist im Dependencylock festgeschrieben.

`STERRACODE_LM_STUDIO_URL` ist die Vorgabe für neue Einstellungen. Danach gilt die gespeicherte Adresse; ein administrativer Override ist über die Serverkonfiguration ausdrücklich benannt. Token werden als geschützte Datei bereitgestellt. Für das vorbereitete Overlay `STERRACODE_LM_STUDIO_TOKEN_PATH` auf eine vom Appbenutzer lesbare Hostdatei setzen. Die Startskripte ergänzen dann `compose.lm-secret.yaml`; nur die App bekommt den Mount. Die Datei auf Linux beispielsweise an UID 10001 geben und Modus 0400 setzen. Bei Token-/Adresswechsel wird der SDK-Clientcache erneuert. Ein Modell ist keine Voraussetzung für Sessions, Editor, Runner oder Programme.

## Programme und Grenzen

Unter Einstellungen → Programme werden Java JDK, Python, Go, Rust/Cargo, C/C++, .NET SDK und Lua tatsächlich installiert oder entfernt. Node und Bash gehören zur Basis und können für die Sprachausführung deaktiviert werden. Deaktivieren erhält Pakete; Entfernen ändert das Sollmanifest und entfernt die zugehörigen optionalen Pakete. Gemeinsam benötigte Abhängigkeiten und Grundkomponenten bleiben erhalten. Das Sollmanifest ist nach der ersten Initialisierung maßgeblich; `STERRACODE_INITIAL_PROGRAMS` wird nur beim ersten Manifest übernommen.

Paketänderungen sperren neue Starts. Laufende Aufträge dürfen auslaufen oder werden nach ausdrücklicher Auswahl gestoppt. Wiederherstellung nach Containerneuerstellung nutzt exakte Versionen und geprüften Paketcache; fehlende Pakete oder beschädigte Downloads zeigen einen reparierbaren Fehler. Fehlerzustände werden nicht als erfolgreiche Installation angezeigt. Die Oberfläche bleibt währenddessen für Datei- und Sessionarbeit erreichbar.

Die App ist eine Instanz mit 1 GiB RAM und 128 Prozessen; der Runner hat 2 GiB und 256 Prozesse. Bis zu vier aktive Ausführungen, höchstens eine je Session und zwei Kompilierungen gleichzeitig. Limits stehen in `compose.yaml`. App ist UID/GID 10001, Nutzerprogramme UID 10002/GID 10001 ohne Zusatzgruppen. Gemeinsam beschreibbare Workspaces haben Setgid und Umask 002. Steuerdateien, Journal und Runner-Schlüssel sind rootgeschützt; App-Daten sind nicht im Runner gemountet. Der Runner hat keinen veröffentlichten Port. Docker-Socket und Hostsystemverzeichnisse werden nicht gemountet.

## Import bestehender Daten

Zuerst den alten lokalen Server stoppen und eine separate Kopie seines vollständigen `server/data`-Verzeichnisses sichern. Unvollständige Migrationsjournale vor dem Import durch Öffnen der betroffenen Session im alten Server abschließen. Der Import verweigert unvollständige Journale, Symlinks/Junctions, Hardlinks und Spezialdateien. Originale bleiben unverändert, die Quelle wird ausschließlich lesend gemountet. Importziele müssen leer sein: für einen Import vor dem ersten Installerstart Images bauen und mit neuem Projektnamen arbeiten.

```sh
cp .env.example .env
# .env: COMPOSE_PROJECT_NAME=sterracode-import, passende LAN-IP/URL
docker compose -f compose.yaml -f compose.lan.yaml build
bash scripts/docker-admin.sh import /absolute/path/to/old/server/data
bash install.sh
```

```powershell
.\scripts\docker-admin.ps1 import -Path 'C:\Sicherung\server\data'
.\install.ps1
```

Der Import bewahrt vor Schemaänderungen einen unveränderten Quellstand unter `backups/import-original-*`, übernimmt Sessions, UUID- und Titelworkspaces, Änderungen, Profile, Backups, Kontext und abgeschlossene Marker und lädt jede Session einmal zum Abschluss der Migration. `runs` wird ausgelassen. Dateirechte werden auf die Container-UIDs angepasst. Browserentwürfe im localStorage wandern nicht mit. Alte Session öffnen und Dateiinhalt, Änderungshistorie sowie KI-Rückgängig prüfen.

## Sicherung, Wiederherstellung und Passwort zurücksetzen

```sh
bash scripts/docker-admin.sh backup /absolute/path/to/empty/backup
# Mit Paketcache und Images für Offline-Wiederherstellung:
bash scripts/docker-admin.sh backup /absolute/path/to/empty/offline-backup --offline
```

```powershell
.\scripts\docker-admin.ps1 backup -Path 'D:\SterraBackup\2026-10-18' -Offline
```

Der Wrapper stoppt App und Runner kontrolliert und startet ausschließlich den Hilfscontainer. Währenddessen sind neue Schreibaktionen und Aufträge gesperrt. Danach startet er den Stack wieder. Bei Fehler bleibt der Stack gestoppt. Die Sicherung enthält App-Daten einschließlich Anmeldeinformationen, Workspaces, Sollmanifest/Journal und getrennte Archive beider Dienstschlüssel. Optional kommen Paketcache und `images.tar` hinzu. Werkzeugcache und flüchtige Compilergebnisse gehören nicht zur Sicherung. Das Manifest nennt UTC-Zeitpunkt, Architektur, Schema, Imageidentitäten, Volumes, Größe und SHA-256; es enthält keine Secretwerte. Zielverzeichnis erhält 0700 und Archive 0600. Auf Windows muss die Host-ACL den Zugriff entsprechend begrenzen. LM-Studio-Token außerhalb der Volumes getrennt geschützt sichern oder neu bereitstellen.

Restore immer zunächst mit anderem Compose-Projektnamen und anderem Port erproben. Das Restoreziel muss leer sein, die Dienste bleiben gestoppt. Kein regulärer Update- oder Restorebefehl löscht alte Volumes. In der neuen Arbeitskopie `.env` anpassen, die passenden App-/Runner-Images bauen beziehungsweise aus `images.tar` laden und auf die Images des Zielprojekts taggen; anschließend:

```sh
bash scripts/docker-admin.sh restore /absolute/path/to/backup
bash start-docker.sh
```

```powershell
.\scripts\docker-admin.ps1 restore -Path 'D:\SterraBackup\2026-10-18'
.\start-docker.ps1
```

Der Helfer prüft vor dem ersten Entpacken alle Prüfsummen, Pfade, Typen und Größen sowie freien Platz. Absolute Pfade, `..`, Links, Spezialdateien, doppelte Einträge und mehr als 100 GiB entpackte Daten je Archiv werden abgewiesen. Das Größenlimit kann für bewusst größere Daten über `STERRACODE_ARCHIVE_MAX_BYTES` im Hilfscontainer gesetzt werden. Ein Backup mit Symlinks/Hardlinks wird ebenfalls abgewiesen; solche Dateien vor der Sicherung entfernen oder als reguläre Dateien exportieren. Anschließend alte Session samt Verlauf öffnen und einen echten Lauf mit rekonstruierter Laufzeit durchführen. Ein vorhandenes Archiv allein gilt nicht als Restoreabnahme.

Vergessenes Passwort bei gestopptem Stack:

```sh
bash stop-docker.sh
bash scripts/docker-admin.sh reset-password
bash start-docker.sh
```

```powershell
.\stop-docker.ps1
.\scripts\docker-admin.ps1 reset-password
.\start-docker.ps1
```

Der Hilfscontainer widerruft die bisherigen Sitzungen und zeigt einen neuen Einrichtungsschlüssel zur Passwortvergabe. Das ist kein API-Hintereingang und kein `exec` in einen gestoppten Dienst.

## Updates, Rollback und Tests

Vor einem Update sichern, danach `git pull`, `docker compose -f compose.yaml -f compose.lan.yaml build` und das Startskript ausführen. Niemals `down -v` oder `docker system prune` als Update verwenden. Der Projektname ist standardmäßig `sterracode`; jede weitere Arbeitskopie braucht einen anderen `COMPOSE_PROJECT_NAME`. Die Volumes haben keine globalen Namen. Rollback verlangt die vorherigen App-/Runner-Imageidentitäten und bei einer Migration den passenden gesicherten Datenstand. Basis-Node 24 auf Debian Bookworm ist durch Digest gebunden; Sicherheitsupdates werden als gemeinsames Release aus neuem Basisdigest, geprüftem Katalog und vollständigen Laufzeitsmokes veröffentlicht. App und Runner müssen denselben Protokollstand haben.

`npm test` benötigt kein Docker. `npm run test:docker` baut ein isoliertes temporäres Projekt, testet Health, geschützte Einrichtung, echte Ausführung, Containerneuerstellung und Restore in ein zweites Projekt und entfernt nur diese Testprojekte. Ohne Linux-Daemon wird lokal verständlich übersprungen; `CI=1` oder `STERRACODE_DOCKER_REQUIRED=1` macht dies zum Fehler. `STERRACODE_DOCKER_FULL=1` installiert, testet, deaktiviert, aktiviert und entfernt jede optionale Laufzeit. CI führt diesen vollständigen Kataloglauf aus. Playwright verwendet weiterhin den lokalen Testserver auf Port 3107. ARM64 ist bis zur vollständigen Katalogabnahme nicht freigegeben.

Plattformnachweise und tatsächliche Ubuntu-Ergebnisse stehen in [docker/ABNAHME.md](docker/ABNAHME.md). Windows-LAN, ein zweites physisches Gerät, IPv6, öffentliche HTTPS-Zertifikate und eine echte LM-Studio-Instanz brauchen jeweils ihre eigene verfügbare Testumgebung.

## KI-Anbieter und OpenAI-Zugang

Unter Einstellungen kann zwischen LM Studio und der direkten OpenAI API gewechselt werden. LM Studio unterstützt sowohl Host- und LAN-Adressen als auch eine externe HTTPS-Adresse. Der native Verbindungstest prüft WebSocket-Zugriff sowie bei geladenem Modell Tokenisierung und Kontextgröße. Eine importierte localhost-Adresse bleibt unverändert und wird im Dockerbetrieb als unpassend gemeldet.

Für OpenAI einen API-Schlüssel über den eigenen Zugangsdialog speichern und eine ausdrücklich gewünschte Modell-ID auswählen oder eintragen. Der Schlüssel wird serverseitig in `provider-secrets.json` auf dem privaten App-Volume mit Dateimodus `0600` gespeichert. Die allgemeine Settings-API und die Zugangsdaten-Metadaten liefern ihn nicht zurück. Er wird nicht in Browser-Localstorage, `.env`, Runner oder Compose-Umgebung geschrieben. App-Backups enthalten den gespeicherten Schlüssel und müssen entsprechend geschützt werden. Löschen im Zugangsdialog entfernt den gespeicherten Schlüssel.

Als Alternative kann eine Secret-Datei verwendet werden: `.env` enthält nur `STERRACODE_OPENAI_API_KEY_PATH=/absoluter/host/pfad/openai-key`; die Startskripte ergänzen `compose.openai-secret.yaml` und mounten die Datei nur in der App. Intern liest die App `STERRACODE_OPENAI_API_KEY_FILE`. Diese Vorgabe hat Vorrang vor dem gespeicherten Schlüssel und ist in der Oberfläche schreibgeschützt. Externe Secret-Dateien werden separat gesichert.

OpenAI-Anfragen gehen ausschließlich an `https://api.openai.com/v1`; die LM-Studio-URL kann dieses Ziel nicht verändern. Die Anbindung verwendet die Responses API mit Funktionswerkzeugen, Streaming und `store: false`. Auch automatische Kontextzusammenfassungen nutzen den ausgewählten Anbieter. Chat und Zusammenfassungen können deshalb API-Kosten verursachen. Der Verbindungstest lädt nur die Modellliste und prüft die Eingabe-Tokenzählung; er erzeugt keine Modellantwort. Ein realer kostenpflichtiger OpenAI-Schlüssel wurde für die Entwicklungstests nicht verwendet.

Das OpenAI-Kontextbudget ist eine einstellbare Obergrenze für Eingabe und reservierte Ausgabe, standardmäßig 128.000 Tokens. Es muss zum gewählten Modell passen. Die API-Modellliste liefert keine verlässliche Kontextgröße; ein zu großes Budget wird bei einer API-Ablehnung verständlich gemeldet. Volle Nachrichten einschließlich Werkzeugschemata werden über den offiziellen Input-Token-Endpunkt gezählt. Temperaturoptionen bleiben bei OpenAI ungesendet, da ihre Unterstützung modellabhängig ist. Verschlüsselte Reasoning-Einträge bei Werkzeugaufrufen werden im privaten Sessionverlauf erhalten und beim nächsten Aufruf zurückgegeben. Ein abgebrochener Antwortstrom wird nicht automatisch erneut kostenpflichtig gestartet.

Technische Referenzen: [Responses und Funktionswerkzeuge](https://developers.openai.com/api/docs/guides/function-calling), [Streaming](https://developers.openai.com/api/docs/guides/streaming-responses), [Tokenzählung einschließlich Werkzeugschemata](https://developers.openai.com/api/docs/guides/token-counting). LM Studio verwendet das festgeschriebene SDK `2.1.0` mit der dokumentierten [apiToken-Option](https://lmstudio.ai/docs/typescript/authentication).

## Automatisierte erste Anmeldung und administrative Vorgaben

Für eine unbeaufsichtigte erste Einrichtung kann `STERRACODE_ADMIN_PASSWORD_PATH` in `.env` auf eine geschützte Hostdatei zeigen. Das Secret-Overlay mountet sie als `STERRACODE_ADMIN_PASSWORD_FILE`; der Inhalt wird nur übernommen, solange noch kein Administratorkonto existiert. Mindestens zwölf Zeichen sind erforderlich. Ein bestehendes Passwort wird durch Neustarts oder spätere Änderungen dieser Datei nicht ersetzt. Einrichtungs- und Sitzungsschlüssel werden ausschließlich gehasht gespeichert; ein Passwortwechsel widerruft ältere Sitzungen.

`STERRACODE_LM_STUDIO_URL` ist die Vorgabe für neue Einstellungen. Für eine dauerhafte administrative Adressvorgabe kann die App ausdrücklich `STERRACODE_LM_STUDIO_OVERRIDE_URL` erhalten; die gespeicherte Benutzeradresse bleibt dabei erhalten. Das ist eine nicht geheime URL und erfordert bei Änderung einen Neustart. LM-Studio-Token bleiben in der gesondert gemounteten Secret-Datei; ein Token- oder Adresswechsel erzeugt einen neuen nativen Client.
