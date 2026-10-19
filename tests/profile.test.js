import { beforeAll, beforeEach, afterAll, it, expect, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  CONCEPTS,
  validateConceptIds,
  reviewExercise,
} from "../server/services/concepts.js";
import { validateSuite } from "../runner/grading/schema.js";

let root,
  storage,
  profile,
  sessions,
  reviews,
  grading,
  workspace,
  processes,
  server,
  base;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "sterra-profile-"));
  vi.stubEnv("STERRACODE_DATA_DIR", root);
  // The catalog imports storage; reload to bind all services to the temporary directory.
  vi.resetModules();
  storage = await import("../server/services/storage.js");
  profile = await import("../server/services/profileManager.js");
  sessions = await import("../server/services/sessions.js");
  reviews = await import("../server/services/learningReviews.js");
  grading = await import("../server/services/testRunner.js");
  workspace = await import("../server/services/workspace.js");
  processes = await import("../server/services/processes.js");
  await storage.ensureDataDirs();
  const { createApp } = await import("../server/app.js");
  server = createApp().listen(0, "127.0.0.1");
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
});
beforeEach(async () => {
  await storage.updateSettings({
    crossChatProfileEnabled: true,
    autoUpdateProfileOnTaskDone: true,
  });
  await fs.rm(path.join(root, "profiles", "user.json"), { force: true });
});
afterAll(async () => {
  await processes?.stopAllProcesses();
  if (server) await new Promise((r) => server.close(r));
  vi.unstubAllEnvs();
  if (root?.startsWith(path.join(os.tmpdir(), "sterra-profile-")))
    await fs.rm(root, { recursive: true, force: true });
});
const event = (overrides = {}) => ({
  schemaVersion: 1,
  eventId: randomUUID(),
  type: "task_completed",
  sessionId: "session-a",
  taskId: "task-a",
  taskVersion: 1,
  language: "python",
  conceptIds: ["python.loops"],
  occurredAt: "2026-03-28T23:30:00.000Z",
  evidence: { kind: "test_run", outcome: "passed", assistance: "independent" },
  ...overrides,
});
const concept = (p) => p.concepts.find((c) => c.id === "python.loops");
async function seeded(events) {
  const p = await profile.getProfile();
  p.events = events;
  await storage.writeJSON(path.join(root, "profiles", "user.json"), p);
  return p;
}
async function json(url, method = "GET", body) {
  const r = await fetch(base + url, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, body: await r.json() };
}

it("vereinheitlicht Aliase, validiert Konzepte und alle Offlineübungen", () => {
  expect(
    validateConceptIds(["Loops", "Schleifen", "python.loops"], "python"),
  ).toEqual(["python.loops"]);
  expect(() => validateConceptIds(["python.magic"])).toThrow();
  expect(() => validateConceptIds(["javascript.loops"], "python")).toThrow();
  for (const c of CONCEPTS.filter((c) => c.language === "python"))
    expect(validateSuite(reviewExercise(c.id).testSuite)).toBeTruthy();
});
it("dedupliziert dauerhafte Abschlüsse, zählt Sessions eindeutig und bewahrt Belegarten", async () => {
  const s = randomUUID(),
    task = randomUUID();
  const e = {
    eventId: `${s}:${task}:1`,
    type: "task_completed",
    sessionId: s,
    taskId: task,
    taskVersion: 1,
    conceptIds: ["python.loops"],
    completedAt: "2026-10-01T10:00:00Z",
    profileEnabled: true,
    evidence: { kind: "test_run" },
  };
  await Promise.all(
    [1, 2, 3].map(() =>
      profile.updateProfile({ language: "python", completionEvent: e }),
    ),
  );
  await profile.updateProfile({
    language: "python",
    completionEvent: { ...e, eventId: `${s}:${task}:2`, taskVersion: 2 },
  });
  await profile.updateProfile({
    language: "python",
    completionEvent: {
      ...e,
      taskId: randomUUID(),
      eventId: randomUUID(),
      evidence: { kind: "manual" },
    },
  });
  const p = await profile.getProfile();
  expect(p.events).toHaveLength(3);
  expect(p.languages.python.tasksSucceeded).toBe(2);
  expect(p.languages.python.sessionCount).toBe(1);
  expect(p.events.map((e) => e.evidence.kind)).toEqual([
    "test_run",
    "test_run",
    "tutor",
  ]);
  await expect(
    profile.updateProfile({
      language: "python",
      completionEvent: { ...e, conceptIds: ["python.lists"] },
    }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
});
it("migriert Altbestand ohne genaue Übungsdaten und ohne rückwirkende Wiederholungen", async () => {
  const old = {
    profileVersion: 1,
    languages: {
      python: {
        knownConcepts: ["Loops", "Unbekannter Altbegriff"],
        tasksAttempted: 8,
        tasksSucceeded: 5,
        sessionCount: 12,
      },
    },
  };
  await storage.writeJSON(path.join(root, "profiles", "user.json"), old);
  const p = await profile.getProfile();
  expect(p.profileVersion).toBe(2);
  expect(p.events).toEqual([]);
  expect(p.reviews).toEqual([]);
  expect(p.legacy.languages.python.sessionCount).toBe(12);
  expect(p.languages.python.tasksSucceeded).toBe(5);
  expect(p.legacyConcepts.map((c) => c.conceptId)).toEqual([
    "python.loops",
    null,
  ]);
  expect(concept(p).lastReviewedAt).toBeNull();
});
it("zeigt beschädigte und doppelte Belege an, ohne die Datei zu überschreiben", async () => {
  const e = event(),
    p = await seeded([e, e]);
  const file = path.join(root, "profiles", "user.json"),
    original = await fs.readFile(file, "utf8");
  await expect(profile.getProfile()).rejects.toMatchObject({
    code: "PROFILE_CORRUPT",
  });
  expect(await fs.readFile(file, "utf8")).toBe(original);
  p.events = [{ ...e, conceptIds: ["Loops"] }];
  await storage.writeJSON(file, p);
  await expect(profile.getProfile()).rejects.toMatchObject({
    code: "PROFILE_CORRUPT",
  });
});
it("beachtet lokale Tagesgrenzen und beide Sommerzeitwechsel", async () => {
  const p = await seeded([event()]);
  expect(concept(profile.deriveProfile(p)).nextReviewAt).toBe("2026-03-30");
  expect(profile.deriveProfile(p, "2026-03-29T21:59:59Z").reviews).toHaveLength(
    0,
  );
  expect(profile.deriveProfile(p, "2026-03-29T22:00:00Z").reviews).toHaveLength(
    1,
  );
  p.events = [event({ occurredAt: "2026-10-24T22:30:00Z" })];
  expect(concept(profile.deriveProfile(p)).nextReviewAt).toBe("2026-10-26");
  expect(profile.deriveProfile(p, "2026-10-25T22:59:59Z").reviews).toHaveLength(
    0,
  );
  expect(profile.deriveProfile(p, "2026-10-25T23:00:00Z").reviews).toHaveLength(
    1,
  );
});
it("erhöht höchstens eine Stufe pro Aufgabe und Tag und übernimmt keine Voraussetzungen", async () => {
  const p = await seeded([
    event(),
    event({
      reviewId: "review-1",
      taskId: "task-b",
      occurredAt: "2026-03-30T12:00:00Z",
    }),
    event({
      reviewId: "review-1",
      taskId: "task-b",
      taskVersion: 2,
      occurredAt: "2026-03-30T12:05:00Z",
    }),
  ]);
  const view = profile.deriveProfile(p);
  expect(concept(view).reviewStage).toBe(1);
  expect(concept(view).nextReviewAt).toBe("2026-04-02");
  expect(view.concepts.find((c) => c.id === "python.conditions").status).toBe(
    "unpracticed",
  );
  expect(view.concepts.find((c) => c.id === "javascript.loops").status).toBe(
    "unpracticed",
  );
});
it("unterscheidet Fehler, Selbsteinschätzung, Lösungshilfe und Laufzeitausfall", async () => {
  const p = await seeded([
    event(),
    event({
      reviewId: "r",
      taskId: "task-b",
      occurredAt: "2026-04-02T10:00:00Z",
    }),
  ]);
  const advanced = profile.deriveProfile(p);
  for (const [kind, outcome, assistance, stage] of [
    ["test_run", "failed", "independent", 0],
    ["self_assessment", "unsure", "not_recorded", 1],
    ["test_run", "unavailable", "not_recorded", 1],
    ["assisted", "passed", "assisted", 1],
  ]) {
    const e = event({
      type: kind === "self_assessment" ? "self_assessment" : "review_result",
      taskId: "task-c",
      reviewId: "r2",
      occurredAt: "2026-04-06T10:00:00Z",
      evidence: { kind, outcome, assistance },
    });
    const view = profile.deriveProfile({ ...p, events: [...p.events, e] });
    expect(concept(view).reviewStage).toBe(stage);
    if (outcome === "unavailable")
      expect(concept(view).nextReviewAt).toBe(concept(advanced).nextReviewAt);
    else if (kind === "assisted")
      expect(concept(view).nextReviewAt).toBe(concept(advanced).nextReviewAt);
    else expect(concept(view).nextReviewAt).toBe("2026-04-07");
  }
});
it("begrenzt Vorschläge auf drei und verschiebt folgenlos", async () => {
  await seeded(
    CONCEPTS.filter((c) => c.language === "python").map((c) =>
      event({ conceptIds: [c.id] }),
    ),
  );
  const before = await profile.getProfile();
  expect(before.reviews).toHaveLength(3);
  const r = before.reviews[0];
  const after = await profile.deferReview(r.reviewId, "skip");
  expect(
    (await profile.deferReview(r.reviewId, "skip")).reviewDeferrals,
  ).toEqual(after.reviewDeferrals);
  expect(after.events).toEqual(before.events);
  expect(after.concepts).toEqual(before.concepts);
  expect(after.reviews.some((v) => v.conceptId === r.conceptId)).toBe(false);
});
it("sperrt Profilableitungen ohne Opt-in, während Aufgaben nutzbar bleiben", async () => {
  await storage.updateSettings({ crossChatProfileEnabled: false });
  expect((await json("/api/profile")).body).toEqual({ enabled: false });
  expect((await json("/api/profile/reviews")).body).toEqual([]);
  expect(
    (
      await json(
        "/api/profile/concepts/python.loops/self-assessments",
        "POST",
        { operationId: randomUUID(), outcome: "unsure" },
      )
    ).status,
  ).toBe(403);
  expect(
    (await sessions.createSession({ title: "Ohne Profil", language: "python" }))
      .id,
  ).toBeTruthy();
  expect((await profile.getProfile()).events).toEqual([]);
});
it("speichert Selbsteinschätzungen idempotent und begrenzt den Tutor-Kontext", async () => {
  const body = { operationId: randomUUID(), outcome: "unsure" };
  await profile.selfAssess("python.loops", body);
  await profile.selfAssess("python.loops", body);
  const p = await profile.getProfile();
  expect(p.events).toHaveLength(1);
  const prompt = profile.profileToPromptText(p);
  expect(prompt).toContain("self_assessment");
  expect(prompt).not.toContain(body.operationId);
  expect(prompt.length).toBeLessThan(3000);
});

it("serialisiert das Ausschalten mit einem bereits laufenden Profilcommit", async () => {
  let release, reached;
  const gate = new Promise((r) => {
      release = r;
    }),
    started = new Promise((r) => {
      reached = r;
    });
  const rename = fs.rename.bind(fs);
  const spy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
    if (to === path.join(root, "profiles", "user.json")) {
      reached();
      await gate;
    }
    return rename(from, to);
  });
  try {
    const pending = profile.selfAssess("python.loops", {
      operationId: randomUUID(),
      outcome: "unsure",
    });
    await started;
    const disable = storage.updateSettings({ crossChatProfileEnabled: false });
    expect(
      await Promise.race([
        disable.then(() => "disabled"),
        new Promise((r) => setTimeout(() => r("waiting"), 25)),
      ]),
    ).toBe("waiting");
    release();
    await pending;
    await disable;
    await expect(
      profile.selfAssess("python.loops", {
        operationId: randomUUID(),
        outcome: "confident",
      }),
    ).rejects.toMatchObject({ code: "PROFILE_DISABLED" });
  } finally {
    release();
    spy.mockRestore();
  }
});
it("startet eine geprüfte Wiederholung offline einmalig und verarbeitet echte Testbelege", async () => {
  await seeded([event()]);
  const r = (await profile.getProfile()).reviews[0];
  const [s, same] = await Promise.all([
    reviews.startReview(r.reviewId),
    reviews.startReview(r.reviewId),
  ]);
  expect(same.id).toBe(s.id);
  expect(s.currentTask.reviewId).toBe(r.reviewId);
  const f = await workspace.readFile(s.id, "main.py");
  await workspace.writeFile(
    s.id,
    "main.py",
    "def sum_to(n):\n    return sum(range(n + 1))\n",
    f.version,
  );
  const current = await workspace.readFile(s.id, "main.py");
  const run = await grading.startTaskTests(s.id, s.currentTask.id, {
    operationId: randomUUID(),
    taskVersion: 1,
    expectedVersions: { "main.py": current.version },
  });
  let result;
  for (let i = 0; i < 150; i++) {
    result = await grading.getTaskTestResults(s.id, run.testRunId);
    if (!["running", "starting"].includes(result.status)) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  expect(result.assessment).toBe("passed");
  await reviews.reviewResult(r.reviewId, {
    action: "submit",
    sessionId: s.id,
    testRunId: run.testRunId,
    assistance: "independent",
  });
  const p = await profile.getProfile();
  expect(p.events).toHaveLength(2);
  expect(concept(p).reviewStage).toBe(1);
  await reviews.reviewResult(r.reviewId, {
    action: "submit",
    sessionId: s.id,
    testRunId: run.testRunId,
    assistance: "independent",
  });
  expect((await profile.getProfile()).events).toHaveLength(2);
  await profile.resetProfile();
  await grading.recoverTaskCompletions(s.id);
  expect((await profile.getProfile()).events).toEqual([]);
});

async function writeAndTest(s, content, actor = "user") {
  const f = await workspace.readFile(s.id, "main.py");
  const current = await workspace.writeFile(
    s.id,
    "main.py",
    content,
    f.version,
    { actor },
  );
  const run = await grading.startTaskTests(s.id, s.currentTask.id, {
    operationId: randomUUID(),
    taskVersion: 1,
    expectedVersions: { "main.py": current.version },
  });
  for (let i = 0; i < 250; i++) {
    const result = await grading.getTaskTestResults(s.id, run.testRunId);
    if (!["running", "starting"].includes(result.status)) return result;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("Testlauf wurde nicht beendet.");
}

it("nimmt fehlgeschlagene Wiederholungen wieder auf, ignoriert Timeouts und erkennt KI-Dateihilfe", async () => {
  await seeded([
    event(),
    event({
      reviewId: "previous",
      taskId: "previous-task",
      occurredAt: "2026-04-02T10:00:00Z",
    }),
  ]);
  const review = (await profile.getProfile()).reviews[0],
    s = await reviews.startReview(review.reviewId);
  const failed = await writeAndTest(s, "def sum_to(n):\n    return 0\n");
  expect(failed.assessment).toBe("failed");
  const p = await profile.getProfile();
  expect(p.events).toHaveLength(3);
  expect(concept(p).reviewStage).toBe(0);
  await grading.recoverTaskCompletions(s.id);
  await grading.recoverTaskCompletions(s.id);
  expect((await profile.getProfile()).events).toHaveLength(3);
  const timeout = await writeAndTest(
    s,
    "def sum_to(n):\n    while True: pass\n",
  );
  expect(timeout.cases.some((c) => c.kind === "timeout")).toBe(true);
  expect((await profile.getProfile()).events).toHaveLength(3);
  const passed = await writeAndTest(
    s,
    "def sum_to(n):\n    return sum(range(n + 1))\n",
    "ai",
  );
  await grading.completeTask(s.id, {
    taskId: s.currentTask.id,
    taskVersion: 1,
    testRunId: passed.testRunId,
    assistance: "independent",
  });
  const after = await profile.getProfile();
  expect(after.events.at(-1).evidence.kind).toBe("assisted");
  expect(concept(after).reviewStage).toBe(0);
  await profile.resetProfile();
  await grading.recoverTaskCompletions(s.id);
  expect((await profile.getProfile()).events).toHaveLength(0);
});

it("übernimmt alte Sessions nur ausdrücklich und kennzeichnet sie dauerhaft als historisch", async () => {
  await storage.updateSettings({ crossChatProfileEnabled: false });
  const s = await sessions.createSession({
    title: "Historische Aufgabe",
    language: "python",
  });
  const taskId = randomUUID();
  await sessions.mutateSession(s.id, (session) => {
    session.currentTask = {
      id: taskId,
      taskVersion: 1,
      title: "Alt",
      description: "Alt",
      conceptIds: ["python.loops"],
      done: false,
    };
  });
  await grading.completeTask(s.id, { taskId, taskVersion: 1 });
  await storage.updateSettings({ crossChatProfileEnabled: true });
  await grading.recoverTaskCompletions(s.id);
  expect((await profile.getProfile()).events).toHaveLength(0);
  const p = await profile.importHistoricalSessions();
  expect(p.events.find((e) => e.taskId === taskId).evidence.kind).toBe(
    "legacy",
  );
  expect(p.reviews).toHaveLength(0);
  expect((await profile.importHistoricalSessions()).events).toHaveLength(
    p.events.length,
  );
});
