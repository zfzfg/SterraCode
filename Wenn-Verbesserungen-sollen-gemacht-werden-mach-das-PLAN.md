# SterraCode als zuverlässigen Lernarbeitsplatz verbessern

> Umsetzungsstand: Die Überarbeitung mit SVG-Icons, modularer Oberfläche, UUID-Workspaces, versioniertem Speichern, dauerhafter KI-Rücknahme, persistenten Fragen und Lernplänen sowie gemeinsamem Prozessdienst ist implementiert. Einrichtung, Datenmigration und Testbefehle stehen in der README. Die folgenden Abschnitte dokumentieren die ursprüngliche Planung.

## Zusammenfassung

SterraCode wird in drei aufeinander aufbauenden Etappen verbessert: zuerst Datenhaltung und Ausführung stabilisieren, dann die Oberfläche für Einsteiger neu ordnen, anschließend Lernplan, Chat und Dateiarbeit vervollständigen. Express, Monaco und Vanilla JavaScript bleiben bestehen. Vorhandene Sessions und Dateien werden übernommen.

## Umsetzung

1. **Stabilität und Daten schützen.** Pro Session einen dauerhaft zugeordneten Workspace verwenden; bestehende Ordner und Editor-Snapshots beim ersten Öffnen verlustfrei übernehmen. Der Editor speichert die aktive Datei statt nur einen getrennten Session-Snapshot. Speichern, Session-Wechsel, KI-Änderungen und Rückgängig erhalten geordnete Schreibvorgänge und Versionsprüfungen, damit ältere Antworten keine neueren Inhalte überschreiben. Fehler werden sichtbar angezeigt. Session-IDs und Dateipfade serverseitig prüfen, Zugriffe auf den Workspace begrenzen und den lokalen Server an `localhost` binden.

2. **KI und Terminal verlässlich machen.** Den Chat-Stream aus **einer** Modellantwort erzeugen und Abbruch, Verbindungsverlust und erneutes Senden sauber behandeln. Tool-Ergebnisse als strukturierte Ereignisse speichern und beim Wiederöffnen identisch darstellen. KI-Dateiänderungen direkt anwenden, mit einer dauerhaften, dateibezogenen Rückgängig-Aktion. KI-Terminalbefehle samt Ausgabe sichtbar machen und über eine Einstellung deaktivierbar halten. Für Nutzer- und KI-Befehle Ausgabelimits, Stop-Funktion und passende Zeitlimits ergänzen; das Terminal arbeitet im jeweiligen Session-Workspace.

3. **Oberfläche neu ordnen.** Aus dem im Screenshot weitgehend leeren Startzustand einen geführten Einstieg machen: gut sichtbare Aktion „Neue Session“, verständlicher LM-Studio-Status und ein nächster Lernschritt. Editor und Chat bleiben die Hauptbereiche; Lernplan, Dateien und Terminal sind bei Bedarf erreichbar und in der Größe anpassbar. Lesbarkeit, Kontrast, Fokusmarkierungen, Tastaturbedienung und Layout bei kleineren Desktopfenstern verbessern. Die vorhandenen Themes bleiben erhalten.

4. **Kernfunktionen abschließen.** Mehrere Dateien pro Session mit zuverlässigem Öffnen, Speichern, Erstellen, Umbenennen und Löschen unterstützen. Lernpläne sollen vom Nutzer und der KI aktualisiert, abgehakt und nach erneutem Öffnen korrekt angezeigt werden. Interaktive KI-Fragen, bearbeitete Nachrichten und deren Folgewirkungen auf den Chatverlauf konsistent speichern. Alle neun angezeigten Sprachen erhalten einen geprüften Ausführungsweg; fehlt eine Laufzeit auf dem Rechner, zeigt SterraCode eine konkrete Meldung statt eines scheinbar funktionsfähigen „Run“-Buttons.

## Schnittstellen und Prüfung

- Session-Daten erhalten eine stabile Workspace-Zuordnung; Datei- und Chat-API liefern klare Fehler und Versionenkonflikte. Alte Datenformate bleiben lesbar und werden ohne Überschreiben migriert.
- Die bisher leere Vitest-Suite bekommt Tests für Pfadgrenzen, Migration, konkurrierende Schreibvorgänge, Datei-Rückgängig, Chat-Ereignisse und Streaming mit einem simulierten LM Studio.
- Browser-Tests prüfen den vollständigen Ablauf: Session erstellen, Datei bearbeiten, neu laden, KI-Frage beantworten, Lernplan fortsetzen, KI-Änderung rückgängig machen sowie Offline- und Fehlerzustände. Ausführung wird für jede Sprache mit vorhandener und fehlender Laufzeit geprüft.

## Annahmen

SterraCode bleibt eine lokale Einzelplatzanwendung für Programmieranfänger. Dateiänderungen der KI erfolgen direkt und sind rückgängig zu machen; KI-Terminalbefehle sind sichtbar und abschaltbar. Komfortfunktionen des älteren Anforderungsdokuments wie Drag & Drop, Kopieren/Einfügen im Dateibaum und Öffnen im OS-Explorer gehören nicht zu diesem Umbau.
