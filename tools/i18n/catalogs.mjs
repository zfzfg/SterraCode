import path from "node:path";
import { area, prose } from "./model.mjs";

function flatten(value, prefix = "", result = new Map()) {
  if (typeof value === "string") result.set(prefix, value);
  else if (value && typeof value === "object")
    for (const [key, child] of Object.entries(value))
      flatten(child, prefix ? `${prefix}.${key}` : key, result);
  return result;
}
const baseKey = (key) => key.replace(/_(?:zero|one|two|few|many|other)$/, "");
const placeholders = (value) =>
  [
    ...new Set(
      [...value.matchAll(/\{\{\s*-?\s*([\w.]+)(?:\s*,[^}]*)?\s*\}\}/g)].map(
        (match) => match[1],
      ),
    ),
  ].sort();

export function checkCatalogs(ctx, documents) {
  const config = ctx.config.catalogs;
  const references = ctx.keyReferences.filter(
    (reference) => area(reference.file) !== "tests",
  );
  const catalogs = [];
  for (const input of documents) {
    const root = config.roots.find((directory) =>
      input.file.startsWith(`${directory}/`),
    );
    if (!root || !input.data) continue;
    const relative = input.file.slice(root.length + 1).split("/");
    if (relative.length < 2) continue;
    catalogs.push({
      file: input.file,
      locale: relative[0],
      namespace: relative
        .slice(1)
        .join("/")
        .replace(/\.json$/, ""),
      values: flatten(input.data),
    });
    for (const literal of ctx.literals)
      if (literal.file === input.file && literal.kind === "json-string") {
        literal.role = "catalog-value";
        literal.disposition = "catalog-value";
      }
  }
  if (!catalogs.length) {
    if (references.length)
      ctx.finding("CATALOGS_ABSENT", null, {
        identity: "catalogs",
        severity: "critical",
        channel: "catalog",
        message:
          "Übersetzungsaufrufe vorhanden, aber keine konfigurierten Kataloge gefunden.",
      });
    return {
      status: "not-present",
      catalogs: 0,
      namespaces: 0,
      note: "Katalogprüfung mangels i18n-Katalogen nicht ausgeführt; kein bestandener Paritätstest.",
    };
  }
  const resourceFiles = new Set(catalogs.map((catalog) => catalog.file));
  ctx.findings = ctx.findings.filter(
    (finding) =>
      !(finding.rule === "SCHEMA_TEXT" && resourceFiles.has(finding.file)),
  );
  const report = (rule, file, key, message, severity = "critical") =>
    ctx.finding(rule, null, {
      file,
      identity: `${file}:${key}`,
      text: key,
      severity,
      channel: "catalog",
      message,
    });
  const namespaces = [
    ...new Set(catalogs.map((catalog) => catalog.namespace)),
  ].sort();
  for (const ns of namespaces) {
    const base = catalogs.find(
      (catalog) =>
        catalog.namespace === ns && catalog.locale === config.baseLocale,
    );
    if (!base) {
      report(
        "CATALOG_BASE_MISSING",
        "",
        ns,
        `Basiskatalog ${config.baseLocale}/${ns} fehlt.`,
      );
      continue;
    }
    const baseGroups = new Map();
    for (const [key, value] of base.values) {
      const name = baseKey(key);
      if (!baseGroups.has(name)) baseGroups.set(name, new Map());
      baseGroups.get(name).set(key, value);
    }
    for (const locale of config.requiredLocales) {
      const catalog = catalogs.find(
        (item) => item.locale === locale && item.namespace === ns,
      );
      if (!catalog) {
        report(
          "CATALOG_LOCALE_MISSING",
          base.file,
          `${locale}:${ns}`,
          `Sprachkatalog ${locale}/${ns} fehlt.`,
        );
        continue;
      }
      for (const [name, forms] of baseGroups) {
        const plural = [...forms.keys()].some((key) => key !== name);
        const required = plural
          ? new Intl.PluralRules(locale)
              .resolvedOptions()
              .pluralCategories.map((category) => `${name}_${category}`)
          : [name];
        if (plural && forms.has(`${name}_zero`)) required.push(`${name}_zero`);
        for (const key of required) {
          if (!catalog.values.has(key)) {
            report(
              "CATALOG_MISSING_KEY",
              catalog.file,
              key,
              `Erforderlicher Schlüssel ${key} fehlt.`,
            );
            continue;
          }
          const value = catalog.values.get(key);
          const expected = placeholders(
            forms.get(key) ?? forms.get(plural ? `${name}_other` : name) ?? "",
          );
          if (
            !value.trim() ||
            /^(?:TODO|FIXME|TRANSLATE|TBD)(?:\b|$)/i.test(value.trim())
          )
            report(
              "CATALOG_EMPTY",
              catalog.file,
              key,
              "Leerer oder unfertiger Übersetzungstext.",
            );
          const actual = placeholders(value);
          if (JSON.stringify(actual) !== JSON.stringify(expected))
            report(
              "CATALOG_PLACEHOLDERS",
              catalog.file,
              key,
              `Platzhalter unterscheiden sich: erwartet ${expected.join(", ") || "keine"}; vorhanden ${actual.join(", ") || "keine"}.`,
            );
        }
      }
      for (const [key, value] of catalog.values) {
        if (!baseGroups.has(baseKey(key)))
          report(
            "CATALOG_EXTRA_KEY",
            catalog.file,
            key,
            "Zusätzlicher Schlüssel ohne Entsprechung im Basiskatalog.",
            "warning",
          );
        const english = catalogs
          .find((item) => item.locale === "en" && item.namespace === ns)
          ?.values.get(key);
        if (locale !== "en" && value === english && prose(value))
          report(
            "CATALOG_IDENTICAL_VALUE",
            catalog.file,
            key,
            "Text stimmt mit Englisch überein; mögliche unübersetzte Prosa, manuell prüfen.",
            "warning",
          );
      }
    }
  }
  const used = new Set();
  let dynamic = false;
  for (const reference of references) {
    if (reference.dynamic || reference.key === null) {
      dynamic = true;
      report(
        "DYNAMIC_KEY",
        reference.file,
        `${reference.line}:${reference.expression || ""}`,
        "Dynamischer Übersetzungsschlüssel; statische Vollständigkeit/Unbenutztheit nicht bewiesen.",
        "info",
      );
      continue;
    }
    const separator = reference.key.indexOf(":");
    const ns =
      separator >= 0
        ? reference.key.slice(0, separator)
        : reference.namespace || config.defaultNamespace;
    const rawKey =
      separator >= 0 ? reference.key.slice(separator + 1) : reference.key;
    const key = reference.context ? `${rawKey}_${reference.context}` : rawKey;
    used.add(`${ns}:${baseKey(key)}`);
    for (const locale of config.requiredLocales) {
      const catalog = catalogs.find(
        (item) => item.locale === locale && item.namespace === ns,
      );
      if (
        !catalog ||
        ![...catalog.values.keys()].some(
          (name) => baseKey(name) === baseKey(key),
        )
      )
        report(
          "MISSING_KEY",
          reference.file,
          `${locale}:${ns}:${key}`,
          `Aufgerufener Schlüssel ${ns}:${key} fehlt in ${locale}.`,
        );
      else if (Array.isArray(reference.providedParameters)) {
        const forms = [...catalog.values].filter(
          ([name]) => baseKey(name) === baseKey(key),
        );
        const plural = forms.some(([name]) => name !== key);
        if (plural && !reference.providedParameters.includes("count"))
          report(
            "PLURAL_COUNT_MISSING",
            reference.file,
            `${ns}:${key}`,
            "Pluralisierter Übersetzungsaufruf übergibt kein count.",
          );
        const required = [
          ...new Set(forms.flatMap(([, value]) => placeholders(value))),
        ];
        const missing = required.filter(
          (name) =>
            !reference.providedParameters.includes(name.split(".")[0]) &&
            !(config.defaultVariables || []).includes(name),
        );
        if (missing.length)
          report(
            "CALL_PLACEHOLDERS",
            reference.file,
            `${ns}:${key}`,
            `Übersetzungsaufruf übergibt Platzhalter nicht: ${missing.join(", ")}.`,
          );
      } else if (reference.providedParameters === null)
        report(
          "DYNAMIC_OPTIONS",
          reference.file,
          `${reference.line}:${reference.expression}`,
          "Übersetzungsoptionen sind dynamisch; count und Platzhalter nicht vollständig geprüft.",
          "info",
        );
    }
  }
  for (const catalog of catalogs.filter(
    (item) => item.locale === config.baseLocale,
  ))
    for (const name of new Set([...catalog.values.keys()].map(baseKey))) {
      if (!used.has(`${catalog.namespace}:${name}`))
        report(
          "POSSIBLY_UNUSED_KEY",
          catalog.file,
          name,
          dynamic
            ? "Kein statischer Aufruf; dynamische Schlüssel verhindern einen Unbenutztheitsbeweis."
            : "Kein erkannter Schlüsselaufruf; externe/dynamische Verbraucher vor Entfernen prüfen.",
          "info",
        );
    }
  return {
    status: "checked",
    catalogs: catalogs.length,
    namespaces: namespaces.length,
    files: catalogs.map(({ file, locale, namespace }) => ({
      file,
      locale,
      namespace,
    })),
    dynamicReferences: references.filter((reference) => reference.dynamic)
      .length,
  };
}
