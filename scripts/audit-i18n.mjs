import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { parsers } from "prettier/plugins/babel";
import { parse as parseHtml } from "parse5";
import * as cssTree from "css-tree";

// Planning tool: reads tracked sources, never application data or credentials.
// AST extraction is exact; language detection and display classification are
// intentionally broad review heuristics, not a translation-completeness proof.
const root = path.resolve(fileURLToPath(new URL("../", import.meta.url)));
const output = path.join(root, "docs", "i18n");
const ownFile = "scripts/audit-i18n.mjs";
const germanWords = new Set(
  `automatisch pausiert abbrechen abgebrochen abgelaufen abgeschlossen abschließen administratorpasswort
  aktualisieren aktualisiert aktion aktiv aktive aktivieren aktiviert alle allgemein
  anmelden anmeldung antwort antworten antwortreserve antwortet anweisung anzeigen
  anzeigename aufgabe aufgaben aufgabenstand aufgabenstände aufgabenstatus aufgabenstellung
  aufgabensprache auftrag auftragsdaten ausgeführt ausgewählt ausführen ausführung
  ausgabe ausgaben auswahl außerhalb bearbeiten bearbeitet beginnt beenden beendet
  befehl befehle befehls bereit bereits bereich bestehen bestanden bestätigen
  bestätigung betriebsmodus bitte braucht cache gelesen codebefehle datei dateien
  dateiname dateipfad dateistand dateistände dateiversion dateiversionen darstellen
  darstellung daten deinen deiner dein deine definieren deaktiviert deutsch deutsche
  deutscher dialog direkt doppelte dunkel durch eben ein eine einem einen einer
  eines einfacher einfügen eingabe eingaben eingerichtet einrichtung einrichtungsschlüssel
  einstellungen einzelresultat entweder entfernen entfernt erneut erklären erklärung
  erforderlich ergebnis ergebnisse erstellen erstellt erweiterte erweiterten erwartet
  erwartete erwarteten falsche fehlt fehler fehlerhaft fehlerhafte fehlgeschlagen
  feld fenster festgelegt folgenden fortfahren fortschritt frage fragen freiwillig
  freiwillige freiwilliges freigegeben funktion funktionen funktionieren für gestartet
  gestoppt gesperrt gespeichert gesperrte gewählte geändert gültig gültige gültigen
  hallo hell hersteller hinweis hinweise historische historischen hinzufügen höchstens
  heute ihrer installieren installiert ist jeder jetzt kein keine keinen keiner
  kleiner konnte können konfigurieren konfiguration konfigurierte kommentar kompiliert
  kontext komprimieren komprimiert laden lang lauf laufen laufend laufende laufzeit
  laufzeiten leer leere leeren leeres leeren letzte letzten lernen lernplan lernprofil
  lernziel lernziele lies liste listen löschen lösung lösungsidee lösungsvorschlag
  maximal meldung meldungen meine mehreren mindestens möglich nach nachricht nachrichten
  nächste nächsten nächstes name neu neue neuen neuer noch nicht nichts nur ohne
  offene öffnen optionale originales originale originalmeldung ordner passwort
  passwörter pfad pfade plan prüfen prüfe prüfung prüfliste rückgabe rückgabewert
  rückgängig rücknahme rechner reparieren reparierbar richtig schlüssel schließen
  schritt schritte schreibweise seite selbst serveradresse serverantwort serverbetrieb
  serverdaten serverstand sessionname sicher sichern sicherung sichern soll sollen
  speichern sprache sprachen sprachprofil standard starten statt steht stoppen suchen
  textauswertung teil teilweise temperatur testen testfall testfälle testen testlauf
  teststand themen titel übertragen übernehmen unterstützte unterstützt ungültig
  ungültige ungültigen unvollständig unbekannt unbekannte unbekannter unverändert
  variable variablen verfügbar verfügbare vergleich vergleichen verwendet verwenden
  verbindung verbunden verboten verlassen verstehen verstanden version versionen
  vollständig vorbereiten vorbereitet vorhanden vorhandene vorschau vorlage vorlagen
  vorherige warten wechsle weiter weitere weiteren werkzeug werkzeuge werkzeugaufruf
  wieder wiederhergestellt wiederherstellen wiederherstellung wiederholung wird wähle
  wählen wörter zeichen zeichenkette zeichenketten zeile zeilen zeitzone ziel zugangsdaten
  zugriff zulässig zurück zurücksetzen zusammenfassung zustand zustands-snapshot zwei
  zwischen inzwischen schleife schleifen bedingungen bedingung zeige gib kannst möchtest
  möchtest fortsetzen fortgesetzt belegt belege auslöseschwelle grundkomponente
  abweichendes vergleichbar zeitlimit ungespeichert ungespeicherter ungelesen`
    .split(/\s+/)
    .filter(Boolean),
);
const textProperties = new Set([
  "label",
  "title",
  "description",
  "explanation",
  "help",
  "placeholder",
  "submit",
  "question",
  "reason",
  "message",
  "error",
  "progress",
  "goal",
  "milestone",
  "category",
]);
// These words also occur frequently as English identifiers or protocol values.
for (const word of [
  "name",
  "version",
  "cache",
  "variable",
  "dialog",
  "plan",
  "standard",
])
  germanWords.delete(word);
const htmlAttributes = new Set([
  "title",
  "placeholder",
  "alt",
  "aria-label",
  "aria-description",
  "aria-valuetext",
  "label",
  "lang",
]);
const candidates = [];
const files = [];
const failures = [];
const unselectedWords = new Set();
let extracted = 0;

function germanSignals(text) {
  const words = text.toLowerCase().match(/\p{L}+/gu) || [];
  return [
    ...(/[äöüßÄÖÜ]/.test(text) ? ["umlaut-or-eszett"] : []),
    ...new Set(words.filter((word) => germanWords.has(word))),
  ];
}
function area(file) {
  if (file.startsWith("tests/")) return "tests";
  if (file.startsWith("public/")) return "frontend";
  if (file.startsWith("server/")) return "server";
  if (file.startsWith("runner/")) return "runner";
  if (
    file.startsWith("docker/") ||
    file.startsWith("scripts/") ||
    /\.(ps1|bat|sh)$/.test(file) ||
    /^(Dockerfile|compose\.|\.env)/.test(file)
  )
    return "operations";
  return "configuration";
}
function keyName(value) {
  return value?.name ?? value?.value ?? "";
}
function calleeName(value) {
  if (value?.type === "Identifier") return value.name;
  if (["MemberExpression", "OptionalMemberExpression"].includes(value?.type))
    return `${calleeName(value.object)}.${keyName(value.property)}`;
  return "";
}
function add(record, force = false) {
  if (!record.text?.trim()) return;
  extracted++;
  const signals = germanSignals(record.text);
  const readable =
    /\p{L}{2,}\s+\p{L}{2,}/u.test(record.text) &&
    !/^(?:https?:|\^|\(\?:)/.test(record.text);
  const singleWord = /^\p{Lu}\p{L}{2,}(?:-\p{L}+)*[.!?…]?$/u.test(record.text);
  if (
    !force &&
    !signals.length &&
    !record.displaySink &&
    !readable &&
    !singleWord
  ) {
    if (
      /^[\p{L} -]{3,80}$/u.test(record.text) &&
      ["frontend", "server", "runner"].includes(area(record.file))
    )
      unselectedWords.add(record.text);
    return;
  }
  candidates.push({
    ...record,
    area: area(record.file),
    germanSignals: signals,
    classification: record.kind.includes("comment")
      ? "developer-comment"
      : signals.length
        ? "german-review"
        : "display-or-language-uncertain",
  });
}
async function javascript(file, source) {
  const ast = await parsers.babel.parse(source);
  function walk(value, ancestors = []) {
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) {
      for (const child of value) walk(child, ancestors);
      return;
    }
    const parent = ancestors.at(-1);
    if (["StringLiteral", "TemplateLiteral"].includes(value.type)) {
      const property =
        parent?.type === "ObjectProperty" && parent.value === value
          ? keyName(parent.key)
          : "";
      const argument = parent?.arguments?.indexOf(value) ?? -1;
      const call = calleeName(parent?.callee);
      const displaySink =
        textProperties.has(property) ||
        (call === "node" && argument === 2) ||
        (["toast", "button", "setButton", "confirmDialog"].includes(call) &&
          argument >= 0 &&
          argument <= (call === "setButton" ? 1 : 0)) ||
        (parent?.type === "AssignmentExpression" &&
          /\.(textContent|title|placeholder|ariaLabel)$/.test(
            calleeName(parent.left),
          ));
      const text =
        value.type === "StringLiteral"
          ? value.value
          : value.quasis
              .map(
                (part, index) =>
                  (part.value.cooked ?? part.value.raw) +
                  (value.expressions[index]
                    ? `\${${source.slice(value.expressions[index].start, value.expressions[index].end)}}`
                    : ""),
              )
              .join("");
      add({
        file,
        line: value.loc.start.line,
        endLine: value.loc.end.line,
        column: value.loc.start.column + 1,
        kind: value.type === "StringLiteral" ? "js-string" : "js-template",
        context: [property, call, parent?.type].filter(Boolean).join(" / "),
        text,
        displaySink,
      });
    }
    for (const [key, child] of Object.entries(value)) {
      if (
        [
          "loc",
          "extra",
          "comments",
          "leadingComments",
          "trailingComments",
          "innerComments",
          "tokens",
          "quasis",
        ].includes(key)
      )
        continue;
      if (child && typeof child === "object")
        walk(child, [...ancestors, value]);
    }
  }
  walk(ast.program);
  for (const comment of ast.comments || []) {
    if (!germanSignals(comment.value).length) continue;
    add({
      file,
      line: comment.loc.start.line,
      endLine: comment.loc.end.line,
      column: comment.loc.start.column + 1,
      kind: "js-comment",
      text: comment.value.trim(),
    });
  }
}
function html(file, source) {
  const ast = parseHtml(source, { sourceCodeLocationInfo: true });
  function walk(value, parent) {
    const loc = value.sourceCodeLocation;
    if (value.nodeName === "#text" && loc && value.value.trim())
      add(
        {
          file,
          line: loc.startLine,
          endLine: loc.endLine,
          column: loc.startCol,
          kind: "html-text",
          context: parent?.tagName || "",
          text: value.value.trim(),
          displaySink: true,
        },
        true,
      );
    for (const attr of value.attrs || []) {
      if (!htmlAttributes.has(attr.name)) continue;
      const position = loc?.attrs?.[attr.name] || loc;
      if (!position) continue;
      add(
        {
          file,
          line: position.startLine,
          endLine: position.endLine,
          column: position.startCol,
          kind: "html-attribute",
          context: `${value.tagName}.${attr.name}`,
          text: attr.value,
          displaySink: true,
        },
        true,
      );
    }
    for (const child of value.childNodes || []) walk(child, value);
    if (value.content) walk(value.content, value);
  }
  walk(ast);
}
function css(file, source) {
  const ast = cssTree.parse(source, { positions: true });
  cssTree.walk(ast, (value) => {
    if (value.type !== "String") return;
    add({
      file,
      line: value.loc.start.line,
      endLine: value.loc.end.line,
      column: value.loc.start.column,
      kind: "css-string",
      text: value.value,
    });
  });
}
function python(file, source) {
  const program = `import ast,json,sys
tree=ast.parse(sys.stdin.read())
result=[]
for node in ast.walk(tree):
 if isinstance(node,ast.Constant) and isinstance(node.value,str):
  result.append(dict(line=node.lineno,endLine=node.end_lineno,column=node.col_offset+1,kind="python-string",text=node.value))
print(json.dumps(result,ensure_ascii=False))
`;
  const result = spawnSync("python", ["-c", program], {
    cwd: root,
    input: source,
    encoding: "utf8",
    env: { ...process.env, PYTHONIOENCODING: "utf-8" },
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error || result.status !== 0)
    throw new Error(result.error?.message || result.stderr);
  for (const record of JSON.parse(result.stdout)) add({ ...record, file });
}
const git = spawnSync("git", ["ls-files", "-z"], {
  cwd: root,
  encoding: "utf8",
});
if (git.error || git.status !== 0)
  throw new Error(git.error?.message || git.stderr);
const tracked = git.stdout.split("\0").filter(Boolean).sort();
for (const file of tracked) {
  if (
    file === ownFile ||
    file === "I18N-UMSTELLUNGSPLAN.md" ||
    file.startsWith("docs/i18n/") ||
    /(?:^|\/)(?:node_modules|data|backups|secrets|\.secrets)(?:\/|$)/.test(
      file,
    ) ||
    (file.startsWith(".env") && file !== ".env.example")
  )
    continue;
  const ext = path.posix.extname(file);
  const documentation = [".md", ".txt"].includes(ext);
  if (
    !documentation &&
    ![
      ".js",
      ".mjs",
      ".html",
      ".svg",
      ".css",
      ".py",
      ".c",
      ".json",
      ".yaml",
      ".yml",
      ".ps1",
      ".sh",
      ".bat",
      ".lock",
    ].includes(ext) &&
    !file.startsWith("Dockerfile") &&
    ![
      ".env.example",
      ".dockerignore",
      ".gitattributes",
      ".gitignore",
      "docker/Caddyfile",
    ].includes(file)
  )
    continue;
  if (file === "package-lock.json") continue;
  const source = await fs.readFile(path.join(root, file), "utf8");
  const lines = source.split(/\r?\n/);
  const germanLines = lines.flatMap((line, index) =>
    germanSignals(line).length ? [index + 1] : [],
  );
  const summary = {
    file,
    area: documentation ? "documentation" : area(file),
    sha256: createHash("sha256").update(source).digest("hex"),
    lines: lines.length,
    germanLines,
    parser: documentation ? "documentation-index-only" : "line-review",
  };
  files.push(summary);
  if (documentation) continue;
  try {
    if ([".js", ".mjs"].includes(ext)) {
      summary.parser = "babel-ast-via-prettier";
      await javascript(file, source);
    } else if ([".html", ".svg"].includes(ext)) {
      summary.parser = "parse5";
      html(file, source);
    } else if (ext === ".css") {
      summary.parser = "css-tree";
      css(file, source);
    } else if (ext === ".py") {
      summary.parser = "python-ast";
      python(file, source);
    } else if (ext === ".json" || file === "runner/catalog/versions.lock") {
      summary.parser = "json-string-tokens";
      JSON.parse(source);
      for (const match of source.matchAll(/"(?:\\.|[^"\\])*"/g)) {
        const line = source.slice(0, match.index).split("\n").length;
        add({
          file,
          line,
          endLine: line,
          kind: "json-string",
          text: JSON.parse(match[0]),
        });
      }
    }
  } catch (error) {
    failures.push({ file, parser: summary.parser, error: error.message });
  }
  const covered = new Set();
  for (const record of candidates.filter((record) => record.file === file))
    for (let line = record.line; line <= record.endLine; line++)
      covered.add(line);
  for (const line of germanLines) {
    if (covered.has(line)) continue;
    const text = lines[line - 1].trim();
    add({
      file,
      line,
      endLine: line,
      kind: /^\s*(?:\/\/|#|\/\*|\*|REM\b)/i.test(text)
        ? "source-comment"
        : "source-line-review",
      text,
    });
  }
  for (const [index, text] of lines.entries()) {
    if (
      !/toLocale(?:String|DateString|TimeString)\(|Intl\.|lang=["']de|nls|navigator\.languages?|Accept-Language/i.test(
        text,
      )
    )
      continue;
    add(
      {
        file,
        line: index + 1,
        endLine: index + 1,
        kind: "locale-review",
        text: text.trim(),
      },
      true,
    );
  }
}
candidates.sort(
  (a, b) =>
    a.file.localeCompare(b.file, "en") ||
    a.line - b.line ||
    a.column - b.column,
);
for (const [index, record] of candidates.entries())
  record.id = `I18N-${String(index + 1).padStart(5, "0")}`;
const totals = {};
for (const record of candidates) {
  const counter = (totals[record.area] ||= {
    candidates: 0,
    german: 0,
    comments: 0,
    files: new Set(),
  });
  counter.candidates++;
  if (record.germanSignals.length) counter.german++;
  if (record.classification === "developer-comment") counter.comments++;
  counter.files.add(record.file);
}
for (const counter of Object.values(totals)) counter.files = counter.files.size;
const revision = spawnSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
});
const report = {
  schemaVersion: 1,
  revision: revision.stdout.trim(),
  method:
    "Tracked source files only. Babel/parse5/css-tree/Python AST extraction plus broad German word and uncovered-line review. No data directories, .env credentials, dependencies, or generated reports are read. Heuristic candidates require human review; this is not an exhaustive semantic language detector.",
  totals: {
    trackedFiles: tracked.length,
    scannedFiles: files.length,
    sourceFiles: files.filter((file) => file.area !== "documentation").length,
    documentationFiles: files.filter((file) => file.area === "documentation")
      .length,
    extractedNonemptyTexts: extracted,
    candidates: candidates.length,
    byArea: totals,
  },
  failures,
  files,
  candidates,
};
function cell(text) {
  return String(text)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("|", "&#124;")
    .replaceAll("`", "&#96;")
    .replaceAll("\r", "")
    .replaceAll("\n", " ⏎ ");
}
const markdown = [
  "# i18n-Bestandsaufnahme",
  "",
  `Quellstand: \`${report.revision}\`. Erzeugt mit \`node scripts/audit-i18n.mjs\`.`,
  "",
  "Dies ist ein Arbeitsinventar, kein fertiger Übersetzungskatalog. Deutsche Signale, mögliche Anzeigetexte, technische Klartexte und Entwicklerkommentare sind bewusst getrennt markiert. Die Heuristik kann Kandidaten übersehen oder technische Werte melden; insbesondere englische Einworttexte und dynamisch geladene Inhalte brauchen manuelle Prüfung. Die JSON-Datei enthält alle Kandidaten vollständig, Quellprüfsummen und die untersuchten Dateien. Dokumentationsprosa ist nur als Datei-/Zeilenindex enthalten. Geheimnisse und persönliche Anwendungsdaten werden nicht gelesen.",
  "",
  `Untersucht: **${report.totals.sourceFiles} Quelldateien** und **${report.totals.documentationFiles} Dokumentationsdateien**. **${candidates.length} Prüfkandidaten**, **${failures.length} Parserfehler**. Kandidaten sind Fundstellen, keine Anzahl eindeutiger Übersetzungsschlüssel.`,
  "",
  "| Bereich | Kandidaten | Mit deutschem Signal | Entwicklerkommentare | Dateien mit Kandidaten |",
  "| --- | ---: | ---: | ---: | ---: |",
  ...Object.entries(totals).map(
    ([name, count]) =>
      `| ${name} | ${count.candidates} | ${count.german} | ${count.comments} | ${count.files} |`,
  ),
  "",
  "## Fundstellen",
  "",
];
for (const summary of files.filter((file) => file.area !== "documentation")) {
  const rows = candidates.filter((record) => record.file === summary.file);
  if (!rows.length) continue;
  markdown.push(
    `### ${summary.file}`,
    "",
    `Parser: \`${summary.parser}\`; ${rows.length} Kandidaten.`,
    "",
    "| ID | Zeile | Art | Einordnung | Text |",
    "| --- | ---: | --- | --- | --- |",
  );
  for (const record of rows)
    markdown.push(
      `| ${record.id} | [${record.line}](../../${summary.file}#L${record.line}) | ${record.kind} | ${record.classification} | ${cell(record.text)} |`,
    );
  markdown.push("");
}
markdown.push(
  "## Vollständiger Dateiindex",
  "",
  "Auch Dateien ohne Kandidaten sind hier aufgeführt. Deutsche Zeilensignale sind eine ergänzende Rohtextsuche und zählen keine Übersetzungen.",
  "",
  "| Datei | Bereich | Parser | Deutsche Zeilensignale |",
  "| --- | --- | --- | ---: |",
);
for (const summary of files)
  markdown.push(
    `| ${summary.file} | ${summary.area} | ${summary.parser} | ${summary.germanLines.length} |`,
  );
markdown.push(
  "",
  "## Parserfehler",
  "",
  failures.length
    ? failures
        .map((failure) => `- ${failure.file}: ${failure.error}`)
        .join("\n")
    : "Keine.",
  "",
);
await fs.mkdir(output, { recursive: true });
await fs.writeFile(
  path.join(output, "bestand.json"),
  JSON.stringify(report, null, 2) + "\n",
  "utf8",
);
await fs.writeFile(
  path.join(output, "BESTAND.md"),
  markdown.join("\n"),
  "utf8",
);
console.log(
  JSON.stringify({ ...report.totals, failures, output: "docs/i18n/" }, null, 2),
);
if (process.argv.includes("--print-unselected-words"))
  console.log([...unselectedWords].sort().join("\n"));
if (failures.length) process.exitCode = 1;
