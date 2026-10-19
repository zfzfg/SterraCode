const catalog = {
  IndexError: [
    "Index außerhalb des gültigen Bereichs",
    "Ein Zugriff liegt außerhalb der vorhandenen Positionen. Prüfe Listenlänge und Schleifenrand.",
  ],
  KeyError: [
    "Schlüssel fehlt",
    "Der angefragte Schlüssel ist im Dictionary nicht vorhanden. Prüfe Eingabe und Schlüssel vor dem Zugriff.",
  ],
  NameError: [
    "Name ist nicht definiert",
    "Prüfe Schreibweise und ob die Variable vor ihrer Verwendung einen Wert erhält.",
  ],
  ReferenceError: [
    "Name ist nicht verfügbar",
    "Prüfe Schreibweise, Deklaration und den Gültigkeitsbereich der Variable.",
  ],
  TypeError: [
    "Datentypen passen nicht",
    "Prüfe die beteiligten Datentypen und die erwarteten Argumente dieser Operation.",
  ],
  ValueError: [
    "Wert passt nicht zur Operation",
    "Der Datentyp kann stimmen, aber der konkrete Wert ist für diese Operation ungeeignet.",
  ],
  ZeroDivisionError: [
    "Division durch null",
    "Prüfe den Nenner und entscheide, wie dein Programm den Wert null behandeln soll.",
  ],
  SyntaxError: [
    "Syntax prüfen",
    "Der Quelltext kann nicht eingelesen werden. Prüfe die markierte Zeile und die Zeile davor auf Klammern, Anführungszeichen und fehlende Zeichen.",
  ],
  IndentationError: [
    "Einrückung prüfen",
    "Zusammengehörige Python-Blöcke brauchen eine konsistente Einrückung.",
  ],
  TabError: [
    "Tabs und Leerzeichen gemischt",
    "Verwende innerhalb eines Python-Blocks einheitliche Einrückungen.",
  ],
};

export function explainError({ message = "", kind, reason } = {}) {
  if (kind === "serialization_error")
    return {
      category: "Rückgabeformat",
      title: "Rückgabe nicht vergleichbar",
      explanation:
        "Die sichtbaren Tests vergleichen JSON-Werte. Prüfe, ob deine Rückgabe einen unterstützten Datentyp enthält und keine Zyklen oder nicht endlichen Zahlen besitzt.",
    };
  if (kind === "return")
    return {
      category: "Abweichendes Ergebnis",
      title: "Rückgabewert prüfen",
      explanation:
        "Vergleiche erhaltenen Wert, Datentyp und erwartetes Ergebnis. Prüfe auch leere Eingaben und Randfälle.",
    };
  if (
    [
      "timeout",
      "output_limit",
      "stopped",
      "not_run",
      "invalid_result",
    ].includes(kind) ||
    reason
  )
    return {
      category: "Ausführung / Infrastruktur",
      title:
        kind === "timeout" || reason === "timeout"
          ? "Zeitlimit erreicht"
          : "Lauf nicht vollständig auswertbar",
      explanation:
        "Prüfe den originalen Abschlussgrund. Ein abgebrochener Lauf oder ein Infrastrukturproblem belegt keine falsche Lösung.",
    };
  const match = String(message).match(
    /(?:^|\n)(?:Uncaught\s+)?(IndexError|KeyError|NameError|ReferenceError|TypeError|ValueError|ZeroDivisionError|SyntaxError|IndentationError|TabError):/,
  );
  if (!match)
    return {
      category: "Unbekannter Fehler",
      title: "Originalmeldung prüfen",
      explanation:
        "Für diese Meldung ist keine eindeutige Offline-Erklärung hinterlegt. Lies die Originalmeldung und prüfe die Quellstelle, falls vorhanden.",
    };
  const type = match[1];
  return {
    category: ["SyntaxError", "IndentationError", "TabError"].includes(type)
      ? "Syntaxfehler"
      : "Laufzeitfehler",
    title: catalog[type][0],
    explanation: catalog[type][1],
  };
}

// Only navigate to a file confirmed by the current workspace listing. Absolute
// library frames must include this workspace's UUID, never just a basename.
export function errorLocation(output, paths, sessionId) {
  const text = String(output)
    .slice(-65536)
    .replace(/\u001b\[[0-9;]*m/g, "");
  const frames = [
    ...text.matchAll(
      /File "([^"]+)", line (\d+)|(?:file:\/\/\/)?([^\s()]+\.(?:[cm]?js|html)):(\d+)(?::\d+)?/g,
    ),
  ];
  const matches = frames
    .map((m) => {
      let source = (m[1] || m[3]).replace(/\\/g, "/");
      try {
        source = decodeURIComponent(source);
      } catch {
        return null;
      }
      const file = paths.find(
        (p) =>
          source === p ||
          source === `./${p}` ||
          source.endsWith(`/${sessionId}/${p}`),
      );
      const line = Number(m[2] || m[4]);
      return file && Number.isSafeInteger(line) && line > 0 && line <= 1000000
        ? { file, line }
        : null;
    })
    .filter(Boolean);
  return matches.at(-1) || null;
}
