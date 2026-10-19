import { beforeAll, afterAll, it, expect, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { validateSuite } from "../runner/grading/schema.js";
import { validatePayload } from "../runner/jobs.js";

let root, storage, sessions, workspace, grading, processes, tools, profile;
const suite = () => ({
  schemaVersion: 1,
  version: 1,
  language: "python",
  entry: { path: "main.py", function: "reverse_string" },
  comparison: { kind: "strict-json" },
  cases: [
    {
      id: "word",
      name: "Einfaches Wort",
      args: ["hello"],
      expected: "olleh",
      visibility: "public",
      required: true,
    },
    {
      id: "empty",
      name: "Leerer String",
      args: [""],
      expected: "",
      visibility: "public",
      required: true,
    },
  ],
});
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "sterra-grading-"));
  vi.stubEnv("STERRACODE_DATA_DIR", root);
  storage = await import("../server/services/storage.js");
  sessions = await import("../server/services/sessions.js");
  workspace = await import("../server/services/workspace.js");
  grading = await import("../server/services/testRunner.js");
  processes = await import("../server/services/processes.js");
  tools = await import("../server/services/toolExecutor.js");
  profile = await import("../server/services/profileManager.js");
  await storage.ensureDataDirs();
});
afterAll(async () => {
  await processes?.stopAllProcesses();
  vi.unstubAllEnvs();
  if (root?.startsWith(path.join(os.tmpdir(), "sterra-grading-")))
    await fs.rm(root, { recursive: true, force: true });
});
async function fixture(
  code = "def reverse_string(s):\n    return s[::-1]\n",
  definition = suite(),
) {
  const s = await sessions.createSession({
    title: "Tests",
    language: "python",
  });
  const initial = await workspace.readFile(s.id, "main.py");
  const f = await workspace.writeFile(s.id, "main.py", code, initial.version);
  const created = await tools.executeTool(
    "create_task",
    {
      title: "Strings umkehren",
      description: "Gib den String in umgekehrter Reihenfolge zurück.",
      difficulty: "beginner",
      conceptIds: ["python.functions", "python.strings"],
      testSuite: definition,
    },
    { sessionId: s.id },
  );
  expect(created.type).toBe("create_task");
  return {
    s,
    task: created.task,
    body: {
      operationId: randomUUID(),
      taskVersion: 1,
      expectedVersions: { "main.py": f.version },
    },
  };
}
async function finished(f) {
  const started = await grading.startTaskTests(f.s.id, f.task.id, f.body);
  for (let i = 0; i < 150; i++) {
    const r = await grading.getTaskTestResults(f.s.id, started.testRunId);
    if (!["starting", "running"].includes(r.status)) return r;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("Suite did not finish");
}
const completion = (f, r) => ({
  taskId: f.task.id,
  taskVersion: 1,
  testRunId: r.testRunId,
});
it("validiert Daten, Adapter, Pfade, Typen und Grenzen vor der Ausführung", () => {
  expect(validateSuite(suite())).toEqual(suite());
  for (const mutate of [
    (s) => s.cases.push(s.cases[0]),
    (s) => (s.entry.path = "../bad.py"),
    (s) => (s.entry.function = "eval(x)"),
    (s) => (s.cases[0].visibility = "hidden"),
    (s) => (s.cases[0].expected = Infinity),
    (s) => (s.cases = Array(21).fill(s.cases[0])),
    (s) => (s.cases[0].args = ["a".repeat(262144)]),
    (s) => (s.comparison.kind = "tolerant"),
  ]) {
    const s = suite();
    mutate(s);
    expect(() => validateSuite(s)).toThrow();
  }
  expect(
    validatePayload({
      sessionId: randomUUID(),
      type: "test",
      test: { suite: suite(), files: [{ path: "main.py", content: "" }] },
    }),
  ).toMatchObject({
    type: "test",
    language: "python",
    executionTimeout: 30000,
  });
});
it("führt reverse_string durch beide Fälle, HTTP-Retry und genau einen Profilabschluss", async () => {
  await storage.updateSettings({
    crossChatProfileEnabled: true,
    autoUpdateProfileOnTaskDone: true,
  });
  const f = await fixture();
  const r = await finished(f);
  expect(r).toMatchObject({
    status: "finished",
    assessment: "passed",
    current: true,
    summary: { passed: 2, failed: 0, total: 2 },
  });
  expect(r.snapshot).toBeUndefined();
  expect(r.runtime.version).toMatch(/^\d+\./);
  expect(
    (await grading.startTaskTests(f.s.id, f.task.id, f.body)).testRunId,
  ).toBe(r.testRunId);
  await expect(
    grading.startTaskTests(f.s.id, f.task.id, { ...f.body, taskVersion: 2 }),
  ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  const before =
    (await profile.getProfile()).languages.python?.tasksSucceeded || 0;
  const first = await grading.completeTask(f.s.id, completion(f, r));
  vi.resetModules(); // durable evidence and profile deduplication survive module restart
  const restarted = await import("../server/services/testRunner.js");
  const second = await restarted.completeTask(f.s.id, completion(f, r));
  expect(first.currentTask.completion).toEqual(second.currentTask.completion);
  expect((await profile.getProfile()).languages.python.tasksSucceeded).toBe(
    before + 1,
  );
  expect(await restarted.listTaskTestRuns(f.s.id, f.task.id)).toHaveLength(1);
});
it("zeigt konkrete falsche Rückgaben, Typunterschiede und frische globale Zustände", async () => {
  let f = await fixture(
    "count=0\ndef reverse_string(s):\n    global count\n    count += 1\n    return s[::-1] if count == 1 else 'wrong'\n",
  );
  expect((await finished(f)).assessment).toBe("passed");
  f = await fixture("def reverse_string(s):\n    return s\n");
  const r = await finished(f);
  expect(r).toMatchObject({
    assessment: "failed",
    summary: { passed: 1, failed: 1 },
    cases: [
      { actual: "hello", expected: "olleh", passed: false },
      { passed: true },
    ],
  });
  await expect(
    grading.completeTask(f.s.id, completion(f, r)),
  ).rejects.toMatchObject({ status: 409 });
  const def = suite();
  def.cases[0].expected = true;
  f = await fixture("def reverse_string(s):\n    return 1\n", def);
  expect((await finished(f)).cases[0].passed).toBe(false);
});
it("wertet gedruckte Erfolgsmeldungen, fehlende und ungültige Protokolle nie als Erfolg", async () => {
  for (const code of [
    'import os\nprint(\'{"kind":"return","actual":"olleh","passed":true}\', flush=True)\nos._exit(0)\n',
    'import sys\nopen(sys.argv[-1], "w").write("bad json")\nimport os\nos._exit(0)\n',
  ]) {
    const r = await finished(await fixture(code));
    expect(r.assessment).toBe("inconclusive");
    expect(r.cases.every((c) => !c.passed)).toBe(true);
  }
});
it("unterscheidet Import-/Syntaxfehler, unzulässige Rückgaben und Ausgabegrenzen", async () => {
  for (const [code, kind] of [
    ["def broken(:\n", "program_error"],
    ["import nonexistent_sterra_module\n", "program_error"],
    ["def reverse_string(s):\n    return {1,2}\n", "serialization_error"],
    [
      "def reverse_string(s):\n    a=[]\n    a.append(a)\n    return a\n",
      "serialization_error",
    ],
    [
      "def reverse_string(s):\n    return float('nan')\n",
      "serialization_error",
    ],
  ]) {
    const r = await finished(await fixture(code));
    expect(r.cases[0].kind).toBe(kind);
    expect(r.assessment).toBe("failed");
  }
  const r = await finished(
    await fixture(
      "def reverse_string(s):\n    print('x'*100000)\n    return s[::-1]\n",
    ),
  );
  expect(r.assessment).toBe("passed");
  expect(r.cases[0].outputTruncated).toBe(true);
  expect(r.cases[0].output.length).toBeLessThanOrEqual(65536);
});
it("entwertet Erfolg nach Code- und Suiteänderung und archiviert Aufgabenstände", async () => {
  const f = await fixture(),
    r = await finished(f);
  const file = await workspace.readFile(f.s.id, "main.py");
  const changed = await workspace.writeFile(
    f.s.id,
    "main.py",
    "# neu\n" + file.content,
    file.version,
  );
  expect((await grading.getTaskTestResults(f.s.id, r.testRunId)).current).toBe(
    false,
  );
  await expect(
    grading.completeTask(f.s.id, completion(f, r)),
  ).rejects.toMatchObject({ status: 409 });
  await workspace.writeFile(f.s.id, "main.py", file.content, changed.version);
  await grading.updateTask(f.s.id, f.task.id, {
    taskVersion: 1,
    description: "Neuer Vertrag",
  });
  await expect(
    grading.completeTask(f.s.id, completion(f, r)),
  ).rejects.toMatchObject({ status: 409 });
  const s = await sessions.loadSession(f.s.id);
  expect(s.currentTask).toMatchObject({
    taskVersion: 2,
    testSuite: { version: 2 },
  });
  expect(s.taskHistory).toHaveLength(1);
});
it("Timeout und Abbruch beenden Suite und reservierten Session-Slot", async () => {
  let f = await fixture("def reverse_string(s):\n    while True: pass\n");
  const r = await finished(f);
  expect(r.cases.map((c) => c.kind)).toEqual(["timeout", "not_run"]);
  f = await fixture("def reverse_string(s):\n    while True: pass\n");
  const run = await grading.startTaskTests(f.s.id, f.task.id, f.body);
  await expect(
    processes.startProcess({
      sessionId: f.s.id,
      command: "echo should-not-start",
    }),
  ).rejects.toMatchObject({ status: 409 });
  await new Promise((r) => setTimeout(r, 150));
  const cancelled = await grading.cancelTaskTests(f.s.id, run.testRunId);
  expect(cancelled.status).toBe("cancelled");
  expect((await grading.cancelTaskTests(f.s.id, run.testRunId)).status).toBe(
    "cancelled",
  );
  const normal = await processes.startProcess({
    sessionId: f.s.id,
    command: "echo free",
  });
  await processes.waitProcess(normal.processId, f.s.id);
});
it("schützt fremde Sessions, alte Manifeststände und KI-Ausführung", async () => {
  const f = await fixture();
  await expect(
    grading.startTaskTests(f.s.id, f.task.id, {
      ...f.body,
      expectedVersions: { "main.py": "a".repeat(64) },
    }),
  ).rejects.toMatchObject({ status: 409 });
  await storage.updateSettings({ allowAITerminalCommands: false });
  expect(
    await tools.executeTool(
      "run_task_tests",
      { ...f.body, taskId: f.task.id },
      { sessionId: f.s.id },
    ),
  ).toMatchObject({ type: "tool_error", code: "TERMINAL_DISABLED" });
  const r = await finished(f);
  const other = await sessions.createSession();
  await expect(
    grading.getTaskTestResults(other.id, r.testRunId),
  ).rejects.toMatchObject({ status: 404 });
});
it("alte manuelle Aufgaben behalten ehrliche, deduplizierte Abschlussbelege und Profil-Opt-in", async () => {
  await storage.updateSettings({ crossChatProfileEnabled: false });
  const s = await sessions.createSession();
  const id = randomUUID();
  await sessions.mutateSession(s.id, (s) => {
    s.currentTask = {
      id,
      title: "Alt",
      description: "Ohne Tests",
      done: false,
    };
  });
  const before = await profile.getProfile();
  const result = await grading.completeTask(s.id, {
    taskId: id,
    taskVersion: 1,
  });
  expect(result.currentTask.completion.evidence.kind).toBe("manual");
  await grading.completeTask(s.id, { taskId: id, taskVersion: 1 });
  expect(await profile.getProfile()).toEqual(before);
  await storage.updateSettings({ crossChatProfileEnabled: true });
  await sessions.mutateSession(s.id, (session) => {
    session.currentTask = {
      id: randomUUID(),
      title: "Bereits historisch abgeschlossen",
      done: true,
    };
  });
  const old = (await sessions.loadSession(s.id)).currentTask;
  const historical = await grading.completeTask(s.id, {
    taskId: old.id,
    taskVersion: 1,
  });
  expect(historical.currentTask.completion).toMatchObject({
    historical: true,
    completedAt: null,
    profileEnabled: false,
    evidence: { kind: "manual" },
  });
  expect(await profile.getProfile()).toEqual(before);
});

it("holt einen unterbrochenen Profilcommit genau einmal aus dem Abschlussereignis nach", async () => {
  await storage.updateSettings({ crossChatProfileEnabled: true });
  const f = await fixture(),
    r = await finished(f);
  const before = (await profile.getProfile()).languages.python.tasksSucceeded;
  const realRename = fs.rename.bind(fs);
  const failure = vi
    .spyOn(fs, "rename")
    .mockImplementation(async (from, to) => {
      if (to === path.join(root, "profiles", "user.json"))
        throw new Error("profile disk unavailable");
      return realRename(from, to);
    });
  try {
    await expect(
      grading.completeTask(f.s.id, completion(f, r)),
    ).rejects.toThrow("profile disk unavailable");
  } finally {
    failure.mockRestore();
  }
  expect((await sessions.loadSession(f.s.id)).currentTask.done).toBe(true);
  await grading.recoverTaskCompletions(f.s.id);
  await grading.recoverTaskCompletions(f.s.id);
  expect((await profile.getProfile()).languages.python.tasksSucceeded).toBe(
    before + 1,
  );
});

it("lässt große Testartefakte ablaufen, behält aber den Idempotenzbeleg", async () => {
  const f = await fixture(),
    r = await finished(f);
  const location = path.join(root, "test-runs", f.s.id, `${r.testRunId}.json`);
  const record = await storage.readJSON(location);
  record.startedAt = "2000-01-01T00:00:00.000Z";
  await storage.writeJSON(location, record);
  await grading.listTaskTestRuns(f.s.id, f.task.id);
  const expired = await grading.getTaskTestResults(f.s.id, r.testRunId);
  expect(expired).toMatchObject({
    status: "expired",
    cases: [],
    current: false,
  });
  expect((await storage.readJSON(location)).snapshot).toBeUndefined();
  expect((await grading.startTaskTests(f.s.id, f.task.id, f.body)).status).toBe(
    "expired",
  );
  await expect(
    grading.completeTask(f.s.id, completion(f, r)),
  ).rejects.toMatchObject({ status: 409 });
});

it("lehnt fehlende Adapter und Laufzeiten ohne stillen Ersatzstart ab", async () => {
  const f = await fixture();
  const runtimes = vi.spyOn(processes, "getRuntimes");
  try {
    runtimes.mockResolvedValue([
      { language: "python", available: true, modes: ["file"] },
    ]);
    await expect(
      grading.startTaskTests(f.s.id, f.task.id, f.body),
    ).rejects.toMatchObject({ code: "TEST_UNAVAILABLE" });
    runtimes.mockResolvedValue([{ language: "python", available: false }]);
    await expect(
      grading.startTaskTests(f.s.id, f.task.id, f.body),
    ).rejects.toMatchObject({ code: "RUNTIME_MISSING" });
    expect(await grading.listTaskTestRuns(f.s.id, f.task.id)).toHaveLength(0);
  } finally {
    runtimes.mockRestore();
  }
});

it("zählt eine neue Version derselben Aufgabe nicht als weiteren gelösten Aufgabenpunkt", async () => {
  await storage.updateSettings({ crossChatProfileEnabled: true });
  const f = await fixture(),
    r = await finished(f);
  await grading.completeTask(f.s.id, completion(f, r));
  const before = (await profile.getProfile()).languages.python.tasksSucceeded;
  await grading.updateTask(f.s.id, f.task.id, {
    taskVersion: 1,
    description: "Auch die Randfälle erklären.",
  });
  f.body = { ...f.body, operationId: randomUUID(), taskVersion: 2 };
  const next = await finished(f);
  const s = await grading.completeTask(f.s.id, {
    ...completion(f, next),
    taskVersion: 2,
  });
  expect(s.currentTask.completion.taskVersion).toBe(2);
  expect((await profile.getProfile()).languages.python.tasksSucceeded).toBe(
    before,
  );
});
