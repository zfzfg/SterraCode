const suite = (fn, cases) => ({
  schemaVersion: 1,
  version: 1,
  language: "python",
  entry: { path: "main.py", function: fn },
  comparison: { kind: "strict-json" },
  cases: cases.map(([name, args, expected], i) => ({
    id: `case-${i + 1}`,
    name,
    args,
    expected,
    visibility: "public",
    required: true,
  })),
});

export const PROJECT_TEMPLATES = [
  {
    id: "guess-number",
    version: 1,
    title: "Zahlenratespiel",
    language: "python",
    goal: "Vergleiche einen Tipp mit einer geheimen Zahl und gib verständliche Rückmeldungen.",
    prerequisites: ["Variablen", "Bedingungen", "Funktionen"],
    milestone:
      "Die Funktion beurteile_tipp gibt zu klein, zu groß oder richtig zurück.",
    runtime: "Python 3 (Standardbibliothek; keine Installation beim Import)",
    features: ["Funktionen", "Vergleiche", "if / elif / else"],
    origin: "SterraCode",
    license: "CC0-1.0",
    files: [
      {
        path: "main.py",
        content:
          '# Vergleiche tipp mit geheim. Ergänze die drei Fälle.\ndef beurteile_tipp(tipp, geheim):\n    # TODO: Gib "zu klein", "zu groß" oder "richtig" zurück.\n    pass\n',
      },
    ],
    task: {
      title: "Einen Tipp beurteilen",
      description:
        "Implementiere beurteile_tipp(tipp, geheim). Erst danach kannst du freiwillig eine Spielschleife ergänzen.",
      conceptIds: ["python.conditions", "python.functions"],
      difficulty: "easy",
      hints: [
        "Welche drei Beziehungen können zwei Zahlen haben?",
        "Prüfe kleiner, größer und gleich getrennt.",
        "Ergänze die Bedingungen innerhalb von beurteile_tipp.",
        'Lösungsidee: if tipp < geheim: return "zu klein"; elif tipp > geheim: return "zu groß"; sonst return "richtig". Schreibe die Zweige als Python-Code.',
      ],
      testSuite: suite("beurteile_tipp", [
        ["Zu klein", [2, 5], "zu klein"],
        ["Zu groß", [8, 5], "zu groß"],
        ["Treffer", [5, 5], "richtig"],
        ["Negative Zahl", [-5, -2], "zu klein"],
      ]),
    },
    checklist: [
      "Alle sichtbaren Fälle bestehen",
      "Einen neuen Tipp selbst ausprobieren",
    ],
  },
  {
    id: "text-analysis",
    version: 1,
    title: "Textauswertung",
    language: "python",
    goal: "Zähle Wörter in Texten einschließlich leerer Eingaben und mehrfacher Leerzeichen.",
    prerequisites: ["Zeichenketten", "Listen", "Funktionen"],
    milestone: "Die Funktion zaehle_woerter liefert eine ganze Zahl.",
    runtime: "Python 3 (Standardbibliothek; keine weiteren Pakete)",
    features: ["str.split", "len", "return"],
    origin: "SterraCode",
    license: "CC0-1.0",
    files: [
      {
        path: "main.py",
        content:
          "def zaehle_woerter(text):\n    # TODO: Zähle Wörter, getrennt durch beliebigen Leerraum.\n    pass\n",
      },
    ],
    task: {
      title: "Wörter zählen",
      description:
        "Implementiere zaehle_woerter(text). Mehrere Leerzeichen und Zeilenumbrüche sollen keine leeren Wörter erzeugen.",
      conceptIds: ["python.strings", "python.lists", "python.functions"],
      difficulty: "easy",
      hints: [
        "Wie viele Wörter enthält eine leere Zeichenkette?",
        "split() ohne Argument behandelt beliebigen Leerraum.",
        "Zerlege text innerhalb der Funktion und bestimme die Listenlänge.",
        "Lösungsvorschlag: return len(text.split()). Probiere danach eigene Eingaben aus.",
      ],
      testSuite: suite("zaehle_woerter", [
        ["Leerer Text", [""], 0],
        ["Zwei Wörter", ["Hallo Welt"], 2],
        ["Leerraum", ["  eins   zwei\ndrei\t"], 3],
      ]),
    },
    checklist: ["Leere Eingabe prüfen", "Text mit Zeilenumbruch prüfen"],
  },
  {
    id: "small-website",
    version: 1,
    title: "Meine kleine Webseite",
    language: "javascript",
    goal: "Gestalte eine statische Seite und ändere ihren Inhalt mit einem Klick.",
    prerequisites: ["HTML-Grundstruktur", "CSS-Selektoren"],
    milestone:
      "Ergänze eine Überschrift, eine eigene Farbe und die Klickaktion.",
    runtime:
      "Integrierte statische Web-Vorschau; kein Node.js oder Paket erforderlich",
    features: ["HTML", "CSS", "DOM-Ereignisse"],
    origin: "SterraCode",
    license: "CC0-1.0",
    files: [
      {
        path: "index.html",
        content:
          '<!doctype html>\n<html lang="de">\n<meta charset="utf-8">\n<meta name="viewport" content="width=device-width,initial-scale=1">\n<title>Meine Webseite</title>\n<link rel="stylesheet" href="style.css">\n<h1>Meine erste Seite</h1>\n<p id="nachricht">Was möchtest du zeigen?</p>\n<button id="aktion">Text ändern</button>\n<script src="app.js"></script>\n</html>\n',
      },
      {
        path: "style.css",
        content:
          "body { font-family: sans-serif; margin: 2rem; }\n/* TODO: Gestalte Überschrift und Button. */\n",
      },
      {
        path: "app.js",
        content:
          '// TODO: Ändere beim Klick den Text in #nachricht.\ndocument.querySelector("#aktion").addEventListener("click", () => {\n  // Ergänze hier deine Aktion.\n});\n',
      },
    ],
    task: {
      title: "Eine interaktive Seite gestalten",
      description:
        "Ändere Überschrift und Farbe. Ergänze danach die Klickaktion. Prüfe das Ergebnis in der Web-Vorschau anhand der Prüfliste.",
      hints: [
        "Welche Elemente möchtest du verändern?",
        "CSS gestaltet die Seite, JavaScript reagiert auf den Klick.",
        "Ergänze den Event-Handler in app.js.",
        'Lösungsidee für die Aktion: document.querySelector("#nachricht").textContent = "Hallo Welt!";',
      ],
      conceptIds: ["javascript.functions"],
      difficulty: "easy",
    },
    checklist: [
      "Eigene Überschrift sichtbar",
      "Farbe geändert",
      "Klick ändert den Nachrichtentext",
      "Mit Tab und Enter bedienbar",
      "Keine Fehler im Vorschau-Log",
    ],
  },
];
