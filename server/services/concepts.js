import { AppError } from "./storage.js";
import { normalizeLocale } from "../../shared/i18n/locale.js";
import { t } from "./i18n.js";

export const CATALOG_VERSION = 1;
const definitions = [
  ["variables", "data", ["variables", "variablen"], []],
  [
    "conditions",
    "control-flow",
    ["conditions", "bedingungen", "condiciones", "if"],
    ["variables"],
  ],
  [
    "loops",
    "control-flow",
    ["loops", "schleifen", "for-schleifen", "bucles"],
    ["conditions"],
  ],
  [
    "lists",
    "collections",
    ["lists", "listen", "arrays", "listas"],
    ["variables"],
  ],
  [
    "functions",
    "functions",
    ["functions", "funktionen", "funciones"],
    ["variables"],
  ],
  [
    "strings",
    "data",
    ["strings", "zeichenketten", "cadenas", "cadenas de texto"],
    ["variables"],
  ],
];
export const CONCEPTS = ["python", "javascript"].flatMap((language) =>
  definitions.map(([key, group, aliases, prerequisites]) => ({
    id: `${language}.${key}`,
    language,
    title: t("de", `learningContent:concepts.${key}`),
    group,
    aliases,
    prerequisites: prerequisites.map((p) => `${language}.${p}`),
  })),
);
export function resolveConcept(value, language) {
  if (typeof value !== "string") return null;
  const name = value.trim().toLowerCase();
  return (
    CONCEPTS.find(
      (c) =>
        c.id === name || (c.language === language && c.aliases.includes(name)),
    )?.id || null
  );
}
export function validateConceptIds(values = [], language) {
  if (!Array.isArray(values) || values.length > 30)
    throw new AppError("Ungültige Konzeptliste.", 400, "INVALID_REQUEST", {
      messageKey: "learningContent:errors.conceptList",
      params: {},
    });
  return [
    ...new Set(
      values.map((v) => {
        const id = resolveConcept(v, language);
        if (!id || (language && !id.startsWith(`${language}.`)))
          throw new AppError(
            `Unbekanntes Konzept: ${String(v).slice(0, 100)}`,
            400,
            "INVALID_REQUEST",
            {
              messageKey: "learningContent:errors.conceptUnknown",
              params: { value: String(v).slice(0, 100) },
            },
          );
        return id;
      }),
    ),
  ];
}

// Small, visible, validated function exercises. No model or file overwrite needed.
const exercises = {
  variables: [
    "double_value",
    [
      [3, 6],
      [-2, -4],
      [0, 0],
    ],
  ],
  conditions: [
    "is_positive",
    [
      [3, true],
      [-1, false],
      [0, false],
    ],
  ],
  loops: [
    "sum_to",
    [
      [4, 10],
      [1, 1],
      [0, 0],
    ],
  ],
  lists: [
    "first_or_none",
    [
      [[4, 2], 4],
      [[], null],
      [[0], 0],
    ],
  ],
  functions: [
    "square",
    [
      [3, 9],
      [-2, 4],
      [0, 0],
    ],
  ],
  strings: [
    "reverse_string",
    [
      ["Lernen", "nenreL"],
      ["", ""],
      ["ab", "ba"],
    ],
  ],
};
export function conceptTitle(conceptId, locale = "de") {
  const concept = CONCEPTS.find((item) => item.id === conceptId);
  return concept
    ? t(locale, `learningContent:concepts.${concept.id.split(".")[1]}`)
    : conceptId;
}

export function localizedConcepts(locale = "de") {
  return CONCEPTS.map((concept) => ({
    ...concept,
    title: conceptTitle(concept.id, locale),
  }));
}

export function reviewExercise(conceptId, locale = "de") {
  if (!conceptId.startsWith("python.")) return null;
  const key = conceptId.split(".")[1];
  const [fn, examples] = exercises[key] || [];
  if (!fn) return null;
  locale = normalizeLocale(locale);
  return {
    title: t(locale, "learningContent:review.title", {
      concept: conceptTitle(conceptId, locale),
    }),
    description: `${t(locale, `learningContent:review.${key}`)}\n${t(locale, "learningContent:review.contract", { function: fn })}`,
    contentLocale: locale,
    contentProvenance: {
      version: 1,
      kind: "review",
      id: conceptId,
      contentVersion: 1,
      contentLocale: locale,
    },
    conceptIds: [conceptId],
    difficulty: "beginner",
    hints: [],
    testSuite: {
      schemaVersion: 1,
      version: 1,
      language: "python",
      entry: { path: "main.py", function: fn },
      comparison: { kind: "strict-json" },
      cases: examples.map(([arg, expected], i) => ({
        id: `case-${i}`,
        name: t(locale, "learningContent:review.case", { number: i + 1 }),
        args: [arg],
        expected,
        visibility: "public",
        required: true,
      })),
    },
  };
}
