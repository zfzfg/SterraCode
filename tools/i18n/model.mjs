import { createHash } from "node:crypto";

export const hash = (value) => createHash("sha256").update(value).digest("hex");
export const severityOrder = { critical: 0, warning: 1, info: 2 };
export const ruleNames = [
  "CALL_PLACEHOLDERS",
  "PLURAL_COUNT_MISSING",
  "DYNAMIC_OPTIONS",
  "HARDCODED",
  "INVARIANT_DISPLAY",
  "SCHEMA_TEXT",
  "CONTENT",
  "FIXED_LOCALE",
  "PROSE_REVIEW",
  "LITERAL_REVIEW",
  "DUPLICATE_KEY",
  "CONFIG_INTERPOLATION",
  "CATALOGS_ABSENT",
  "CATALOG_BASE_MISSING",
  "CATALOG_LOCALE_MISSING",
  "CATALOG_MISSING_KEY",
  "CATALOG_EMPTY",
  "CATALOG_PLACEHOLDERS",
  "CATALOG_EXTRA_KEY",
  "CATALOG_IDENTICAL_VALUE",
  "DYNAMIC_KEY",
  "MISSING_KEY",
  "POSSIBLY_UNUSED_KEY",
  "STALE_EXCEPTION",
  "KEY_FALLBACK",
];
export function area(file) {
  if (file.startsWith("tests/")) return "tests";
  if (file.startsWith("public/")) return "frontend";
  if (file.startsWith("server/")) return "server";
  if (file.startsWith("runner/")) return "runner";
  if (file.startsWith("shared/") || file.startsWith("locales/"))
    return "shared";
  if (/^(scripts|docker)\//.test(file) || /\.(sh|ps1|bat)$/.test(file))
    return "operations";
  return "configuration";
}
export function position(source, offset) {
  const before = source.slice(0, offset);
  return {
    line: before.split("\n").length,
    column: offset - before.lastIndexOf("\n"),
  };
}
export function languageHint(text) {
  if (
    /[äöüßÄÖÜ]|\b(?:nicht|keine?|bitte|wurde|werden|speichern|gespeichert|pruefen|fuer|ausfuehren)\b/i.test(
      text,
    )
  )
    return "de-signal";
  if (/[¿¡ñÑ]|\b(?:guardar|archivo|contraseña|sesión)\b/i.test(text))
    return "es-signal";
  if (/\b(?:please|your|cannot|failed|save|cancel|unknown|the)\b/i.test(text))
    return "en-signal";
  return "undetermined";
}
export function prose(text) {
  return (
    /\p{L}{2,}\s+\p{L}{2,}/u.test(text) || languageHint(text) !== "undetermined"
  );
}
export function technicalShape(text) {
  const value = text.trim();
  if (!/\p{L}/u.test(value)) return "punctuation-or-empty";
  if (
    /^(?:https?:\/\/|(?:\.{0,2}\/|[A-Za-z]:[\\/])\S*$)/.test(value) &&
    !/\s/.test(value)
  )
    return "path-or-url";
  if (/^[a-z]+\/[a-z0-9.+-]+(?:;\s*charset=[\w-]+)?$/i.test(value))
    return "mime-type";
  if (/^[A-Z][A-Z0-9_]+$/.test(value)) return "protocol-or-enum";
  if (/^[a-z][a-z0-9]*(?:[._/-][a-zA-Z0-9_-]+)+$/.test(value))
    return "identifier-shaped";
  if (/^--?[\w-]+$/.test(value)) return "command-option";
  return null;
}
export class Context {
  constructor(config) {
    this.config = config;
    this.literals = [];
    this.findings = [];
    this.sinks = [];
    this.boundaries = [];
    this.coverage = [];
    this.errors = [];
    this.keyReferences = [];
    this.helpers = [];
    this.occurrences = new Map();
    this.findingKeys = new Map();
  }
  literal(record) {
    // Native PowerShell hashtables do not guarantee JSON property order.
    // Canonicalize records before export so identical scans stay byte-stable.
    record = Object.fromEntries(
      Object.entries(record).sort(([left], [right]) =>
        left.localeCompare(right, "en"),
      ),
    );
    const basis = JSON.stringify([
      record.file,
      record.kind,
      record.owner || "",
      record.role || "",
      record.text,
    ]);
    const occurrence = this.occurrences.get(basis) || 0;
    this.occurrences.set(basis, occurrence + 1);
    const item = {
      ...record,
      id: `L-${hash(`${basis}:${occurrence}`).slice(0, 20)}`,
      area: area(record.file),
      languageHint: languageHint(record.text),
      disposition:
        record.role === "comment" ? "comment" : "unclassified-review",
      evidence: [],
    };
    this.literals.push(item);
    return this.literals.length - 1;
  }
  finding(rule, literalIndex, options = {}) {
    const literal = literalIndex === null ? null : this.literals[literalIndex];
    const key = JSON.stringify([
      rule,
      literal?.id,
      options.identity || "",
      options.channel || "",
    ]);
    let result = this.findingKeys.get(key);
    if (!result) {
      const file = options.file || literal?.file || "";
      const text = options.text ?? literal?.text ?? "";
      result = {
        id: `F-${hash(key).slice(0, 20)}`,
        fingerprint: hash(
          JSON.stringify([
            rule,
            file,
            literal?.owner || "",
            text,
            options.identity || "",
            options.channel || "",
          ]),
        ),
        rule,
        severity: options.severity || "warning",
        channel: options.channel || "review",
        file,
        line: options.line || literal?.line || 1,
        column: options.column || literal?.column || 1,
        literalId: literal?.id || null,
        text,
        message: options.message || "Hardcoded text requires review.",
        evidence: [],
        status: "open",
      };
      this.findings.push(result);
      this.findingKeys.set(key, result);
    }
    if (options.evidence && result.evidence.length < 10)
      result.evidence.push(options.evidence);
    else if (
      options.evidence?.certainty === "static-flow" &&
      result.evidence.every(
        (entry) => entry.certainty === "possible-call-union",
      )
    )
      result.evidence[result.evidence.length - 1] = options.evidence;
    if (
      options.severity &&
      severityOrder[options.severity] < severityOrder[result.severity]
    )
      result.severity = options.severity;
    if (literal && options.evidence && literal.evidence.length < 12)
      literal.evidence.push({
        sinkId: options.evidence.sinkId,
        certainty: options.evidence.certainty,
      });
    return result;
  }
  direct(literalIndex, channel, evidence = {}) {
    const literal = this.literals[literalIndex];
    if (
      literal.role === "comment" ||
      (literal.role === "syntax-key" && !evidence.keyUsedAsText) ||
      !/\p{L}/u.test(literal.staticText ?? literal.text)
    )
      return;
    const content = ["prompt", "generated-source", "test-data"].includes(
      literal.role,
    );
    literal.disposition = content ? "content-review" : "output-text";
    const invariant = this.config.invariantDisplayValues?.[literal.text];
    this.finding(
      invariant
        ? "INVARIANT_DISPLAY"
        : content
          ? "CONTENT"
          : channel === "schema-field"
            ? "SCHEMA_TEXT"
            : "HARDCODED",
      literalIndex,
      {
        channel: literal.area === "tests" ? "test-fixture" : channel,
        severity: invariant
          ? "info"
          : [
                "ui",
                "api-error",
                "runner-error",
                "html",
                "accessibility",
              ].includes(channel) &&
              !content &&
              evidence.certainty !== "possible-call-union" &&
              literal.area !== "tests"
            ? "critical"
            : "warning",
        message: invariant
          ? `Bewusst unveränderte Anzeige: ${invariant}. Der Fund bleibt im Inventar sichtbar.`
          : content
            ? "Mitgelieferter Inhalt erreicht einen Textpfad; Vertrag und Herkunft prüfen."
            : channel === "schema-field"
              ? "Textfeld in einem Datenobjekt; tatsächliche Anzeige und fachlichen Vertrag prüfen."
              : "Fest eingebauter Text erreicht eine registrierte Ausgabestelle.",
        evidence,
      },
    );
  }
}
