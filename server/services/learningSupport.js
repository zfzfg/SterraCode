import { randomUUID } from "node:crypto";
import { AppError } from "./storage.js";
import { loadSession, mutateSession } from "./sessions.js";

function currentTask(session, id, version) {
  const task = session.currentTask;
  if (!task || task.id !== id || (task.taskVersion || 1) !== version)
    throw new AppError(
      "Die Aufgabe wurde verändert. Bitte neu laden.",
      409,
      "CONFLICT",
    );
  return task;
}

export async function revealHint(sessionId, taskId, body) {
  return mutateSession(sessionId, (session) => {
    const task = currentTask(session, taskId, body.taskVersion);
    const count = task.hintUsage?.count || 0;
    if (
      !Number.isInteger(body.index) ||
      body.index < 1 ||
      body.index > (task.hints?.length || 0) ||
      body.index > count + 1
    )
      throw new AppError("Bitte den nächsten Hinweis einzeln öffnen.");
    if (body.index <= count) return;
    task.hintUsage = {
      count: body.index,
      lastRevealedAt: new Date().toISOString(),
    };
  });
}

export async function listJournal(sessionId) {
  return (await loadSession(sessionId)).learningJournal || [];
}

// One personal entry per exercise revision. Completion and entry are independent:
// a failed connection can retry the entry without completing the exercise twice.
export async function saveJournal(sessionId, taskId, body) {
  if (
    typeof body.text !== "string" ||
    body.text.length > 2000 ||
    !Number.isInteger(body.expectedVersion) ||
    body.expectedVersion < 0
  )
    throw new AppError(
      "Ein Journaleintrag benötigt höchstens 2.000 Zeichen und eine Version.",
    );
  return mutateSession(sessionId, (session) => {
    const entries = (session.learningJournal ||= []);
    const previous = entries.find(
      (e) => e.taskId === taskId && e.taskVersion === body.taskVersion,
    );
    const task = previous || currentTask(session, taskId, body.taskVersion);
    if ((previous?.version || 0) !== body.expectedVersion)
      throw new AppError(
        "Der Journaleintrag wurde inzwischen verändert. Bitte neu laden.",
        409,
        "CONFLICT",
      );
    if (!body.text.trim() && !previous) return;
    if (!previous && entries.length >= 200)
      throw new AppError(
        "Das Journal enthält bereits 200 Aufgabenstände. Bitte für weitere Einträge eine neue Session verwenden.",
        413,
      );
    const completion = session.taskCompletions?.[taskId];
    const testRunId =
      completion?.taskVersion === body.taskVersion
        ? completion.evidence?.testRunId
        : previous?.testRunId;
    const entry = {
      id: previous?.id || randomUUID(),
      taskId,
      taskVersion: body.taskVersion,
      title: previous?.title || task.title,
      text: body.text.trim(),
      origin: "personal",
      version: body.expectedVersion + 1,
      createdAt: previous?.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...(testRunId ? { testRunId } : {}),
    };
    if (previous) entries[entries.indexOf(previous)] = entry;
    else entries.push(entry);
  });
}
