import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { AppError } from "./storage.js";

const directoryFlags =
  constants.O_RDONLY |
  (constants.O_DIRECTORY || 0) |
  (constants.O_NOFOLLOW || 0);
export const readFlags =
  constants.O_RDONLY |
  (constants.O_NOFOLLOW || 0) |
  (constants.O_NONBLOCK || 0);
const denied = () =>
  new AppError(
    "Verzeichnisverknüpfungen sind im Workspace nicht erlaubt.",
    403,
    "PATH_DENIED",
    { messageKey: "serverFeature:files.directoryLinks", params: {} },
  );
function translate(error) {
  if (["ELOOP", "ENOTDIR"].includes(error.code)) throw denied();
  throw error;
}

// Linux openat equivalent: keep every parent descriptor open and address each
// next entry relative to that descriptor. A concurrent rename or symlink swap
// cannot redirect an already opened parent. Never use realpath-then-open here.
export async function withSafeEntry(
  root,
  relative,
  operation,
  { parents = false } = {},
) {
  const parts = relative.split("/");
  const handles = [];
  try {
    let parent = root;
    if (process.platform === "linux") {
      const handle = await fs.open(root, directoryFlags);
      handles.push(handle);
      parent = `/proc/self/fd/${handle.fd}`;
      for (const part of parts.slice(0, -1)) {
        const next = `${parent}/${part}`;
        if (parents)
          await fs.mkdir(next, { mode: 0o2770 }).catch((error) => {
            if (error.code !== "EEXIST") throw error;
          });
        const child = await fs.open(next, directoryFlags);
        handles.push(child);
        parent = `/proc/self/fd/${child.fd}`;
      }
    } else {
      for (const part of ["", ...parts.slice(0, -1)]) {
        parent = path.join(parent, part);
        if (parents) await fs.mkdir(parent, { recursive: true });
        if ((await fs.lstat(parent)).isSymbolicLink()) throw denied();
      }
    }
    const full = path.join(parent, parts.at(-1));
    try {
      if ((await fs.lstat(full)).isSymbolicLink()) throw denied();
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return await operation(full);
  } catch (error) {
    translate(error);
  } finally {
    await Promise.all(handles.reverse().map((handle) => handle.close()));
  }
}

export async function withSafeDirectory(directory, operation) {
  if (process.platform !== "linux") {
    if ((await fs.lstat(directory)).isSymbolicLink()) throw denied();
    return operation(directory);
  }
  let handle;
  try {
    handle = await fs.open(directory, directoryFlags);
    return await operation(`/proc/self/fd/${handle.fd}`);
  } catch (error) {
    translate(error);
  } finally {
    await handle?.close();
  }
}

export async function copySafe(source, target) {
  const stat = await fs.lstat(source);
  if (stat.isSymbolicLink()) throw denied();
  if (stat.isDirectory())
    return withSafeDirectory(source, async (pinned) => {
      await fs.mkdir(target, { recursive: true, mode: 0o2770 });
      for (const name of await fs.readdir(pinned))
        await copySafe(path.join(pinned, name), path.join(target, name));
      if (process.platform === "linux") {
        const destination = await fs.open(target, directoryFlags);
        try {
          await destination.sync();
        } finally {
          await destination.close();
        }
      }
    });
  if (!stat.isFile())
    throw new AppError(
      "Nur reguläre Dateien dürfen übernommen werden.",
      403,
      "PATH_DENIED",
      { messageKey: "serverFeature:files.regularOnly", params: {} },
    );
  const input = await fs.open(source, readFlags);
  let output;
  try {
    const opened = await input.stat();
    if (!opened.isFile()) throw denied();
    output = await fs.open(target, "wx", opened.mode & 0o111 ? 0o770 : 0o660);
    const buffer = Buffer.alloc(65536);
    let offset = 0;
    while (offset < opened.size) {
      const { bytesRead } = await input.read(
        buffer,
        0,
        Math.min(buffer.length, opened.size - offset),
        offset,
      );
      if (!bytesRead) break;
      await output.writeFile(buffer.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const after = await input.stat();
    if (
      offset !== opened.size ||
      after.size !== opened.size ||
      after.mtimeMs !== opened.mtimeMs
    )
      throw new AppError(
        "Eine Datei wurde während der Sicherung verändert. Vorgang bitte wiederholen.",
        409,
        "CONFLICT",
        { messageKey: "serverFeature:files.backupChanged", params: {} },
      );
    await output.sync();
  } finally {
    await input.close();
    await output?.close();
  }
}

export async function treeBytesSafe(source) {
  const stat = await fs.lstat(source);
  if (stat.isSymbolicLink()) throw denied();
  if (stat.isFile()) return stat.size;
  if (!stat.isDirectory()) throw denied();
  return withSafeDirectory(source, async (pinned) => {
    let total = 0;
    for (const name of await fs.readdir(pinned))
      total += await treeBytesSafe(path.join(pinned, name));
    return total;
  });
}

export async function requireSpace(destination, bytes) {
  const stat = await fs.statfs(destination);
  if (Number(stat.bavail) * Number(stat.bsize) < bytes + 16 * 1024 ** 2)
    throw new AppError(
      "Zu wenig freier Speicher für die Sicherung. Bisherige Daten bleiben erhalten.",
      507,
      "INSUFFICIENT_STORAGE",
      { messageKey: "serverFeature:files.notEnoughSpace", params: {} },
    );
}

export async function removeSafe(entry) {
  const stat = await fs.lstat(entry);
  if (stat.isSymbolicLink()) throw denied();
  if (!stat.isDirectory()) return fs.unlink(entry);
  await withSafeDirectory(entry, async (pinned) => {
    for (const name of await fs.readdir(pinned))
      await removeSafe(path.join(pinned, name));
  });
  await fs.rmdir(entry);
}
