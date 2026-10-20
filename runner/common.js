import fs from "node:fs/promises";
import path from "node:path";
import { constants } from "node:fs";
import { randomUUID } from "node:crypto";

export class RunnerError extends Error {
  constructor(message, status = 400, code = "INVALID_REQUEST", metadata = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.messageKey = metadata.messageKey || metadata.key;
    this.params = metadata.params || {};
  }
}
export const UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
export function sessionId(value) {
  if (typeof value !== "string" || !UUID.test(value))
    throw new RunnerError("Ungültige Session-ID.", 400, "INVALID_REQUEST", {
      messageKey: "runner:session.invalid",
      params: {},
    });
  return value;
}
export function relativePath(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value.includes("\0") ||
    value.includes("\\") ||
    path.posix.isAbsolute(value) ||
    /^[A-Za-z]:/.test(value) ||
    value.split("/").some((p) => !p || p === "." || p === "..")
  )
    throw new RunnerError(
      "Ungültiger relativer Dateipfad.",
      400,
      "INVALID_PATH",
      { messageKey: "runner:path.invalid", params: {} },
    );
  return value;
}
export async function atomicJSON(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await fs.open(temp, "wx", 0o600);
    await handle.writeFile(JSON.stringify(value));
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temp, file);
    if (process.platform === "linux") {
      const dir = await fs.open(path.dirname(file), "r");
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    }
  } finally {
    await handle?.close();
    await fs.rm(temp, { force: true }).catch(() => {});
  }
}
export async function readJSON(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" && fallback !== undefined) return fallback;
    throw error;
  }
}
export async function freeSpace(root, required) {
  const stat = await fs.statfs(root);
  const available = Number(stat.bavail) * Number(stat.bsize);
  if (available < required)
    throw new RunnerError(
      "Zu wenig freier Speicher am Ziel. Speicher freigeben und erneut versuchen.",
      507,
      "INSUFFICIENT_STORAGE",
      { messageKey: "runner:storage.free", params: {} },
    );
  return available;
}

// Every component is opened relative to an already held directory descriptor.
// O_NOFOLLOW applies at each step, so a concurrent rename/symlink replacement
// cannot redirect privileged file reads outside the workspace.
export async function safeOpen(root, relative = "", directory = false) {
  if (relative) relativePath(relative);
  const resolved = path.resolve(root);
  const parts = [
    ...path
      .relative(path.parse(resolved).root, resolved)
      .split(path.sep)
      .filter(Boolean),
    ...relative.split("/").filter(Boolean),
  ];
  let handle = await fs.open(
    path.parse(path.resolve(root)).root,
    constants.O_RDONLY | constants.O_DIRECTORY,
  );
  try {
    for (let i = 0; i < parts.length; i++) {
      const final = i === parts.length - 1;
      const parent =
        process.platform === "linux"
          ? `/proc/self/fd/${handle.fd}`
          : path.join(
              path.parse(path.resolve(root)).root,
              ...parts.slice(0, i),
            );
      const next = await fs.open(
        path.join(parent, parts[i]),
        constants.O_RDONLY |
          (constants.O_NOFOLLOW || 0) |
          (final && !directory ? constants.O_NONBLOCK || 0 : 0) |
          (!final || directory ? constants.O_DIRECTORY || 0 : 0),
      );
      await handle.close();
      handle = next;
    }
    return handle;
  } catch (error) {
    await handle.close();
    throw new RunnerError(
      `Workspace-Zugriff abgewiesen: ${error.code || error.message}`,
      400,
      "INVALID_PATH",
      {
        messageKey: "runner:path.denied",
        params: { reason: error.code || error.message },
      },
    );
  }
}
export async function safeRead(root, relative) {
  const handle = await safeOpen(root, relative);
  try {
    const limit = 2 * 1024 * 1024,
      stat = await handle.stat();
    if (!stat.isFile())
      throw new RunnerError("Keine reguläre Datei.", 400, "INVALID_REQUEST", {
        messageKey: "runner:file.regular",
        params: {},
      });
    if (stat.size > limit)
      throw new RunnerError(
        "Quelldatei überschreitet 2 MiB.",
        413,
        "FILE_TOO_LARGE",
        { messageKey: "runner:file.large", params: {} },
      );
    const chunks = [];
    let bytes = 0;
    for (;;) {
      const data = Buffer.alloc(Math.min(65536, limit + 1 - bytes));
      const count = (await handle.read(data)).bytesRead;
      if (!count) break;
      bytes += count;
      if (bytes > limit)
        throw new RunnerError(
          "Quelldatei überschreitet 2 MiB.",
          413,
          "FILE_TOO_LARGE",
          { messageKey: "runner:file.large", params: {} },
        );
      chunks.push(data.subarray(0, count));
    }
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(
        Buffer.concat(chunks),
      );
    } catch {
      throw new RunnerError(
        "Quelldatei enthält kein gültiges UTF-8.",
        400,
        "INVALID_REQUEST",
        { messageKey: "runner:file.encoding", params: {} },
      );
    }
  } finally {
    await handle.close();
  }
}
export async function removeTree(root, relative) {
  relativePath(relative);
  const parts = relative.split("/");
  const parent = await safeOpen(root, parts.slice(0, -1).join("/"), true);
  const location =
    process.platform === "linux"
      ? `/proc/self/fd/${parent.fd}`
      : path.join(root, ...parts.slice(0, -1));
  const remove = async (directory, name, depth = 0) => {
    if (depth > 256)
      throw new RunnerError(
        "Temporärer Verzeichnisbaum ist zu tief.",
        503,
        "TEMP_CLEANUP_FAILED",
        { messageKey: "runner:storage.depth", params: {} },
      );
    const entry = path.join(directory, name);
    let stat;
    try {
      stat = await fs.lstat(entry);
    } catch (error) {
      if (error.code === "ENOENT") return;
      throw error;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      await fs.unlink(entry).catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
      return;
    }
    const handle = await fs.open(
      entry,
      constants.O_RDONLY |
        (constants.O_DIRECTORY || 0) |
        (constants.O_NOFOLLOW || 0),
    );
    try {
      const pinned =
        process.platform === "linux" ? `/proc/self/fd/${handle.fd}` : entry;
      for (const child of await fs.readdir(pinned))
        await remove(pinned, child, depth + 1);
    } finally {
      await handle.close();
    }
    await fs.rmdir(entry).catch((error) => {
      if (error.code !== "ENOENT") throw error;
    });
  };
  try {
    await remove(location, parts.at(-1));
  } finally {
    await parent.close();
  }
}

export async function sources(
  root,
  extension,
  relative = "",
  depth = 0,
  result = [],
) {
  if (depth > 20)
    throw new RunnerError(
      "Projektstruktur ist zu tief.",
      400,
      "INVALID_REQUEST",
      { messageKey: "runner:project.depth", params: {} },
    );
  const dir = await safeOpen(root, relative, true);
  try {
    const location =
      process.platform === "linux"
        ? `/proc/self/fd/${dir.fd}`
        : path.join(root, relative);
    for (const entry of await fs.readdir(location, { withFileTypes: true })) {
      if (
        entry.isSymbolicLink() ||
        ["node_modules", ".git", "bin", "obj", "target"].includes(entry.name)
      )
        continue;
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory())
        await sources(root, extension, name, depth + 1, result);
      else if (entry.isFile() && entry.name.endsWith(extension))
        result.push(name);
      if (result.length > 1000)
        throw new RunnerError(
          "Zu viele Quelldateien.",
          400,
          "INVALID_REQUEST",
          { messageKey: "runner:project.files", params: {} },
        );
    }
    return result;
  } finally {
    await dir.close();
  }
}
