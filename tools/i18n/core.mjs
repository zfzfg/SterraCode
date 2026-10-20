import fs from "node:fs/promises";
import path from "node:path";
import { Context, prose, technicalShape, severityOrder } from "./model.mjs";
import { collectSources } from "./sources.mjs";
import { JavaScriptAudit } from "./javascript.mjs";
import * as formats from "./formats.mjs";
import { checkCatalogs } from "./catalogs.mjs";

export async function loadConfig(
  filename = new URL("./config.json", import.meta.url),
) {
  const config = JSON.parse(await fs.readFile(filename, "utf8"));
  if (
    config.version !== 1 ||
    !Array.isArray(config.roots) ||
    !Array.isArray(config.sinks)
  )
    throw new Error("Unsupported audit configuration");
  for (const exception of config.exceptions || [])
    if (!exception.fingerprint || !exception.reason?.trim())
      throw new Error(
        "Every exception needs a fingerprint and a nonempty reason",
      );
  for (const [key, value] of Object.entries({
    maxGraphPasses: config.maxGraphPasses,
    maxTraceNodes: config.maxTraceNodes,
    maxPropertyDepth: config.maxPropertyDepth,
    maxSourceBytes: config.maxSourceBytes,
  }))
    if (!Number.isInteger(value) || value < 1)
      throw new Error(`Invalid analysis limit: ${key}`);
  return config;
}
export async function auditProject(root, options = {}) {
  const config = options.config || (await loadConfig());
  const ctx = new Context(config);
  const { files, coverage } = await collectSources(
    root,
    config,
    options.scope || "all",
  );
  ctx.coverage = coverage;
  const analyzer = new JavaScriptAudit(ctx);
  const documents = [];
  const python = [];
  const powershell = [];
  const embedded = [];
  const parsed = new Map();
  const recordCoverage = (input) => {
    let record = ctx.coverage.find((item) => item.file === input.file);
    if (!record) {
      record = {
        file: input.file,
        status: "pending",
        originalFile: input.originalFile,
        originalLine: input.originalLine,
        embedded: true,
      };
      ctx.coverage.push(record);
    }
    return record;
  };
  const parse = async (input) => {
    const entry = recordCoverage(input);
    const extension = path.posix.extname(input.file);
    try {
      let result = {};
      if ([".js", ".mjs", ".cjs"].includes(extension)) {
        entry.parser = "babel-ast+scope+dataflow";
        const module = await analyzer.parse(input);
        analyzer.build(module);
        for (const item of analyzer.embedded.splice(0)) {
          if (item.code === null)
            ctx.coverage.push({
              file: `${item.module.file}::template-${item.ast.loc.start.line}`,
              status: "dynamic-embedded-content",
              originalFile: item.module.originalFile || item.module.file,
              originalLine: item.module.originalFile
                ? item.module.originalLine
                : item.ast.loc.start.line,
              reason:
                "Template expressions require runtime materialization; not executed by the scanner.",
            });
          else if (
            [".html", ".css", ".js", ".mjs", ".py"].includes(
              path.posix.extname(item.filename),
            )
          )
            embedded.push({
              file: `${item.module.file}::${item.ast.loc.start.line}:${item.filename}`,
              source: item.code,
              originalFile: item.module.originalFile || item.module.file,
              originalLine: item.module.originalFile
                ? item.module.originalLine
                : item.ast.loc.start.line,
            });
        }
      } else if ([".html", ".svg"].includes(extension)) {
        entry.parser = "parse5";
        result = formats.html(ctx, input);
        if (result.recovery.length) entry.recovery = result.recovery;
      } else if (extension === ".css") {
        entry.parser = "css-tree";
        formats.css(ctx, input);
      } else if (extension === ".py") {
        entry.parser = "python-ast";
        python.push(input);
        return;
      } else if (extension === ".ps1") {
        entry.parser = "powershell-native-ast";
        powershell.push(input);
        return;
      } else if (
        extension === ".json" ||
        input.file === "runner/catalog/versions.lock"
      ) {
        entry.parser = "json-tokens+duplicate-check";
        result = formats.json(ctx, input);
        documents.push({ file: input.file, data: result.data });
      } else if ([".yaml", ".yml"].includes(extension)) {
        entry.parser = "yaml-ast";
        await formats.yaml(ctx, input);
      } else {
        entry.parser =
          extension === ".sh"
            ? "shell-lexer"
            : extension === ".bat"
              ? "batch-lexer"
              : "c-or-directive-lexer";
        result = formats.lexical(
          ctx,
          input,
          extension === ".sh" ? "shell" : extension === ".bat" ? "batch" : "c",
        );
        entry.coverageNote = result.coverageNote;
      }
      embedded.push(...(result.embedded || []));
      entry.status = entry.coverageNote ? "lexical-coverage" : "parsed";
      parsed.set(input.file, input);
    } catch (error) {
      entry.status = "error";
      entry.reason = error.message;
      ctx.errors.push({
        type: "parse",
        file: input.file,
        message: error.message,
      });
    }
  };
  for (const input of files) await parse(input);
  // Recursively parse embedded inline scripts/styles and materialized templates.
  // Virtual filenames retain an explicit mapping to the physical source.
  for (let index = 0; index < embedded.length; index++) {
    if (index >= 1000) {
      ctx.errors.push({
        type: "analysis-budget",
        message: "Embedded-source expansion limit reached.",
      });
      break;
    }
    const input = embedded[index];
    if (parsed.has(input.file) || recordCoverage(input).status !== "pending")
      continue;
    await parse(input);
  }
  for (const [language, batch] of [
    ["python", python],
    ["powershell", powershell],
  ]) {
    try {
      const entries = formats.nativeParse(ctx, batch, language);
      for (const entry of entries) {
        const source = recordCoverage(
          batch.find((input) => input.file === entry.file),
        );
        if (entry.error || entry.errors?.length) {
          source.status = "error";
          source.reason = entry.error || entry.errors.join("; ");
          ctx.errors.push({
            type: "parse",
            file: entry.file,
            message: source.reason,
          });
        } else source.status = "parsed";
      }
    } catch (error) {
      for (const input of batch) {
        const entry = recordCoverage(input);
        entry.status = "error";
        entry.reason = error.message;
      }
      ctx.errors.push({
        type: "parser-unavailable",
        language,
        message: error.message,
      });
    }
  }
  const graph = analyzer.analyze();
  const catalogs = checkCatalogs(ctx, documents);
  for (const [literalIndex, literal] of ctx.literals.entries()) {
    if (
      literal.disposition !== "unclassified-review" &&
      !["technical-shape-review", "unresolved-literal-review"].includes(
        literal.disposition,
      )
    )
      continue;
    const technical = technicalShape(literal.staticText ?? literal.text);
    literal.technicalShape = technical;
    literal.disposition = technical
      ? "technical-shape-review"
      : "unresolved-literal-review";
    if (!technical && /\p{L}/u.test(literal.staticText ?? literal.text))
      ctx.finding(
        prose(literal.text) ? "PROSE_REVIEW" : "LITERAL_REVIEW",
        literalIndex,
        {
          severity: prose(literal.text) ? "warning" : "info",
          channel: literal.area === "tests" ? "test-fixture" : "unresolved",
          message:
            "Nicht als übersetzt/strukturell belegtes Literal; bewusst im vollständigen Inventar behalten.",
        },
      );
  }
  for (const exception of config.exceptions || []) {
    const matches = ctx.findings.filter(
      (finding) => finding.fingerprint === exception.fingerprint,
    );
    if (!matches.length)
      ctx.finding("STALE_EXCEPTION", null, {
        identity: exception.fingerprint,
        channel: "audit-config",
        severity: "warning",
        message:
          "Ausnahme passt zu keinem aktuellen Befund; bereinigen oder neu begründen.",
      });
    for (const finding of matches) {
      finding.status = "accepted";
      finding.acceptanceReason = exception.reason;
    }
  }
  ctx.findings.sort(
    (a, b) =>
      severityOrder[a.severity] - severityOrder[b.severity] ||
      a.file.localeCompare(b.file, "en") ||
      a.line - b.line ||
      a.id.localeCompare(b.id),
  );
  ctx.literals.sort(
    (a, b) =>
      a.file.localeCompare(b.file, "en") ||
      a.line - b.line ||
      a.column - b.column ||
      a.id.localeCompare(b.id),
  );
  const summary = {
    physicalSourceFiles: files.length,
    embeddedSources: ctx.coverage.filter((entry) => entry.embedded).length,
    literalCount: ctx.literals.length,
    findings: ctx.findings.length,
    openFindings: ctx.findings.filter((finding) => finding.status === "open")
      .length,
    acceptedFindings: ctx.findings.filter(
      (finding) => finding.status === "accepted",
    ).length,
    critical: ctx.findings.filter(
      (finding) => finding.severity === "critical" && finding.status === "open",
    ).length,
    warnings: ctx.findings.filter(
      (finding) => finding.severity === "warning" && finding.status === "open",
    ).length,
    info: ctx.findings.filter(
      (finding) => finding.severity === "info" && finding.status === "open",
    ).length,
    sinks: ctx.sinks.length,
    runtimeBoundaries: ctx.boundaries.length,
    parseOrAnalysisErrors:
      ctx.errors.length +
      ctx.coverage.filter(
        (entry) =>
          entry.status === "error" &&
          !ctx.errors.some((error) => error.file === entry.file),
      ).length,
    lexicalFiles: ctx.coverage.filter(
      (entry) => entry.status === "lexical-coverage",
    ).length,
  };
  return {
    schemaVersion: 2,
    summary,
    graph,
    catalogs,
    findings: ctx.findings,
    literals: ctx.literals,
    sinks: ctx.sinks,
    helpers: ctx.helpers,
    keyReferences: ctx.keyReferences.map(
      ({ argumentNode, optionsNode, ...entry }) => entry,
    ),
    runtimeBoundaries: ctx.boundaries,
    coverage: ctx.coverage,
    errors: ctx.errors,
  };
}
