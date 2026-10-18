# SterraCode – Feature-Anfragen & Bugfixes

> Dieses Dokument beschreibt alle gewünschten Erweiterungen und Korrekturen für das SterraCode-Projekt.  


---

## 1. Interaktive KI-Kommunikation (Fragen & Antworten)

Die lokale KI soll in der Lage sein, dem Nutzer aktiv Fragen zu stellen – nicht nur Aufgaben zu präsentieren.

**Frageformat:**
- **Multiple-Choice**: Die KI zeigt eine Frage mit 2–5 vordefinierten Antwortoptionen als klickbare Buttons an
- **Freitext**: Der Nutzer kann alternativ eine eigene Antwort in ein Eingabefeld tippen

**UI-Anforderungen:**
- Fragen der KI sollen sich visuell klar von normalen Chat-Nachrichten unterscheiden (z. B. eigene Komponente mit Fragezeichen-Icon oder anderer Hintergrundfarbe)
- Nach Beantwortung soll die gewählte Antwort sichtbar im Chat-Verlauf bleiben
- Die KI soll die Antwort des Nutzers in ihrem nächsten Schritt berücksichtigen (als Kontext weitergeben)

---

## 2. Lernplan-System

### 2.1 Lernplan-Erstellung zu Sessionbeginn

Beim Start **jeder neuen Session** fragt die KI den Nutzer:

> *„Möchtest du, dass ich für dich einen Lernplan erstelle? Du kannst ein Ziel und Themen angeben, die du lernen möchtest."*

- Bei **Ja**: Die KI erfragt das gewünschte Lernziel und die Themen (als interaktiver Dialog mit Fragen, siehe Punkt 1)
- Anschließend erstellt die KI einen strukturierten Plan mit:
  - Einem übergeordneten **Lernziel** (z. B. „Java-Grundlagen verstehen")
  - Einer **geordneten Liste von Themen/Lektionen** als Checkliste (Checkboxen)
  - Optional: einer geschätzten Anzahl an Sessions oder Schwierigkeitsangaben pro Thema

### 2.2 Lernplan als Checkliste

- Der Plan wird als interaktive Checkliste angezeigt (z. B. in der Session-Sidebar oder als eigene Komponente)
- Abgeschlossene Themen können abgehakt werden (manuell oder automatisch durch die KI)
- Der Lernplan-Fortschritt bleibt **persistent gespeichert** und wird beim Wiedereröffnen der Session korrekt wiederhergestellt

### 2.3 Lernplan anpassen

- Der Nutzer kann die KI jederzeit bitten, den Lernplan zu ändern:
  - Themen hinzufügen oder entfernen
  - Reihenfolge ändern
  - Ziel anpassen
- Die KI nimmt die Änderung vor und aktualisiert die Checkliste direkt

### 2.4 Nach Abschluss des Lernplans

- Wenn alle Punkte abgehakt sind, erkennt die KI dies **automatisch**
- Sie fragt den Nutzer:
  - *„Du hast alle Themen abgeschlossen! Möchtest du weitermachen?"*
  - *„Soll ich einen fortgeschrittenen Lernplan basierend auf deinem bisherigen Fortschritt erstellen?"*
- Bei Zustimmung erstellt die KI einen neuen, aufbauenden Lernplan

---

## 3. Mehrere Dateien & KI-Dateizugriff

### 3.1 Mehrere Dateien pro Session

- Es soll möglich sein, beliebig viele Dateien innerhalb einer Session zu erstellen und zu bearbeiten
- Alle Dateien einer Session werden in einem **echten Ordner auf dem Dateisystem** gespeichert
- Der **Überordner** trägt den **Namen der Session** (z. B. `SterraCode/MeineSession/Main.java`)

### 3.2 KI-Dateizugriff per Tool Call

- Die KI soll **keinen Code mehr direkt in Chat-Nachrichten senden** – weder über den bisherigen „Code"-Button noch über den „Erledigt"-Button. Beide Funktionen entfallen in ihrer jetzigen Form
- Stattdessen entscheidet die KI **selbst**, wann sie einen Tool Call verwendet, um:
  - Eine Datei **zu lesen** (z. B. um den aktuellen Stand des Codes zu analysieren)
  - Eine Datei **zu schreiben oder zu bearbeiten** (z. B. um Aufgaben-Templates oder Korrekturen einzufügen)
- Der Nutzer sieht im Chat, welche Datei die KI gerade liest oder bearbeitet (als kurze Info-Nachricht, z. B. *„[Lese: Main.java]"* oder *„[Schreibe: Main.java]"*)

### 3.3 Code-Änderungen ohne Bestätigungsdialog

- Die KI nimmt Code-Änderungen **direkt vor**, ohne vorher um Erlaubnis zu fragen
- Stattdessen erscheint nach jeder Änderung **in der entsprechenden Chat-Nachricht** ein kleiner **„Rückgängig"-Button**, mit dem der Nutzer die letzte Änderung an dieser Datei zurücksetzen kann
- So bleibt die Kontrolle beim Nutzer, ohne den Workflow zu unterbrechen

---

## 4. Datei-Sidebar & Verzeichnisverwaltung

### 4.1 Neue Datei-Sidebar

- Neben der bestehenden **Session-Sidebar** kommt eine neue **Datei-Sidebar** hinzu
- Der Nutzer kann zwischen beiden Sidebars wechseln, z. B. über **zwei Tabs oder Icons** oben in der Sidebar

### 4.2 Funktionsumfang der Datei-Sidebar

Die Datei-Sidebar verhält sich wie ein vollwertiger **Datei-Explorer**:

| Funktion | Beschreibung |
|---|---|
| Ordner erstellen | Neuen Unterordner anlegen |
| Ordner umbenennen | Name eines Ordners ändern |
| Ordner löschen | Ordner und Inhalt entfernen |
| Datei erstellen | Neue Datei anlegen (mit Dateinamen & Typ) |
| Datei umbenennen | Name einer Datei ändern |
| Datei kopieren (Copy) | Datei in Zwischenablage kopieren |
| Datei ausschneiden (Cut) | Datei ausschneiden und verschieben |
| Einfügen (Paste) | Kopierte/ausgeschnittene Datei einfügen |
| Datei löschen (Delete) | Datei entfernen |
| Drag & Drop | Dateien/Ordner per Ziehen verschieben |
| Kontextmenü | Rechtsklick öffnet Menü mit allen Aktionen |
| Im Datei-Explorer öffnen | Session-Ordner im nativen Explorer des OS öffnen |

**Zweck:** Diese Funktionen sollen es dem Nutzer erleichtern, **Importstrukturen und Paketorganisation** (z. B. in Java) praktisch zu üben.

---

## 5. Anpassbare Sidebar-Größen

- **Alle** Sidebars und Bereiche der Anwendung sollen durch Ziehen der Trennlinien in ihrer Größe anpassbar sein:
  - Session-Sidebar (Breite)
  - Datei-Sidebar (Breite)
  - Editor-Bereich (Breite/Höhe)
  - Terminal-Bar (Höhe) ← war bisher die einzige anpassbare
- Die eingestellten Größen sollen persistent gespeichert werden und beim nächsten Start wiederhergestellt werden

---

## 6. Terminal-Integration für die KI

- Die KI soll **Lesezugriff auf den Terminal-Output** haben (kann sehen, was im Terminal ausgegeben wird)
- Die KI darf außerdem **selbst Befehle im Terminal ausführen**, z. B. um:
  - Code zu kompilieren (`javac Main.java`)
  - Code auszuführen (`java Main`)
  - Abhängigkeiten zu installieren
  - Debugging-Aktionen durchzuführen

**Transparenz für den Nutzer:**
- Jeder Terminal-Befehl der KI erscheint im Chat als klar gekennzeichnete Nachricht (z. B. `[Terminal] javac Main.java`)
- Das Ergebnis des Befehls (Terminal-Output) wird ebenfalls im Chat oder direkt im Terminal angezeigt
- Der Nutzer kann Terminal-Befehle der KI in den Einstellungen optional **deaktivieren**

---

## 7. Bugfix: Textanzeigefehler beim Wiedereröffnen einer Session

**Problem (sichtbar im angehängten Screenshot):**  
Wenn eine Session geschlossen und später wieder geöffnet wird, werden Nachrichten nicht korrekt als UI-Komponenten gerendert. Stattdessen erscheint der **rohe JSON-Text** der Tool-Call-Nachrichten im Chat, z. B.:

```
{"type":"create_task","task":{"title":"Zahlen von 1 bis 10 mit for-Schleife ausgeben", ...}}
{"type":"write_editor","code":"public class Main { ... }","status":"pending_apply"}
```

**Wahrscheinliche Ursache:**  
Beim Laden gespeicherter Session-Nachrichten aus dem persistenten Speicher werden Tool-Call-Nachrichten nicht erneut durch den Render-Prozess geleitet, sondern direkt als Text-String ausgegeben.

**Gewünschte Lösung:**
- Beim Speichern einer Nachricht soll ihr **Typ** (`type`-Feld) und alle relevanten Daten mitgespeichert werden
- Beim Laden der Session müssen alle Nachrichten anhand ihres `type`-Felds korrekt als ihre jeweiligen **UI-Komponenten** gerendert werden (Aufgaben-Karte, Code-Template, KI-Frage, etc.)
- Nachrichten ohne `type` (normale Textnachrichten) werden wie gewohnt als Text gerendert
- Bitte stelle sicher, dass dieser Render-Prozess **identisch** mit dem beim ursprünglichen Empfang einer Nachricht ist

---

## 8. Design-Themes

- In den **Einstellungen** soll eine Auswahl an Design-Themes verfügbar sein (mindestens 3–4 Optionen), z. B.:
  - Dark (Standard, aktuelles Design)
  - Light
  - High Contrast (Barrierefreiheit)
  - Solarized / weitere nach Belieben
- Das gewählte Theme wird **persistent gespeichert**
- Der Theme-Wechsel soll **ohne Neustart** der Anwendung sofort angewendet werden (empfohlen: CSS-Variablen/Custom Properties)

---

## 9. Chat-Verbesserungen

### 9.1 Nachrichten bearbeiten

- Der Nutzer soll eigene Chat-Nachrichten **nachträglich bearbeiten** können (z. B. per Doppelklick oder einem „Bearbeiten"-Icon beim Hover)
- Nach der Bearbeitung wird die Konversation ab dieser Nachricht **neu gestartet**: Die KI antwortet erneut auf die geänderte Nachricht
- Bearbeitete Nachrichten erhalten eine **„(bearbeitet)"-Markierung**
- **Wichtig:** Der an die KI gesendete Kontext muss nach der Bearbeitung vollständig aktualisiert werden, damit der Gesprächsverlauf konsistent bleibt

### 9.2 Letzte Nachricht löschen

- Es soll möglich sein, die **zuletzt gesendete Nutzer-Nachricht sowie die dazugehörige KI-Antwort** gemeinsam zu löschen
- Der Chat-Verlauf wird entsprechend bereinigt
- **Wichtig:** Auch hier muss der gesendete Kontext aktualisiert werden, damit die KI beim nächsten Senden keinen inkonsistenten Verlauf erhält
- Falls die gelöschte Nachricht eine Datei-Änderung ausgelöst hat, soll der Nutzer optional gefragt werden, ob diese ebenfalls rückgängig gemacht werden soll

---

## Zusammenfassung der notwendigen technischen Anpassungen

| Bereich | Änderung |
|---|---|
| KI-Kontext | Immer vollständigen, aktuellen Chat-Verlauf übergeben (besonders nach Edit/Delete) |
| Persistenz | Lernplan, Sidebar-Größen, Theme, Dateistruktur persistent speichern |
| Session-Daten | Nachrichtentypen beim Speichern mitschreiben, beim Laden korrekt rendern |
| Tool Calls | KI entscheidet eigenständig über Datei-Lese- und Schreib-Calls |
| Datei-System | Echter OS-Ordner pro Session, vollständige CRUD-Operationen |
| Undo-System | Rückgängig-Funktion für KI-Code-Änderungen direkt in Chat-Nachrichten |