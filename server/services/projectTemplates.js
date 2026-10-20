import { normalizeLocale } from "../../shared/i18n/locale.js";
import { getCatalogValue } from "./i18n.js";

export const TEMPLATE_IDS = ["guess-number", "text-analysis", "small-website"];

// These are programming contracts, not translatable text. In particular the
// German return literals and the empty-string test input must stay byte exact.
const contracts = {
  "guess-number": {
    language: "python",
    function: "beurteile_tipp",
    cases: [
      [[2, 5], "zu klein"],
      [[8, 5], "zu groß"],
      [[5, 5], "richtig"],
      [[-5, -2], "zu klein"],
    ],
  },
  "text-analysis": {
    language: "python",
    function: "zaehle_woerter",
    cases: [
      [[""], 0],
      [["Hallo Welt"], 2],
      [["  eins   zwei\ndrei\t"], 3],
    ],
  },
  "small-website": { language: "javascript" },
};

function testSuite(contract, names) {
  if (!contract.function) return {};
  return {
    testSuite: {
      schemaVersion: 1,
      version: 1,
      language: "python",
      entry: { path: "main.py", function: contract.function },
      comparison: { kind: "strict-json" },
      cases: contract.cases.map(([args, expected], i) => ({
        id: `case-${i + 1}`,
        name: names[i],
        args,
        expected,
        visibility: "public",
        required: true,
      })),
    },
  };
}

// Materialise once at creation time. Files and case names then belong to the
// project and must never be retranslated in response to a UI language change.
export function materializeProjectTemplates(locale = "de") {
  locale = normalizeLocale(locale);
  return TEMPLATE_IDS.map((id) => {
    const template = getCatalogValue(locale, "templates", id);
    const contract = contracts[id];
    const { testCaseNames, ...task } = template.task;
    const metadata = {
      contentLocale: locale,
      contentProvenance: {
        version: 1,
        kind: "template",
        id,
        contentVersion: 1,
        contentLocale: locale,
      },
    };
    return {
      id,
      ...template,
      version: 1,
      language: contract.language,
      origin: "SterraCode",
      license: "CC0-1.0",
      ...metadata,
      task: { ...task, ...testSuite(contract, testCaseNames), ...metadata },
    };
  });
}

export const PROJECT_TEMPLATES = materializeProjectTemplates();
