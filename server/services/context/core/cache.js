// Adapted from context-compressor 0.8.3. See ../ORIGIN.md.
/**
 * Content-addressed summary cache. An entry stored under prefix-hash H means:
 * "the messages hashed by H are covered by these byte-stable chunk summaries."
 * Persistence is a single JSON file written atomically; the cache is always
 * reconstructible, so corruption or loss just means re-summarizing.
 */
import { randomUUID } from "crypto";
import { mkdir, readFile, rename, writeFile } from "fs/promises";
import { dirname, join } from "path";
export const MAX_ENTRIES = 200;
export class ChunkCache {
  filePath;
  entries = new Map();
  constructor(filePath) {
    this.filePath = filePath;
  }
  /** Test hook: lets tests inject write latency to reproduce races. */
  async beforeWrite() {}
  static async load(filePath) {
    const cache = new ChunkCache(filePath);
    try {
      const raw = JSON.parse(await readFile(filePath, "utf8"));
      if (raw && typeof raw.entries === "object" && raw.entries !== null) {
        for (const [hash, entry] of Object.entries(raw.entries)) {
          if (!entry || typeof entry !== "object") continue;
          const e = entry;
          if (
            Array.isArray(e.chunkSummaries) &&
            e.chunkSummaries.every((s) => typeof s === "string") &&
            Number.isInteger(e.coveredCount) &&
            e.coveredCount >= 0 &&
            Number.isFinite(e.lastUsedAt)
          ) {
            cache.put(hash, e);
          }
        }
      }
    } catch {
      // Missing or corrupt file: start empty; the cache is reconstructible.
    }
    return cache;
  }
  get size() {
    return this.entries.size;
  }
  get(hash) {
    const entry = this.entries.get(hash);
    if (entry) entry.lastUsedAt = Date.now();
    return entry;
  }
  put(hash, entry) {
    this.entries.set(hash, entry);
    while (this.entries.size > MAX_ENTRIES) {
      let oldestHash;
      let oldestUsed = Infinity;
      for (const [h, e] of this.entries) {
        if (e.lastUsedAt < oldestUsed) {
          oldestUsed = e.lastUsedAt;
          oldestHash = h;
        }
      }
      if (oldestHash === undefined) break;
      this.entries.delete(oldestHash);
    }
  }
  /** Scan from the end: the longest prefix with a cached entry wins. */
  findLongestMatch(hashes) {
    for (let i = hashes.length - 1; i >= 0; i--) {
      const entry = this.entries.get(hashes[i]);
      if (entry && entry.coveredCount === i + 1) {
        entry.lastUsedAt = Date.now();
        return { index: i, entry };
      }
    }
    return undefined;
  }
  /** Workflow-only snapshots can cover a tail newer than the summary's source range. */
  findLatestProtectedMatch(hashes) {
    for (let i = hashes.length - 1; i >= 0; i--) {
      const entry = this.entries.get(hashes[i]);
      const count = entry?.protectedSourceCount;
      if (
        entry?.protectedState &&
        count &&
        count <= hashes.length &&
        hashes[count - 1] === entry.protectedSourceHash
      )
        return entry;
    }
    return undefined;
  }
  persistChain = Promise.resolve();
  persistDirty = false;
  /**
   * Serialized and coalesced: concurrent calls queue behind one another
   * (so an older snapshot can never overwrite a newer one on disk) and
   * each executed write snapshots the map at execution time, collapsing
   * queued requests into a single write of the freshest state.
   */
  persist() {
    if (!this.filePath) return Promise.resolve();
    this.persistDirty = true;
    this.persistChain = this.persistChain.then(() => this.persistNow());
    return this.persistChain;
  }
  async persistNow() {
    if (!this.persistDirty || !this.filePath) return;
    this.persistDirty = false;
    this.lastPersistError = null;
    try {
      const payload = JSON.stringify(
        { version: 2, entries: Object.fromEntries(this.entries) },
        null,
        0,
      );
      const tmp = join(
        dirname(this.filePath),
        `.cache-${process.pid}-${randomUUID()}.tmp`,
      );
      await this.beforeWrite();
      await mkdir(dirname(this.filePath), { recursive: true });
      await writeFile(tmp, payload, { encoding: "utf8", mode: 0o600 });
      await rename(tmp, this.filePath);
    } catch (error) {
      this.lastPersistError = error;
      // Best-effort: a failed persist only costs a future re-summarization.
      // Swallowing also keeps the chain resolvable for future persists.
    }
  }
}
