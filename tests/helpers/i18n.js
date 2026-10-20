import fs from "node:fs";
import { initResources } from "../../public/js/i18n.js";
const root = new URL("../../shared/i18n/locales/", import.meta.url);
const resources = {};
for (const locale of fs.readdirSync(root)) {
  resources[locale] = {};
  for (const file of fs.readdirSync(new URL(`${locale}/`, root)))
    if (file.endsWith(".json"))
      resources[locale][file.slice(0, -5)] = JSON.parse(
        fs.readFileSync(new URL(`${locale}/${file}`, root), "utf8"),
      );
}
await initResources(resources, "de");
