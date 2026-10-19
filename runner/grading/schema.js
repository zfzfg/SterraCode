import { validateTrace } from "../tracer/adapter.js";

export const TEST_LIMITS = {
  cases: 20,
  definitionBytes: 262144,
  caseTimeout: 2000,
  suiteTimeout: 30000,
  resultBytes: 65536,
};
export function jsonValue(value, depth = 0) {
  if (depth > 20) return false;
  if (value === null || typeof value === "boolean" || typeof value === "string")
    return true;
  if (typeof value === "number")
    return Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
  if (Array.isArray(value)) return value.every((v) => jsonValue(v, depth + 1));
  return (
    value &&
    Object.getPrototypeOf(value) === Object.prototype &&
    Object.values(value).every((v) => jsonValue(v, depth + 1))
  );
}
export function validateSuite(
  suite,
  fail = (m) => {
    throw new Error(m);
  },
) {
  const only = (object, keys) =>
    object &&
    typeof object === "object" &&
    !Array.isArray(object) &&
    Object.keys(object).every((key) => keys.includes(key));
  if (
    !suite ||
    !only(suite, [
      "schemaVersion",
      "version",
      "language",
      "entry",
      "comparison",
      "cases",
    ]) ||
    !only(suite.entry, ["path", "function"]) ||
    Buffer.byteLength(JSON.stringify(suite)) > TEST_LIMITS.definitionBytes ||
    suite.schemaVersion !== 1 ||
    !Number.isInteger(suite.version) ||
    suite.version < 1 ||
    suite.language !== "python" ||
    suite.comparison?.kind !== "strict-json" ||
    Object.keys(suite.comparison).length !== 1 ||
    !/^[A-Za-z][A-Za-z0-9_]{0,99}$/.test(suite.entry?.function || "") ||
    !Array.isArray(suite.cases) ||
    !suite.cases.length ||
    suite.cases.length > 20
  )
    return fail(
      "Ungültige Testsuite: Python, strict-json und 1–20 sichtbare Fälle erforderlich.",
    );
  validateTrace(
    {
      entry: suite.entry.path,
      files: [{ path: suite.entry.path, content: "" }],
      stdin: "",
    },
    fail,
  );
  const ids = new Set();
  for (const c of suite.cases) {
    if (
      !c ||
      !only(c, ["id", "name", "args", "expected", "visibility", "required"]) ||
      !/^[a-zA-Z0-9_-]{1,100}$/.test(c.id) ||
      ids.has(c.id) ||
      typeof c.name !== "string" ||
      !c.name.length ||
      c.name.length > 200 ||
      c.visibility !== "public" ||
      typeof c.required !== "boolean" ||
      !Array.isArray(c.args) ||
      !jsonValue(c.args) ||
      !Object.hasOwn(c, "expected") ||
      !jsonValue(c.expected)
    )
      return fail(
        "Ungültiger Testfall: eindeutige ID, JSON-Argumente und sichtbare Erwartung erforderlich.",
      );
    ids.add(c.id);
  }
  if (!suite.cases.some((c) => c.required))
    return fail("Mindestens ein erforderlicher Testfall fehlt.");
  return JSON.parse(JSON.stringify(suite));
}
export function validateTest(test, fail) {
  const suite = validateSuite(test?.suite, fail);
  const snapshot = validateTrace(
    { entry: suite.entry.path, files: test?.files, stdin: "" },
    fail,
  );
  return { suite, files: snapshot.files };
}
