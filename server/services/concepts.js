import { AppError } from "./storage.js";

export const CATALOG_VERSION = 1;
const definitions = [
  ["variables", "Variablen", "data", ["variables", "variablen"], []],
  [
    "conditions",
    "Bedingungen",
    "control-flow",
    ["conditions", "bedingungen", "if"],
    ["variables"],
  ],
  [
    "loops",
    "Schleifen",
    "control-flow",
    ["loops", "schleifen", "for-schleifen"],
    ["conditions"],
  ],
  [
    "lists",
    "Listen",
    "collections",
    ["lists", "listen", "arrays"],
    ["variables"],
  ],
  [
    "functions",
    "Funktionen",
    "functions",
    ["functions", "funktionen"],
    ["variables"],
  ],
  [
    "strings",
    "Zeichenketten",
    "data",
    ["strings", "zeichenketten"],
    ["variables"],
  ],
];
export const CONCEPTS = ["python", "javascript"].flatMap((language) =>
  definitions.map(([key, title, group, aliases, prerequisites]) => ({
    id: `${language}.${key}`,
    language,
    title,
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
    throw new AppError("Ungültige Konzeptliste.");
  return [
    ...new Set(
      values.map((v) => {
        const id = resolveConcept(v, language);
        if (!id || (language && !id.startsWith(`${language}.`)))
          throw new AppError(`Unbekanntes Konzept: ${String(v).slice(0, 100)}`);
        return id;
      }),
    ),
  ];
}

// Small, visible, validated function exercises. No model or file overwrite needed.
const exercises = {
  variables: [
    "double_value",
    "Gib das Doppelte der Zahl zurück.",
    [
      [3, 6],
      [-2, -4],
      [0, 0],
    ],
  ],
  conditions: [
    "is_positive",
    "Gib zurück, ob die Zahl größer als null ist.",
    [
      [3, true],
      [-1, false],
      [0, false],
    ],
  ],
  loops: [
    "sum_to",
    "Addiere mit einer Schleife die Zahlen von 1 bis n (einschließlich).",
    [
      [4, 10],
      [1, 1],
      [0, 0],
    ],
  ],
  lists: [
    "first_or_none",
    "Gib das erste Listenelement zurück, bei einer leeren Liste None.",
    [
      [[4, 2], 4],
      [[], null],
      [[0], 0],
    ],
  ],
  functions: [
    "square",
    "Schreibe eine Funktion, die das Quadrat der Zahl zurückgibt.",
    [
      [3, 9],
      [-2, 4],
      [0, 0],
    ],
  ],
  strings: [
    "reverse_string",
    "Gib die Zeichenkette in umgekehrter Reihenfolge zurück.",
    [
      ["Lernen", "nenreL"],
      ["", ""],
      ["ab", "ba"],
    ],
  ],
};
export function reviewExercise(conceptId) {
  if (!conceptId.startsWith("python.")) return null;
  const [fn, description, examples] = exercises[conceptId.split(".")[1]] || [];
  if (!fn) return null;
  return {
    title: `Freiwillige Wiederholung: ${CONCEPTS.find((c) => c.id === conceptId).title}`,
    description: `${description}\nDatei: main.py; Funktion: ${fn}(value). Die Tests prüfen Verhalten, nicht die verwendete Syntax.`,
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
        name: `Beispiel ${i + 1}`,
        args: [arg],
        expected,
        visibility: "public",
        required: true,
      })),
    },
  };
}
