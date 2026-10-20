import fs from "node:fs/promises";
import path from "node:path";
import { area } from "./model.mjs";

const cell = (text) =>
  String(text ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("|", "&#124;")
    .replaceAll("`", "&#96;")
    .replaceAll("\r", "")
    .replaceAll("\n", " ⏎ ")
    // Make trailing whitespace visible without changing the exact JSON inventory.
    .replace(/[ \t]+$/g, (ending) =>
      ending.replaceAll(" ", "␠").replaceAll("\t", "⇥"),
    );
export function comparePrevious(report, previous) {
  const previousByFile = new Map();
  for (const record of previous?.candidates || []) {
    if (!previousByFile.has(record.file)) previousByFile.set(record.file, []);
    previousByFile.get(record.file).push(record);
  }
  const outputIds = new Set(
    report.findings
      .filter((finding) => ["HARDCODED", "CONTENT"].includes(finding.rule))
      .map((finding) => finding.literalId),
  );
  const additional = [];
  const embedded = [];
  const newSourceFiles = [];
  const previousFiles = new Set(
    previous?.files?.map((entry) => entry.file) || previousByFile.keys(),
  );
  for (const literal of report.literals) {
    if (!outputIds.has(literal.id)) continue;
    if (literal.file.includes("::")) {
      embedded.push(literal);
      continue;
    }
    if (!previousFiles.has(literal.file)) {
      newSourceFiles.push(literal);
      continue;
    }
    const old = previousByFile.get(literal.file) || [];
    if (
      !old.some(
        (record) =>
          record.line <= literal.line &&
          (record.endLine || record.line) >= literal.line &&
          (record.text.includes(literal.text) ||
            literal.text.includes(record.text)),
      )
    )
      additional.push(literal);
  }
  return {
    previousCandidates: previous?.candidates?.length ?? null,
    additionalOutputLocations: additional.length,
    embeddedOutputLocations: embedded.length,
    newSourceFileOutputLocations: newSourceFiles.length,
    additional,
    embedded,
    newSourceFiles,
    method:
      "Physical file/line/text containment comparison. Additional hits are review evidence, not a proof of translation need. Embedded hits are a separate increase in granularity.",
  };
}
function sourceLocation(report, literal) {
  const mapping = report.coverage.find(
    (entry) => entry.file === literal.file && entry.originalFile,
  );
  return mapping
    ? `${mapping.originalFile}:${mapping.originalLine} (embedded ${literal.line})`
    : `${literal.file}:${literal.line}`;
}
export async function writeReports(root, output, report, comparison) {
  const resolved = path.resolve(root, output);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error(
      "Report output must be a child directory inside the selected project root.",
    );
  // Existing directory links must not redirect report writes outside root.
  let directory = root;
  for (const part of relative.split(path.sep)) {
    directory = path.join(directory, part);
    try {
      if ((await fs.lstat(directory)).isSymbolicLink())
        throw new Error("Report output must not follow directory links.");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  await fs.mkdir(resolved, { recursive: true });
  for (const name of [
    "befunde.json",
    "literale.json",
    "coverage.json",
    "BERICHT.md",
    "ZUSAETZLICHE-FUNDE.md",
  ]) {
    try {
      if ((await fs.lstat(path.join(resolved, name))).isSymbolicLink())
        throw new Error(`Report target is a symlink: ${name}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const { literals, coverage, runtimeBoundaries, ...findings } = report;
  await fs.writeFile(
    path.join(resolved, "befunde.json"),
    JSON.stringify(
      {
        ...findings,
        previousComparison: comparison
          ? {
              ...comparison,
              additional: undefined,
              embedded: undefined,
              newSourceFiles: undefined,
            }
          : null,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  await fs.writeFile(
    path.join(resolved, "literale.json"),
    JSON.stringify(
      {
        schemaVersion: report.schemaVersion,
        count: literals.length,
        note: "Every extracted string, including short/empty/technical values and comments; no language filter removes inventory records.",
        literals,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  await fs.writeFile(
    path.join(resolved, "coverage.json"),
    JSON.stringify(
      {
        summary: report.summary,
        coverage,
        runtimeBoundaries,
        errors: report.errors,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  const byRule = new Map();
  for (const finding of report.findings)
    byRule.set(finding.rule, (byRule.get(finding.rule) || 0) + 1);
  const uniqueOutputs = new Set(
    report.findings
      .filter((finding) => finding.rule === "HARDCODED")
      .map((finding) => finding.literalId),
  );
  const markdown = [
    "# Tiefer i18n-Scan für SterraCode",
    "",
    `Geprüft: **${report.summary.physicalSourceFiles} physische Quelldateien** und **${report.summary.embeddedSources} eingebettete Quellen**. Inventar: **${literals.length} Literale/Kommentare**, ohne Deutsch- oder Mindestlängenfilter.`,
    "",
    `Befunde: **${report.summary.findings}**, davon **${uniqueOutputs.size} unterschiedliche Literalquellen mit registriertem Ausgabepfad**. Befunde können mehrere Kanäle derselben Quelle beschreiben; sie sind keine Zahl eindeutiger Übersetzungsschlüssel. ${report.summary.acceptedFindings} Befunde sind begründet akzeptiert und bleiben sichtbar.`,
    "",
    `**Abdeckung:** ${report.summary.parseOrAnalysisErrors} Parser-/Analysefehler; ${report.summary.lexicalFiles} Dateien nur lexikalisch analysiert; ${report.summary.runtimeBoundaries} Ausgabepfade mit dynamischen oder nur teilweise auflösbaren Daten. Katalogprüfung: \`${report.catalogs.status}\`.`,
    "",
    "Ein statischer Textfluss ist ein möglicher Quellpfad, kein Beweis seiner Ausführung. Funktionsparameter werden über Aufrufstellen vereinigt; solche Belege tragen `possible-call-union`. Fremddaten, Nutzereingaben, Laufzeitverhalten und unbekannte Bibliotheksaufrufe bleiben ausdrücklich offen. Ein fehlerfreier Parse oder ein späterer Nullbefund ist deshalb kein Vollständigkeitsbeweis.",
    "",
    "## Dateien",
    "",
    "- [Vollständiges Literalinventar](literale.json)",
    "- [Befunde, Ausgabestellen und Helfer](befunde.json)",
    "- [Abdeckung, Ausschlüsse, Fehler und Laufzeitgrenzen](coverage.json)",
    "- [Zusätzliche Fundstellen gegenüber dem ersten Scan](ZUSAETZLICHE-FUNDE.md)",
    "",
    "## Regelübersicht",
    "",
    "| Regel | Befunde |",
    "| --- | ---: |",
    ...[...byRule]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([rule, count]) => `| ${rule} | ${count} |`),
    "",
    "## Befunde",
    "",
    "Branding, Programmiersprachnamen, Datenverträge, Quellcodevorlagen und feste Technikbegriffe benötigen eine ausdrückliche Einordnung. Die Kennzeichnung als fest eingebauter Ausgabetext bedeutet noch nicht, dass der konkrete Wert übersetzt werden muss.",
    "",
  ];
  for (const finding of report.findings) {
    const literal = literals.find((item) => item.id === finding.literalId);
    markdown.push(
      `### ${finding.id} · ${finding.rule} · ${finding.severity}`,
      "",
      `Quelle: \`${cell(literal ? sourceLocation(report, literal) : `${finding.file}:${finding.line}`)}\` · Kanal: \`${finding.channel}\` · Status: \`${finding.status}\``,
      "",
      cell(finding.text),
      "",
      finding.message,
      "",
    );
    if (finding.acceptanceReason)
      markdown.push(
        `Begründete Ausnahme: ${cell(finding.acceptanceReason)}`,
        "",
      );
    for (const evidence of finding.evidence.slice(0, 3))
      markdown.push(
        `- Ausgabe: \`${cell(evidence.file)}:${evidence.line}\` — ${cell(evidence.description)} (${evidence.certainty || "syntactic"}).${evidence.chain ? ` Pfad: ${evidence.chain.map(cell).join(" → ")}.` : ""}`,
      );
    if (finding.evidence.length) markdown.push("");
  }
  markdown.push(
    "## Tatsächliche Analysefehler",
    "",
    report.errors.length
      ? report.errors
          .map(
            (error) =>
              `- ${cell(error.file || error.language || error.type)}: ${cell(error.message)}`,
          )
          .join("\n")
      : "Keine.",
    "",
  );
  await fs.writeFile(
    path.join(resolved, "BERICHT.md"),
    markdown.join("\n"),
    "utf8",
  );
  const extra = [
    "# Zusätzliche Fundstellen des tiefen Scans",
    "",
    comparison
      ? `${comparison.additionalOutputLocations} zusätzliche physische Ausgabetext-Fundstellen in bereits früher geprüften Dateien gegenüber ${comparison.previousCandidates} früheren Prüfkandidaten. Zusätzlich ${comparison.embeddedOutputLocations} Ausgabetext-Fundstellen innerhalb eingebetteter Inhalte und ${comparison.newSourceFileOutputLocations} in neu hinzugekommenen Quellen. Der Vergleich verwendet Quellpfad, Zeilenbereich und Text; die Zahlen sind kein Beweis echter Übersetzungslücken.`
      : "Kein vorheriges Inventar zum Vergleich verfügbar.",
    "",
  ];
  for (const [title, rows] of [
    ["Zusätzliche physische Quellen", comparison?.additional || []],
    ["Vertiefte eingebettete Inhalte", comparison?.embedded || []],
    ["Neu hinzugekommene Quelldateien", comparison?.newSourceFiles || []],
  ]) {
    extra.push(
      `## ${title}`,
      "",
      "| Quelle | Bereich | Text |",
      "| --- | --- | --- |",
    );
    for (const literal of rows)
      extra.push(
        `| ${cell(sourceLocation(report, literal))} | ${area(literal.file)} | ${cell(literal.text)} |`,
      );
    extra.push("");
  }
  await fs.writeFile(
    path.join(resolved, "ZUSAETZLICHE-FUNDE.md"),
    extra.join("\n"),
    "utf8",
  );
  return path.relative(root, resolved).replaceAll("\\", "/");
}
