import fs from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { createInterface } from "node:readline";
import { AppError, getWorkspacePath } from "./storage.js";
import { normalizePath } from "./workspace.js";
import { withSafeDirectory, withSafeEntry, readFlags } from "./safeFiles.js";

export const EDITOR_BYTES = 2 * 1024 ** 2;
export const LARGE_PROJECT_BYTES = 500_000_000;
const digest = (value) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail = (code) =>
  new AppError("Die Baumansicht wurde verändert. Bitte neu laden.", 409, code, {
    messageKey: "features:codebase.errors.treeChanged",
  });

export function fileClassification(relative, bytes, type = "file") {
  const parts = relative.toLowerCase().split("/");
  const name = parts.at(-1);
  const locked =
    parts.includes(".git") ||
    /^(?:\.env(?:\.(?!example$|sample$|template$).*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.pub)?|credentials(?:\.json)?|\.netrc|\.npmrc|\.pypirc|\.git-credentials)$/.test(
      name,
    ) ||
    /\.(?:pem|p12|pfx|key)$/.test(name) ||
    (type !== "file" && type !== "folder");
  const generated = parts.some((part) =>
    [
      "node_modules",
      ".venv",
      "venv",
      "__pycache__",
      "target",
      "dist",
      "build",
      ".next",
      ".cache",
    ].includes(part),
  );
  const binary =
    /\.(?:png|jpe?g|gif|webp|ico|avif|woff2?|ttf|pdf|zip|gz|7z|rar|tar|exe|dll|so|dylib|class|pyc|sqlite|db|mp[34]|wav|ogg|flac|bin)$/i.test(
      name,
    );
  const languages = {
    py: "python",
    js: "javascript",
    mjs: "javascript",
    cjs: "javascript",
    jsx: "javascript",
    ts: "typescript",
    tsx: "typescript",
    sh: "shell",
    go: "go",
    rs: "rust",
    cpp: "cpp",
    c: "c",
    h: "c",
    cs: "csharp",
    lua: "lua",
    java: "java",
    json: "json",
    md: "markdown",
    html: "html",
    css: "css",
    yaml: "yaml",
    yml: "yaml",
    toml: "ini",
    xml: "xml",
    rb: "ruby",
    php: "php",
    kt: "kotlin",
    swift: "swift",
  };
  const reason = locked
    ? parts.includes(".git")
      ? "gitMetadata"
      : type !== "file" && type !== "folder"
        ? "specialFile"
        : "secret"
    : generated
      ? "generated"
      : binary
        ? "binary"
        : bytes > EDITOR_BYTES
          ? "large"
          : null;
  return {
    locked,
    reason,
    defaultSelected: !locked && !generated && !binary,
    binary,
    textStatus:
      type === "folder" ? "directory" : binary ? "binary" : "unverified",
    language: languages[name.split(".").at(-1)] || "plaintext",
    editorEligible:
      type === "file" && !locked && !binary && bytes <= EDITOR_BYTES,
    aiEligible: type === "file" && !locked && !binary && bytes <= EDITOR_BYTES,
  };
}

export function normalizeImportPath(raw) {
  if (typeof raw !== "string" || /[\x00-\x1f\x7f]/.test(raw))
    throw new AppError("Ungültiger Archivpfad.", 400, "IMPORT_PATH_DENIED", {
      messageKey: "features:codebase.errors.unsafePath",
    });
  return normalizePath(raw.replace(/[/\\]$/, ""));
}

export function selectionFor(entry, selection) {
  if (entry.locked) return false;
  let selected =
    selection.profile === "all" ||
    (selection.profile === "recommended" && entry.defaultSelected);
  let deepest = -1;
  for (const rule of selection.rules || []) {
    if (
      (entry.path === rule.path || entry.path.startsWith(rule.path + "/")) &&
      rule.path.length >= deepest
    ) {
      selected = rule.selected;
      deepest = rule.path.length;
    }
  }
  if (
    selection.rootMapping &&
    !entry.path.startsWith(selection.rootMapping + "/")
  )
    return false;
  return selected;
}

export async function* readManifest(file) {
  const input = createReadStream(file, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  try {
    for await (const line of lines) if (line) yield JSON.parse(line);
  } finally {
    lines.close();
    input.destroy();
  }
}

export async function selectionSummary(file, selection, manifestVersion) {
  let files = 0,
    bytes = 0,
    selectedFiles = 0,
    selectedBytes = 0;
  const languages = new Set();
  for await (const entry of readManifest(file)) {
    if (entry.type !== "file") continue;
    files++;
    bytes += entry.bytes;
    if (selectionFor(entry, selection)) {
      selectedFiles++;
      selectedBytes += entry.bytes;
      if (entry.language !== "plaintext") languages.add(entry.language);
    }
  }
  return {
    files,
    bytes,
    selectedFiles,
    selectedBytes,
    languages: [...languages].sort(),
    requiresConfirmation: selectedBytes > LARGE_PROJECT_BYTES,
    selectionDigest: digest([
      manifestVersion,
      selection,
      selectedFiles,
      selectedBytes,
    ]),
  };
}

function pageOptions(options, version) {
  const parent = options.parent ? normalizePath(options.parent) : "";
  const query = String(options.query || "").toLowerCase();
  if (query.length > 200)
    throw new AppError("Suchtext ist zu lang.", 400, "INVALID_REQUEST", {
      messageKey: "features:codebase.errors.invalidRequest",
    });
  const limit = Number(options.limit ?? 200);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500)
    throw new AppError("Ungültige Seitengröße.", 400, "INVALID_REQUEST", {
      messageKey: "features:codebase.errors.invalidRequest",
    });
  const view = digest([version, parent, query]);
  let after = "";
  if (options.cursor) {
    let cursor;
    try {
      cursor = JSON.parse(
        Buffer.from(options.cursor, "base64url").toString("utf8"),
      );
    } catch {
      throw fail("STALE_CURSOR");
    }
    if (cursor.view !== view || typeof cursor.after !== "string")
      throw fail("STALE_CURSOR");
    after = cursor.after;
  }
  return { parent, query, limit, view, after };
}

// Retain only the requested page while scanning a line-oriented manifest. A
// directory with 100,000 children does not become a 100,000-row HTTP response.
export async function manifestTreePage(
  file,
  { manifestVersion, selectionVersion, selection, summary },
  options = {},
) {
  const page = pageOptions(options, [manifestVersion, selectionVersion]);
  const entries = [];
  const folderStats = new Map();
  const prefix = page.parent ? page.parent + "/" : "";
  for await (const entry of readManifest(file)) {
    if (!entry.path.startsWith(prefix)) continue;
    const suffix = entry.path.slice(prefix.length);
    const direct = !suffix.includes("/");
    if (
      !(page.query
        ? entry.type === "file" && entry.path.toLowerCase().includes(page.query)
        : direct)
    )
      continue;
    const key = `${entry.type === "folder" ? "0" : "1"}:${entry.path}`;
    if (key <= page.after) continue;
    if (entries.length === page.limit + 1 && key >= entries.at(-1).key)
      continue;
    const result = {
      ...entry,
      name: path.posix.basename(entry.path),
      selected: entry.type === "file" ? selectionFor(entry, selection) : false,
      key,
    };
    delete result.archiveEntry;
    delete result.oid;
    entries.push(result);
    entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
    if (entries.length > page.limit + 1) entries.pop();
  }
  for (const entry of entries)
    if (entry.type === "folder")
      folderStats.set(entry.path, {
        files: 0,
        selectedFiles: 0,
        bytes: 0,
        selectedBytes: 0,
      });
  if (folderStats.size)
    for await (const entry of readManifest(file)) {
      if (entry.type !== "file") continue;
      const parts = entry.path.split("/");
      for (let depth = 1; depth < parts.length; depth++) {
        const stats = folderStats.get(parts.slice(0, depth).join("/"));
        if (stats) {
          stats.files++;
          stats.bytes += entry.bytes;
          if (selectionFor(entry, selection)) {
            stats.selectedFiles++;
            stats.selectedBytes += entry.bytes;
          }
        }
      }
    }
  for (const entry of entries)
    if (folderStats.has(entry.path)) {
      const stats = folderStats.get(entry.path);
      Object.assign(entry, stats, {
        selected:
          stats.selectedFiles === 0
            ? false
            : stats.selectedFiles === stats.files
              ? true
              : null,
      });
    }
  const more = entries.length > page.limit;
  if (more) entries.pop();
  const nextCursor = more
    ? Buffer.from(
        JSON.stringify({ view: page.view, after: entries.at(-1).key }),
      ).toString("base64url")
    : null;
  for (const entry of entries) delete entry.key;
  return { entries, nextCursor, manifestVersion, selectionVersion, summary };
}

export async function workspaceTreePage(sessionId, options = {}) {
  const root = await getWorkspacePath(sessionId);
  const parent = options.parent ? normalizePath(options.parent) : "";
  const query = String(options.query || "").toLowerCase();
  if (query) return workspaceSearch(sessionId, options);
  const list = async (dir) => {
    const stat = await fs.stat(dir);
    const version = digest([sessionId, parent, stat.mtimeMs, stat.ctimeMs]);
    const page = pageOptions(options, version);
    const results = [];
    // opendir streams directory names; retain at most limit + one candidates.
    const directory = await fs.opendir(dir);
    for await (const entry of directory) {
      if (
        (!entry.isDirectory() && !entry.isFile()) ||
        entry.name.endsWith(".tmp")
      )
        continue;
      const type = entry.isDirectory() ? "folder" : "file";
      const key = `${type === "folder" ? "0" : "1"}:${entry.name}`;
      if (key <= page.after) continue;
      if (results.length === page.limit + 1 && key >= results.at(-1).key)
        continue;
      const relative = parent ? `${parent}/${entry.name}` : entry.name;
      results.push({
        id: digest(relative),
        path: relative,
        name: entry.name,
        type,
        key,
      });
      results.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
      if (results.length > page.limit + 1) results.pop();
    }
    const after = await fs.stat(dir);
    if (after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs)
      throw fail("STALE_CURSOR");
    const more = results.length > page.limit;
    if (more) results.pop();
    for (const result of results) {
      const metadata = await fs.lstat(path.join(dir, result.name));
      if (metadata.isSymbolicLink()) throw fail("STALE_CURSOR");
      Object.assign(
        result,
        { bytes: metadata.size },
        fileClassification(result.path, metadata.size, result.type),
      );
    }
    const nextCursor = more
      ? Buffer.from(
          JSON.stringify({ view: page.view, after: results.at(-1).key }),
        ).toString("base64url")
      : null;
    for (const result of results) delete result.key;
    return { entries: results, nextCursor, manifestVersion: version };
  };
  return parent
    ? withSafeEntry(root, parent, (directory) =>
        withSafeDirectory(directory, list),
      )
    : withSafeDirectory(root, list);
}

export async function workspaceSearch(sessionId, options = {}) {
  const root = await getWorkspacePath(sessionId);
  const query = String(options.query || "").toLowerCase();
  const limit = Number(options.limit || 100);
  if (
    !query ||
    query.length > 200 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 500
  )
    throw new AppError("Ungültige Suchanfrage.", 400, "INVALID_REQUEST", {
      messageKey: "features:codebase.errors.invalidRequest",
    });
  const results = [];
  const started = Date.now();
  let scanned = 0,
    truncated = false;
  async function walk(directory, prefix = "", depth = 0) {
    if (
      depth > 64 ||
      results.length >= limit ||
      scanned > 100000 ||
      Date.now() - started > 3000
    ) {
      truncated = true;
      return;
    }
    await withSafeDirectory(directory, async (pinned) => {
      const handle = await fs.opendir(pinned);
      for await (const entry of handle) {
        if (
          ++scanned > 100000 ||
          results.length >= limit ||
          Date.now() - started > 3000
        ) {
          truncated = true;
          break;
        }
        const relative = prefix + entry.name;
        if (entry.isDirectory())
          await walk(path.join(pinned, entry.name), relative + "/", depth + 1);
        else if (entry.isFile() && relative.toLowerCase().includes(query)) {
          const stat = await fs.lstat(path.join(pinned, entry.name));
          if (!stat.isSymbolicLink())
            results.push({
              id: digest(relative),
              name: entry.name,
              path: relative,
              type: "file",
              bytes: stat.size,
              ...fileClassification(relative, stat.size),
            });
        }
      }
    });
  }
  await walk(root);
  return { entries: results, nextCursor: null, truncated, scanned };
}

export async function workspaceMetadata(sessionId, relative) {
  const root = await getWorkspacePath(sessionId);
  return withSafeEntry(root, normalizePath(relative), async (full) => {
    const handle = await fs.open(full, readFlags);
    try {
      const stat = await handle.stat();
      if (!stat.isFile())
        throw new AppError("Keine reguläre Datei.", 400, "PATH_DENIED");
      return {
        path: relative,
        bytes: stat.size,
        ...fileClassification(relative, stat.size),
      };
    } finally {
      await handle.close();
    }
  });
}
