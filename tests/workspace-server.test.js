import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

let temp, dataDir, workspacesDir, storage, sessions, workspace, safe;
beforeAll(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), "sterracode-volumes-"));
  dataDir = path.join(temp, "private-app");
  workspacesDir = path.join(temp, "shared-workspaces");
  vi.stubEnv("STERRACODE_DATA_DIR", dataDir);
  vi.stubEnv("STERRACODE_WORKSPACE_DIR", workspacesDir);
  storage = await import("../server/services/storage.js");
  sessions = await import("../server/services/sessions.js");
  workspace = await import("../server/services/workspace.js");
  safe = await import("../server/services/safeFiles.js");
  await storage.ensureDataDirs();
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await fs.rm(temp, { recursive: true, force: true });
});
const link = (target, entry) =>
  fs.symlink(target, entry, process.platform === "win32" ? "junction" : "dir");

function deferred() {
  let resolve;
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}
async function queuedBeforeDeletion(session, queueKey, operation) {
  const entered = deferred(),
    release = deferred(),
    checked = deferred();
  const marker = path.join(dataDir, "deletions", `${session.id}.json`);
  const blocker = storage.serial(queueKey, async () => {
    entered.resolve();
    await release.promise;
  });
  await entered.promise;
  const original = fs.access.bind(fs);
  const observer = vi
    .spyOn(fs, "access")
    .mockImplementation(async (file, ...args) => {
      try {
        return await original(file, ...args);
      } finally {
        if (file === marker) checked.resolve();
      }
    });
  try {
    const outcome = operation().then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await checked.promise;
    await storage.writeJSON(marker, {
      sessionId: session.id,
      status: "pending",
    });
    release.resolve();
    await blocker;
    expect((await outcome).error).toMatchObject({ code: "SESSION_DELETING" });
  } finally {
    observer.mockRestore();
    release.resolve();
    await blocker;
  }
}
describe("separate persistent app and workspace volumes", () => {
  it("rejects queued metadata and undo writes after deletion acquires the session", async () => {
    const metadata = await sessions.createSession();
    await queuedBeforeDeletion(metadata, `session:${metadata.id}`, () =>
      sessions.mutateSession(metadata.id, (s) => (s.title = "must not change")),
    );
    expect(
      JSON.parse(await fs.readFile(sessions.sessionFile(metadata.id), "utf8"))
        .title,
    ).toBe(metadata.title);
    const edited = await sessions.createSession(),
      original = await workspace.readFile(edited.id, edited.activeFile);
    const change = await workspace.writeFile(
      edited.id,
      edited.activeFile,
      "AI change",
      original.version,
      { actor: "ai" },
    );
    await queuedBeforeDeletion(edited, `workspace:${edited.id}`, () =>
      workspace.undoChange(edited.id, change.changeId),
    );
    expect(
      await fs.readFile(
        path.join(workspacesDir, edited.id, edited.activeFile),
        "utf8",
      ),
    ).toBe("AI change");
  });
  it("blocks a queued chat reservation once the deletion marker exists", async () => {
    const { runTeacher, isActive } =
      await import("../server/services/teacher.js");
    const session = await sessions.createSession(),
      entered = deferred(),
      release = deferred();
    const blocker = storage.serial(`lifecycle:${session.id}`, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
    const outcome = runTeacher({
      sessionId: session.id,
      userMessage: "must not start",
    }).then(
      (value) => ({ value }),
      (error) => ({ error }),
    );
    await storage.writeJSON(
      path.join(dataDir, "deletions", `${session.id}.json`),
      { sessionId: session.id, status: "pending" },
    );
    release.resolve();
    await blocker;
    expect((await outcome).error).toMatchObject({ code: "SESSION_DELETING" });
    expect(isActive(session.id)).toBe(false);
  });
  it("does not lazily migrate a pending-deletion snapshot after its workspace was removed", async () => {
    const session = await sessions.createSession();
    const legacy = { ...session, schemaVersion: 1, contextVersion: -1 };
    await storage.writeJSON(sessions.sessionFile(session.id), legacy);
    await storage.writeJSON(
      path.join(dataDir, "deletions", `${session.id}.json`),
      { sessionId: session.id, phase: "backed-up" },
    );
    await fs.rm(path.join(workspacesDir, session.id), { recursive: true });
    expect(await sessions.loadSession(session.id)).toEqual(legacy);
    expect(
      JSON.parse(await fs.readFile(sessions.sessionFile(session.id), "utf8")),
    ).toEqual(legacy);
    await expect(
      fs.access(path.join(workspacesDir, session.id)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("creates source files only on the configured workspace volume", async () => {
    const session = await sessions.createSession({ language: "javascript" });
    expect(storage.WORKSPACE_DIR).toBe(workspacesDir);
    expect(await storage.getWorkspacePath(session.id)).toBe(
      path.join(workspacesDir, session.id),
    );
    expect(
      await fs.readFile(
        path.join(workspacesDir, session.id, "main.js"),
        "utf8",
      ),
    ).toBe("");
    await expect(
      fs.access(path.join(dataDir, "workspaces")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const change = await workspace.writeFile(
      session.id,
      "nested/hello.js",
      "console.log('hello')",
      null,
      { actor: "ai" },
    );
    expect(
      await fs.readFile(
        path.join(workspacesDir, session.id, "nested/hello.js"),
        "utf8",
      ),
    ).toContain("hello");
    expect(
      await fs.readFile(
        path.join(dataDir, "changes", session.id, `${change.changeId}.json`),
        "utf8",
      ),
    ).toContain("hello.js");
    await workspace.undoChange(session.id, change.changeId);
    await expect(
      fs.access(path.join(workspacesDir, session.id, "nested/hello.js")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("migrates a title workspace and its divergent snapshot into the configured volume", async () => {
    const id = randomUUID(),
      title = "Altes Projekt im eigenen Volume";
    await fs.mkdir(path.join(workspacesDir, title));
    await fs.writeFile(
      path.join(workspacesDir, title, "main.py"),
      "print('original')",
    );
    await storage.writeJSON(sessions.sessionFile(id), {
      id,
      title,
      language: "python",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      messages: [],
      editorSnapshot: "print('snapshot')",
    });
    const migrated = await sessions.loadSession(id);
    expect(migrated.schemaVersion).toBe(2);
    expect((await workspace.readFile(id, "main.py")).content).toContain(
      "original",
    );
    expect(
      (await workspace.readFile(id, migrated.activeFile)).content,
    ).toContain("snapshot");
    expect(
      await fs.readFile(path.join(workspacesDir, title, "main.py"), "utf8"),
    ).toContain("original");
    expect(
      (await fs.readdir(path.join(dataDir, "backups"))).some((name) =>
        name.startsWith(id),
      ),
    ).toBe(true);
  });
  it("keeps a pending deletion visible and blocks edits before removing its workspace", async () => {
    const session = await sessions.createSession();
    const marker = path.join(dataDir, "deletions", `${session.id}.json`);
    await storage.writeJSON(marker, {
      sessionId: session.id,
      status: "pending",
    });
    expect(
      (await sessions.listSessions()).find((s) => s.id === session.id).deleting,
    ).toBe(true);
    await expect(
      workspace.writeFile(session.id, "no-new-file.py", "x", null),
    ).rejects.toMatchObject({ code: "SESSION_DELETING" });
    await expect(
      sessions.mutateSession(session.id, (s) => (s.title = "changed")),
    ).rejects.toMatchObject({ code: "SESSION_DELETING" });
    expect(
      await fs.readFile(
        path.join(workspacesDir, session.id, session.activeFile),
        "utf8",
      ),
    ).toBe("");
    await sessions.removeSession(session.id);
    await expect(
      fs.access(path.join(workspacesDir, session.id)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.access(marker)).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      (await fs.readdir(path.join(dataDir, "backups"))).some((name) =>
        name.startsWith(`deleted-${session.id}`),
      ),
    ).toBe(true);
  });
  it("filters imported secrets from settings and rejects secret updates", async () => {
    const file = path.join(dataDir, "settings.json"),
      saved = JSON.parse(await fs.readFile(file, "utf8"));
    await storage.writeJSON(file, {
      ...saved,
      apiToken: "private-imported-token",
      adminPassword: "private-password",
    });
    const settings = await storage.getSettings();
    expect(settings).not.toHaveProperty("apiToken");
    expect(settings).not.toHaveProperty("adminPassword");
    await expect(
      storage.updateSettings({ apiToken: "new-secret" }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });
  it("resumes a backed-up deletion after its workspace was already removed", async () => {
    const session = await sessions.createSession();
    const changed = await workspace.writeFile(
      session.id,
      "history.py",
      "print('history')",
      null,
      { actor: "ai" },
    );
    const backupName = `deleted-${session.id}-${randomUUID()}`;
    const backup = path.join(dataDir, "backups", backupName);
    await fs.mkdir(backup);
    await safe.copySafe(
      path.join(workspacesDir, session.id),
      path.join(backup, "workspace"),
    );
    await safe.copySafe(
      path.join(dataDir, "changes", session.id),
      path.join(backup, "changes"),
    );
    await storage.writeJSON(path.join(backup, "session.json"), session);
    await storage.writeJSON(
      path.join(dataDir, "deletions", `${session.id}.json`),
      { sessionId: session.id, phase: "backed-up", backup: backupName },
    );
    await safe.removeSafe(path.join(workspacesDir, session.id));
    await sessions.removeSession(session.id);
    await expect(
      fs.access(sessions.sessionFile(session.id)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    const record = await storage.readJSON(
      path.join(backup, "changes", `${changed.changeId}.json`),
    );
    expect(record.status).toBe("applied");
    expect(
      await fs.readFile(path.join(backup, "workspace", "history.py"), "utf8"),
    ).toContain("history");
  });
});

describe("workspace symlink boundary", () => {
  it("rejects directory links for read, write, backup and removal", async () => {
    const session = await sessions.createSession(),
      outside = path.join(temp, `outside-${randomUUID()}`);
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "protected.txt"), "private");
    const entry = path.join(workspacesDir, session.id, "escape");
    await link(outside, entry);
    await expect(
      workspace.readFile(session.id, "escape/protected.txt"),
    ).rejects.toMatchObject({ code: "PATH_DENIED" });
    await expect(
      workspace.writeFile(session.id, "escape/protected.txt", "changed", null),
    ).rejects.toMatchObject({ code: "PATH_DENIED" });
    await expect(
      safe.copySafe(entry, path.join(temp, "unsafe-copy")),
    ).rejects.toMatchObject({ code: "PATH_DENIED" });
    await expect(safe.removeSafe(entry)).rejects.toMatchObject({
      code: "PATH_DENIED",
    });
    expect(await fs.readFile(path.join(outside, "protected.txt"), "utf8")).toBe(
      "private",
    );
  });
  it.skipIf(process.platform !== "linux")(
    "pins an opened parent while a directory is replaced with an external symlink",
    async () => {
      const root = path.join(temp, `race-${randomUUID()}`),
        outside = path.join(temp, `private-${randomUUID()}`);
      await fs.mkdir(path.join(root, "parent"), { recursive: true });
      await fs.mkdir(outside);
      await fs.writeFile(path.join(root, "parent", "file.txt"), "workspace");
      await fs.writeFile(path.join(outside, "file.txt"), "private");
      const content = await safe.withSafeEntry(
        root,
        "parent/file.txt",
        async (pinnedFile) => {
          await fs.rename(
            path.join(root, "parent"),
            path.join(root, "original-parent"),
          );
          await link(outside, path.join(root, "parent"));
          const handle = await fs.open(pinnedFile, safe.readFlags);
          try {
            const result = await handle.readFile("utf8");
            await fs.writeFile(pinnedFile, "safe edit");
            return result;
          } finally {
            await handle.close();
          }
        },
      );
      expect(content).toBe("workspace");
      expect(await fs.readFile(path.join(outside, "file.txt"), "utf8")).toBe(
        "private",
      );
      expect(
        await fs.readFile(
          path.join(root, "original-parent", "file.txt"),
          "utf8",
        ),
      ).toBe("safe edit");
      await expect(
        safe.withSafeEntry(root, "parent/file.txt", (p) =>
          fs.readFile(p, "utf8"),
        ),
      ).rejects.toMatchObject({ code: "PATH_DENIED" });
    },
  );
});
