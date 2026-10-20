export const DEFAULT_LOCALE = "en";
export const LOCALES = Object.freeze({
  de: { name: "Deutsch", format: "de-DE", monaco: "de", dir: "ltr" },
  en: { name: "English", format: "en-GB", monaco: "i-default", dir: "ltr" },
  es: { name: "Español", format: "es-ES", monaco: "es", dir: "ltr" },
});
export function normalizeLocale(value, fallback = DEFAULT_LOCALE) {
  if (typeof value !== "string") return fallback;
  const base = value.trim().toLowerCase().split(/[-_]/)[0];
  return Object.hasOwn(LOCALES, base) ? base : fallback;
}
export function requestLocale(header) {
  const candidates = String(header || "")
    .split(",")
    .map((part, index) => {
      const [locale, ...options] = part.trim().split(";");
      const quality = options.find((option) => option.trim().startsWith("q="));
      return {
        locale,
        quality: quality ? Number(quality.trim().slice(2)) : 1,
        index,
      };
    })
    .filter((item) => item.quality > 0 && item.quality <= 1)
    .sort((a, b) => b.quality - a.quality || a.index - b.index);
  for (const item of candidates) {
    const locale = normalizeLocale(item.locale, null);
    if (locale) return locale;
  }
  return DEFAULT_LOCALE;
}
export const formatLocale = (locale) => LOCALES[normalizeLocale(locale)].format;
