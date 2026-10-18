import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import {
  DATA_DIR,
  LANGUAGES,
  AppError,
  readJSON,
  writeJSON,
  serial,
  validateSessionId,
  listFiles,
} from "./storage.js";

export const extension = {
  python: "py",
  javascript: "js",
  bash: "sh",
  go: "go",
  rust: "rs",
  cpp: "cpp",
  csharp: "cs",
  lua: "lua",
  java: "java",
};
export const entryFile = (language) =>
  language === "java" ? "Main.java" : `main.${extension[language] || "py"}`;
export const sessionFile = (id) =>
  path.join(DATA_DIR, "sessions", `${validateSessionId(id)}.json`);
export function message(role, content, extra = {}) {
  return {
    id: randomUUID(),
    role,
    content,
    createdAt: new Date().toISOString(),
    ...extra,
  };
}
export function validatePlan(plan) {
  if (
    !plan ||
    typeof plan.goal !== "string" ||
    plan.goal.length > 500 ||
    !Array.isArray(plan.topics) ||
    plan.topics.length > 200
  )
    throw new AppError("Ungültiger Lernplan.");
  const ids = new Set();
  for (const topic of plan.topics) {
    if (
      !topic ||
      typeof topic.id !== "string" ||
      ids.has(topic.id) ||
      typeof topic.title !== "string" ||
      typeof topic.done !== "boolean"
    )
      throw new AppError("Ungültiges Lernplanthema.");
    ids.add(topic.id);
  }
  return plan;
}
export function setLearningPlan(session, plan) {
  session.learningPlan = validatePlan(plan);
  if (!plan.topics.length || !plan.topics.every((t) => t.done)) return;
  const key = createHash("sha256")
    .update(
      JSON.stringify([plan.goal, plan.topics.map((t) => [t.id, t.title])]),
    )
    .digest("hex");
  session.completedPlanKeys ||= [];
  if (session.completedPlanKeys.includes(key)) return;
  session.completedPlanKeys.push(key);
  session.messages.push(
    message("event", "", {
      event: {
        type: "ask_question",
        questionId: randomUUID(),
        question:
          "Du hast alle Themen abgeschlossen. Möchtest du mit einem weiterführenden Lernplan fortfahren?",
        questionType: "multiple-choice",
        options: ["Ja, fortsetzen", "Für heute abschließen"],
      },
    }),
  );
}
async function copySafe(source, target) {
  const stat = await fs.lstat(source);
  if (stat.isSymbolicLink())
    throw new AppError(
      "Verzeichnisverknüpfung im alten Workspace. Bitte vor der Migration entfernen.",
      409,
    );
  if (stat.isDirectory()) {
    await fs.mkdir(target, { recursive: true });
    for (const name of await fs.readdir(source))
      await copySafe(path.join(source, name), path.join(target, name));
  } else if (stat.isFile())
    await fs.copyFile(source, target, fs.constants.COPYFILE_EXCL);
}
async function migrate(session) {
  if (session.schemaVersion === 2) return session;
  const originalDigest = createHash("sha256")
    .update(JSON.stringify(session))
    .digest("hex");
  const root = path.join(DATA_DIR, "workspaces", session.id);
  const marker = path.join(DATA_DIR, "migrations", `${session.id}.json`);
  let pending;
  try {
    pending = await readJSON(marker);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (pending) {
    if (
      pending.originalDigest !== originalDigest ||
      pending.session.id !== session.id
    )
      throw new AppError(
        "Die Session wurde während einer unterbrochenen Migration verändert. Sicherung bitte prüfen.",
        409,
      );
    if (
      !(await fs.access(root).then(
        () => true,
        () => false,
      ))
    ) {
      if (
        typeof pending.staging !== "string" ||
        !pending.staging.startsWith(root + ".migration-")
      )
        throw new AppError("Ungültiger Migrationsstand.", 409);
      await fs.rename(pending.staging, root);
    }
    await writeJSON(sessionFile(session.id), pending.session);
    await fs.rm(marker, { force: true });
    return pending.session;
  }
  const backup = path.join(
    DATA_DIR,
    "backups",
    `${session.id}-${randomUUID()}`,
  );
  await fs.mkdir(backup, { recursive: true });
  await writeJSON(path.join(backup, "session.json"), session);
  const name = String(session.title || "").replace(/[/\\?%*:|"<>]/g, "-");
  const legacy = path.join(DATA_DIR, "workspaces", name);
  const staging = `${root}.migration-${randomUUID()}`;
  await fs.mkdir(staging, { recursive: true });
  try {
    if (name && name !== "." && name !== ".." && name !== session.id) {
      try {
        await copySafe(legacy, path.join(backup, "workspace"));
        await copySafe(legacy, staging);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
    const preferred = entryFile(session.language);
    if (session.editorSnapshot) {
      let existing = null;
      try {
        existing = await fs.readFile(path.join(staging, preferred), "utf8");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      let recovered = preferred;
      if (existing !== null && existing !== session.editorSnapshot) {
        let counter = 1;
        do {
          recovered = `recovered-editor-${counter++}.${extension[session.language] || "txt"}`;
        } while (
          await fs.access(path.join(staging, recovered)).then(
            () => true,
            () => false,
          )
        );
      }
      if (existing !== session.editorSnapshot)
        await fs.writeFile(
          path.join(staging, recovered),
          session.editorSnapshot,
          "utf8",
        );
      session.activeFile = recovered;
    }
    if (!session.activeFile) {
      try {
        await fs.access(path.join(staging, preferred));
      } catch {
        await fs.writeFile(path.join(staging, preferred), "", "utf8");
      }
      session.activeFile = preferred;
    }
    try {
      await fs.access(root);
      throw new AppError(
        "Ein Workspace mit dieser ID existiert bereits. Migration zur Prüfung angehalten.",
        409,
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    session.schemaVersion = 2;
    session.revision = 0;
    session.openFiles = [session.activeFile];
    session.turns = {};
    session.messages = (session.messages || []).map((m) => ({
      ...m,
      id: m.id || randomUUID(),
      createdAt: m.createdAt || session.createdAt,
    }));
    session.onboardingAsked = true;
    await writeJSON(marker, { originalDigest, staging, session });
    await fs.rename(staging, root);
    await writeJSON(sessionFile(session.id), session);
    await fs.rm(marker, { force: true });
    return session;
  } finally {
    if (
      !(await fs.access(marker).then(
        () => true,
        () => false,
      ))
    )
      await fs.rm(staging, { recursive: true, force: true });
  }
}
export async function loadSession(id) {
  return serial(`session:${validateSessionId(id)}`, async () => {
    try {
      const session = await readJSON(sessionFile(id));
      if (session.id !== id)
        throw new AppError(
          "Session-ID und gespeicherte Daten passen nicht zusammen.",
          409,
        );
      return await migrate(session);
    } catch (error) {
      if (error.code === "ENOENT")
        throw new AppError("Session nicht gefunden.", 404, "NOT_FOUND");
      throw error;
    }
  });
}
export async function mutateSession(id, change, expectedRevision) {
  await loadSession(id);
  return serial(`session:${id}`, async () => {
    const session = await readJSON(sessionFile(id));
    if (expectedRevision !== undefined && expectedRevision !== session.revision)
      throw new AppError(
        "Die Session wurde inzwischen verändert. Bitte neu laden.",
        409,
        "CONFLICT",
      );
    await change(session);
    session.revision++;
    session.updatedAt = new Date().toISOString();
    await writeJSON(sessionFile(id), session);
    return session;
  });
}
export async function createSession({
  title = "Neue Session",
  language = "python",
} = {}) {
  if (
    typeof title !== "string" ||
    !title.trim() ||
    title.length > 200 ||
    !LANGUAGES.includes(language)
  )
    throw new AppError("Ungültiger Sessionname oder ungültige Sprache.");
  const id = randomUUID();
  const now = new Date().toISOString();
  const file = entryFile(language);
  const question = {
    type: "ask_question",
    questionId: randomUUID(),
    question: "Möchtest du einen Lernplan erstellen?",
    questionType: "multiple-choice",
    options: ["Ja, bitte", "Direkt anfangen"],
    onboarding: true,
  };
  const session = {
    id,
    title: title.trim(),
    language,
    schemaVersion: 2,
    revision: 0,
    createdAt: now,
    updatedAt: now,
    activeFile: file,
    openFiles: [file],
    messages: [message("event", "", { event: question })],
    summaries: [],
    turns: {},
    currentTask: null,
    learningPlan: null,
    onboardingAsked: true,
  };
  await fs.mkdir(path.join(DATA_DIR, "workspaces", id), { recursive: true });
  await fs.writeFile(path.join(DATA_DIR, "workspaces", id, file), "", "utf8");
  await writeJSON(sessionFile(id), session);
  return session;
}
export async function listSessions() {
  const result = [];
  for (const file of await listFiles(path.join(DATA_DIR, "sessions"))) {
    const s = await readJSON(file);
    result.push({
      id: s.id,
      title: s.title,
      language: s.language,
      updatedAt: s.updatedAt,
      createdAt: s.createdAt,
    });
  }
  return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
export async function removeSession(id) {
  const session = await loadSession(id);
  await serial(`session:${id}`, async () => {
    const backup = path.join(
      DATA_DIR,
      "backups",
      `deleted-${id}-${randomUUID()}`,
    );
    await fs.mkdir(backup, { recursive: true });
    await writeJSON(path.join(backup, "session.json"), session);
    await copySafe(
      path.join(DATA_DIR, "workspaces", id),
      path.join(backup, "workspace"),
    );
    await fs.unlink(sessionFile(id));
  });
}
