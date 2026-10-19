import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import {
  copySafe,
  removeSafe,
  treeBytesSafe,
  requireSpace,
} from "./safeFiles.js";
import { CONTEXT_VERSION } from "./context/settings.js";
import {
  DATA_DIR,
  WORKSPACE_DIR,
  assertSessionWritable,
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
export { copySafe } from "./safeFiles.js";
async function migrate(session) {
  if (session.schemaVersion === 2) return session;
  const originalDigest = createHash("sha256")
    .update(JSON.stringify(session))
    .digest("hex");
  const root = path.join(WORKSPACE_DIR, session.id);
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
  const legacy = path.join(WORKSPACE_DIR, name);
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
      // Pending deletion owns the persisted snapshot. GET must not perform a
      // lazy migration after its backup was committed or its workspace removed.
      if (
        await fs.access(path.join(DATA_DIR, "deletions", `${id}.json`)).then(
          () => true,
          (error) => {
            if (error.code === "ENOENT") return false;
            throw error;
          },
        )
      )
        return session;
      const current = await migrate(session);
      if (current.contextVersion !== CONTEXT_VERSION) {
        await writeJSON(
          path.join(
            DATA_DIR,
            "backups",
            `context-session-${id}-${randomUUID()}.json`,
          ),
          current,
        );
        current.contextVersion = CONTEXT_VERSION;
        current.contextUsage = null;
        current.revision++;
        await writeJSON(sessionFile(id), current);
      }
      return current;
    } catch (error) {
      if (error.code === "ENOENT")
        throw new AppError("Session nicht gefunden.", 404, "NOT_FOUND");
      throw error;
    }
  });
}
export async function mutateSession(id, change, expectedRevision) {
  await assertSessionWritable(id);
  await loadSession(id);
  return serial(`session:${id}`, async () => {
    await assertSessionWritable(id);
    const session = await readJSON(sessionFile(id));
    if (expectedRevision !== undefined && expectedRevision !== session.revision)
      throw new AppError(
        "Die Session wurde inzwischen verändert. Bitte neu laden.",
        409,
        "CONFLICT",
      );
    const contextKey = (s) =>
      JSON.stringify([
        s.language,
        s.activeFile,
        s.learningPlan,
        s.currentTask,
        s.messages.filter(
          (m) =>
            !["context_usage", "context_compaction"].includes(m.event?.type),
        ),
      ]);
    const previousContext = contextKey(session),
      previousUsage = session.contextUsage;
    await change(session);
    if (
      session.contextUsage === previousUsage &&
      previousContext !== contextKey(session)
    )
      session.contextUsage = null;
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
    contextVersion: CONTEXT_VERSION,
    contextUsage: null,
    turns: {},
    currentTask: null,
    learningPlan: null,
    onboardingAsked: true,
  };
  await fs.mkdir(path.join(WORKSPACE_DIR, id), {
    recursive: true,
    mode: 0o2770,
  });
  if (process.platform !== "win32")
    await fs.chmod(path.join(WORKSPACE_DIR, id), 0o2770);
  await fs.writeFile(path.join(WORKSPACE_DIR, id, file), "", { mode: 0o660 });
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
      deleting: await fs
        .access(path.join(DATA_DIR, "deletions", `${s.id}.json`))
        .then(
          () => true,
          () => false,
        ),
    });
  }
  return result.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
export async function removeSession(id) {
  const session = await loadSession(id);
  await serial(`session:${id}`, async () => {
    const marker = path.join(DATA_DIR, "deletions", `${id}.json`);
    let deletion;
    try {
      deletion = await readJSON(marker);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      deletion = { sessionId: id };
    }
    const contextRoot = path.resolve(DATA_DIR, "context");
    const contextDir = path.join(contextRoot, validateSessionId(id));
    if ((await fs.lstat(contextRoot)).isSymbolicLink())
      throw new AppError(
        "Kontext-Verknüpfungen sind nicht erlaubt.",
        403,
        "PATH_DENIED",
      );
    if (deletion.phase !== "backed-up") {
      const backup = path.join(
        DATA_DIR,
        "backups",
        `deleted-${id}-${randomUUID()}`,
      );
      const source = path.join(WORKSPACE_DIR, id);
      await requireSpace(DATA_DIR, await treeBytesSafe(source));
      deletion = {
        ...deletion,
        phase: "backing-up",
        backup: path.basename(backup),
      };
      await writeJSON(marker, deletion);
      await fs.mkdir(backup, { recursive: true });
      await writeJSON(path.join(backup, "session.json"), session);
      await copySafe(source, path.join(backup, "workspace"));
      for (const [origin, target] of [
        [contextDir, "context"],
        [path.join(DATA_DIR, "changes", id), "changes"],
        [path.join(DATA_DIR, "traces", id), "traces"],
      ]) {
        try {
          await copySafe(origin, path.join(backup, target));
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      }
      deletion.phase = "backed-up";
      await writeJSON(marker, deletion);
    }
    try {
      await removeSafe(path.join(WORKSPACE_DIR, id));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    await fs.rm(path.join(DATA_DIR, "changes", id), {
      recursive: true,
      force: true,
    });
    await fs.rm(contextDir, { recursive: true, force: true });
    await fs.rm(path.join(DATA_DIR, "traces", id), {
      recursive: true,
      force: true,
    });
    await fs.unlink(sessionFile(id));
    await fs.rm(marker, { force: true });
  });
}
