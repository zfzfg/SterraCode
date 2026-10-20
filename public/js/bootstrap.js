import { initI18n } from "./i18n.js";
try {
  await initI18n();
} catch (error) {
  // Deliberate bootstrap exception: catalogs cannot be used before they load.
  document.documentElement.lang = "de";
  const warning = document.createElement("p");
  warning.setAttribute("role", "alert");
  warning.textContent =
    "Sprachdateien konnten nicht geladen werden. / Language files could not be loaded. / No se pudieron cargar los idiomas. Bitte neu laden. / Please reload. / Recarga la página.";
  document.body.prepend(warning);
  console.error("i18n bootstrap", error);
  try {
    await initI18n("de");
  } catch {
    document.documentElement.removeAttribute("data-i18n-loading");
    throw error;
  }
}
document.documentElement.removeAttribute("data-i18n-loading");
await import("/app.js");
