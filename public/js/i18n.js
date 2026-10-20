import i18next from "/vendor/i18next.js";
import {
  DEFAULT_LOCALE,
  LOCALES,
  normalizeLocale,
  formatLocale,
} from "/i18n/locale.js";
export { LOCALES, normalizeLocale };
const storageKey = "sterracode.uiLocale";
let locale = DEFAULT_LOCALE,
  initialized = false,
  namespaces = [];
try {
  locale = normalizeLocale(
    history.state?.sterracodeUiLocale || localStorage.getItem(storageKey),
  );
} catch {
  /* Tab-only preference. */
  try {
    locale = normalizeLocale(history.state?.sterracodeUiLocale);
  } catch {
    /* Registry default. */
  }
}
const instance = i18next.createInstance();
export const getLocale = () => locale;
export async function preloadLocale(value) {
  const selected = normalizeLocale(value);
  const resources = {};
  for (const language of new Set(["de", selected])) {
    resources[language] = {};
    await Promise.all(
      namespaces.map(async (namespace) => {
        try {
          const response = await fetch(
            `/i18n/locales/${language}/${namespace}.json`,
            { cache: "no-cache" },
          );
          if (!response.ok)
            throw new Error(
              `Translation catalog unavailable (${language}/${namespace})`,
            );
          resources[language][namespace] = await response.json();
        } catch (error) {
          if (initialized) throw new Error(t("common:locale.loadFailed"));
          throw error;
        }
      }),
    );
  }
  return resources;
}
export async function initI18n(value = locale) {
  const response = await fetch("/i18n/manifest.json", { cache: "no-cache" });
  if (!response.ok) throw new Error("Translation manifest unavailable");
  namespaces = (await response.json()).namespaces;
  const resources = await preloadLocale(value);
  // Tutors can use a different language from the interface. Failures of an
  // unused language must not prevent login in the selected language.
  await Promise.all(
    Object.keys(LOCALES)
      .filter((language) => !resources[language])
      .map(async (language) => {
        try {
          Object.assign(resources, await preloadLocale(language));
        } catch {
          /* German fallback remains available. */
        }
      }),
  );
  await initResources(resources, value);
}
export async function initResources(resources, value = DEFAULT_LOCALE) {
  await instance.init({
    resources,
    lng: normalizeLocale(value),
    fallbackLng: "de",
    supportedLngs: Object.keys(LOCALES),
    ns: Object.keys(resources.de || {}),
    defaultNS: "common",
    interpolation: { escapeValue: false, skipOnVariables: true },
    returnNull: false,
    returnEmptyString: false,
  });
  initialized = true;
  locale = normalizeLocale(value);
  applyDocumentLocale();
}
export function t(key, params = {}) {
  if (!initialized) return "…";
  const language = normalizeLocale(params.lng, locale);
  return instance.exists(key, {
    lng: language,
    count: params.count,
    context: params.context,
  })
    ? instance.t(key, {
        lng: language,
        count: params.count,
        context: params.context,
        replace: params,
        interpolation: { escapeValue: false, skipOnVariables: true },
      })
    : instance.t("common:errors.generic");
}
export function translateMessage(descriptor, fallback = "") {
  const key = descriptor?.messageKey || descriptor?.key;
  return key ? t(key, descriptor.params || {}) : fallback;
}
export const formatNumber = (value, options) =>
  new Intl.NumberFormat(formatLocale(locale), options).format(value);
export const formatPercent = (value, options = {}) =>
  formatNumber(value, { style: "percent", ...options });
export const formatDateTime = (value, options = {}) =>
  new Intl.DateTimeFormat(formatLocale(locale), options).format(
    new Date(value),
  );
export const formatDate = (value, options = {}) =>
  formatDateTime(value, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    ...options,
  });
export const getFormatLocale = () => formatLocale(locale);
export function persistLocale(value) {
  locale = normalizeLocale(value);
  try {
    localStorage.setItem(storageKey, locale);
    try {
      if (history.state?.sterracodeUiLocale) {
        const state = { ...history.state };
        delete state.sterracodeUiLocale;
        history.replaceState(state, "");
      }
    } catch {
      /* Preference was successfully saved in Web Storage. */
    }
  } catch {
    /* Keep current tab usable. */
    try {
      history.replaceState(
        { ...history.state, sterracodeUiLocale: locale },
        "",
      );
    } catch {
      /* In-memory selection remains usable. */
    }
  }
}
export async function changeLocale(value) {
  const selected = normalizeLocale(value);
  const resources = await preloadLocale(selected);
  for (const [language, bundles] of Object.entries(resources))
    for (const [namespace, bundle] of Object.entries(bundles))
      instance.addResourceBundle(language, namespace, bundle, true, true);
  await instance.changeLanguage(selected);
  persistLocale(selected);
  applyDocumentLocale();
  window.dispatchEvent(
    new CustomEvent("locale-changed", { detail: { locale } }),
  );
}
export function applyDocumentLocale() {
  if (typeof document === "undefined") return;
  document.documentElement.lang = locale;
  document.documentElement.dir = LOCALES[locale].dir;
  translateDOM();
}
export function translateDOM(root = document) {
  for (const element of root.querySelectorAll("[data-i18n]"))
    element.textContent = t(element.dataset.i18n);
  for (const attribute of [
    "title",
    "aria-label",
    "aria-description",
    "aria-valuetext",
    "placeholder",
    "alt",
  ])
    for (const element of root.querySelectorAll(`[data-i18n-${attribute}]`))
      element.setAttribute(
        attribute,
        t(element.getAttribute(`data-i18n-${attribute}`)),
      );
}
export function localeSelector(onChange = changeLocale) {
  const select = document.createElement("select");
  select.setAttribute("aria-label", t("common:locale.label"));
  select.setAttribute("data-i18n-aria-label", "common:locale.label");
  select.className = "ui-locale-select";
  for (const [value, entry] of Object.entries(LOCALES)) {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = entry.name;
    select.append(option);
  }
  select.value = locale;
  select.addEventListener("change", async () => {
    select.disabled = true;
    try {
      await onChange(select.value);
    } catch (error) {
      window.dispatchEvent(new CustomEvent("app-error", { detail: error }));
    } finally {
      select.value = locale;
      select.disabled = false;
    }
  });
  return select;
}
