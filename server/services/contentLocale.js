import { LOCALES } from "../../shared/i18n/locale.js";
import { AppError } from "./storage.js";

export function validateContentLocale(value, fallback = "de") {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !Object.hasOwn(LOCALES, value))
    throw new AppError("Ungültige Inhaltssprache.", 400, "INVALID_REQUEST", {
      messageKey: "learningContent:errors.locale",
    });
  return value;
}

export function contentMetadata(value) {
  const result = {};
  if (value.contentLocale !== undefined)
    result.contentLocale = validateContentLocale(value.contentLocale);
  if (value.contentProvenance !== undefined) {
    const p = value.contentProvenance;
    if (
      !p ||
      p.version !== 1 ||
      !["template", "review", "import"].includes(p.kind) ||
      typeof p.id !== "string" ||
      !p.id ||
      p.id.length > 200 ||
      typeof p.contentLocale !== "string" ||
      !Number.isInteger(p.contentVersion) ||
      p.contentVersion < 1 ||
      p.contentVersion > 1000000 ||
      Object.keys(p).some(
        (key) =>
          ![
            "version",
            "kind",
            "id",
            "contentVersion",
            "contentLocale",
          ].includes(key),
      ) ||
      validateContentLocale(p.contentLocale) !== result.contentLocale
    )
      throw new AppError(
        "Ungültige Herkunftsangaben für Lerninhalte.",
        400,
        "INVALID_REQUEST",
        {
          messageKey: "learningContent:errors.contentProvenance",
        },
      );
    result.contentProvenance = {
      version: 1,
      kind: p.kind,
      id: p.id,
      contentVersion: p.contentVersion,
      contentLocale: p.contentLocale,
    };
  }
  return result;
}
