import { beforeAll, afterAll, it, expect, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { explainError, errorLocation } from "../public/js/errorCatalog.js";

let root, storage, sessions, workspace, projects, support, grading;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "sterra-support-"));
  vi.stubEnv("STERRACODE_DATA_DIR", root);
  vi.stubEnv("STERRACODE_WORKSPACE_DIR", path.join(root, "workspaces"));
  storage = await import("../server/services/storage.js");
  sessions = await import("../server/services/sessions.js");
  workspace = await import("../server/services/workspace.js");
  projects = await import("../server/services/projects.js");
  support = await import("../server/services/learningSupport.js");
  grading = await import("../server/services/testRunner.js");
  await storage.ensureDataDirs();
});
afterAll(async () => {
  vi.unstubAllEnvs();
  if (
    root &&
    path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)
  )
    await fs.rm(root, { recursive: true, force: true });
});
const template = (id = "small-website", operationId = randomUUID()) =>
  projects.importProject({ templateId: id, operationId });

it("creates all three curated templates with visible tests or checklist, without running commands", async () => {
  expect(projects.listProjectTemplates()).toHaveLength(3);
  for (const metadata of projects.listProjectTemplates()) {
    const session = await template(metadata.id);
    expect(session.project).toMatchObject({
      templateId: metadata.id,
      version: 1,
      license: "CC0-1.0",
    });
    expect(session.project.checklist.length).toBeGreaterThan(0);
    for (const file of metadata.files)
      expect(
        (await workspace.readFile(session.id, file)).content.length,
      ).toBeGreaterThan(0);
    expect(session.currentTask.done).toBe(false);
    if (metadata.language === "python")
      expect(
        session.currentTask.testSuite.cases.every(
          (c) => c.visibility === "public",
        ),
      ).toBe(true);
    else expect(session.activeFile).toBe("index.html");
  }
});
it("persists sequential hints, rejects stale tasks and records help on completion once", async () => {
  const session = await template();
  const t = session.currentTask;
  const before = await workspace.readFile(session.id, "app.js");
  const reveal = (index, taskVersion = 1) =>
    support.revealHint(session.id, t.id, { taskVersion, index });
  await expect(reveal(2)).rejects.toThrow(/einzeln/);
  await Promise.all([reveal(1), reveal(1)]);
  expect(
    (await sessions.loadSession(session.id)).currentTask.hintUsage.count,
  ).toBe(1);
  await expect(reveal(2, 2)).rejects.toMatchObject({ status: 409 });
  await reveal(2);
  expect(await workspace.readFile(session.id, "app.js")).toEqual(before);
  const completed = await grading.completeTask(session.id, {
    taskId: t.id,
    taskVersion: 1,
    assistance: "independent",
  });
  expect(completed.currentTask.completion.evidence).toMatchObject({
    hintsUsed: 2,
    assistance: "assisted",
  });
  const duplicate = await grading.completeTask(session.id, {
    taskId: t.id,
    taskVersion: 1,
  });
  expect(duplicate.currentTask.completion.eventId).toBe(
    completed.currentTask.completion.eventId,
  );
  await grading.updateTask(session.id, t.id, {
    taskVersion: 1,
    description: "Neue Aufgabe",
  });
  expect(
    (await sessions.loadSession(session.id)).currentTask.hintUsage,
  ).toBeUndefined();
});
it("keeps personal journal revisions across task changes and prevents stale overwrite, including deletion", async () => {
  const s = await template();
  const id = s.currentTask.id;
  const save = (text, expectedVersion) =>
    support.saveJournal(s.id, id, { taskVersion: 1, text, expectedVersion });
  await save("Ich verstehe Ereignisse.", 0);
  await expect(save("Veraltete Notiz", 0)).rejects.toMatchObject({
    status: 409,
  });
  await grading.updateTask(s.id, id, {
    taskVersion: 1,
    description: "Anderer Stand",
  });
  await save("Noch eine Frage offen.", 1);
  await save("", 2);
  await expect(save("Veraltete Notiz", 2)).rejects.toMatchObject({
    status: 409,
  });
  await save("Eigene neue Reflexion", 3);
  expect(await support.listJournal(s.id)).toMatchObject([
    { taskId: id, taskVersion: 1, origin: "personal", version: 4 },
  ]);
  await expect(
    support.saveJournal(s.id, "unbekannt", {
      text: "x",
      expectedVersion: 0,
      taskVersion: 1,
    }),
  ).rejects.toMatchObject({ status: 409 });
});

it("distinguishes personal manual completion from tutor assessment in the opted-in profile", async () => {
  const previous = await storage.getSettings();
  await storage.updateSettings({
    crossChatProfileEnabled: true,
    autoUpdateProfileOnTaskDone: true,
  });
  try {
    const profile = await import("../server/services/profileManager.js");
    for (const actor of ["user", "ai"]) {
      const s = await template();
      const result = await grading.completeTask(
        s.id,
        { taskId: s.currentTask.id, taskVersion: 1 },
        undefined,
        actor,
      );
      expect(result.currentTask.completion.evidence.kind).toBe("manual");
      const event = (await profile.getProfile()).events.find(
        (e) => e.sessionId === s.id,
      );
      expect(event.evidence.kind).toBe(
        actor === "user" ? "self_assessment" : "tutor",
      );
    }
  } finally {
    await storage.updateSettings({
      crossChatProfileEnabled: previous.crossChatProfileEnabled,
      autoUpdateProfileOnTaskDone: previous.autoUpdateProfileOnTaskDone,
    });
  }
});
async function exported(s) {
  const paths = await projects.projectFiles(s.id);
  const expectedVersions = {};
  for (const p of paths)
    expectedVersions[p] = (await workspace.readFile(s.id, p)).version;
  return projects.exportProject(s.id, {
    paths,
    expectedVersions,
    taskVersion: s.currentTask.taskVersion,
  });
}
it("exports explicit source and visible tasks, excludes private state and round-trips into a new session", async () => {
  const s = await template("text-analysis");
  await support.saveJournal(s.id, s.currentTask.id, {
    taskVersion: 1,
    text: "Private Reflexion",
    expectedVersion: 0,
  });
  for (const p of [
    ".env",
    "credentials.json",
    "profiles/user.json",
    ".git/config",
    "backups/file.py",
  ])
    await workspace.writeFile(s.id, p, "SECRET", null);
  const pkg = await exported(s);
  expect(pkg.files.map((f) => f.path)).toEqual(["main.py"]);
  expect(JSON.stringify(pkg)).not.toMatch(
    /SECRET|Private Reflexion|learningJournal|completion|profileEnabled/,
  );
  const imported = await projects.importProject({
    package: pkg,
    operationId: randomUUID(),
  });
  expect(imported.id).not.toBe(s.id);
  expect(imported.activeFile).toBe(pkg.activeFile);
  expect(imported.currentTask.id).not.toBe(s.currentTask.id);
  expect(imported.learningJournal).toBeUndefined();
  expect((await workspace.readFile(imported.id, "main.py")).content).toBe(
    pkg.files[0].content,
  );
});
it("rejects traversal, link metadata, duplicate/colliding paths, hidden tests, manifest damage and limits", async () => {
  const pkg = await exported(await template("text-analysis"));
  const corruptions = [
    (p) => {
      p.schemaVersion = 2;
    },
    (p) => {
      p.files[0].path = "../evil.py";
    },
    (p) => {
      p.files[0].path = "C:/evil.py";
    },
    (p) => {
      p.files[0].path = "a\\b.py";
    },
    (p) => {
      p.files[0].link = "other.py";
    },
    (p) => {
      p.files[0].content += "tampered";
    },
    (p) => {
      p.files.push({ ...p.files[0], path: "MAIN.py" });
    },
    (p) => {
      p.files.push({ ...p.files[0], path: "main.py/child.py" });
    },
    (p) => {
      p.files[0].path = ".env";
    },
    (p) => {
      p.files = Array.from({ length: 51 }, (_, i) => ({
        ...p.files[0],
        path: `${i}.py`,
      }));
    },
    (p) => {
      p.task.testSuite.cases[0].visibility = "hidden";
    },
    (p) => {
      p.task.testSuite.entry.path = "missing.py";
    },
    (p) => {
      const f = p.files[0];
      f.content = "a".repeat(2 * 1024 * 1024 + 1);
      f.bytes = f.content.length;
      f.version = createHash("sha256").update(f.content).digest("hex");
    },
  ];
  for (const corrupt of corruptions) {
    const p = structuredClone(pkg);
    corrupt(p);
    expect(() => projects.validateProjectPackage(p)).toThrow();
  }
});
it("deduplicates import operations, rejects different payloads and never silently restarts interrupted imports", async () => {
  const operationId = randomUUID();
  const results = await Promise.all([
    template("guess-number", operationId),
    template("guess-number", operationId),
  ]);
  expect(results[0].id).toBe(results[1].id);
  await expect(template("text-analysis", operationId)).rejects.toMatchObject({
    code: "IDEMPOTENCY_CONFLICT",
  });
  await fs.unlink(sessions.sessionFile(results[0].id));
  await expect(template("guess-number", operationId)).rejects.toMatchObject({
    code: "IMPORT_INTERRUPTED",
  });
});
it("refuses stale export versions and symlink source access", async () => {
  const s = await template("text-analysis");
  await expect(
    projects.exportProject(s.id, {
      paths: ["main.py"],
      expectedVersions: { "main.py": "stale" },
      taskVersion: 1,
    }),
  ).rejects.toMatchObject({ status: 409 });
  // Directory junction creation does not require Windows symlink privileges.
  const target = path.join(root, `outside-${randomUUID()}`);
  await fs.mkdir(target);
  await fs.writeFile(path.join(target, "main.py"), "private");
  await fs.symlink(
    target,
    path.join(root, "workspaces", s.id, "linked"),
    process.platform === "win32" ? "junction" : "dir",
  );
  await expect(
    projects.exportProject(s.id, {
      paths: ["linked/main.py"],
      expectedVersions: {},
      taskVersion: 1,
    }),
  ).rejects.toMatchObject({ status: 403 });
});
it("explains only curated error patterns and resolves workspace locations without library basename guesses", () => {
  expect(
    explainError({ message: "IndexError: list index out of range" }).title,
  ).toMatch(/Index/);
  expect(
    explainError({ message: "SyntaxError: invalid syntax" }).category,
  ).toBe("Syntaxfehler");
  expect(explainError({ message: "A strange result" }).category).toBe(
    "Unbekannter Fehler",
  );
  expect(
    explainError({ message: "some output says TypeError: perhaps" }).category,
  ).toBe("Unbekannter Fehler");
  expect(explainError({ kind: "return" }).category).toBe(
    "Abweichendes Ergebnis",
  );
  expect(explainError({ kind: "timeout" }).category).toBe(
    "Ausführung / Infrastruktur",
  );
  const id = randomUUID();
  expect(
    errorLocation(
      `File "C:\\workspaces\\${id}\\main.py", line 8\nIndexError: x`,
      ["main.py"],
      id,
    ),
  ).toEqual({ file: "main.py", line: 8 });
  expect(
    errorLocation('File "/library/main.py", line 4', ["main.py"], id),
  ).toBeNull();
  expect(
    errorLocation('File "../main.py", line 4', ["main.py"], id),
  ).toBeNull();
  expect(
    errorLocation(
      `at run (file:///workspaces/${id}/app.js:12:3)`,
      ["app.js"],
      id,
    ),
  ).toEqual({ file: "app.js", line: 12 });
});
