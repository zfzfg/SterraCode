import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { CONTEXT_DEFAULTS, CONTEXT_VERSION } from "./context/settings.js";
import { getDefaultSystemPrompt } from "../prompts/tutor.js";

export const DATA_DIR = path.resolve(
  process.env.STERRACODE_DATA_DIR ||
    (process.env.STERRACODE_MODE === "docker"
      ? "/data"
      : path.join(path.dirname(fileURLToPath(import.meta.url)), "../data")),
);
export const WORKSPACE_DIR = path.resolve(
  process.env.STERRACODE_WORKSPACE_DIR ||
    (process.env.STERRACODE_MODE === "docker"
      ? "/workspaces"
      : path.join(DATA_DIR, "workspaces")),
);
const queues = new Map();
export class AppError extends Error {
  constructor(message, status = 400, code = "INVALID_REQUEST", metadata = {}) {
    super(message);
    this.status = status;
    this.code = code;
    if (metadata.messageKey || metadata.key) {
      this.messageKey = metadata.messageKey || metadata.key;
      this.params = metadata.params || {};
    }
  }
}
export function validateSessionId(id) {
  if (
    typeof id !== "string" ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
      id,
    )
  )
    throw new AppError("Ungültige Session-ID.", 400, "INVALID_REQUEST", {
      messageKey: "errors:session.invalidId",
    });
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
async function replaceJSONFile(source, target) {
  // Windows can briefly deny an atomic replacement while another request (or
  // the virus scanner) has the previous file open. Retain both complete files
  // and retry the rename; unlinking the previous version would lose atomicity.
  const deadline = Date.now() + 2000;
  let delay = 10;
  for (;;) {
    try {
      await fs.rename(source, target);
      return;
    } catch (error) {
      if (
        process.platform !== "win32" ||
        !["EPERM", "EACCES", "EBUSY"].includes(error.code) ||
        Date.now() >= deadline
      )
        throw error;
      await new Promise((resolve) => setTimeout(resolve, delay));
      delay = Math.min(200, delay * 2);
    }
  }
}
export async function writeJSON(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    const handle = await fs.open(temp, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(data, null, 2), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await replaceJSONFile(temp, file);
    if (process.platform !== "win32") {
      const directory = await fs.open(path.dirname(file), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    }
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
Prüfe den Status von write_file: applied ist wirksam und rückgängig; proposed ist nur ein gespeicherter Vorschlag. Behaupte bei proposed keine erfolgte Änderung. Tests prüfen echte Dateien. Beende den Turn nach einem Vorschlag, ohne auf eine Entscheidung zu warten.`;
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
    provider: "lmstudio",
    openAIModel: "",
    lmStudioUrl:
      process.env.STERRACODE_LM_STUDIO_URL ||
      (process.env.STERRACODE_MODE === "docker"
        ? "http://host.docker.internal:1234"
        : "http://localhost:1234"),
    activeModel: null,
    temperature: 0.4,
    maxTokensResponse: 2048,
    systemPrompt: getDefaultSystemPrompt(),
    ...CONTEXT_DEFAULTS,
    maxToolCallsPerTurn: 10,
    crossChatProfileEnabled: false,
    autoUpdateProfileOnTaskDone: true,
    executionTimeout: 30000,
    compilationTimeout: 60000,
    allowedLanguages: LANGUAGES,
    allowAITerminalCommands: true,
    reviewAIChanges: false,
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
    "backups",
    "changes",
    "runs",
    "context",
    "deletions",
  ])
    await fs.mkdir(path.join(DATA_DIR, dir), { recursive: true });
  await fs.mkdir(WORKSPACE_DIR, { recursive: true, mode: 0o2770 });
  if (process.env.STERRACODE_MODE === "docker") {
    await fs.chmod(DATA_DIR, 0o700);
    await fs.chmod(WORKSPACE_DIR, 0o2770);
  }
  const file = path.join(DATA_DIR, "settings.json");
  try {
    await fs.access(file);
  } catch {
    await writeJSON(file, defaultSettings());
  }
}
export async function getSettings() {
  return serial("settings-read", async () => {
    const file = path.join(DATA_DIR, "settings.json");
    let saved = await readJSON(file);
    if (saved.contextSettingsVersion !== CONTEXT_VERSION) {
      await writeJSON(
        path.join(DATA_DIR, "backups", `context-settings-${randomUUID()}.json`),
        saved,
      );
      const { tokenThreshold, keepRecentMessages, ...other } = saved;
      saved = { ...other, ...CONTEXT_DEFAULTS };
      await writeJSON(file, saved);
    }
    const legacyPrompt =
      saved.systemPrompt?.includes("Du bist SterraCode Teacher,") &&
      saved.systemPrompt.includes("read_editor");
    saved = Object.fromEntries(
      Object.entries(saved).filter(
        ([key]) =>
          Object.hasOwn(defaultSettings(), key) || key === "editorWidth",
      ),
    );
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
  });
}
export async function updateSettings(updates) {
  return serial("settings", async () => {
    const current = await getSettings();
    const defaults = defaultSettings();
    for (const key of Object.keys(updates)) {
      if (!Object.hasOwn(defaults, key))
        throw new AppError(
          `Unbekannte Einstellung: ${key}`,
          400,
          "INVALID_REQUEST",
          { messageKey: "errors:settings.unknown", params: { name: key } },
        );
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
        throw new AppError(
          `Ungültige Einstellung: ${key}`,
          400,
          "INVALID_REQUEST",
          { messageKey: "errors:settings.invalid", params: { name: key } },
        );
    }
    const next = { ...current, ...updates };
    if (
      !["lmstudio", "openai"].includes(next.provider) ||
      !/^[A-Za-z0-9._:-]{0,200}$/.test(next.openAIModel)
    )
      throw new AppError(
        "Ungültiger KI-Anbieter oder ungültige Modell-ID.",
        400,
        "INVALID_REQUEST",
        { messageKey: "errors:settings.provider" },
      );
    if (!["dark", "light", "high-contrast", "solarized"].includes(next.theme))
      throw new AppError("Ungültiges Theme.", 400, "INVALID_REQUEST", {
        messageKey: "errors:settings.theme",
      });
    for (const [key, min, max] of [
      ["temperature", 0, 1],
      ["fontSize", 10, 24],
      ["executionTimeout", 0, 600000],
      ["compilationTimeout", 1000, 600000],
      ["maxToolCallsPerTurn", 1, 20],
      ["maxTokensResponse", 256, 32768],
      ["thresholdPercent", 10, 95],
      ["compactFloorPercent", 5, 90],
      ["keepRecentTokens", 0, 50000],
      ["chunkTokens", 1000, 64000],
      ["summarizerMaxTokens", 200, 8000],
      ["summaryBudgetTokens", 200, 64000],
      ["maxToolResultTokens", 256, 64000],
      ["maxTotalToolResultTokens", 256, 128000],
      ["sidebarWidth", 220, 360],
      ["editorRatio", 0.3, 0.75],
      ["terminalHeight", 120, 1200],
    ]) {
      if (
        next[key] < min ||
        next[key] > max ||
        (Object.hasOwn(CONTEXT_DEFAULTS, key) && !Number.isInteger(next[key]))
      )
        throw new AppError(
          `Ungültiger Wertebereich: ${key}`,
          400,
          "INVALID_REQUEST",
          { messageKey: "errors:settings.range", params: { name: key } },
        );
    }
    if (
      next.contextSettingsVersion !== CONTEXT_VERSION ||
      next.compactFloorPercent >= next.thresholdPercent ||
      next.maxTotalToolResultTokens < next.maxToolResultTokens ||
      !["auto", "full", "compact"].includes(next.summarizerPromptMode)
    )
      throw new AppError(
        "Ungültige Kontexteinstellungen: Ziel muss unter der Auslöseschwelle und das Gesamtlimit über dem Einzelresultat liegen.",
        400,
        "INVALID_REQUEST",
        { messageKey: "errors:settings.context" },
      );
    if (
      !Array.isArray(next.allowedLanguages) ||
      next.allowedLanguages.some((l) => !LANGUAGES.includes(l))
    )
      throw new AppError("Ungültige Sprachauswahl.", 400, "INVALID_REQUEST", {
        messageKey: "errors:settings.languages",
      });
    let url;
    try {
      url = new URL(next.lmStudioUrl);
    } catch {
      throw new AppError("Ungültige LM-Studio-URL.", 400, "INVALID_REQUEST", {
        messageKey: "errors:settings.lmUrl",
      });
    }
    if (
      !["http:", "https:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      throw new AppError("Ungültige LM-Studio-URL.", 400, "INVALID_REQUEST", {
        messageKey: "errors:settings.lmUrl",
      });
    next.lmStudioUrl = url.href.replace(/\/$/, "");
    const file = path.join(DATA_DIR, "settings.json");
    const original = await readJSON(file);
    if (original.systemPrompt !== current.systemPrompt)
      await writeJSON(
        path.join(DATA_DIR, "backups", `settings-${randomUUID()}.json`),
        original,
      );
    // Opt-in changes commit between profile writes, so no in-flight profile
    // mutation can finish after a successful disable response.
    if (
      Object.hasOwn(updates, "crossChatProfileEnabled") ||
      Object.hasOwn(updates, "autoUpdateProfileOnTaskDone")
    )
      await serial("profile", () => writeJSON(file, next));
    else await writeJSON(file, next);
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
  await assertSessionWritable(id);
  const { loadSession } = await import("./sessions.js");
  await loadSession(id);
  const parent = WORKSPACE_DIR,
    root = path.join(parent, id);
  for (const directory of [parent, root])
    if ((await fs.lstat(directory)).isSymbolicLink())
      throw new AppError(
        "Workspace-Verknüpfungen sind nicht erlaubt.",
        403,
        "PATH_DENIED",
        { messageKey: "errors:workspace.links" },
      );
  return root;
}

export async function assertSessionWritable(id) {
  validateSessionId(id);
  try {
    await fs.access(path.join(DATA_DIR, "deletions", `${id}.json`));
  } catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  throw new AppError(
    "Session wird gelöscht. Bei unterbrochener Verbindung das Löschen erneut ausführen.",
    409,
    "SESSION_DELETING",
    { messageKey: "errors:session.deleting" },
  );
}
