import fs from "node:fs";
import { fileURLToPath } from "node:url";
import i18next from "i18next";
import {
  LOCALES,
  DEFAULT_LOCALE,
  normalizeLocale,
  requestLocale,
} from "../../shared/i18n/locale.js";
import { messageDescriptor } from "../../shared/i18n/messages.js";

export const catalogRoot = fileURLToPath(
  new URL("../../shared/i18n/locales/", import.meta.url),
);
const resources = {};
export const namespaces = fs
  .readdirSync(`${catalogRoot}/de`)
  .filter((name) => /^[\w-]+\.json$/.test(name))
  .map((name) => name.slice(0, -5));
for (const locale of Object.keys(LOCALES)) {
  resources[locale] = {};
  for (const namespace of namespaces)
    resources[locale][namespace] = JSON.parse(
      fs.readFileSync(`${catalogRoot}/${locale}/${namespace}.json`, "utf8"),
    );
}
const instance = i18next.createInstance();
await instance.init({
  resources,
  lng: DEFAULT_LOCALE,
  fallbackLng: "de",
  supportedLngs: Object.keys(LOCALES),
  ns: namespaces,
  defaultNS: "common",
  initAsync: false,
  interpolation: { escapeValue: false },
  returnNull: false,
  returnEmptyString: false,
});
export function t(locale, key, params = {}) {
  const fixed = instance.getFixedT(normalizeLocale(locale));
  return instance.exists(key, {
    lng: normalizeLocale(locale),
    count: params.count,
    context: params.context,
  })
    ? fixed(key, {
        replace: params,
        count: params.count,
        context: params.context,
        interpolation: { escapeValue: false, skipOnVariables: true },
      })
    : fixed("common:errors.generic");
}
// Materialized learning content is data; avoid translation-option parameters
// on the message descriptor path when reading structured template resources.
export function getCatalogValue(locale, namespace, key) {
  const language = normalizeLocale(locale);
  const value =
    instance.getResource(language, namespace, key) ??
    instance.getResource("de", namespace, key);
  return value === undefined ? undefined : structuredClone(value);
}
export function localizeMessage(locale, descriptor, fallback = "") {
  if (!descriptor?.key) return fallback;
  const safe = messageDescriptor(descriptor.key, descriptor.params);
  return t(locale, safe.key, safe.params);
}
export function errorPayload(error, locale = DEFAULT_LOCALE) {
  let messageKey = error.messageKey || error.descriptor?.key;
  let params = error.params || error.descriptor?.params || {};
  if (messageKey) {
    try {
      params = messageDescriptor(messageKey, params).params;
    } catch {
      messageKey = "common:errors.generic";
      params = {};
    }
  }
  return {
    error: messageKey ? t(locale, messageKey, params) : error.message,
    code: error.code,
    ...(messageKey ? { messageKey, params } : {}),
  };
}
export function localeMiddleware(req, res, next) {
  if (req.path.startsWith("/api")) res.set("Cache-Control", "no-store");
  req.uiLocale = requestLocale(req.get("Accept-Language"));
  req.t = (key, params) => t(req.uiLocale, key, params);
  res.set("Content-Language", req.uiLocale);
  res.vary("Accept-Language");
  next();
}
