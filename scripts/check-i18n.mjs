import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parsers } from "prettier/plugins/babel";
import { LOCALES } from "../shared/i18n/locale.js";
import { auditProject } from "../tools/i18n/core.mjs";

// Keep the full audit (including uncertain data flows) visible. This additional
// gate checks catalog and explicit descriptor contracts, not a word-count target.
export async function checkI18n(
  root = fileURLToPath(new URL("../", import.meta.url)),
) {
  const audit = await auditProject(root, { scope: "product" });
  const rules = new Set([
    "DUPLICATE_KEY",
    "CATALOGS_ABSENT",
    "CATALOG_BASE_MISSING",
    "CATALOG_LOCALE_MISSING",
    "CATALOG_MISSING_KEY",
    "CATALOG_EMPTY",
    "CATALOG_PLACEHOLDERS",
    "CATALOG_EXTRA_KEY",
    "MISSING_KEY",
    "CALL_PLACEHOLDERS",
    "PLURAL_COUNT_MISSING",
  ]);
  const errors = audit.findings.filter((finding) => rules.has(finding.rule));
  const resources = {};
  const flatten = (object, prefix = "", output = {}) => {
    for (const [key, value] of Object.entries(object)) {
      const name = prefix ? `${prefix}.${key}` : key;
      if (typeof value === "string") output[name] = value;
      else if (value && typeof value === "object") flatten(value, name, output);
    }
    return output;
  };
  const catalogs = path.join(root, "shared/i18n/locales");
  for (const locale of Object.keys(LOCALES)) {
    resources[locale] = {};
    for (const file of await fs.readdir(path.join(catalogs, locale)))
      if (file.endsWith(".json"))
        resources[locale][file.slice(0, -5)] = flatten(
          JSON.parse(
            await fs.readFile(path.join(catalogs, locale, file), "utf8"),
          ),
        );
  }
  const descriptors = [];
  function reference(file, node, key, params) {
    if (!/^[\w-]+:[\w.-]+$/.test(key)) return;
    descriptors.push({ file, line: node.loc.start.line, key });
    const [ns, name] = key.split(":");
    for (const locale of Object.keys(LOCALES)) {
      const value = resources[locale]?.[ns]?.[name];
      if (value === undefined)
        errors.push({
          rule: "DESCRIPTOR_KEY_MISSING",
          file,
          line: node.loc.start.line,
          message: `${locale}: ${key}`,
        });
      else if (
        params?.type === "ObjectExpression" &&
        !params.properties.some((property) => property.type === "SpreadElement")
      ) {
        const names = new Set(
          params.properties.map(
            (property) => property.key?.name || property.key?.value,
          ),
        );
        for (const match of value.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g))
          if (!names.has(match[1].split(".")[0]))
            errors.push({
              rule: "DESCRIPTOR_PARAM_MISSING",
              file,
              line: node.loc.start.line,
              message: `${key}: ${match[1]}`,
            });
      }
    }
  }
  for (const entry of audit.coverage.filter(
    (item) =>
      item.status === "parsed" &&
      /\.[cm]?js$/.test(item.file) &&
      !item.embedded,
  )) {
    const source = await fs.readFile(path.join(root, entry.file), "utf8");
    const ast = parsers.babel.parse(source);
    function walk(node) {
      if (!node || typeof node !== "object") return;
      if (node.type === "ObjectExpression")
        for (const property of node.properties) {
          const field = property.key?.name || property.key?.value;
          if (
            (field === "key" ||
              /(?:message|description|error|reason|warning|limitations|version)Key$/.test(
                field || "",
              )) &&
            property.value?.type === "StringLiteral"
          ) {
            const paramsField =
              field === "key" || field === "messageKey"
                ? "params"
                : field.slice(0, -3) + "Params";
            const params = node.properties.find(
              (item) => (item.key?.name || item.key?.value) === paramsField,
            )?.value;
            reference(entry.file, property, property.value.value, params);
          }
        }
      for (const [key, child] of Object.entries(node))
        if (!["loc", "tokens", "comments"].includes(key)) {
          if (Array.isArray(child)) child.forEach(walk);
          else if (child && typeof child === "object") walk(child);
        }
    }
    walk(ast);
  }
  if (audit.errors.length || audit.summary.parseOrAnalysisErrors)
    errors.push(...audit.errors);
  return {
    errors,
    descriptors,
    summary: {
      locales: Object.keys(LOCALES),
      catalogs: audit.catalogs.catalogs,
      descriptorReferences: descriptors.length,
      auditedFiles: audit.summary.physicalSourceFiles,
      dynamicBoundaries: audit.summary.runtimeBoundaries,
      openAuditFindings: audit.summary.openFindings,
    },
  };
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const result = await checkI18n();
  console.log(
    JSON.stringify(
      result.errors.length
        ? { summary: result.summary, errors: result.errors }
        : result.summary,
      null,
      2,
    ),
  );
  if (result.errors.length) process.exitCode = 1;
}
