import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID, createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import {
  AppError,
  DATA_DIR,
  serial,
  readJSON,
  writeJSON,
  validateSessionId,
  getSettings,
  assertSessionWritable,
} from "./storage.js";
import { loadSession, mutateSession } from "./sessions.js";
import { readFile, normalizePath, listChanges } from "./workspace.js";
import {
  startProcess,
  readProcess,
  stopProcess,
  getRuntimes,
} from "./processes.js";
import { updateProfile, recordReviewFailure } from "./profileManager.js";
import { validateConceptIds } from "./concepts.js";
import {
  TEST_LIMITS,
  validateSuite,
  jsonValue,
} from "../../runner/grading/schema.js";
import { validateTrace } from "../../runner/tracer/adapter.js";
import { requireSpace } from "./safeFiles.js";

const fail = (m) => {
  throw new AppError(m);
};
const conflict = () => {
  throw new AppError(
    "Aufgaben-, Suite- oder Quellstand geändert. Bitte erneut prüfen.",
    409,
    "CONFLICT",
  );
};
const digest = (v) =>
  createHash("sha256")
    .update(JSON.stringify(v) ?? "null")
    .digest("hex");
const file = (s, id) =>
  path.join(
    DATA_DIR,
    "test-runs",
    validateSessionId(s),
    `${validateSessionId(id)}.json`,
  );
const active = (r) => ["starting", "running"].includes(r.status);
const monitors = new Set();
async function prune(s) {
  const dir = path.join(DATA_DIR, "test-runs", validateSessionId(s));
  const names = await fs.readdir(dir).catch((e) => {
    if (e.code === "ENOENT") return [];
    throw e;
  });
  const records = await Promise.all(
    names
      .filter((n) => n.endsWith(".json"))
      .map((n) => readJSON(path.join(dir, n))),
  );
  const finished = records
    .filter((r) => !active(r) && r.status !== "expired")
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  for (const [index, record] of finished.entries()) {
    if (index < 20 && Date.now() - Date.parse(record.startedAt) < 86400000)
      continue;
    await serial(`test:${s}:${record.testRunId}`, async () => {
      const r = await readJSON(file(s, record.testRunId));
      if (active(r)) return;
      r.status = "expired";
      r.expiredAt = new Date().toISOString();
      delete r.snapshot;
      delete r.suite;
      r.cases = [];
      await save(r);
    });
  }
}
async function load(s, id) {
  await loadSession(s);
  try {
    return await readJSON(file(s, id));
  } catch (e) {
    if (e.code === "ENOENT")
      throw new AppError("Testlauf nicht gefunden.", 404);
    throw e;
  }
}
async function save(r) {
  await assertSessionWritable(r.sessionId);
  await writeJSON(file(r.sessionId, r.testRunId), r);
}
function publicRun(r) {
  const { request, snapshot, suite, ...rest } = r;
  return rest;
}
export function taskAssessment(args, language) {
  if (
    args.conceptIds !== undefined &&
    (!Array.isArray(args.conceptIds) ||
      args.conceptIds.length > 30 ||
      args.conceptIds.some((v) => typeof v !== "string" || v.length > 100))
  )
    fail("Ungültige Konzept-IDs.");
  if (args.assessmentMode === "tests" && !args.testSuite)
    fail("Testsuite fehlt.");
  if (args.testSuite && args.assessmentMode && args.assessmentMode !== "tests")
    fail("Testsuite benötigt assessmentMode tests.");
  return {
    taskVersion: 1,
    ...(args.testSuite?.language || language
      ? { language: args.testSuite?.language || language }
      : {}),
    conceptIds: validateConceptIds(
      args.conceptIds || [],
      args.testSuite?.language || language,
    ),
    assessmentMode: args.testSuite ? "tests" : "manual",
    ...(args.testSuite
      ? { testSuite: validateSuite(args.testSuite, fail) }
      : {}),
  };
}
function checkTask(t, id, version) {
  if (!t || t.id !== id || (t.taskVersion || 1) !== version) conflict();
}
export async function updateTask(s, id, body) {
  return mutateSession(s, (session) => {
    if (
      Object.keys(body).some(
        (key) =>
          ![
            "taskVersion",
            "title",
            "description",
            "difficulty",
            "hints",
            "conceptIds",
            "testSuite",
            "assessmentMode",
          ].includes(key),
      )
    )
      fail("Nicht unterstütztes Aufgabenfeld.");
    const t = session.currentTask;
    checkTask(t, id, body.taskVersion);
    const next = {
      ...t,
      ...body,
      id,
      ...taskAssessment({ ...t, ...body }, t.language || session.language),
    };
    if (
      typeof next.title !== "string" ||
      typeof next.description !== "string" ||
      next.title.length > 100000 ||
      next.description.length > 100000
    )
      fail("Ungültige Aufgabenbeschreibung.");
    next.taskVersion = (t.taskVersion || 1) + 1;
    if (next.testSuite)
      next.testSuite.version = (t.testSuite?.version || 0) + 1;
    (session.taskHistory ||= []).push(structuredClone(t));
    next.done = false;
    // An edited exercise no longer represents the curated review catalog.
    delete next.reviewId;
    delete next.completion;
    delete next.lastTestRunId;
    delete next.hintUsage;
    session.currentTask = next;
  });
}
export async function startTaskTests(s, taskId, body, actor = "user") {
  validateSessionId(body.operationId);
  if (actor === "ai" && !(await getSettings()).allowAITerminalCommands)
    throw new AppError(
      "KI-Terminalbefehle sind deaktiviert.",
      403,
      "TERMINAL_DISABLED",
    );
  const expected = body.expectedVersions;
  if (!expected || typeof expected !== "object" || Array.isArray(expected))
    fail("Erwartete Dateiversionen fehlen.");
  const paths = Object.keys(expected).sort();
  if (
    !paths.length ||
    paths.length > 20 ||
    paths.some(
      (p) => normalizePath(p) !== p || !/^[a-f0-9]{64}$/.test(expected[p]),
    )
  )
    fail("Ungültiges Snapshot-Manifest.");
  const request = digest({
    taskId,
    taskVersion: body.taskVersion,
    files: paths.map((p) => [p, expected[p]]),
  });
  return serial(`test-start:${s}`, async () => {
    await prune(s);
    const id = body.operationId; // durable, session-scoped operation lookup
    try {
      const old = await load(s, id);
      if (old.request !== request)
        throw new AppError(
          "operationId mit anderen Daten verwendet.",
          409,
          "IDEMPOTENCY_CONFLICT",
        );
      return publicRun(old);
    } catch (e) {
      if (e.status !== 404) throw e;
    }
    const session = await loadSession(s);
    const task = session.currentTask;
    checkTask(task, taskId, body.taskVersion);
    const suite = validateSuite(task.testSuite, fail);
    const runtime = (await getRuntimes()).find((r) => r.language === "python");
    if (!runtime?.available)
      throw new AppError(
        runtime?.reason || "Python-Laufzeit fehlt. Laufzeitverwaltung öffnen.",
        400,
        "RUNTIME_MISSING",
      );
    if (!runtime.modes?.includes("test") || runtime.testAdapterVersion !== 1)
      throw new AppError(
        "Runner unterstützt keine Python-Funktionstests.",
        503,
        "TEST_UNAVAILABLE",
      );
    const files = await serial(`workspace:${s}`, async () => {
      const result = [];
      for (const p of paths) {
        const f = await readFile(s, p);
        if (f.version !== expected[p]) conflict();
        result.push(f);
      }
      for (const f of result)
        if ((await readFile(s, f.path)).version !== f.version) conflict();
      return result;
    });
    validateTrace({ entry: suite.entry.path, files, stdin: "" }, fail);
    await requireSpace(DATA_DIR, 8 * 1024 * 1024);
    const run = {
      schemaVersion: 1,
      sessionId: s,
      testRunId: id,
      operationId: id,
      processId: id,
      taskId,
      taskVersion: body.taskVersion,
      suiteVersion: suite.version,
      suiteDigest: digest(suite),
      snapshotId: randomUUID(),
      sourceFiles: files.map(({ path, version }) => ({ path, version })),
      snapshot: files,
      suite,
      harnessVersion: "python-functions-v1",
      runtime: {
        language: "python",
        version: runtime.version || runtime.label || "siehe Fallausgabe",
      },
      limits: TEST_LIMITS,
      request,
      status: "starting",
      assessment: null,
      cases: [],
      startedAt: new Date().toISOString(),
      profileEnabled: Boolean((await getSettings()).crossChatProfileEnabled),
      ...(task.reviewId
        ? { reviewId: task.reviewId, conceptIds: task.conceptIds }
        : {}),
    };
    await save(run); // Never replay a start after a crash, even in the acceptance window.
    try {
      await mutateSession(s, (current) => {
        checkTask(current.currentTask, taskId, body.taskVersion);
        if (digest(current.currentTask.testSuite) !== run.suiteDigest)
          conflict();
        current.currentTask.lastTestRunId = id;
      });
      const job = await startProcess({
        sessionId: s,
        test: { suite, files },
        actor,
        idempotencyId: id,
      });
      run.processId = job.processId;
      collect(run, job);
      await save(run);
      monitor(s, id);
    } catch (e) {
      run.status = e.code === "RUNNER_UNAVAILABLE" ? "starting" : "interrupted";
      run.reason = e.code || "start_failed";
      run.error = e.message;
      await save(run);
      if (active(run)) monitor(s, id);
      else throw e;
    }
    return publicRun(run);
  });
}
function collect(r, job) {
  r.status = job.exited
    ? job.reason === "stopped"
      ? "cancelled"
      : job.reason === "runner_restarted"
        ? "interrupted"
        : "finished"
    : "running";
  r.reason = job.reason || null;
  r.cases = r.suite.cases.map((c, i) => {
    const raw = job.testResults?.[i];
    const valid =
      raw?.id === c.id &&
      Buffer.byteLength(JSON.stringify(raw)) <=
        TEST_LIMITS.resultBytes * 2 + 4096;
    const kind =
      valid &&
      [
        "return",
        "program_error",
        "serialization_error",
        "invalid_result",
        "timeout",
        "stopped",
        "output_limit",
        "not_run",
      ].includes(raw.kind)
        ? raw.kind
        : "not_run";
    const actualValid =
      kind === "return" &&
      Object.hasOwn(raw, "actual") &&
      jsonValue(raw.actual);
    const passed = actualValid && isDeepStrictEqual(raw.actual, c.expected);
    return {
      id: c.id,
      name: c.name,
      required: c.required,
      args: c.args,
      expected: c.expected,
      kind: kind === "return" && !actualValid ? "invalid_result" : kind,
      passed,
      ...(actualValid ? { actual: raw.actual } : {}),
      message: valid
        ? String(raw.message || "").slice(0, 1000)
        : "Noch kein auswertbares Ergebnis.",
      ...(valid &&
      r.sourceFiles.some((f) => f.path === raw.file) &&
      Number.isInteger(raw.line)
        ? { file: raw.file, line: raw.line }
        : {}),
      output: valid ? String(raw.output || "").slice(0, 65536) : "",
      outputTruncated: Boolean(raw?.outputTruncated),
    };
  });
  const version = job.testResults?.find(
    (c) => typeof c.runtime === "string",
  )?.runtime;
  if (version) r.runtime.version = version.slice(0, 100);
  r.summary = {
    passed: r.cases.filter((c) => c.passed).length,
    failed: r.cases.filter((c) => !c.passed && c.kind !== "not_run").length,
    total: r.cases.length,
  };
  if (job.exited) {
    r.finishedAt = new Date().toISOString();
    r.assessment =
      r.status === "cancelled" || r.status === "interrupted"
        ? null
        : r.cases.some((c) => ["not_run", "invalid_result"].includes(c.kind))
          ? "inconclusive"
          : r.cases.filter((c) => c.required).every((c) => c.passed) &&
              !job.reason &&
              job.exitCode === 0
            ? "passed"
            : "failed";
  }
}
async function refresh(r) {
  if (active(r)) {
    try {
      collect(r, await readProcess(r.processId, r.sessionId));
    } catch (e) {
      if (e.status !== 404) throw e;
      r.status = "interrupted";
      r.reason = "process_unavailable";
      r.finishedAt = new Date().toISOString();
    }
    await save(r);
  }
  if (
    r.profileEnabled &&
    r.reviewId &&
    !r.reason &&
    r.status === "finished" &&
    r.assessment === "failed" &&
    r.cases.every((c) =>
      ["return", "program_error", "serialization_error"].includes(c.kind),
    )
  ) {
    await recordReviewFailure({
      schemaVersion: 1,
      eventId: `review-failure:${r.testRunId}`,
      type: "review_result",
      sessionId: r.sessionId,
      taskId: r.taskId,
      taskVersion: r.taskVersion,
      reviewId: r.reviewId,
      language: "python",
      conceptIds: r.conceptIds,
      occurredAt: r.finishedAt,
      evidence: {
        kind: "test_run",
        testRunId: r.testRunId,
        outcome: "failed",
        assistance: "not_recorded",
      },
    });
  }
  return r;
}
function monitor(s, id) {
  const key = `${s}:${id}`;
  if (monitors.has(key)) return;
  monitors.add(key);
  const tick = async () => {
    try {
      const r = await serial(`test:${key}`, async () =>
        refresh(await load(s, id)),
      );
      if (active(r)) {
        setTimeout(tick, 250).unref();
        return;
      }
    } catch {
      /* Resume by reading durable state; never replay. */
    }
    monitors.delete(key);
  };
  setTimeout(tick, 100).unref();
}
export async function getTaskTestResults(s, id) {
  return serial(`test:${s}:${id}`, async () => {
    const r = await refresh(await load(s, id));
    if (active(r)) monitor(s, id);
    const t = (await loadSession(s)).currentTask;
    let current =
      r.status !== "expired" &&
      t?.id === r.taskId &&
      (t.taskVersion || 1) === r.taskVersion &&
      digest(t.testSuite) === r.suiteDigest;
    if (current)
      for (const f of r.sourceFiles) {
        try {
          if ((await readFile(s, f.path)).version !== f.version)
            current = false;
        } catch {
          current = false;
        }
      }
    return { ...publicRun(r), current };
  });
}
export async function cancelTaskTests(s, id) {
  return serial(`test:${s}:${id}`, async () => {
    const r = await load(s, id);
    if (active(r)) {
      try {
        collect(r, await stopProcess(r.processId, s));
      } catch (e) {
        if (e.status !== 404) throw e;
        r.status = "interrupted";
        r.reason = "process_unavailable";
      }
      await save(r);
    }
    return publicRun(r);
  });
}
export async function listTaskTestRuns(s, taskId) {
  await loadSession(s);
  await prune(s);
  const dir = path.join(DATA_DIR, "test-runs", validateSessionId(s));
  const names = await fs.readdir(dir).catch((e) => {
    if (e.code === "ENOENT") return [];
    throw e;
  });
  const runs = await Promise.all(
    names
      .filter((n) => n.endsWith(".json"))
      .map((n) => readJSON(path.join(dir, n))),
  );
  return runs
    .filter((r) => r.taskId === taskId)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
    .slice(0, 20)
    .map((r) => ({
      testRunId: r.testRunId,
      startedAt: r.startedAt,
      status: r.status,
      assessment: r.assessment,
    }));
}
export async function completeTask(s, body, language, actor = "user") {
  const result = await serial(`workspace:${s}`, async () => {
    const original = (await loadSession(s)).currentTask;
    checkTask(original, body.taskId, body.taskVersion);
    let evidence = {
      kind: "manual",
      assessmentSource: actor === "user" ? "self_assessment" : "tutor",
    };
    if (
      body.assistance !== undefined &&
      !["independent", "assisted", "not_recorded"].includes(body.assistance)
    )
      fail("Ungültige Angabe zur Lösungshilfe.");
    if (original.testSuite) {
      const r = await serial(`test:${s}:${body.testRunId}`, async () =>
        refresh(await load(s, body.testRunId)),
      );
      if (
        r.taskId !== original.id ||
        r.taskVersion !== (original.taskVersion || 1) ||
        r.suiteDigest !== digest(original.testSuite) ||
        r.assessment !== "passed" ||
        r.status !== "finished"
      )
        conflict();
      for (const f of r.sourceFiles)
        if ((await readFile(s, f.path)).version !== f.version) conflict();
      evidence = {
        kind: "test_run",
        testRunId: r.testRunId,
        suiteVersion: r.suiteVersion,
        sourceFiles: r.sourceFiles,
        snapshotId: r.snapshotId,
      };
    }
    const taskStartedAt = original.reviewStartedAt || original.createdAt;
    const changes = taskStartedAt ? await listChanges(s) : [];
    evidence.hintsUsed = original.hintUsage?.count || 0;
    evidence.assistance =
      evidence.hintsUsed > 0 ||
      changes.some((c) => c.createdAt >= taskStartedAt)
        ? "assisted"
        : actor === "ai"
          ? "not_recorded"
          : body.assistance || "not_recorded";
    return mutateSession(s, async (session) => {
      const t = session.currentTask;
      checkTask(t, body.taskId, body.taskVersion);
      if (digest(t.testSuite) !== digest(original.testSuite)) conflict();
      // Hint reveals share this lock; a completion must see committed help.
      evidence.hintsUsed = t.hintUsage?.count || 0;
      if (evidence.hintsUsed) evidence.assistance = "assisted";
      const settings = await getSettings();
      const key = `${s}:${t.id}`;
      const previous = session.taskCompletions?.[t.id];
      const historical = t.done && !t.completion && !previous;
      const event =
        previous && previous.taskVersion === (t.taskVersion || 1)
          ? previous
          : {
              eventId: `${key}:${t.taskVersion || 1}`,
              type: "task_completed",
              sessionId: s,
              taskId: t.id,
              taskVersion: t.taskVersion || 1,
              language:
                t.testSuite?.language ||
                t.language ||
                language ||
                session.language,
              conceptIds: t.conceptIds || [],
              ...(t.reviewId ? { reviewId: t.reviewId } : {}),
              evidence,
              completedAt: historical ? null : new Date().toISOString(),
              ...(historical
                ? { historical: true, recordedAt: new Date().toISOString() }
                : {}),
              profileEnabled: Boolean(
                !historical &&
                settings.crossChatProfileEnabled &&
                settings.autoUpdateProfileOnTaskDone,
              ),
            };
      (session.taskCompletions ||= {})[t.id] = event;
      t.done = true;
      t.feedback = String(body.feedback || "").slice(0, 10000);
      t.completion = event;
    });
  });
  const event = result.currentTask.completion;
  const settings = await getSettings();
  if (
    event.profileEnabled &&
    settings.crossChatProfileEnabled &&
    settings.autoUpdateProfileOnTaskDone
  )
    await updateProfile({
      language: event.language,
      taskSucceeded: true,
      completionEvent: event,
    });
  return result;
}

// Session events form a durable outbox; profile writes deduplicate by task.
export async function recoverTaskCompletions(s) {
  const settings = await getSettings();
  if (
    !settings.crossChatProfileEnabled ||
    !settings.autoUpdateProfileOnTaskDone
  )
    return;
  const session = await loadSession(s);
  for (const event of Object.values(session.taskCompletions || {})) {
    if (event.profileEnabled)
      await updateProfile({
        language: event.language,
        taskSucceeded: true,
        completionEvent: event,
      });
  }
  const dir = path.join(DATA_DIR, "test-runs", s);
  const names = await fs.readdir(dir).catch((e) => {
    if (e.code === "ENOENT") return [];
    throw e;
  });
  for (const name of names.filter((n) => n.endsWith(".json"))) {
    const r = await readJSON(path.join(dir, name));
    if (r.reviewId && r.profileEnabled && r.status !== "expired")
      await serial(`test:${s}:${r.testRunId}`, () => refresh(r));
  }
}
const housekeeping = setInterval(async () => {
  try {
    for (const name of await fs.readdir(path.join(DATA_DIR, "sessions"))) {
      if (!name.endsWith(".json")) continue;
      const s = name.slice(0, -5);
      try {
        await prune(s);
        await recoverTaskCompletions(s);
      } catch {
        /* Retry deleted/locked sessions or unavailable storage later. */
      }
    }
  } catch {
    /* Storage is not initialized yet. */
  }
}, 60000);
housekeeping.unref();
