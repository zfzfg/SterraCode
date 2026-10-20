# Cache-Nutzung und Token-Effizienz

SterraCode trennt die Größe des nächsten Modellkontexts von tatsächlich gemeldetem Verbrauch. Antwortlimits, Reasoning-Einstellungen, Modellwahl und Komprimierungsschwellen bleiben unverändert.

## Verhalten

- Feste Anweisungen bleiben am Promptanfang. Änderungen an aktiver Datei, Sprache, Lernplan, Aufgabe und freigegebenem Profil werden als interne Zustands-Snapshots angehängt. Unveränderte Zustände erzeugen keinen weiteren Snapshot. `/usage` legt keine Snapshots an.
- Snapshots sind Daten, keine Nutzeraufträge oder Ausführungsfreigaben. Der tatsächliche aktuelle Nutzerauftrag bleibt vor Komprimierung geschützt. Der letzte abgedeckte Snapshot bleibt auch nach Komprimierung exakt verfügbar. Modelle ohne Systemrolle erhalten eine passende zusammengeführte SDK-Ansicht; Originalnachrichten bleiben getrennt.
- Tool-Ergebnisse werden für das Modell projiziert. Schreibbestätigungen enthalten Status und Versions-/Änderungsreferenzen statt einer zweiten Kopie des Codes. Beide Provider begrenzen große Ergebnisse anhand der bestehenden Ergebnisbudgets. Die vollständigen Originale bleiben gespeichert und über `read_tool_result` nachladbar.
- `read_file` akzeptiert optionale inklusive Zeilenbereiche `startLine`/`endLine` ab 1. Ausschnitte behalten die Version der ganzen Datei und nennen Gesamtzeilenzahl sowie tatsächlich gelesenen Bereich.
- Terminaltools übertragen höchstens 16 KiB Ausgabe pro Seite vor Anwendung des Tokenbudgets. `nextCursor` wird unverändert als `cursor` weitergegeben. Cursor sind an Session, Prozess, Laufzeit und App-Instanz gebunden. Nach einem App-Neustart kann ein alter Cursor abgewiesen werden; ohne Cursor lässt sich ein noch verfügbarer Prozess erneut ab Anfang lesen. Ein leerer Folgeschritt liefert weiterhin den Prozessstatus.
- Terminal-Originalausgaben bleiben im gespeicherten Tool-Ergebnis erhalten, auch wenn der Prozess später abläuft. Das interne Feld `modelPage` hält die stabile Modellseite samt Cursor; die Projektion ersetzt damit die vollständige `output`-Übertragung. Die bisherigen HTTP-Terminal-Offsets ändern sich nicht.
- OpenAI-Komprimierungsobjekte und die erhaltenen nativen Komprimierungsfenster werden nicht durch den Ergebnislimiter umgeschrieben. Bereits komprimierte historische Originalergebnisse werden nicht nochmals für die Projektion tokenisiert. Änderungen der Quellhistorie oder der Profilfreigabe verhindern die Wiederverwendung veralteten Providerzustands.

## Verbrauchsdaten

Modellantworten speichern optional `usage` mit `inputTokens`, `outputTokens`, `reasoningTokens`, `cacheReadTokens` und `cacheWriteTokens`. Fehlende Werte sind `null`. `responseId` erlaubt die Deduplizierung; `modelCall` unterscheidet Modellantworten von anwendungsseitigen Hinweisen.

Interne LM-Studio-Zusammenfassungen und manuelle OpenAI-Komprimierungen erzeugen ebenfalls Verbrauchsbelege. `turn.usage` aggregiert diese und die Tutoraufrufe; `contextUsage.consumption` stellt das Ergebnis der Anzeige bereit. Reasoning-Tokens sind bereits in Output-Tokens enthalten. Tokenzählanfragen und `/usage` gelten nicht als Generierung.

Der Cache-Read-Anteil wird über zusammengehörige Input-/Cache-Messungen gewichtet. `measuredCalls` und `cacheMeasuredCalls` zeigen, ob alle Aufrufe gemessen wurden. Unvollständige Gesamtsummen werden nicht als vollständiger Turnverbrauch ausgegeben. Das installierte LM-Studio-SDK liefert Input-/Output-Zähler, aber keine entsprechenden Cache-/Reasoning-Zähler; dafür werden keine Werte geschätzt.

## Reproduzierbarer Offlinevergleich

```powershell
node scripts/compare-token-efficiency.mjs
```

Der Vergleich nutzt ausschließlich Wegwerfverzeichnisse und lokale Provider-Fixtures. Er prüft Datei lesen/schreiben, Aufgabe ändern, Terminalausgabe wiederholt lesen, Präfixstabilität bei Dateiwechsel und Komprimierung eines langen Verlaufs. Originaldaten und Versionsreferenzen bleiben erhalten. Die LM-Studio-Baseline berücksichtigt die bereits vorher vorhandenen Ergebnislimits; beide Varianten verwenden dieselben Standardbudgets. Die frühere OpenAI-Baseline ist unbeschränkt.

Beispiel auf Windows/Node 24.19.0, 20.10.2026:

| Gesprächsdaten ohne gemeinsamen Toolschema-Overhead |       Vorher |      Nachher | Reduktion |
| --------------------------------------------------- | -----------: | -----------: | --------: |
| LM Studio                                           | 65.957 Bytes | 43.530 Bytes |    34,0 % |
| OpenAI                                              | 65.750 Bytes | 42.391 Bytes |    35,5 % |

Im separaten Wiederholungsbeispiel sinkt dieselbe Terminalausgabe von 4.764 auf 2.382 übertragene Bytes. Der OpenAI-Präfix bleibt beim Dateiwechsel unverändert; der lange LM-Studio-Verlauf wird weiterhin komprimiert.

Dies sind Payload-Messungen für einen festgelegten Ablauf, keine allgemeine Einsparprognose. Tokenzahlen des Fixture-Tokenizers sind simuliert; tatsächliche Provider-Tokens und Cache-Hit-Raten werden im Bericht ausdrücklich als nicht gemessen (`null`) ausgegeben. Es erfolgen keine kostenpflichtigen Modellaufrufe. Reale Cache-Effekte sind anschließend anhand der gespeicherten Nutzungswerte mit demselben Modell und vergleichbaren Abläufen zu vergleichen.

Prüfungen: `npm test`, `npm run test:e2e`, `npm run format:check`, `npm run test:docker`. Plattformnachweise stehen in `docker/ABNAHME.md`.
