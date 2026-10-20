import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { auditProject, loadConfig } from "./core.mjs";
import { comparePrevious, writeReports } from "./report.mjs";
import { ruleNames, severityOrder } from "./model.mjs";

const usage = `SterraCode i18n audit
  node tools/i18n/audit.mjs [options]
  --root PATH             Projektwurzel (Standard: dieses Repository)
  --scope all|product|operations|tests
  --output PATH           Berichtsordner relativ zur Projektwurzel
  --config PATH           Eigene JSON-Konfiguration
  --previous PATH         Früheres Inventar für den Fundstellenvergleich
  --only RULE,RULE        Filter für Anzeige/Strict-Gate; Vollinventar bleibt erhalten
  --strict                Bei offenen Befunden ab --fail-on mit Status 1 enden
  --fail-on critical|warning|info (Standard: critical)
  --list-helpers          Erkannte Funktionen mit Ausgabepfaden anzeigen
  --no-report             Nur Zusammenfassung, keine Dateien schreiben
  --help                  Hilfe anzeigen
Status: 0 erfolgreicher Scan, 1 Strict-Befunde, 2 Konfiguration/Parser/Analysefehler.
`;
async function main() {
  const args = process.argv.slice(2);
  const options = {
    root: fileURLToPath(new URL("../../", import.meta.url)),
    scope: "all",
    output: "docs/i18n/deep",
    failOn: "critical",
    previous: "docs/i18n/bestand.json",
  };
  for (let index = 0; index < args.length; index++) {
    const name = args[index];
    if (["--help", "-h"].includes(name)) {
      console.log(usage);
      return;
    }
    if (["--strict", "--list-helpers", "--no-report"].includes(name)) {
      options[name] = true;
      continue;
    }
    const mappings = {
      "--root": "root",
      "--scope": "scope",
      "--output": "output",
      "--config": "config",
      "--previous": "previous",
      "--fail-on": "failOn",
      "--only": "only",
    };
    if (!mappings[name] || !args[index + 1] || args[index + 1].startsWith("--"))
      throw new Error(`Unknown option or missing value: ${name}`);
    options[mappings[name]] = args[++index];
  }
  if (
    !["all", "product", "operations", "tests"].includes(options.scope) ||
    !Object.hasOwn(severityOrder, options.failOn)
  )
    throw new Error("Invalid scope or severity");
  const rules = options.only ? new Set(options.only.split(",")) : null;
  if (rules)
    for (const rule of rules)
      if (!ruleNames.includes(rule))
        throw new Error(`Unknown detector: ${rule}`);
  const root = await fs.realpath(path.resolve(options.root));
  const config = await loadConfig(
    options.config ? path.resolve(options.config) : undefined,
  );
  const report = await auditProject(root, { config, scope: options.scope });
  let previous;
  try {
    previous = JSON.parse(
      await fs.readFile(path.resolve(root, options.previous), "utf8"),
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  const comparison = previous ? comparePrevious(report, previous) : null;
  let output;
  if (!options["--no-report"])
    output = await writeReports(root, options.output, report, comparison);
  const selected = report.findings.filter(
    (finding) => !rules || rules.has(finding.rule),
  );
  console.log(
    JSON.stringify(
      {
        ...report.summary,
        graph: report.graph,
        catalogs: report.catalogs.status,
        selectedFindings: selected.length,
        additionalOutputLocations: comparison?.additionalOutputLocations,
        output,
      },
      null,
      2,
    ),
  );
  if (options["--list-helpers"])
    for (const helper of report.helpers)
      console.log(
        `${helper.file}:${helper.line} ${helper.name} (${helper.sinkCount} output sites)`,
      );
  if (report.summary.parseOrAnalysisErrors) {
    console.error(JSON.stringify(report.errors, null, 2));
    process.exitCode = 2;
  } else if (
    options["--strict"] &&
    selected.some(
      (finding) =>
        finding.status === "open" &&
        severityOrder[finding.severity] <= severityOrder[options.failOn],
    )
  )
    process.exitCode = 1;
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 2;
});
