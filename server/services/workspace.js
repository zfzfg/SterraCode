import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  AppError,
  DATA_DIR,
  getWorkspacePath,
  readJSON,
  writeJSON,
  serial,
  validateSessionId,
  assertSessionWritable,
} from "./storage.js";
import { loadSession, mutateSession } from "./sessions.js";
import {
  withSafeEntry,
  withSafeDirectory,
  readFlags,
  copySafe,
  removeSafe,
  treeBytesSafe,
  requireSpace,
} from "./safeFiles.js";

const hash = (content) => createHash("sha256").update(content).digest("hex");
function markWorkspaceChanged(session) {
  if (!session.codebase) return;
  session.codebase.workspaceGeneration =
    (session.codebase.workspaceGeneration || 0) + 1;
  if (session.codebase.analysis?.analysisId)
    session.codebase.analysis.freshness = "stale";
}
export function normalizePath(input) {
  if (
    typeof input !== "string" ||
    !input ||
    input.length > 1000 ||
    /[\x00-\x1f:*?"<>|]/.test(input) ||
    path.win32.isAbsolute(input) ||
    path.posix.isAbsolute(input)
  )
    throw new AppError(
      "Ungültiger relativer Dateipfad.",
      undefined,
      undefined,
      { messageKey: "serverFeature:workspace.invalidRelativePath", params: {} },
    );
  const parts = input.replace(/\\/g, "/").split("/");
  if (
    parts.some(
      (p) =>
        !p ||
        p === "." ||
        p === ".." ||
        /[. ]$/.test(p) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p),
    )
  )
    throw new AppError(
      "Ungültiger Dateiname oder Pfad.",
      undefined,
      undefined,
      { messageKey: "serverFeature:workspace.invalidPath", params: {} },
    );
  return parts.join("/");
}
export async function resolvePath(root, input) {
  const relative = normalizePath(input);
  // Check each existing component, including the workspace itself, against junctions/symlinks.
  let current = root;
  for (const part of ["", ...relative.split("/")]) {
    current = path.join(current, part);
    try {
      if ((await fs.lstat(current)).isSymbolicLink())
        throw new AppError(
          "Verzeichnisverknüpfungen sind im Workspace nicht erlaubt.",
          403,
          "PATH_DENIED",
          { messageKey: "serverFeature:files.directoryLinks", params: {} },
        );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return { relative, full: path.join(root, ...relative.split("/")) };
}
async function existing(full) {
  let handle;
  try {
    handle = await fs.open(full, readFlags);
    const stat = await handle.stat();
    if (!stat.isFile())
      throw new AppError("Der Pfad ist keine Datei.", undefined, undefined, {
        messageKey: "serverFeature:workspace.notAFile",
        params: {},
      });
    if (stat.size > 2 * 1024 * 1024)
      throw new AppError("Die Datei ist größer als 2 MiB.", 413, undefined, {
        messageKey: "serverFeature:workspace.fileTooLarge",
        params: {},
      });
    const limit = 2 * 1024 * 1024;
    const buffer = Buffer.alloc(Math.min(stat.size + 1, limit + 1));
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        length,
        buffer.length - length,
        length,
      );
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length > stat.size)
      throw new AppError(
        "Die Datei wurde während des Lesens verändert. Bitte erneut laden.",
        409,
        "CONFLICT",
        {
          messageKey: "serverFeature:workspace.changedWhileReading",
          params: {},
        },
      );
    const bytes = buffer.subarray(0, length);
    let content;
    try {
      content = new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(bytes);
      if (content.includes("\0")) throw new Error("binary");
    } catch {
      throw new AppError(
        "Nur UTF-8-Textdateien können im Editor bearbeitet werden.",
        415,
        "TEXT_REQUIRED",
        { messageKey: "serverFeature:workspace.utf8Required", params: {} },
      );
    }
    return { exists: true, content, version: hash(content) };
  } catch (error) {
    if (error.code === "ENOENT")
      return { exists: false, content: null, version: null };
    if (error.code === "ELOOP")
      throw new AppError("Verknüpfung nicht erlaubt.", 403, "PATH_DENIED", {
        messageKey: "serverFeature:workspace.linkDenied",
        params: {},
      });
    throw error;
  } finally {
    await handle?.close();
  }
}
export async function readFile(sessionId, input, { startLine, endLine } = {}) {
  const ranged = startLine !== undefined || endLine !== undefined;
  if (
    ranged &&
    ((startLine !== undefined &&
      (!Number.isSafeInteger(startLine) || startLine < 1)) ||
      (endLine !== undefined &&
        (!Number.isSafeInteger(endLine) || endLine < 1)) ||
      (endLine !== undefined && endLine < (startLine ?? 1)))
  )
    throw new AppError("Ungültiger Zeilenbereich.", undefined, undefined, {
      messageKey: "serverFeature:workspace.invalidLineRange",
      params: {},
    });
  const root = await getWorkspacePath(sessionId);
  const relative = normalizePath(input);
  const file = await withSafeEntry(root, relative, existing);
  if (!file.exists)
    throw new AppError("Datei nicht gefunden.", 404, "NOT_FOUND", {
      messageKey: "serverFeature:workspace.notFound",
      params: {},
    });
  if (!ranged)
    return { path: relative, content: file.content, version: file.version };
  const lines = file.content.match(/[^\n]*\n|[^\n]+$/g) || [""];
  const start = startLine ?? 1,
    end = Math.min(endLine ?? lines.length, lines.length);
  if (start > lines.length)
    throw new AppError(
      "Der Zeilenbereich liegt hinter der Datei.",
      undefined,
      undefined,
      { messageKey: "serverFeature:workspace.rangeAfterEnd", params: {} },
    );
  return {
    path: relative,
    content: lines.slice(start - 1, end).join(""),
    version: file.version,
    totalLines: lines.length,
    startLine: start,
    endLine: end,
  };
}
async function atomicText(full, content) {
  await fs.mkdir(path.dirname(full), { recursive: true });
  const temp = `${full}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, content, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o660,
    });
    await fs.rename(temp, full);
  } finally {
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}
export async function writeFile(
  sessionId,
  input,
  content,
  expectedVersion,
  options = {},
) {
  await getWorkspacePath(sessionId);
  return serial(`workspace:${sessionId}`, () =>
    writeFileUnlocked(sessionId, input, content, expectedVersion, options),
  );
}
// Internal commit path; caller must hold the workspace lock exactly once.
export async function writeFileUnlocked(
  sessionId,
  input,
  content,
  expectedVersion,
  options = {},
) {
  if (
    typeof content !== "string" ||
    Buffer.byteLength(content) > 2 * 1024 * 1024
  )
    throw new AppError(
      "Ungültiger oder zu großer Dateiinhalt.",
      413,
      undefined,
      { messageKey: "serverFeature:workspace.invalidContent", params: {} },
    );
  const {
    actor = "user",
    reason = "",
    turnId = null,
    proposalId = null,
    changeId = randomUUID(),
  } = options;
  const root = await getWorkspacePath(sessionId);
  await assertSessionWritable(sessionId);
  const relative = normalizePath(input);
  return withSafeEntry(
    root,
    relative,
    async (full) => {
      const before = await existing(full);
      if (expectedVersion === undefined || expectedVersion !== before.version)
        throw new AppError(
          "Datei inzwischen verändert. Bitte vergleichen oder neu laden; deine Änderungen bleiben im Editor.",
          409,
          "CONFLICT",
          { messageKey: "serverFeature:workspace.versionConflict", params: {} },
        );
      const version = hash(content);
      let change = null;
      if (actor === "ai") {
        change = {
          id: changeId,
          schemaVersion: 2,
          origin: "ai",
          acceptedBy: proposalId ? "user" : "direct",
          proposalId,
          originalPath: relative,
          after: { exists: true, content, version },
          sessionId,
          path: relative,
          before,
          afterVersion: version,
          reason,
          turnId,
          status: "pending",
          createdAt: new Date().toISOString(),
        };
        await writeJSON(
          path.join(DATA_DIR, "changes", sessionId, `${change.id}.json`),
          change,
        );
      }
      await atomicText(full, content);
      if ((await loadSession(sessionId)).mode === "codebase")
        await mutateSession(sessionId, markWorkspaceChanged);
      if (change) {
        change.status = "applied";
        await writeJSON(
          path.join(DATA_DIR, "changes", sessionId, `${change.id}.json`),
          change,
        );
      }
      return {
        type: "write_file",
        path: relative,
        content,
        version,
        changeId: change?.id,
        reason,
        status: "applied",
      };
    },
    { parents: true },
  );
}
export async function undoChange(sessionId, changeId) {
  validateSessionId(changeId);
  const root = await getWorkspacePath(sessionId);
  return serial(`workspace:${sessionId}`, async () => {
    await assertSessionWritable(sessionId);
    const record = path.join(
      DATA_DIR,
      "changes",
      sessionId,
      `${changeId}.json`,
    );
    let change;
    try {
      change = await readJSON(record);
    } catch (error) {
      if (error.code === "ENOENT")
        throw new AppError("Änderung nicht gefunden.", 404, undefined, {
          messageKey: "serverFeature:workspace.changeNotFound",
          params: {},
        });
      throw error;
    }
    if (change.status === "undone")
      return { ok: true, path: change.path, alreadyUndone: true };
    return withSafeEntry(root, normalizePath(change.path), async (full) => {
      const current = await existing(full);
      if (current.version !== change.afterVersion)
        throw new AppError(
          "Diese Datei wurde danach verändert. Rückgängig würde neuere Änderungen überschreiben.",
          409,
          "CONFLICT",
          { messageKey: "serverFeature:workspace.undoConflict", params: {} },
        );
      if (change.before.exists) await atomicText(full, change.before.content);
      else await fs.unlink(full);
      change.status = "undone";
      await writeJSON(record, change);
      await mutateSession(sessionId, (s) => {
        markWorkspaceChanged(s);
        for (const m of s.messages) {
          if (m.event?.changeId === changeId) m.event.undone = true;
          if (m.role === "tool") {
            try {
              const v = JSON.parse(m.content);
              if (v.changeId === changeId) {
                v.undone = true;
                m.content = JSON.stringify(v);
              }
            } catch {}
          }
        }
      });
      return {
        ok: true,
        path: change.path,
        exists: change.before.exists,
        version: change.before.version,
      };
    });
  });
}
export async function getChange(sessionId, changeId) {
  validateSessionId(changeId);
  await getWorkspacePath(sessionId);
  const record = await readJSON(
    path.join(DATA_DIR, "changes", sessionId, `${changeId}.json`),
  );
  let after = record.after;
  if (!after) {
    try {
      const current = await readFile(sessionId, record.path);
      if (current.version === record.afterVersion) after = current;
    } catch (error) {
      if (error.code !== "ENOENT" && ![404, 413, 415].includes(error.status))
        throw error;
    }
  }
  return {
    ...record,
    after,
    diffAvailable: Boolean(after),
    historicalPath: record.originalPath || record.path,
  };
}
export async function listChanges(sessionId) {
  await getWorkspacePath(sessionId);
  const dir = path.join(DATA_DIR, "changes", sessionId);
  let names;
  try {
    names = await fs.readdir(dir);
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const changes = [];
  for (const name of names.filter((n) => n.endsWith(".json"))) {
    const record = await readJSON(path.join(dir, name));
    changes.push({
      changeId: record.id,
      path: record.path,
      reason: record.reason,
      status: record.status,
      createdAt: record.createdAt,
    });
  }
  return changes.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
export async function listWorkspace(sessionId) {
  const root = await getWorkspacePath(sessionId);
  let count = 0;
  async function walk(dir, prefix = "", depth = 0) {
    if (depth > 32)
      throw new AppError(
        "Die Verzeichnisstruktur ist zu tief.",
        undefined,
        undefined,
        { messageKey: "serverFeature:workspace.directoryTooDeep", params: {} },
      );
    const items = [];
    return withSafeDirectory(dir, async (pinned) => {
      for (const entry of await fs.readdir(pinned, { withFileTypes: true })) {
        if (++count > 5000)
          throw new AppError(
            "Der Workspace enthält mehr als 5000 Einträge.",
            undefined,
            undefined,
            {
              messageKey: "serverFeature:workspace.tooManyEntries",
              params: {},
            },
          );
        if (entry.isSymbolicLink()) continue;
        const relative = prefix + entry.name;
        if (entry.isDirectory())
          items.push({
            name: entry.name,
            path: relative,
            type: "folder",
            children: await walk(
              path.join(pinned, entry.name),
              relative + "/",
              depth + 1,
            ),
          });
        else if (entry.isFile() && !entry.name.endsWith(".tmp"))
          items.push({ name: entry.name, path: relative, type: "file" });
      }
      return items.sort((a, b) =>
        a.type === b.type
          ? a.name.localeCompare(b.name)
          : a.type === "folder"
            ? -1
            : 1,
      );
    });
  }
  return walk(root);
}
export async function createFolder(sessionId, input) {
  const root = await getWorkspacePath(sessionId);
  return serial(`workspace:${sessionId}`, async () => {
    await assertSessionWritable(sessionId);
    return withSafeEntry(root, normalizePath(input), async (full) => {
      try {
        await fs.mkdir(full, { recursive: false });
      } catch (e) {
        if (e.code === "EEXIST")
          throw new AppError("Dieser Name existiert bereits.", 409, undefined, {
            messageKey: "serverFeature:workspace.nameExists",
            params: {},
          });
        throw e;
      }
      if ((await loadSession(sessionId)).mode === "codebase")
        await mutateSession(sessionId, markWorkspaceChanged);
      return { ok: true };
    });
  });
}
export async function renamePath(sessionId, oldPath, newPath) {
  const root = await getWorkspacePath(sessionId);
  return serial(`workspace:${sessionId}`, async () => {
    await assertSessionWritable(sessionId);
    const from = { relative: normalizePath(oldPath) },
      to = { relative: normalizePath(newPath) };
    return withSafeEntry(root, from.relative, async (source) =>
      withSafeEntry(root, to.relative, async (target) => {
        from.full = source;
        to.full = target;
        if (
          to.relative
            .toLowerCase()
            .startsWith(from.relative.toLowerCase() + "/")
        )
          throw new AppError(
            "Ein Ordner kann nicht in sich selbst verschoben werden.",
            undefined,
            undefined,
            { messageKey: "serverFeature:workspace.moveIntoSelf", params: {} },
          );
        if (from.relative === to.relative) return { ok: true };
        if (
          await fs.access(to.full).then(
            () => true,
            () => false,
          )
        )
          throw new AppError(
            "Der Zielname existiert bereits.",
            409,
            undefined,
            { messageKey: "serverFeature:workspace.targetExists", params: {} },
          );
        await fs.rename(from.full, to.full);
        const replace = (p) =>
          p === from.relative || p.startsWith(from.relative + "/")
            ? to.relative + p.slice(from.relative.length)
            : p;
        const changes = await listChanges(sessionId);
        for (const change of changes) {
          const next = replace(change.path);
          if (next !== change.path) {
            const file = path.join(
                DATA_DIR,
                "changes",
                sessionId,
                `${change.changeId}.json`,
              ),
              record = await readJSON(file);
            record.path = next;
            await writeJSON(file, record);
          }
        }
        await mutateSession(sessionId, (s) => {
          markWorkspaceChanged(s);
          for (const m of s.messages) {
            if (m.event?.changeId) m.event.path = replace(m.event.path);
            if (m.role === "tool") {
              try {
                const e = JSON.parse(m.content);
                if (e.changeId) {
                  e.path = replace(e.path);
                  m.content = JSON.stringify(e);
                }
              } catch {}
            }
          }
          s.activeFile = s.activeFile ? replace(s.activeFile) : null;
          s.openFiles = s.openFiles.map(replace);
        });
        return { ok: true };
      }),
    );
  });
}
export async function deletePath(sessionId, input) {
  const root = await getWorkspacePath(sessionId);
  return serial(`workspace:${sessionId}`, async () => {
    await assertSessionWritable(sessionId);
    const relative = normalizePath(input);
    return withSafeEntry(root, relative, async (full) => {
      // Persist a filesystem backup before deletion, including empty files and nested directories.
      const backup = path.join(
        DATA_DIR,
        "backups",
        `file-${sessionId}-${randomUUID()}`,
      );
      await fs.mkdir(backup, { recursive: true });
      await requireSpace(DATA_DIR, await treeBytesSafe(full));
      await copySafe(full, path.join(backup, path.basename(relative)));
      await removeSafe(full);
      await mutateSession(sessionId, (s) => {
        markWorkspaceChanged(s);
        const keep = (p) => p !== relative && !p.startsWith(relative + "/");
        s.openFiles = s.openFiles.filter(keep);
        if (s.activeFile && !keep(s.activeFile))
          s.activeFile = s.openFiles[0] || null;
      });
      return { ok: true };
    });
  });
}
