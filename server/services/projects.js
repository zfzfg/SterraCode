import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  AppError,
  DATA_DIR,
  LANGUAGES,
  serial,
  validateSessionId,
  readJSON,
  writeJSON,
} from "./storage.js";
import { loadSession, createSession } from "./sessions.js";
import { normalizePath, listWorkspace, readFile } from "./workspace.js";
import { taskAssessment } from "./testRunner.js";
import { PROJECT_TEMPLATES } from "./projectTemplates.js";
import { requireSpace } from "./safeFiles.js";

export const PACKAGE_LIMITS = {
  files: 50,
  bytes: 2 * 1024 * 1024,
  jsonBytes: 3 * 1024 * 1024,
};
const hash = (v) => createHash("sha256").update(v).digest("hex");
// Export is deliberately limited to source/document files. Hidden directories,
// environment files, credential stores and generated/private app data stay out.
export function exportablePath(input) {
  const p = normalizePath(input);
  return (
    !p
      .split("/")
      .some(
        (part) =>
          part.startsWith(".") ||
          /^(node_modules|vendor|dist|build|data|backups?|profiles?|credentials?|secrets?|auth|sessions|test-runs|traces)$/i.test(
            part,
          ) ||
          /^(credentials?|secrets?|auth|tokens?|passwords?)([.-]|$)/i.test(
            part,
          ),
      ) &&
    /\.(py|js|mjs|cjs|html|css|svg|md|txt|json|sh|go|rs|cpp|h|cs|lua|java)$/i.test(
      p,
    )
  );
}
function cleanTask(t, language) {
  if (t == null) return null;
  if (
    typeof t !== "object" ||
    typeof t.title !== "string" ||
    !t.title.trim() ||
    t.title.length > 200 ||
    typeof t.description !== "string" ||
    t.description.length > 20000 ||
    !Array.isArray(t.hints || []) ||
    (t.hints || []).length > 20 ||
    (t.hints || []).some((h) => typeof h !== "string" || h.length > 2000)
  )
    throw new AppError("Ungültige Projektaufgabe.");
  return {
    title: t.title,
    description: t.description,
    difficulty: ["easy", "medium", "hard"].includes(t.difficulty)
      ? t.difficulty
      : "easy",
    hints: t.hints || [],
    ...taskAssessment(
      { conceptIds: t.conceptIds || [], testSuite: t.testSuite },
      language,
    ),
  };
}
function checklist(items = []) {
  if (
    !Array.isArray(items) ||
    items.length > 30 ||
    items.some((v) => typeof v !== "string" || v.length > 500)
  )
    throw new AppError("Ungültige Projektprüfliste.");
  return items;
}
export function validateProjectPackage(input) {
  if (
    !input ||
    input.format !== "sterracode-project" ||
    input.schemaVersion !== 1 ||
    Buffer.byteLength(JSON.stringify(input)) > PACKAGE_LIMITS.jsonBytes ||
    !LANGUAGES.includes(input.language) ||
    typeof input.title !== "string" ||
    !input.title.trim() ||
    input.title.length > 200 ||
    !Array.isArray(input.files) ||
    !input.files.length ||
    input.files.length > PACKAGE_LIMITS.files
  )
    throw new AppError(
      "Ungültiges Projektpaket (Format 1, höchstens 50 Dateien / 3 MiB JSON).",
    );
  const seen = new Set();
  let bytes = 0;
  const files = input.files.map((f) => {
    if (
      !f ||
      !exportablePath(f.path) ||
      typeof f.content !== "string" ||
      f.content.includes("\0")
    )
      throw new AppError(
        "Nur freigegebene Quelltextdateien ohne Links sind erlaubt.",
      );
    const p = normalizePath(f.path);
    if (
      p !== f.path ||
      seen.has(p.toLowerCase()) ||
      [...seen].some(
        (other) =>
          other.startsWith(p.toLowerCase() + "/") ||
          p.toLowerCase().startsWith(other + "/"),
      )
    )
      throw new AppError("Doppelte oder kollidierende Dateipfade im Paket.");
    seen.add(p.toLowerCase());
    const size = Buffer.byteLength(f.content);
    bytes += size;
    if (
      bytes > PACKAGE_LIMITS.bytes ||
      f.bytes !== size ||
      f.version !== hash(f.content) ||
      Object.keys(f).some(
        (k) => !["path", "content", "bytes", "version"].includes(k),
      )
    )
      throw new AppError(
        "Dateimanifest stimmt nicht oder überschreitet 2 MiB.",
      );
    return { path: p, content: f.content, bytes: size, version: f.version };
  });
  const task = cleanTask(input.task, input.language);
  if (
    input.activeFile !== undefined &&
    !files.some((f) => f.path === input.activeFile)
  )
    throw new AppError("Die aktive Datei fehlt im Paket.");
  if (
    task?.testSuite &&
    !files.some((f) => f.path === task.testSuite.entry.path)
  )
    throw new AppError("Der Testsuite-Einstieg fehlt im Paket.");
  return {
    format: input.format,
    schemaVersion: 1,
    title: input.title.trim(),
    language: input.language,
    files,
    activeFile:
      input.activeFile ||
      task?.testSuite?.entry.path ||
      (files.some((f) => f.path === "index.html")
        ? "index.html"
        : files[0].path),
    task,
    checklist: checklist(input.checklist),
    runtime:
      typeof input.runtime === "string"
        ? input.runtime.slice(0, 500)
        : input.language,
  };
}
export function listProjectTemplates() {
  return structuredClone(
    PROJECT_TEMPLATES.map(({ files, task, ...metadata }) => ({
      ...metadata,
      files: files.map((f) => f.path),
      hasTests: Boolean(task.testSuite),
    })),
  );
}

// Persist the chosen UUID before publication. A retry after publication returns
// that session; an interrupted unpublished import never creates a second one.
export async function importProject(body) {
  validateSessionId(body.operationId);
  if ((body.templateId !== undefined) === (body.package !== undefined))
    throw new AppError("Genau eine Vorlage oder ein Projektpaket angeben.");
  let source;
  let provenance;
  if (body.templateId !== undefined) {
    const template = PROJECT_TEMPLATES.find((t) => t.id === body.templateId);
    if (!template) throw new AppError("Projektvorlage nicht gefunden.", 404);
    provenance = {
      templateId: template.id,
      version: template.version,
      origin: template.origin,
      license: template.license,
    };
    source = {
      ...template,
      format: "sterracode-project",
      schemaVersion: 1,
      files: template.files.map((f) => ({
        ...f,
        bytes: Buffer.byteLength(f.content),
        version: hash(f.content),
      })),
    };
  } else source = body.package;
  const pkg = validateProjectPackage(source);
  const digest = hash(JSON.stringify([pkg, provenance || null]));
  return serial(`project-import:${body.operationId}`, async () => {
    const receiptPath = path.join(
      DATA_DIR,
      "project-imports",
      `${body.operationId}.json`,
    );
    let receipt;
    try {
      receipt = await readJSON(receiptPath);
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
    if (receipt) {
      if (receipt.digest !== digest)
        throw new AppError(
          "Diese Operation gehört zu einem anderen Paket.",
          409,
          "IDEMPOTENCY_CONFLICT",
        );
      try {
        return await loadSession(receipt.sessionId);
      } catch (e) {
        if (e.status !== 404) throw e;
        throw new AppError(
          "Der Import wurde unterbrochen oder die Session gelöscht. Bitte einen neuen Import starten.",
          409,
          "IMPORT_INTERRUPTED",
        );
      }
    }
    await requireSpace(DATA_DIR, Buffer.byteLength(JSON.stringify(pkg)) * 2);
    receipt = { sessionId: randomUUID(), digest };
    await writeJSON(receiptPath, receipt);
    const task = pkg.task
      ? {
          ...pkg.task,
          id: randomUUID(),
          done: false,
          createdAt: new Date().toISOString(),
        }
      : null;
    return createSession(pkg, {
      id: receipt.sessionId,
      files: pkg.files,
      activeFile: pkg.activeFile,
      task,
      project: {
        schemaVersion: 1,
        ...(provenance || { origin: "import" }),
        runtime: pkg.runtime,
        checklist: pkg.checklist,
      },
    });
  });
}

export async function exportProject(sessionId, body) {
  return serial(`workspace:${validateSessionId(sessionId)}`, async () => {
    const session = await loadSession(sessionId);
    if (
      !Array.isArray(body.paths) ||
      !body.paths.length ||
      body.paths.length > PACKAGE_LIMITS.files ||
      new Set(body.paths).size !== body.paths.length ||
      body.paths.some((p) => !exportablePath(p))
    )
      throw new AppError(
        "Bitte 1–50 freigegebene Quelldateien ausdrücklich auswählen.",
      );
    const files = [];
    let bytes = 0;
    for (const p of body.paths) {
      const f = await readFile(sessionId, p);
      if (!body.expectedVersions || body.expectedVersions[p] !== f.version)
        throw new AppError(
          "Eine Quelldatei wurde verändert. Bitte neu laden.",
          409,
          "CONFLICT",
        );
      bytes += Buffer.byteLength(f.content);
      if (bytes > PACKAGE_LIMITS.bytes)
        throw new AppError("Das Paket überschreitet 2 MiB Quelltext.", 413);
      files.push({ ...f, bytes: Buffer.byteLength(f.content) });
    }
    if (
      body.taskVersion !==
      (session.currentTask?.taskVersion || (session.currentTask ? 1 : null))
    )
      throw new AppError(
        "Die Aufgabe wurde verändert. Bitte neu laden.",
        409,
        "CONFLICT",
      );
    // Recheck against changes made by external processes, outside app locks.
    for (const f of files)
      if ((await readFile(sessionId, f.path)).version !== f.version)
        throw new AppError(
          "Quelldatei während des Exports verändert.",
          409,
          "CONFLICT",
        );
    return {
      ...validateProjectPackage({
        format: "sterracode-project",
        schemaVersion: 1,
        title: session.title,
        language: session.language,
        files,
        ...(files.some((f) => f.path === session.activeFile)
          ? { activeFile: session.activeFile }
          : {}),
        task: session.currentTask,
        checklist: session.project?.checklist || [],
        runtime: session.project?.runtime || session.language,
      }),
      exportedAt: new Date().toISOString(),
      limitations:
        "Quelltext und sichtbare Aufgabe; keine Ausführungsumgebung oder vollständige App-Sicherung. Keine atomare Aufnahme gegenüber externen Programmen.",
    };
  });
}
export async function projectFiles(sessionId) {
  const files = [];
  const walk = (tree) => {
    for (const f of tree) {
      if (f.children) walk(f.children);
      else if (exportablePath(f.path)) files.push(f.path);
    }
  };
  walk(await listWorkspace(sessionId));
  return files;
}
