import fs from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import yauzl from "yauzl";
import {
  AppError,
  DATA_DIR,
  WORKSPACE_DIR,
  readJSON,
  writeJSON,
  serial,
  validateSessionId,
  listFiles,
} from "./storage.js";
import { withSafeEntry, requireSpace, removeSafe } from "./safeFiles.js";
import {
  fileClassification,
  normalizeImportPath,
  readManifest,
  selectionFor,
  selectionSummary,
  manifestTreePage,
} from "./codebaseTree.js";
import {
  withCodebaseJob,
  cancelCodebaseJob,
  listActiveCodebaseJobs,
} from "./codebaseJobs.js";
import { parseGitSource } from "./gitImports.js";

const importsRoot = path.join(DATA_DIR, "codebase-imports");
const live = new Map();
const terminal = new Set([
  "completed",
  "cancelled",
  "failed",
  "expired",
  "interrupted",
]);
const heavy = new Set([
  "queued",
  "receiving",
  "fetching",
  "inspecting",
  "materializing",
  "publishing",
]);
const sha = (value) => createHash("sha256").update(value).digest("hex");
const recordFile = (id) =>
  path.join(importsRoot, `${validateSessionId(id)}.json`);
const quarantine = (id) => path.join(importsRoot, validateSessionId(id));
const manifestFile = (id) => path.join(quarantine(id), "manifest.jsonl");
const archiveFile = (id) => path.join(quarantine(id), "archive.zip");
const preparation = (id) =>
  path.join(WORKSPACE_DIR, ".codebase-staging", validateSessionId(id));

function failure(code, status = 400, params = {}) {
  return new AppError(
    "Der Codebase-Import konnte nicht abgeschlossen werden.",
    status,
    code,
    {
      messageKey: "features:codebase.errors.import",
      params: { reason: code, ...params },
    },
  );
}
function integerSetting(name, fallback) {
  const value = Number(process.env[name] || fallback);
  if (!Number.isSafeInteger(value) || value < 1)
    throw failure("IMPORT_CONFIGURATION_INVALID", 500);
  return value;
}
export function codebaseImportLimits() {
  return {
    uploadBytes: integerSetting(
      "STERRACODE_IMPORT_UPLOAD_BYTES",
      2 * 1024 ** 3,
    ),
    extractedBytes: integerSetting(
      "STERRACODE_IMPORT_EXTRACTED_BYTES",
      8 * 1024 ** 3,
    ),
    entries: integerSetting("STERRACODE_IMPORT_ENTRIES", 200000),
    depth: integerSetting("STERRACODE_IMPORT_DEPTH", 64),
    durationMs: integerSetting("STERRACODE_IMPORT_DURATION_MS", 30 * 60 * 1000),
    retentionMs: integerSetting(
      "STERRACODE_IMPORT_RETENTION_MS",
      24 * 60 * 60 * 1000,
    ),
    absoluteRetentionMs: integerSetting(
      "STERRACODE_IMPORT_ABSOLUTE_RETENTION_MS",
      72 * 60 * 60 * 1000,
    ),
    concurrency: 1,
  };
}
function publicJob(job) {
  const { requestDigest, selection, commitDigest, roots, ...safe } = job;
  return {
    ...safe,
    warnings: (job.warnings || []).slice(0, 100),
    warningCount: (job.warnings || []).length,
    importId: job.id,
    selection: selection ? { ...selection } : undefined,
    limits: codebaseImportLimits(),
  };
}
async function save(job) {
  job.updatedAt = new Date().toISOString();
  job.sequence = (job.sequence || 0) + 1;
  await serial(`codebase-record:${job.id}`, () =>
    writeJSON(recordFile(job.id), job),
  );
}
async function rawRecord(id) {
  try {
    return await serial(`codebase-record:${id}`, () =>
      readJSON(recordFile(id)),
    );
  } catch (error) {
    if (error.code === "ENOENT") throw failure("IMPORT_NOT_FOUND", 404);
    throw error;
  }
}
async function cleanup(job) {
  const errors = [];
  // Only private, UUID-addressed import data. Published workspace paths are
  // never cleanup targets, including a cancelled request racing publication.
  for (const target of [quarantine(job.id), preparation(job.id)]) {
    try {
      await removeSafe(target);
    } catch (error) {
      if (error.code !== "ENOENT") errors.push(error.code || "CLEANUP_FAILED");
    }
  }
  job.cleanup = errors.length
    ? { state: "pending", codes: errors }
    : { state: "completed" };
  await save(job);
}
async function recovered(job) {
  if (
    heavy.has(job.state) &&
    !live.has(job.id) &&
    !listActiveCodebaseJobs().some((active) => active.id === job.id)
  ) {
    if (job.sessionId) {
      try {
        const { loadSession, recoverCodebasePublications } =
          await import("./sessions.js");
        await recoverCodebasePublications?.();
        const session = await loadSession(job.sessionId);
        if (session.codebase?.importId === job.id) {
          job.state = "completed";
          job.phase = "completed";
          await save(job);
          await cleanup(job);
          return job;
        }
      } catch (error) {
        if (error.status !== 404 && error.code !== "ENOENT") throw error;
      }
    }
    job.state = "interrupted";
    job.phase = "interrupted";
    job.error = {
      code: "IMPORT_INTERRUPTED",
      messageKey: "features:codebase.errors.import",
      params: { reason: "IMPORT_INTERRUPTED" },
    };
    await save(job);
    await cleanup(job);
  }
  if (job.state === "awaiting_selection") {
    const source =
      job.source.kind === "zip"
        ? archiveFile(job.id)
        : path.join(quarantine(job.id), "git");
    const available = await Promise.all(
      [manifestFile(job.id), source].map((file) =>
        fs.access(file).then(
          () => true,
          (error) => {
            if (error.code === "ENOENT") return false;
            throw error;
          },
        ),
      ),
    );
    if (available.some((value) => !value)) {
      job.state = job.phase = "expired";
      job.error = {
        code: "IMPORT_SOURCE_EXPIRED",
        messageKey: "features:codebase.errors.import",
        params: { reason: "IMPORT_SOURCE_EXPIRED" },
      };
      await save(job);
      await cleanup(job);
    }
  }
  if (
    !terminal.has(job.state) &&
    !heavy.has(job.state) &&
    Date.parse(job.expiresAt) <= Date.now()
  ) {
    job.state = "expired";
    job.phase = "expired";
    await save(job);
    await cleanup(job);
  }
  if (terminal.has(job.state) && job.cleanup?.state === "pending")
    await cleanup(job);
  return job;
}
export async function getCodebaseImport(id, { touch = true } = {}) {
  return serial(`codebase-import:${validateSessionId(id)}`, async () => {
    const job = await recovered(await rawRecord(id));
    if (touch && job.state === "awaiting_selection") {
      const limits = codebaseImportLimits();
      job.expiresAt = new Date(
        Math.min(
          Date.now() + limits.retentionMs,
          Date.parse(job.createdAt) + limits.absoluteRetentionMs,
        ),
      ).toISOString();
      await save(job);
    }
    return publicJob(job);
  });
}
export async function listCodebaseImports() {
  const jobs = [];
  for (const file of await listFiles(importsRoot)) {
    const id = path.basename(file, ".json");
    try {
      jobs.push(await getCodebaseImport(id, { touch: false }));
    } catch (error) {
      if (error.code !== "IMPORT_NOT_FOUND") throw error;
    }
  }
  return jobs
    .filter((job) => job.state !== "expired")
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
function cleanSource(source) {
  if (
    source?.kind === "zip" &&
    Object.keys(source).every((key) => key === "kind")
  )
    return { kind: "zip" };
  if (
    source?.kind !== "git" ||
    typeof source.repositoryUrl !== "string" ||
    Object.keys(source).some(
      (key) => !["kind", "repositoryUrl", "ref", "credentialId"].includes(key),
    )
  )
    throw failure("IMPORT_SOURCE_INVALID");
  let url;
  try {
    url = new URL(source.repositoryUrl);
  } catch {
    throw failure("IMPORT_SOURCE_INVALID");
  }
  if (
    !["https:", "ssh:"].includes(url.protocol) ||
    url.password ||
    (url.username && url.protocol !== "ssh:") ||
    url.search ||
    url.hash
  )
    throw failure("IMPORT_SOURCE_INVALID");
  if (
    source.ref !== undefined &&
    (typeof source.ref !== "string" || source.ref.length > 200)
  )
    throw failure("IMPORT_SOURCE_INVALID");
  // Validate source syntax before creating a durable receipt. The adapter's
  // stricter URL/ref rules must not be deferred until after persistence.
  parseGitSource(source);
  if (source.credentialId) validateSessionId(source.credentialId);
  return {
    kind: "git",
    repositoryUrl: url.href,
    ...(source.ref ? { ref: source.ref } : {}),
    ...(source.credentialId ? { credentialId: source.credentialId } : {}),
  };
}
export async function createCodebaseImport(body) {
  const id = validateSessionId(body.operationId),
    source = cleanSource(body.source);
  if (
    body.title !== undefined &&
    (typeof body.title !== "string" ||
      !body.title.trim() ||
      body.title.length > 200)
  )
    throw failure("IMPORT_TITLE_INVALID");
  if (
    body.tutorLocale !== undefined &&
    !["de", "en", "es"].includes(body.tutorLocale)
  )
    throw failure("IMPORT_LOCALE_INVALID");
  const requestDigest = sha(
    JSON.stringify([source, body.title || null, body.tutorLocale || "de"]),
  );
  return serial(`codebase-import:${id}`, async () => {
    let old;
    try {
      old = await rawRecord(id);
    } catch (error) {
      if (error.code !== "IMPORT_NOT_FOUND") throw error;
    }
    if (old) {
      if (old.requestDigest !== requestDigest)
        throw failure("IDEMPOTENCY_CONFLICT", 409);
      return publicJob(await recovered(old));
    }
    await fs.mkdir(quarantine(id), { recursive: true, mode: 0o700 });
    await fs.chmod(quarantine(id), 0o700);
    const createdAt = new Date().toISOString();
    const job = {
      id,
      schemaVersion: 1,
      requestDigest,
      source,
      title: body.title?.trim() || "Codebase",
      tutorLocale: body.tutorLocale || "de",
      state: "created",
      phase: "created",
      createdAt,
      expiresAt: new Date(
        Date.now() + codebaseImportLimits().retentionMs,
      ).toISOString(),
      progress: { bytes: 0, files: 0 },
      warnings: [],
      selection: { profile: "recommended", rules: [], rootMapping: "" },
      selectionVersion: 1,
    };
    if (source.kind === "git") job.state = job.phase = "queued";
    await save(job);
    if (source.kind === "git")
      schedule(job.id, (signal) => fetchGit(job.id, signal));
    return publicJob(job);
  });
}
function checkedSignal(signal, started) {
  if (signal.aborted) throw failure("IMPORT_CANCELLED", 409);
  if (Date.now() - started > codebaseImportLimits().durationMs)
    throw failure("IMPORT_TIMEOUT", 408);
}
async function phaseFailure(id, error) {
  return serial(`codebase-import:${id}`, async () => {
    const job = await rawRecord(id);
    // A complete session is the commit point, irrespective of later failures.
    if (job.state === "completed") return;
    if (job.state === "publishing" && job.sessionId) {
      const { loadSession, recoverCodebasePublications } =
        await import("./sessions.js");
      await recoverCodebasePublications();
      try {
        const session = await loadSession(job.sessionId);
        if (session.codebase?.importId === id) {
          job.state = job.phase = "completed";
          await save(job);
          await cleanup(job);
          return;
        }
      } catch (loadError) {
        if (loadError.status !== 404) throw loadError;
      }
    }
    job.state =
      error.code === "IMPORT_CANCELLED" || error.name === "AbortError"
        ? "cancelled"
        : "failed";
    job.phase = job.state;
    job.error = {
      code: error.code || "IMPORT_INVALID_ARCHIVE",
      messageKey: error.messageKey || "features:codebase.errors.import",
      params: error.params || {
        reason: error.code || "IMPORT_INVALID_ARCHIVE",
      },
    };
    await save(job);
    await cleanup(job);
  });
}
function schedule(id, operation) {
  if (live.has(id)) return live.get(id);
  const promise = withCodebaseJob({ id, kind: "import" }, (signal) =>
    serial("codebase-import-resource", () =>
      withImportDeadline(signal, operation),
    ),
  )
    .catch((error) => phaseFailure(id, error))
    .finally(() => live.delete(id));
  live.set(id, promise);
  return promise;
}
async function withImportDeadline(signal, operation) {
  const timeout = new AbortController();
  const timer = setTimeout(
    () => timeout.abort(failure("IMPORT_TIMEOUT", 408)),
    codebaseImportLimits().durationMs,
  );
  timer.unref();
  try {
    return await operation(AbortSignal.any([signal, timeout.signal]));
  } catch (error) {
    if (timeout.signal.aborted) throw timeout.signal.reason;
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function openZip(file) {
  return new Promise((resolve, reject) =>
    yauzl.open(
      file,
      {
        lazyEntries: true,
        autoClose: false,
        decodeStrings: true,
        strictFileNames: true,
        validateEntrySizes: true,
      },
      (error, zip) =>
        error ? reject(failure("IMPORT_INVALID_ARCHIVE")) : resolve(zip),
    ),
  );
}
async function eachZip(zip, operation, signal) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const abort = () => finish(failure("IMPORT_CANCELLED", 409));
    const finish = (error) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener("abort", abort);
      zip.removeAllListeners("entry");
      zip.removeAllListeners("end");
      zip.removeAllListeners("error");
      if (error) reject(error);
      else resolve();
    };
    signal?.addEventListener("abort", abort, { once: true });
    zip.on("error", () => finish(failure("IMPORT_INVALID_ARCHIVE")));
    zip.on("end", () => finish());
    zip.on("entry", (entry) =>
      Promise.resolve()
        .then(() => operation(entry))
        .then(() => {
          if (!settled) zip.readEntry();
        }, finish),
    );
    if (signal?.aborted) abort();
    else zip.readEntry();
  });
}
function zipType(entry) {
  const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
  const type = mode & 0xf000;
  if (type === 0xa000) return "symlink";
  if (type !== 0 && type !== 0x8000 && type !== 0x4000) return "special";
  if (
    entry.fileName.endsWith("/") ||
    type === 0x4000 ||
    (entry.externalFileAttributes & 0x10) !== 0
  )
    return "folder";
  return "file";
}
function manifestBuilder(handle, limits, signal) {
  const seen = new Map(),
    hash = createHash("sha256");
  let count = 0,
    bytes = 0,
    started = Date.now();
  const roots = new Set();
  const emit = async (entry) => {
    const line = JSON.stringify(entry) + "\n";
    await handle.write(line, null, "utf8");
    hash.update(line);
  };
  const add = async (input) => {
    checkedSignal(signal, started);
    if (++count > limits.entries)
      throw failure("IMPORT_ENTRY_LIMIT", 413, { limit: limits.entries });
    const relative = normalizeImportPath(input.path);
    if (relative.split("/").length > limits.depth)
      throw failure("IMPORT_DEPTH_LIMIT", 413, { limit: limits.depth });
    if (!Number.isSafeInteger(input.bytes) || input.bytes < 0)
      throw failure("IMPORT_INVALID_ARCHIVE");
    bytes += input.type === "file" ? input.bytes : 0;
    if (!Number.isSafeInteger(bytes) || bytes > limits.extractedBytes)
      throw failure("IMPORT_EXTRACTED_LIMIT", 413, {
        limit: limits.extractedBytes,
      });
    roots.add(relative.split("/")[0]);
    const parts = relative.split("/");
    for (let i = 1; i <= parts.length; i++) {
      const p = parts.slice(0, i).join("/"),
        key = p.normalize("NFC").toLowerCase(),
        last = i === parts.length;
      const previous = seen.get(key);
      const type = last ? input.type : "folder";
      if (previous) {
        if (
          previous.path !== p ||
          previous.type !== "folder" ||
          type !== "folder" ||
          (last && previous.explicit)
        )
          throw failure("IMPORT_PATH_COLLISION");
        if (last) previous.explicit = true;
        continue;
      }
      if (seen.size >= limits.entries)
        throw failure("IMPORT_ENTRY_LIMIT", 413, { limit: limits.entries });
      seen.set(key, { path: p, type, explicit: last });
      const entry = {
        ...(last ? input : {}),
        path: p,
        type,
        bytes: last ? input.bytes : 0,
        id: sha(p),
        ...fileClassification(p, last ? input.bytes : 0, type),
      };
      await emit(entry);
    }
  };
  return {
    add,
    finish: () => ({
      manifestVersion: hash.digest("hex"),
      entryCount: seen.size,
      rootCount: roots.size,
      rootSuggestion:
        roots.size === 1 &&
        seen.get([...roots][0].normalize("NFC").toLowerCase())?.type ===
          "folder"
          ? [...roots][0]
          : null,
    }),
  };
}
async function finalizeManifest(job, result) {
  Object.assign(job, result, {
    state: "awaiting_selection",
    phase: "awaiting_selection",
  });
  job.summary = await selectionSummary(
    manifestFile(job.id),
    job.selection,
    job.manifestVersion,
  );
  job.selectionDigest = job.summary.selectionDigest;
  await save(job);
}

export async function uploadCodebaseArchive(id, input, { contentLength } = {}) {
  validateSessionId(id);
  const job = await serial(`codebase-import:${id}`, async () => {
    const current = await recovered(await rawRecord(id));
    if (current.source.kind !== "zip" || current.state !== "created")
      throw failure("IMPORT_UPLOAD_STATE", 409);
    if (
      contentLength !== undefined &&
      (!Number.isSafeInteger(contentLength) ||
        contentLength < 0 ||
        contentLength > codebaseImportLimits().uploadBytes)
    )
      throw failure("IMPORT_UPLOAD_LIMIT", 413, {
        limit: codebaseImportLimits().uploadBytes,
      });
    current.state = current.phase = "receiving";
    await save(current);
    return current;
  });
  const operation = withCodebaseJob({ id, kind: "import" }, (registrySignal) =>
    serial("codebase-import-resource", () =>
      withImportDeadline(registrySignal, async (signal) => {
        const limits = codebaseImportLimits(),
          started = Date.now(),
          hash = createHash("sha256");
        let lastSpace = 0,
          lastSave = 0;
        await requireSpace(
          DATA_DIR,
          contentLength || Math.min(limits.uploadBytes, 16 * 1024 ** 2),
        );
        const meter = new Transform({
          transform(chunk, encoding, callback) {
            (async () => {
              checkedSignal(signal, started);
              job.progress.bytes += chunk.length;
              if (job.progress.bytes > limits.uploadBytes)
                throw failure("IMPORT_UPLOAD_LIMIT", 413, {
                  limit: limits.uploadBytes,
                });
              hash.update(chunk);
              if (job.progress.bytes - lastSpace >= 4 * 1024 ** 2) {
                await requireSpace(
                  DATA_DIR,
                  Math.min(
                    limits.uploadBytes - job.progress.bytes,
                    16 * 1024 ** 2,
                  ),
                );
                lastSpace = job.progress.bytes;
              }
              if (Date.now() - lastSave > 500) {
                await save(job);
                lastSave = Date.now();
              }
              callback(null, chunk);
            })().catch(callback);
          },
        });
        await pipeline(
          input,
          meter,
          createWriteStream(archiveFile(id), { flags: "wx", mode: 0o600 }),
          { signal },
        );
        if (contentLength !== undefined && job.progress.bytes !== contentLength)
          throw failure("IMPORT_UPLOAD_INCOMPLETE");
        job.uploadDigest = hash.digest("hex");
        job.state = job.phase = "inspecting";
        await save(job);
        const zip = await openZip(archiveFile(id));
        const handle = await fs.open(manifestFile(id), "wx", 0o600);
        try {
          const builder = manifestBuilder(handle, limits, signal);
          await eachZip(
            zip,
            async (entry) => {
              checkedSignal(signal, started);
              if (
                entry.isEncrypted() ||
                ![0, 8].includes(entry.compressionMethod)
              )
                throw failure("IMPORT_UNSUPPORTED_ARCHIVE");
              if (entry.generalPurposeBitFlag & 0x800) {
                try {
                  new TextDecoder("utf-8", { fatal: true }).decode(
                    entry.fileNameRaw,
                  );
                } catch {
                  throw failure("IMPORT_PATH_ENCODING_INVALID");
                }
              }
              const type = zipType(entry);
              await builder.add({
                path: entry.fileName,
                type,
                bytes: entry.uncompressedSize,
                compressedBytes: entry.compressedSize,
                crc32: entry.crc32,
                archiveIndex: job.progress.files,
              });
              job.progress.files++;
              if (job.progress.files % 1000 === 0) await save(job);
            },
            signal,
          );
          await handle.sync();
          await finalizeManifest(job, builder.finish());
        } finally {
          zip.close();
          await handle.close();
        }
      }),
    ),
  )
    .catch(async (error) => {
      await phaseFailure(id, error);
      throw error;
    })
    .finally(() => live.delete(id));
  live.set(id, operation);
  await operation;
  return getCodebaseImport(id);
}

async function fetchGit(id, signal) {
  const job = await rawRecord(id);
  checkedSignal(signal, Date.now());
  job.state = job.phase = "fetching";
  await save(job);
  const { inspectGitSnapshot } = await import("./gitImports.js");
  const limits = codebaseImportLimits();
  const result = await inspectGitSnapshot({
    source: job.source,
    directory: path.join(quarantine(id), "git"),
    signal,
    budget: { maxBytes: limits.extractedBytes, maxEntries: limits.entries },
    onProgress: async (progress) => {
      job.progress = { ...job.progress, ...progress };
    },
  });
  job.state = job.phase = "inspecting";
  await save(job);
  const handle = await fs.open(manifestFile(id), "wx", 0o600);
  try {
    const builder = manifestBuilder(handle, limits, signal);
    for (const entry of result.entries) await builder.add(entry);
    await handle.sync();
    job.source = result.source;
    job.warnings = result.warnings || [];
    await finalizeManifest(job, builder.finish());
  } finally {
    await handle.close();
  }
}

export async function codebaseImportTree(id, options = {}) {
  const job = await getCodebaseImport(id);
  if (
    job.state !== "awaiting_selection" &&
    !["materializing", "publishing"].includes(job.state)
  )
    throw failure("IMPORT_SELECTION_STATE", 409);
  return manifestTreePage(manifestFile(id), job, options);
}
export async function updateCodebaseSelection(id, body) {
  return serial(`codebase-import:${validateSessionId(id)}`, async () => {
    const job = await recovered(await rawRecord(id));
    if (job.state !== "awaiting_selection")
      throw failure("IMPORT_SELECTION_STATE", 409);
    if (
      body.manifestVersion !== job.manifestVersion ||
      body.selectionVersion !== job.selectionVersion
    )
      throw failure("IMPORT_SELECTION_CONFLICT", 409);
    const selection = structuredClone(job.selection);
    if (body.profile !== undefined) {
      if (!["recommended", "all", "none"].includes(body.profile))
        throw failure("IMPORT_SELECTION_INVALID");
      selection.profile = body.profile;
    }
    if (body.rootMapping !== undefined) {
      if (typeof body.rootMapping !== "string")
        throw failure("IMPORT_SELECTION_INVALID");
      selection.rootMapping = body.rootMapping
        ? normalizeImportPath(body.rootMapping)
        : "";
      if (selection.rootMapping && job.rootSuggestion !== selection.rootMapping)
        throw failure("IMPORT_SELECTION_INVALID");
    }
    if (body.rules !== undefined) {
      if (!Array.isArray(body.rules) || body.rules.length > 1000)
        throw failure("IMPORT_SELECTION_INVALID");
      const rules = new Map();
      for (const rule of body.rules) {
        if (typeof rule?.selected !== "boolean")
          throw failure("IMPORT_SELECTION_INVALID");
        const p = normalizeImportPath(rule.path);
        if (rules.has(p)) throw failure("IMPORT_SELECTION_INVALID");
        rules.set(p, { path: p, selected: rule.selected });
      }
      const found = new Set();
      for await (const entry of readManifest(manifestFile(id)))
        if (rules.has(entry.path)) found.add(entry.path);
      if (found.size !== rules.size) throw failure("IMPORT_SELECTION_INVALID");
      selection.rules = [...rules.values()].sort((a, b) =>
        a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
      );
    }
    job.selection = selection;
    job.selectionVersion++;
    job.summary = await selectionSummary(
      manifestFile(id),
      selection,
      job.manifestVersion,
    );
    job.selectionDigest = job.summary.selectionDigest;
    await save(job);
    return publicJob(job);
  });
}

// CRC is independent of the ZIP library's announced-size check. Integrity is
// verified before a prepared workspace can be published.
const crcTable = Array.from({ length: 256 }, (_, value) => {
  for (let i = 0; i < 8; i++)
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});
function crcUpdate(crc, chunk) {
  for (const byte of chunk) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return crc >>> 0;
}
async function selectedEntries(job) {
  const entries = [];
  for await (const entry of readManifest(manifestFile(job.id)))
    if (entry.type === "file" && selectionFor(entry, job.selection))
      entries.push(entry);
  return entries;
}
function mappedPath(entry, job) {
  return job.selection.rootMapping
    ? entry.path.slice(job.selection.rootMapping.length + 1)
    : entry.path;
}
async function materializeZip(job, signal) {
  const selected = new Map(
    (await selectedEntries(job)).map((entry) => [entry.path, entry]),
  );
  const zip = await openZip(archiveFile(job.id));
  const started = Date.now();
  let actualBytes = 0,
    files = 0;
  try {
    await eachZip(
      zip,
      async (archiveEntry) => {
        checkedSignal(signal, started);
        const relative = normalizeImportPath(archiveEntry.fileName),
          entry = selected.get(relative);
        if (!entry) return;
        if (
          archiveEntry.uncompressedSize !== entry.bytes ||
          archiveEntry.crc32 !== entry.crc32 ||
          archiveEntry.compressedSize !== entry.compressedBytes ||
          zipType(archiveEntry) !== "file"
        )
          throw failure("IMPORT_MANIFEST_CHANGED", 409);
        const stream = await new Promise((resolve, reject) =>
          zip.openReadStream(archiveEntry, (error, input) =>
            error ? reject(failure("IMPORT_INVALID_ARCHIVE")) : resolve(input),
          ),
        );
        await withSafeEntry(
          preparation(job.id),
          mappedPath(entry, job),
          async (full) => {
            let fileBytes = 0,
              crc = 0xffffffff,
              lastSpace = 0;
            const meter = new Transform({
              transform(chunk, encoding, callback) {
                (async () => {
                  checkedSignal(signal, started);
                  fileBytes += chunk.length;
                  actualBytes += chunk.length;
                  if (
                    fileBytes > entry.bytes ||
                    actualBytes > job.summary.selectedBytes ||
                    actualBytes > codebaseImportLimits().extractedBytes
                  )
                    throw failure("IMPORT_SIZE_MISMATCH");
                  crc = crcUpdate(crc, chunk);
                  if (actualBytes - lastSpace >= 4 * 1024 ** 2) {
                    await requireSpace(
                      WORKSPACE_DIR,
                      job.summary.selectedBytes - actualBytes,
                    );
                    lastSpace = actualBytes;
                  }
                  callback(null, chunk);
                })().catch(callback);
              },
            });
            await pipeline(
              stream,
              meter,
              createWriteStream(full, { flags: "wx", mode: 0o660 }),
              { signal },
            );
            if (
              fileBytes !== entry.bytes ||
              (crc ^ 0xffffffff) >>> 0 !== entry.crc32
            )
              throw failure("IMPORT_INTEGRITY_FAILED");
          },
          { parents: true },
        );
        selected.delete(relative);
        files++;
        job.progress = {
          bytes: actualBytes,
          files,
          totalBytes: job.summary.selectedBytes,
        };
        if (files % 100 === 0) await save(job);
      },
      signal,
    );
    if (
      selected.size ||
      files !== job.summary.selectedFiles ||
      actualBytes !== job.summary.selectedBytes
    )
      throw failure("IMPORT_SIZE_MISMATCH");
  } finally {
    zip.close();
  }
}
async function materializeGit(job, signal) {
  const entries = await selectedEntries(job);
  const { materializeGitSnapshot } = await import("./gitImports.js");
  await materializeGitSnapshot({
    directory: path.join(quarantine(job.id), "git"),
    entries: entries.map((entry) => ({
      ...entry,
      destinationPath: mappedPath(entry, job),
    })),
    destination: preparation(job.id),
    signal,
    onProgress: (progress) => {
      job.progress = { ...job.progress, ...progress };
    },
  });
  // Inspect the exact outputs again. Git's blob sizes never grant permission to
  // publish extra files or to follow links left by an adapter.
  let total = 0;
  for (const entry of entries) {
    const stat = await fs.lstat(
      path.join(preparation(job.id), mappedPath(entry, job)),
    );
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size !== entry.bytes)
      throw failure("IMPORT_SIZE_MISMATCH");
    total += stat.size;
    await fs.chmod(
      path.join(preparation(job.id), mappedPath(entry, job)),
      0o660,
    );
  }
  if (total !== job.summary.selectedBytes)
    throw failure("IMPORT_SIZE_MISMATCH");
}
async function publishImport(id, signal) {
  const job = await rawRecord(id);
  checkedSignal(signal, Date.now());
  job.state = job.phase = "materializing";
  job.progress = { bytes: 0, files: 0, totalBytes: job.summary.selectedBytes };
  await save(job);
  await fs.mkdir(path.dirname(preparation(id)), {
    recursive: true,
    mode: 0o2770,
  });
  await requireSpace(DATA_DIR, 1024 ** 2);
  await requireSpace(WORKSPACE_DIR, job.summary.selectedBytes);
  await fs.mkdir(preparation(id), { mode: 0o2770 });
  if (job.source.kind === "zip") await materializeZip(job, signal);
  else await materializeGit(job, signal);
  checkedSignal(signal, Date.now());
  job.state = job.phase = "publishing";
  await save(job);
  const { createCodebaseSession } = await import("./sessions.js");
  await createCodebaseSession(
    { title: job.title, tutorLocale: job.tutorLocale, source: job.source },
    {
      id: job.sessionId,
      preparation: preparation(id),
      importId: id,
      summary: job.summary,
    },
  );
  job.state = job.phase = "completed";
  job.completedAt = new Date().toISOString();
  await save(job);
  await cleanup(job);
}
export async function commitCodebaseImport(id, body) {
  return serial(`codebase-import:${validateSessionId(id)}`, async () => {
    const job = await recovered(await rawRecord(id));
    const title = body.title === undefined ? job.title : body.title;
    const tutorLocale =
      body.tutorLocale === undefined ? job.tutorLocale : body.tutorLocale;
    if (typeof title !== "string" || !title.trim() || title.length > 200)
      throw failure("IMPORT_TITLE_INVALID");
    if (!["de", "en", "es"].includes(tutorLocale))
      throw failure("IMPORT_LOCALE_INVALID");
    const commitDigest = sha(
      JSON.stringify([
        body.manifestVersion,
        body.selectionVersion,
        body.selectionDigest,
        title.trim(),
        tutorLocale,
      ]),
    );
    if (job.commitDigest) {
      if (job.commitDigest !== commitDigest)
        throw failure("IDEMPOTENCY_CONFLICT", 409);
      return publicJob(job);
    }
    if (job.state !== "awaiting_selection")
      throw failure("IMPORT_SELECTION_STATE", 409);
    if (
      body.manifestVersion !== job.manifestVersion ||
      body.selectionVersion !== job.selectionVersion ||
      body.selectionDigest !== job.selectionDigest
    )
      throw failure("IMPORT_SELECTION_CONFLICT", 409);
    if (!job.summary.selectedFiles) throw failure("IMPORT_EMPTY_SELECTION");
    if (
      job.summary.requiresConfirmation &&
      (body.confirmation?.bytes !== job.summary.selectedBytes ||
        body.confirmation?.selectionDigest !== job.selectionDigest ||
        body.confirmation?.manifestVersion !== job.manifestVersion)
    )
      throw failure("IMPORT_SIZE_CONFIRMATION_REQUIRED", 409, {
        bytes: job.summary.selectedBytes,
      });
    job.commitDigest = commitDigest;
    job.title = title.trim();
    job.tutorLocale = tutorLocale;
    job.sessionId = randomUUID();
    job.state = job.phase = "queued";
    await save(job);
    schedule(id, (signal) => publishImport(id, signal));
    return publicJob(job);
  });
}
export async function cancelCodebaseImport(id) {
  validateSessionId(id);
  cancelCodebaseJob(id);
  if (live.has(id)) await live.get(id).catch(() => {});
  return serial(`codebase-import:${id}`, async () => {
    const job = await recovered(await rawRecord(id));
    if (job.state === "completed") return publicJob(job);
    job.state = job.phase = "cancelled";
    await save(job);
    await cleanup(job);
    return publicJob(job);
  });
}
export async function deleteCodebaseImport(id) {
  const job = await cancelCodebaseImport(id);
  return {
    ok: true,
    importId: id,
    state: job.state,
    sessionId: job.state === "completed" ? job.sessionId : undefined,
  };
}
export async function recoverCodebaseImports() {
  await listCodebaseImports();
}

export function startCodebaseImportCleanup() {
  const timer = setInterval(() => {
    listCodebaseImports().catch(() => {
      // Retry on the next sweep. A cleanup failure must not republish a session.
    });
  }, 60 * 1000);
  timer.unref();
  return () => clearInterval(timer);
}

export async function codebaseImportPreview(id, relative) {
  const job = await getCodebaseImport(id);
  if (job.state !== "awaiting_selection")
    throw failure("IMPORT_SELECTION_STATE", 409);
  const p = normalizeImportPath(relative);
  let entry;
  for await (const candidate of readManifest(manifestFile(id)))
    if (candidate.path === p) {
      entry = candidate;
      break;
    }
  if (!entry || entry.type !== "file")
    throw failure("IMPORT_FILE_NOT_FOUND", 404);
  const metadata = {
    path: p,
    bytes: entry.bytes,
    editorEligible: entry.editorEligible,
    aiEligible: entry.aiEligible,
    reason: entry.reason,
  };
  if (entry.locked || entry.binary) return metadata;
  const chunks = [];
  let length = 0;
  if (job.source.kind === "git") {
    const { readGitPreview } = await import("./gitImports.js");
    if (!readGitPreview) return { ...metadata, reason: "previewUnavailable" };
    const bytes = await readGitPreview({
      directory: path.join(quarantine(id), "git"),
      entry,
      maxBytes: 65536,
    });
    chunks.push(bytes);
    length = bytes.length;
  } else {
    const zip = await openZip(archiveFile(id));
    try {
      await eachZip(zip, async (archiveEntry) => {
        if (normalizeImportPath(archiveEntry.fileName) !== p) return;
        const stream = await new Promise((resolve, reject) =>
          zip.openReadStream(archiveEntry, (error, value) =>
            error ? reject(failure("IMPORT_INVALID_ARCHIVE")) : resolve(value),
          ),
        );
        for await (const chunk of stream) {
          const take = Math.min(chunk.length, 65536 - length);
          if (take > 0) {
            chunks.push(chunk.subarray(0, take));
            length += take;
          }
          if (length >= 65536) {
            stream.destroy();
            break;
          }
        }
      });
    } finally {
      zip.close();
    }
  }
  try {
    const buffer = Buffer.concat(chunks, length);
    const content = new TextDecoder("utf-8", { fatal: true }).decode(buffer, {
      stream: entry.bytes > length,
    });
    if (content.includes("\0")) throw Error("binary");
    return { ...metadata, content, truncated: entry.bytes > length };
  } catch {
    return {
      ...metadata,
      reason: "binary",
      editorEligible: false,
      aiEligible: false,
    };
  }
}
