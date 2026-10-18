import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

export const DATA_DIR = path.resolve(
  process.env.STERRACODE_DATA_DIR ||
    path.join(path.dirname(fileURLToPath(import.meta.url)), "../data"),
);
const queues = new Map();
export class AppError extends Error {
  constructor(message, status = 400, code = "INVALID_REQUEST") {
    super(message);
    this.status = status;
    this.code = code;
  }
}
export function validateSessionId(id) {
  if (
    typeof id !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
      id,
    )
  )
    throw new AppError("Ungültige Session-ID.");
  return id;
}
export async function serial(key, operation) {
  const previous = queues.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  queues.set(key, next);
  try {
    return await next;
  } finally {
    if (queues.get(key) === next) queues.delete(key);
  }
}
export async function readJSON(file) {
  return JSON.parse(await fs.readFile(file, "utf8"));
}
export async function writeJSON(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(data, null, 2), "utf8");
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}
export async function listFiles(dir, ext = ".json") {
  try {
    return (await fs.readdir(dir))
      .filter((f) => f.endsWith(ext))
      .map((f) => path.join(dir, f));
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
}
export const DEFAULT_SYSTEM_PROMPT = `Du bist SterraCode, ein geduldiger Programmier-Lehrbegleiter. Antworte in der Sprache des Nutzers.
Erkläre erst das Warum, dann das Wie. Gib kurze, konkrete Erklärungen und passende Übungsaufgaben.
Die Lernplanfrage zum Sessionstart wird bereits von der Anwendung angezeigt. Frage sie nicht erneut.
Lies Code mit read_file und liste Dateien mit list_files. Bearbeite echte Workspace-Dateien mit write_file.
Lies vor einer Änderung die aktuelle Dateiversion und übergib sie als expectedVersion an write_file.
Verwende ausschließlich die angebotenen Tools. Erstelle Aufgaben mit create_task und schreibe Vorlagen direkt in Dateien.
Benutze ask_question für interaktive Fragen und update_learning_plan für Lernziele und Themen.
Berücksichtige den aktuellen Lernplan und die aktive Datei. Ein abgeschlossenes Lernziel kann durch einen neuen Plan ergänzt werden.
Verwende run_terminal_command zum Ausführen und read_terminal_output zum Lesen laufender Prozesse, soweit freigegeben.
Dateiänderungen sind direkt wirksam und rückgängig zu machen. Beschreibe kurz, welche Datei du geändert hast.`;
export const LANGUAGES = [
  "python",
  "javascript",
  "bash",
  "go",
  "rust",
  "cpp",
  "csharp",
  "lua",
  "java",
];
export function defaultSettings() {
  return {
    lmStudioUrl: "http://localhost:1234",
    activeModel: null,
    temperature: 0.4,
    maxTokensResponse: 2048,
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    tokenThreshold: 8000,
    keepRecentMessages: 6,
    maxToolCallsPerTurn: 10,
    crossChatProfileEnabled: false,
    autoUpdateProfileOnTaskDone: true,
    executionTimeout: 30000,
    compilationTimeout: 60000,
    allowedLanguages: LANGUAGES,
    allowAITerminalCommands: true,
    theme: "dark",
    fontSize: 14,
    streaming: true,
    sidebarWidth: 256,
    editorRatio: 0.6,
    terminalHeight: 180,
    layoutVersion: 1,
  };
}
export async function ensureDataDirs() {
  for (const dir of [
    "sessions",
    "profiles",
    "workspaces",
    "backups",
    "changes",
    "runs",
  ])
    await fs.mkdir(path.join(DATA_DIR, dir), { recursive: true });
  const file = path.join(DATA_DIR, "settings.json");
  try {
    await fs.access(file);
  } catch {
    await writeJSON(file, defaultSettings());
  }
}
export async function getSettings() {
  const saved = await readJSON(path.join(DATA_DIR, "settings.json"));
  const legacyPrompt =
    saved.systemPrompt?.includes("Du bist SterraCode Teacher,") &&
    saved.systemPrompt.includes("read_editor");
  return {
    ...defaultSettings(),
    ...saved,
    allowedLanguages:
      !saved.layoutVersion &&
      JSON.stringify(saved.allowedLanguages) ===
        JSON.stringify(["python", "javascript", "bash", "go"])
        ? LANGUAGES
        : saved.allowedLanguages || LANGUAGES,
    systemPrompt: legacyPrompt
      ? saved.systemPrompt
          .replaceAll("read_editor", "read_file")
          .replaceAll("write_editor", "write_file")
          .replaceAll("run_code", "run_terminal_command") +
        "\n\nAktueller Werkzeugvertrag (verbindlich):\n" +
        DEFAULT_SYSTEM_PROMPT
      : saved.systemPrompt || DEFAULT_SYSTEM_PROMPT,
    sidebarWidth: Math.max(
      220,
      Math.min(360, parseFloat(saved.sidebarWidth) || 256),
    ),
    editorRatio: Math.max(
      0.3,
      Math.min(0.75, Number(saved.editorRatio) || 0.6),
    ),
    terminalHeight: Math.max(120, parseFloat(saved.terminalHeight) || 180),
    layoutVersion: saved.layoutVersion || 0,
  };
}
export async function updateSettings(updates) {
  return serial("settings", async () => {
    const current = await getSettings();
    const defaults = defaultSettings();
    for (const key of Object.keys(updates)) {
      if (!Object.hasOwn(defaults, key))
        throw new AppError(`Unbekannte Einstellung: ${key}`);
      const value = updates[key];
      if (
        key === "activeModel" &&
        (value === null || typeof value === "string")
      )
        continue;
      if (
        typeof value !== typeof defaults[key] ||
        (typeof value === "number" && !Number.isFinite(value))
      )
        throw new AppError(`Ungültige Einstellung: ${key}`);
    }
    const next = { ...current, ...updates };
    if (!["dark", "light", "high-contrast", "solarized"].includes(next.theme))
      throw new AppError("Ungültiges Theme.");
    for (const [key, min, max] of [
      ["temperature", 0, 1],
      ["fontSize", 10, 24],
      ["executionTimeout", 0, 600000],
      ["compilationTimeout", 1000, 600000],
      ["maxToolCallsPerTurn", 1, 20],
      ["maxTokensResponse", 256, 32768],
      ["tokenThreshold", 2000, 128000],
      ["keepRecentMessages", 2, 100],
      ["sidebarWidth", 220, 360],
      ["editorRatio", 0.3, 0.75],
      ["terminalHeight", 120, 1200],
    ]) {
      if (next[key] < min || next[key] > max)
        throw new AppError(`Ungültiger Wertebereich: ${key}`);
    }
    if (
      !Array.isArray(next.allowedLanguages) ||
      next.allowedLanguages.some((l) => !LANGUAGES.includes(l))
    )
      throw new AppError("Ungültige Sprachauswahl.");
    let url;
    try {
      url = new URL(next.lmStudioUrl);
    } catch {
      throw new AppError("Ungültige LM-Studio-URL.");
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new AppError("Ungültige LM-Studio-URL.");
    next.lmStudioUrl = url.href.replace(/\/$/, "");
    const file = path.join(DATA_DIR, "settings.json");
    const original = await readJSON(file);
    if (original.systemPrompt !== current.systemPrompt)
      await writeJSON(
        path.join(DATA_DIR, "backups", `settings-${randomUUID()}.json`),
        original,
      );
    await writeJSON(file, next);
    return next;
  });
}
export async function getSessionTitle(id) {
  return (
    await readJSON(
      path.join(DATA_DIR, "sessions", `${validateSessionId(id)}.json`),
    )
  ).title;
}
export async function getWorkspacePath(id) {
  validateSessionId(id);
  const { loadSession } = await import("./sessions.js");
  await loadSession(id);
  const parent = path.join(DATA_DIR, "workspaces"),
    root = path.join(parent, id);
  for (const directory of [parent, root])
    if ((await fs.lstat(directory)).isSymbolicLink())
      throw new AppError(
        "Workspace-Verknüpfungen sind nicht erlaubt.",
        403,
        "PATH_DENIED",
      );
  return root;
}
