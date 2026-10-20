import { beforeAll, afterAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { crc32, deflateRawSync } from "node:zlib";
import { Readable } from "node:stream";
import http from "node:http";

let directory, imports, tree, sessions, storage, origin, protectedOrigin, app;
const servers = [];
async function serve(application) {
  const server = http.createServer(application);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}
beforeAll(async () => {
  directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "sterracode-codebase-imports-"),
  );
  vi.stubEnv("STERRACODE_DATA_DIR", path.join(directory, "data"));
  vi.stubEnv("STERRACODE_WORKSPACE_DIR", path.join(directory, "workspaces"));
  storage = await import("../server/services/storage.js");
  imports = await import("../server/services/codebaseImports.js");
  tree = await import("../server/services/codebaseTree.js");
  sessions = await import("../server/services/sessions.js");
  await storage.ensureDataDirs();
  const { createApp } = await import("../server/app.js");
  const { loadConfig } = await import("../server/config.js");
  app = createApp();
  origin = await serve(app);
  protectedOrigin = await serve(
    createApp({
      config: loadConfig({
        STERRACODE_MODE: "server",
        STERRACODE_PUBLIC_URL: "http://127.0.0.1:3000",
        STERRACODE_DATA_DIR: path.join(directory, "protected"),
      }),
      auth: {
        authenticate: async () => false,
        status: async () => ({ setupRequired: false }),
      },
    }),
  );
});
afterAll(async () => {
  for (const server of servers) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  vi.unstubAllEnvs();
  await fs.rm(directory, { recursive: true, force: true });
});

function zip(entries) {
  const local = [],
    central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path),
      data = Buffer.from(entry.content || ""),
      compressed = entry.compress ? deflateRawSync(data) : data;
    const crc = entry.crc ?? crc32(data);
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x800 | (entry.encrypted ? 1 : 0), 6);
    head.writeUInt16LE(entry.compress ? 8 : 0, 8);
    head.writeUInt32LE(crc, 14);
    head.writeUInt32LE(compressed.length, 18);
    head.writeUInt32LE(entry.bytes ?? data.length, 22);
    head.writeUInt16LE(name.length, 26);
    local.push(head, name, compressed);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50);
    c.writeUInt16LE(0x314, 4);
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0x800 | (entry.encrypted ? 1 : 0), 8);
    c.writeUInt16LE(entry.compress ? 8 : 0, 10);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(compressed.length, 20);
    c.writeUInt32LE(entry.bytes ?? data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt32LE(((entry.mode ?? 0o100644) << 16) >>> 0, 38);
    c.writeUInt32LE(offset, 42);
    central.push(c, name);
    offset += head.length + name.length + compressed.length;
  }
  const centralBytes = Buffer.concat(central),
    end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBytes, end]);
}
async function upload(entries, body = {}) {
  const job = await imports.createCodebaseImport({
    operationId: randomUUID(),
    source: { kind: "zip" },
    title: "Test repository",
    ...body,
  });
  const bytes = zip(entries);
  return imports.uploadCodebaseArchive(job.id, Readable.from([bytes]), {
    contentLength: bytes.length,
  });
}
async function completed(id) {
  for (let i = 0; i < 400; i++) {
    const job = await imports.getCodebaseImport(id);
    if (["completed", "failed", "cancelled", "interrupted"].includes(job.state))
      return job;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw Error("Import did not settle");
}
const selectionBody = (job) => ({
  manifestVersion: job.manifestVersion,
  selectionVersion: job.selectionVersion,
  selectionDigest: job.selectionDigest,
});

describe("codebase ZIP quarantine and publication", () => {
  it("streams a selected byte-exact snapshot into one separate codebase session", async () => {
    const binary = Buffer.from([0, 255, 1, 10]);
    let job = await upload([
      { path: "project/README.md", content: "Grüße\r\n" },
      { path: "project/src/app.xyz", content: "unknown source" },
      { path: "project/node_modules/generated.js", content: "generated" },
      { path: "project/image.bin", content: binary },
      { path: "project/.env", content: "SYNTHETIC_SECRET" },
      { path: "project/.git/config", content: "config" },
    ]);
    expect(job.state).toBe("awaiting_selection");
    expect(job.summary.selectedFiles).toBe(2);
    expect(await sessions.listSessions()).toHaveLength(0);
    const preview = await imports.codebaseImportPreview(
      job.id,
      "project/README.md",
    );
    expect(preview.content).toBe("Grüße\r\n");
    expect(
      await imports.codebaseImportPreview(job.id, "project/.env"),
    ).not.toHaveProperty("content");
    job = await imports.updateCodebaseSelection(job.id, {
      ...selectionBody(job),
      profile: "all",
      rootMapping: "project",
    });
    expect(job.summary.selectedFiles).toBe(4);
    const request = selectionBody(job);
    const queued = await imports.commitCodebaseImport(job.id, request);
    expect(
      (await imports.commitCodebaseImport(job.id, request)).sessionId,
    ).toBe(queued.sessionId);
    const result = await completed(job.id);
    expect(result.state, JSON.stringify(result.error)).toBe("completed");
    expect(await sessions.listSessions()).toHaveLength(1);
    const session = await sessions.loadSession(result.sessionId);
    expect(session).toMatchObject({
      mode: "codebase",
      language: null,
      activeFile: null,
      messages: [],
    });
    expect(
      await fs.readFile(
        path.join(storage.WORKSPACE_DIR, result.sessionId, "README.md"),
        "utf8",
      ),
    ).toBe("Grüße\r\n");
    expect(
      await fs.readFile(
        path.join(storage.WORKSPACE_DIR, result.sessionId, "image.bin"),
      ),
    ).toEqual(binary);
    await expect(
      fs.access(path.join(storage.WORKSPACE_DIR, result.sessionId, ".env")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect((await imports.cancelCodebaseImport(job.id)).state).toBe(
      "completed",
    );
    expect(
      (await imports.commitCodebaseImport(job.id, request)).sessionId,
    ).toBe(result.sessionId);
    expect((await imports.deleteCodebaseImport(job.id)).sessionId).toBe(
      result.sessionId,
    );
    expect(await sessions.loadSession(result.sessionId)).toHaveProperty(
      "id",
      result.sessionId,
    );
  });
  it("binds creation IDs and selection versions to their exact payload", async () => {
    const operationId = randomUUID(),
      body = { operationId, source: { kind: "zip" }, title: "first" };
    const first = await imports.createCodebaseImport(body);
    expect((await imports.createCodebaseImport(body)).id).toBe(first.id);
    await expect(
      imports.createCodebaseImport({ ...body, title: "different" }),
    ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", status: 409 });
    const job = await upload([
      { path: "README.md", content: "only documentation" },
    ]);
    const selection = await imports.updateCodebaseSelection(job.id, {
      ...selectionBody(job),
      profile: "none",
    });
    expect(selection.summary.selectedFiles).toBe(0);
    await expect(
      imports.commitCodebaseImport(job.id, selectionBody(job)),
    ).rejects.toMatchObject({ code: "IMPORT_SELECTION_CONFLICT" });
    await expect(
      imports.commitCodebaseImport(job.id, selectionBody(selection)),
    ).rejects.toMatchObject({ code: "IMPORT_EMPTY_SELECTION" });
    await imports.cancelCodebaseImport(job.id);
  });
  it.each([
    "https://SYNTHETIC_PRIVATE_TOKEN@example.com/repository.git",
    "https://example.com/repository.git?token=SYNTHETIC_PRIVATE_TOKEN",
    "https://example.com/" + "a".repeat(2048),
    "\nhttps://example.com/repository.git",
  ])(
    "rejects unsafe Git source syntax before writing a receipt",
    async (repositoryUrl) => {
      const operationId = randomUUID();
      await expect(
        imports.createCodebaseImport({
          operationId,
          source: { kind: "git", repositoryUrl },
        }),
      ).rejects.toBeTruthy();
      await expect(
        fs.access(
          path.join(
            storage.DATA_DIR,
            "codebase-imports",
            `${operationId}.json`,
          ),
        ),
      ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );
  it.each([
    "../escape",
    "a/../escape",
    "/absolute",
    "C:/drive",
    "\\\\server\\share",
    "a\\..\\escape",
    "a\0bad",
    "NUL.txt",
    "trailing. ",
    "a/./b",
  ])("rejects unsafe path %s before publication", async (p) => {
    await expect(
      upload([{ path: p, content: "never published" }]),
    ).rejects.toBeTruthy();
  });
  it("rejects invalid UTF-8 ZIP names instead of silently replacing bytes", async () => {
    await expect(
      upload([{ path: Buffer.from([0xff]), content: "unrepresentable name" }]),
    ).rejects.toMatchObject({ code: "IMPORT_PATH_ENCODING_INVALID" });
  });
  it.each([
    [
      { path: "a", content: "1" },
      { path: "a", content: "2" },
    ],
    [
      { path: "a", content: "1" },
      { path: "A", content: "2" },
    ],
    [
      { path: "é", content: "1" },
      { path: "e\u0301", content: "2" },
    ],
    [
      { path: "folder", content: "1" },
      { path: "folder/a", content: "2" },
    ],
  ])("rejects portable path collisions", async (...entries) => {
    await expect(upload(entries)).rejects.toMatchObject({
      code: "IMPORT_PATH_COLLISION",
    });
  });
  it("locks symlinks and encrypted entries, validates CRC, and accepts high compression", async () => {
    let job = await upload([
      { path: "link", content: "../outside", mode: 0o120777 },
      { path: "safe.txt", content: "a".repeat(200000), compress: true },
    ]);
    const page = await imports.codebaseImportTree(job.id);
    expect(page.entries.find((entry) => entry.path === "link")).toMatchObject({
      locked: true,
      selected: false,
      reason: "specialFile",
    });
    expect(job.summary.selectedFiles).toBe(1);
    await imports.commitCodebaseImport(job.id, selectionBody(job));
    const compressionResult = await completed(job.id);
    expect(
      compressionResult.state,
      JSON.stringify(compressionResult.error),
    ).toBe("completed");
    await expect(
      upload([{ path: "encrypted", encrypted: true, compress: true }]),
    ).rejects.toMatchObject({ code: "IMPORT_UNSUPPORTED_ARCHIVE" });
    job = await upload([{ path: "bad.txt", content: "bad crc", crc: 1 }]);
    await imports.commitCodebaseImport(job.id, selectionBody(job));
    expect(await completed(job.id)).toMatchObject({
      state: "failed",
      error: { code: "IMPORT_INTEGRITY_FAILED" },
    });
  });
  it("applies limits before extraction without treating compression ratio as a limit", async () => {
    vi.stubEnv("STERRACODE_IMPORT_EXTRACTED_BYTES", "10");
    try {
      await expect(
        upload([
          { path: "large.txt", content: "a".repeat(100), compress: true },
        ]),
      ).rejects.toMatchObject({ code: "IMPORT_EXTRACTED_LIMIT" });
    } finally {
      vi.stubEnv("STERRACODE_IMPORT_EXTRACTED_BYTES", "");
    }
    const job = await imports.createCodebaseImport({
      operationId: randomUUID(),
      source: { kind: "zip" },
    });
    vi.stubEnv("STERRACODE_IMPORT_UPLOAD_BYTES", "10");
    try {
      await expect(
        imports.uploadCodebaseArchive(
          job.id,
          Readable.from([Buffer.alloc(11)]),
          { contentLength: 11 },
        ),
      ).rejects.toMatchObject({ code: "IMPORT_UPLOAD_LIMIT" });
    } finally {
      vi.stubEnv("STERRACODE_IMPORT_UPLOAD_BYTES", "");
    }
  });
  it("recovers a published session after a lost completion write and never repeats network work", async () => {
    let job = await upload([{ path: "one.txt", content: "one" }]);
    await imports.commitCodebaseImport(job.id, selectionBody(job));
    job = await completed(job.id);
    await (
      await import("../server/services/codebaseJobs.js")
    ).waitForCodebaseJobs();
    const file = path.join(
      storage.DATA_DIR,
      "codebase-imports",
      `${job.id}.json`,
    );
    const receipt = await storage.readJSON(file);
    receipt.state = "publishing";
    await storage.writeJSON(file, receipt);
    expect((await imports.getCodebaseImport(job.id)).state).toBe("completed");
    const interrupted = await imports.createCodebaseImport({
      operationId: randomUUID(),
      source: { kind: "zip" },
    });
    const interruptedFile = path.join(
      storage.DATA_DIR,
      "codebase-imports",
      `${interrupted.id}.json`,
    );
    const incomplete = await storage.readJSON(interruptedFile);
    incomplete.state = "receiving";
    await storage.writeJSON(interruptedFile, incomplete);
    expect((await imports.getCodebaseImport(interrupted.id)).state).toBe(
      "interrupted",
    );
  });
  it("expires restored waiting jobs when private source data was deliberately omitted", async () => {
    const job = await upload([
      { path: "readme.txt", content: "A quarantined source" },
    ]);
    await fs.rm(path.join(storage.DATA_DIR, "codebase-imports", job.id), {
      recursive: true,
    });
    expect(await imports.getCodebaseImport(job.id)).toMatchObject({
      state: "expired",
      error: { code: "IMPORT_SOURCE_EXPIRED" },
    });
    await expect(
      imports.commitCodebaseImport(job.id, selectionBody(job)),
    ).rejects.toMatchObject({ code: "IMPORT_SELECTION_STATE" });
  });
  it("enforces a wall-clock deadline even when an upload stops producing bytes", async () => {
    const job = await imports.createCodebaseImport({
      operationId: randomUUID(),
      source: { kind: "zip" },
    });
    vi.stubEnv("STERRACODE_IMPORT_DURATION_MS", "30");
    const idle = new Readable({ read() {} });
    try {
      await expect(
        imports.uploadCodebaseArchive(job.id, idle),
      ).rejects.toMatchObject({ code: "IMPORT_TIMEOUT" });
    } finally {
      vi.stubEnv("STERRACODE_IMPORT_DURATION_MS", "");
    }
    expect(await imports.getCodebaseImport(job.id)).toMatchObject({
      state: "failed",
      error: { code: "IMPORT_TIMEOUT" },
    });
  });
});

describe("bounded tree and selection summaries", () => {
  it("keeps status and tree pages bounded for 10,000 top-level manifest entries", async () => {
    const job = await upload(
      Array.from({ length: 10000 }, (_, index) => ({
        path: `f${String(index).padStart(5, "0")}.txt`,
        content: "",
      })),
    );
    expect(job.rootCount).toBe(10000);
    expect(job.rootSuggestion).toBeNull();
    expect(JSON.stringify(job).length).toBeLessThan(8192);
    const started = Date.now();
    const page = await imports.codebaseImportTree(job.id, { limit: 200 });
    const elapsed = Date.now() - started;
    if (process.env.STERRACODE_CODEBASE_BENCHMARK === "1")
      console.log(
        JSON.stringify({
          benchmark: "manifest-first-tree-page",
          entries: 10000,
          pageSize: 200,
          milliseconds: elapsed,
          platform: process.platform,
          architecture: process.arch,
          node: process.version,
        }),
      );
    expect(page.entries).toHaveLength(200);
    expect(page.nextCursor).toBeTruthy();
    expect(elapsed).toBeLessThan(5000);
    await imports.cancelCodebaseImport(job.id);
  });
  it("binds cursors to complete folder rules even for unloaded pages", async () => {
    let job = await upload(
      Array.from({ length: 650 }, (_, i) => ({
        path: `src/f${String(i).padStart(4, "0")}.js`,
        content: "x",
      })),
    );
    let page = await imports.codebaseImportTree(job.id, {
      parent: "src",
      limit: 200,
    });
    expect(page.entries).toHaveLength(200);
    expect(page.nextCursor).toBeTruthy();
    const next = await imports.codebaseImportTree(job.id, {
      parent: "src",
      limit: 200,
      cursor: page.nextCursor,
    });
    expect(next.entries[0].path).toBe("src/f0200.js");
    job = await imports.updateCodebaseSelection(job.id, {
      ...selectionBody(job),
      rules: [
        { path: "src", selected: false },
        { path: "src/f0649.js", selected: true },
      ],
    });
    expect(job.summary).toMatchObject({ selectedFiles: 1, selectedBytes: 1 });
    await expect(
      imports.codebaseImportTree(job.id, {
        parent: "src",
        cursor: page.nextCursor,
      }),
    ).rejects.toMatchObject({ code: "STALE_CURSOR" });
    page = await imports.codebaseImportTree(job.id);
    expect(page.entries[0]).toMatchObject({
      selected: null,
      files: 650,
      selectedFiles: 1,
    });
    await imports.cancelCodebaseImport(job.id);
  });
  it.each([499999999, 500000000, 500000001])(
    "warns only above the decimal threshold at %s bytes",
    async (bytes) => {
      const file = path.join(directory, `${bytes}.jsonl`);
      await fs.writeFile(
        file,
        JSON.stringify({
          path: "large",
          type: "file",
          bytes,
          locked: false,
          defaultSelected: true,
        }) + "\n",
      );
      const summary = await tree.selectionSummary(
        file,
        { profile: "recommended", rules: [], rootMapping: "" },
        "manifest",
      );
      expect(summary.requiresConfirmation).toBe(bytes > 500000000);
    },
  );
  it("pages a workspace beyond the legacy 5,000-entry tree limit", async () => {
    const session = await sessions.createSession();
    const root = path.join(storage.WORKSPACE_DIR, session.id);
    for (let offset = 0; offset < 10000; offset += 100)
      await Promise.all(
        Array.from({ length: 100 }, (_, i) =>
          fs.writeFile(
            path.join(root, `f${String(offset + i).padStart(5, "0")}.txt`),
            "",
          ),
        ),
      );
    const started = Date.now();
    const page = await tree.workspaceTreePage(session.id, { limit: 200 });
    expect(page.entries).toHaveLength(200);
    expect(page.nextCursor).toBeTruthy();
    const elapsed = Date.now() - started;
    if (process.env.STERRACODE_CODEBASE_BENCHMARK === "1")
      console.log(
        JSON.stringify({
          benchmark: "workspace-first-tree-page",
          entries: 10000,
          pageSize: 200,
          milliseconds: elapsed,
          platform: process.platform,
          architecture: process.arch,
          node: process.version,
        }),
      );
    expect(elapsed).toBeLessThan(5000);
    const next = await tree.workspaceTreePage(session.id, {
      limit: 200,
      cursor: page.nextCursor,
    });
    expect(next.entries[0].path).toBe("f00200.txt");
    await fs.writeFile(path.join(root, "a-new-file.txt"), "");
    await expect(
      tree.workspaceTreePage(session.id, { cursor: page.nextCursor }),
    ).rejects.toMatchObject({ code: "STALE_CURSOR" });
  }, 20000);
});

describe("authenticated narrow binary upload transport", () => {
  it("retains authentication, origin and JSON requirements around the one upload route", async () => {
    const id = randomUUID();
    const bytes = zip([{ path: "readme.txt", content: "text" }]);
    const protectedResponse = await fetch(
      `${protectedOrigin}/api/codebase/imports/${id}/upload`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/zip" },
        body: bytes,
      },
    );
    expect(protectedResponse.status).toBe(401);
    const denied = await fetch(`${origin}/api/codebase/imports/${id}/upload`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/zip",
        Origin: "https://foreign.example",
      },
      body: bytes,
    });
    expect(denied.status).toBe(403);
    for (const endpoint of [
      "/api/sessions",
      `/api/codebase/imports/${id}/cancel`,
      `/api/codebase/imports/${id}/selection`,
    ]) {
      const response = await fetch(origin + endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/zip" },
        body: bytes,
      });
      expect(response.status).toBe(415);
    }
    const created = await fetch(`${origin}/api/codebase/imports`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ operationId: id, source: { kind: "zip" } }),
    });
    expect(created.status).toBe(202);
    const wrong = await fetch(`${origin}/api/codebase/imports/${id}/upload`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: "{}",
    });
    expect(wrong.status).toBe(415);
    // The ordinary JSON parser remains capped at 4 MiB. The raw archive stream
    // can legitimately exceed that size without buffering in express.json().
    const largeZip = zip([
      { path: "data.txt", content: "x".repeat(4 * 1024 ** 2 + 1) },
    ]);
    const uploaded = await fetch(
      `${origin}/api/codebase/imports/${id}/upload`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/zip" },
        body: largeZip,
      },
    );
    expect(uploaded.status).toBe(202);
    expect(await uploaded.json()).toMatchObject({
      state: "awaiting_selection",
      summary: { selectedFiles: 1, selectedBytes: 4 * 1024 ** 2 + 1 },
    });
    const events = await fetch(`${origin}/api/codebase/imports/${id}/events`);
    expect(events.headers.get("content-type")).toContain("text/event-stream");
    const frame = await events.text();
    expect(frame).toContain('"phase":"awaiting_selection"');
    expect(frame).not.toContain("xxxx");
    const repeat = await fetch(`${origin}/api/codebase/imports/${id}/upload`, {
      method: "PUT",
      headers: { "Content-Type": "application/zip" },
      body: bytes,
    });
    expect(repeat.status).toBe(409);
    await imports.cancelCodebaseImport(id);
  });
  it("rejects new upload work during maintenance", async () => {
    app.locals.beginMaintenance();
    const response = await fetch(
      `${origin}/api/codebase/imports/${randomUUID()}/upload`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/zip" },
        body: zip([]),
      },
    );
    expect(response.status).toBe(503);
  });
});
