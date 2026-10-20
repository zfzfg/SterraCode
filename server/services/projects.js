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
import { materializeProjectTemplates } from "./projectTemplates.js";
import { requireSpace } from "./safeFiles.js";
import { contentMetadata, validateContentLocale } from "./contentLocale.js";

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
    throw new AppError("Ungültige Projektaufgabe.", 400, "INVALID_REQUEST", {
      messageKey: "learningContent:errors.projectTask",
      params: {},
    });
  return {
    ...contentMetadata(t),
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
    throw new AppError("Ungültige Projektprüfliste.", 400, "INVALID_REQUEST", {
      messageKey: "learningContent:errors.projectChecklist",
      params: {},
    });
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
      400,
      "INVALID_REQUEST",
      { messageKey: "learningContent:errors.projectPackage", params: {} },
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
        400,
        "INVALID_REQUEST",
        { messageKey: "learningContent:errors.projectFileType", params: {} },
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
      throw new AppError(
        "Doppelte oder kollidierende Dateipfade im Paket.",
        400,
        "INVALID_REQUEST",
        { messageKey: "learningContent:errors.projectPaths", params: {} },
      );
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
        400,
        "INVALID_REQUEST",
        { messageKey: "learningContent:errors.projectManifest", params: {} },
      );
    return { path: p, content: f.content, bytes: size, version: f.version };
  });
  const task = cleanTask(input.task, input.language);
  if (
    input.activeFile !== undefined &&
    !files.some((f) => f.path === input.activeFile)
  )
    throw new AppError(
      "Die aktive Datei fehlt im Paket.",
      400,
      "INVALID_REQUEST",
      { messageKey: "learningContent:errors.projectActiveFile", params: {} },
    );
  if (
    task?.testSuite &&
    !files.some((f) => f.path === task.testSuite.entry.path)
  )
    throw new AppError(
      "Der Testsuite-Einstieg fehlt im Paket.",
      400,
      "INVALID_REQUEST",
      { messageKey: "learningContent:errors.projectTestEntry", params: {} },
    );
  return {
    format: input.format,
    schemaVersion: 1,
    ...contentMetadata(input),
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
export function listProjectTemplates(locale = "de") {
  return structuredClone(
    materializeProjectTemplates(locale).map(({ files, task, ...metadata }) => ({
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
    throw new AppError(
      "Genau eine Vorlage oder ein Projektpaket angeben.",
      400,
      "INVALID_REQUEST",
      { messageKey: "learningContent:errors.projectSource", params: {} },
    );
  let source;
  let provenance;
  if (body.templateId !== undefined) {
    const contentLocale = validateContentLocale(body.contentLocale);
    const template = materializeProjectTemplates(contentLocale).find(
      (t) => t.id === body.templateId,
    );
    if (!template)
      throw new AppError(
        "Projektvorlage nicht gefunden.",
        404,
        "INVALID_REQUEST",
        { messageKey: "learningContent:errors.projectTemplate", params: {} },
      );
    provenance = {
      templateId: template.id,
      version: template.version,
      origin: template.origin,
      license: template.license,
      ...contentMetadata(template),
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
  const tutorLocale = validateContentLocale(
    body.tutorLocale,
    pkg.contentLocale || "de",
  );
  const digest = hash(JSON.stringify([pkg, provenance || null]));
  // Receipts from the pre-locale application describe the exact same German
  // files and task. Recognise that representation without accepting another
  // materialised language under its operation ID.
  let legacyDigest;
  if (body.templateId !== undefined && pkg.contentLocale === "de") {
    const { contentLocale, contentProvenance, ...legacyPackage } = pkg;
    const {
      contentLocale: ignoredLocale,
      contentProvenance: ignoredProvenance,
      ...legacyProvenance
    } = provenance;
    if (legacyPackage.task) {
      const {
        contentLocale: taskLocale,
        contentProvenance: taskProvenance,
        ...legacyTask
      } = legacyPackage.task;
      legacyPackage.task = legacyTask;
    }
    legacyDigest = hash(JSON.stringify([legacyPackage, legacyProvenance]));
  }
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
      if (receipt.digest !== digest && receipt.digest !== legacyDigest)
        throw new AppError(
          "Diese Operation gehört zu einem anderen Paket.",
          409,
          "IDEMPOTENCY_CONFLICT",
          { messageKey: "learningContent:errors.projectOperation", params: {} },
        );
      try {
        return await loadSession(receipt.sessionId);
      } catch (e) {
        if (e.status !== 404) throw e;
        throw new AppError(
          "Der Import wurde unterbrochen oder die Session gelöscht. Bitte einen neuen Import starten.",
          409,
          "IMPORT_INTERRUPTED",
          {
            messageKey: "learningContent:errors.projectInterrupted",
            params: {},
          },
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
    return createSession(
      { ...pkg, tutorLocale },
      {
        id: receipt.sessionId,
        files: pkg.files,
        activeFile: pkg.activeFile,
        task,
        project: {
          schemaVersion: 1,
          ...contentMetadata(pkg),
          ...(provenance || { origin: "import" }),
          runtime: pkg.runtime,
          checklist: pkg.checklist,
        },
      },
    );
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
        400,
        "INVALID_REQUEST",
        { messageKey: "learningContent:errors.projectSelection", params: {} },
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
          {
            messageKey: "learningContent:errors.projectFileChanged",
            params: {},
          },
        );
      bytes += Buffer.byteLength(f.content);
      if (bytes > PACKAGE_LIMITS.bytes)
        throw new AppError(
          "Das Paket überschreitet 2 MiB Quelltext.",
          413,
          "INVALID_REQUEST",
          { messageKey: "learningContent:errors.projectSize", params: {} },
        );
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
        { messageKey: "learningContent:errors.projectTaskChanged", params: {} },
      );
    // Recheck against changes made by external processes, outside app locks.
    for (const f of files)
      if ((await readFile(sessionId, f.path)).version !== f.version)
        throw new AppError(
          "Quelldatei während des Exports verändert.",
          409,
          "CONFLICT",
          {
            messageKey: "learningContent:errors.projectExportChanged",
            params: {},
          },
        );
    return {
      ...validateProjectPackage({
        format: "sterracode-project",
        schemaVersion: 1,
        title: session.title,
        language: session.language,
        ...contentMetadata(session.project || {}),
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
      limitationsKey: "learningContent:projectExportLimitations",
      limitationsParams: {},
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
