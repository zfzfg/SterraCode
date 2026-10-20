import path from "node:path";
import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  AppError,
  DATA_DIR,
  validateSessionId,
  getWorkspacePath,
  assertSessionWritable,
  serial,
  readJSON,
  writeJSON,
} from "./storage.js";
import { readFile, normalizePath } from "./workspace.js";
import {
  startProcess,
  readProcess,
  stopProcess,
  getRuntimes,
} from "./processes.js";
import { TRACE_LIMITS, validateTrace } from "../../runner/tracer/adapter.js";
import { requireSpace } from "./safeFiles.js";
import { reasonMetadata } from "./processReasons.js";

const live = new Set();
const RETENTION_MS = 24 * 60 * 60 * 1000;
async function prune(session) {
  const directory = path.join(DATA_DIR, "traces", session);
  const names = await fs.readdir(directory).catch((error) => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const records = await Promise.all(
    names
      .filter((name) => name.endsWith(".json"))
      .map((name) => readJSON(path.join(directory, name))),
  );
  const finished = records
    .filter((r) => !["starting", "running", "expired"].includes(r.status))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  for (const [index, record] of finished.entries()) {
    if (index < 20 && Date.now() - Date.parse(record.createdAt) < RETENTION_MS)
      continue;
    await serial(`trace:${record.traceRunId}`, async () => {
      const run = await load(session, record.traceRunId);
      if (["starting", "running"].includes(run.status)) return;
      run.status = "expired";
      run.expiredAt = new Date().toISOString();
      run.events = [];
      delete run.output;
      run.snapshot.files = run.snapshot.files.map(({ path, version }) => ({
        path,
        version,
      }));
      await save(run);
    });
  }
}
const location = (session, id) => {
  validateSessionId(session);
  validateSessionId(id);
  return path.join(DATA_DIR, "traces", session, `${id}.json`);
};
async function load(session, id) {
  await getWorkspacePath(session);
  try {
    const file = location(session, id);
    const run = await readJSON(file);
    run.events = [];
    if (run.status !== "expired") {
      const [sources, artifact] = await Promise.all([
        readJSON(`${file}.sources`),
        readJSON(`${file}.events`),
      ]);
      run.snapshot.files = sources;
      Object.assign(run, artifact);
    }
    return run;
  } catch (error) {
    if (error.code === "ENOENT")
      throw new AppError("Trace nicht gefunden.", 404, undefined, {
        messageKey: "serverFeature:trace.notFound",
        params: {},
      });
    throw error;
  }
}
const save = async (run) => {
  await assertSessionWritable(run.sessionId);
  const file = location(run.sessionId, run.traceRunId);
  const { events, output, ...metadata } = run;
  metadata.eventCount = events?.length ?? 0;
  metadata.snapshot = {
    ...run.snapshot,
    files: run.snapshot.files.map(({ path, version }) => ({ path, version })),
  };
  if (run.status !== "expired") {
    await fs.mkdir(path.dirname(file), { recursive: true });
    try {
      await fs.writeFile(
        `${file}.sources`,
        JSON.stringify(run.snapshot.files),
        { flag: "wx", mode: 0o600 },
      );
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    await writeJSON(`${file}.events`, { events, output });
  }
  await writeJSON(file, metadata);
  if (run.status === "expired") {
    await fs.rm(`${file}.sources`, { force: true });
    await fs.rm(`${file}.events`, { force: true });
  }
};
function summary(run) {
  const { events, request, ...result } = run;
  return {
    ...result,
    ...reasonMetadata(run.reason, run.errorKey, run.errorParams),
    eventCount: events?.length ?? run.eventCount ?? 0,
  };
}
function validEvent(event, run) {
  const object = (value) =>
    value && typeof value === "object" && !Array.isArray(value);
  const source = (file) => run.snapshot.files.some((f) => f.path === file);
  const label = (value) => typeof value === "string" && value.length <= 250;
  const locals = (value) => object(value) && Object.keys(value).length <= 20;
  return (
    object(event) &&
    ["call", "line", "return", "exception"].includes(event.event) &&
    event.phase === (event.event === "line" ? "before" : "at") &&
    source(event.file) &&
    Number.isInteger(event.line) &&
    event.line >= (event.event === "call" ? 0 : 1) &&
    label(event.frameId) &&
    label(event.function) &&
    locals(event.locals) &&
    object(event.objects) &&
    Object.keys(event.objects).length <= 200 &&
    Array.isArray(event.stack) &&
    event.stack.length > 0 &&
    event.stack.length <= 30 &&
    event.stack.every(
      (f) =>
        object(f) &&
        label(f.frameId) &&
        label(f.function) &&
        source(f.file) &&
        Number.isInteger(f.line) &&
        locals(f.locals),
    )
  );
}
function collect(run, job) {
  const data = job.traceData || "";
  let end;
  let invalid = Buffer.byteLength(data) > TRACE_LIMITS.bytes;
  const events = [];
  const lines = data.slice(0, TRACE_LIMITS.bytes).split("\n");
  const partial = lines.pop();
  for (const line of lines) {
    try {
      const event = JSON.parse(line);
      if (end) {
        invalid = true;
        continue;
      }
      if (
        event.kind === "end" &&
        [
          "completed",
          "program_error",
          "event_limit",
          "trace_size_limit",
        ].includes(event.reason) &&
        typeof event.complete === "boolean"
      )
        end = event;
      else if (
        event.kind === "event" &&
        event.step === events.length + 1 &&
        events.length < TRACE_LIMITS.events &&
        validEvent(event, run)
      )
        events.push({ ...event, traceRunId: run.traceRunId });
      else invalid = true;
    } catch {
      invalid = true;
    }
  }
  // A runner restart can return only the journal prefix. Never discard the
  // longer, already durable prefix collected by the application before a crash.
  if (job.traceData !== undefined && events.length >= run.events.length)
    run.events = events;
  run.output = job.output || "";
  run.exitCode = job.exitCode;
  if (job.exited) {
    run.status =
      job.reason === "stopped"
        ? "cancelled"
        : job.reason === "runner_restarted"
          ? "interrupted"
          : "finished";
    run.reason =
      job.reason ||
      (invalid || partial
        ? "invalid_trace"
        : end?.reason || "incomplete_trace");
    run.complete =
      !invalid && !partial && !job.reason && end?.complete === true;
    run.endedAt = new Date().toISOString();
    if (
      end?.error &&
      typeof end.error.type === "string" &&
      typeof end.error.message === "string"
    )
      run.programError = {
        type: end.error.type.slice(0, 250),
        message: end.error.message.slice(0, 250),
        ...(end.error.messageKey === "runner:trace.errorDetails"
          ? { messageKey: "runner:trace.errorDetails", params: {} }
          : {}),
      };
  } else run.status = "running";
}
async function refresh(run) {
  try {
    collect(run, await readProcess(run.processId, run.sessionId));
  } catch (error) {
    if (error.status !== 404) throw error;
    Object.assign(run, {
      status: "interrupted",
      reason: "process_unavailable",
      complete: false,
    });
  }
  await save(run);
  return run;
}
function monitor(session, id) {
  live.add(id);
  const tick = async () => {
    try {
      const run = await serial(`trace:${id}`, async () =>
        refresh(await load(session, id)),
      );
      if (["starting", "running"].includes(run.status)) {
        setTimeout(tick, 250).unref();
        return;
      }
    } catch {
      /* Resume by reading the durable record; never replay a start. */
    }
    live.delete(id);
  };
  setTimeout(tick, 100).unref();
}
export async function startTrace(sessionId, body) {
  validateSessionId(sessionId);
  validateSessionId(body.operationId);
  const entry = normalizePath(body.entry);
  const expected = body.expectedVersions;
  if (!expected || typeof expected !== "object" || Array.isArray(expected))
    throw new AppError(
      "Erwartete Dateiversionen fehlen.",
      undefined,
      undefined,
      { messageKey: "serverFeature:snapshot.versionsMissing", params: {} },
    );
  const paths = Object.keys(expected).sort();
  if (
    !paths.includes(entry) ||
    paths.length > 20 ||
    paths.some(
      (p) => normalizePath(p) !== p || !/^[a-f0-9]{64}$/.test(expected[p]),
    )
  )
    throw new AppError("Ungültiges Snapshot-Manifest.", undefined, undefined, {
      messageKey: "serverFeature:snapshot.invalidManifest",
      params: {},
    });
  const request = JSON.stringify({
    entry,
    files: paths.map((p) => [p, expected[p]]),
    stdin: body.stdin ?? "",
  });
  return serial(`trace-start:${sessionId}`, async () => {
    await prune(sessionId);
    const dir = path.join(DATA_DIR, "traces", sessionId);
    await getWorkspacePath(sessionId);
    await fs.mkdir(dir, { recursive: true });
    for (const name of await fs.readdir(dir)) {
      if (!name.endsWith(".json")) continue;
      const old = await readJSON(path.join(dir, name));
      if (old.operationId === body.operationId) {
        if (old.request !== request)
          throw new AppError(
            "operationId mit anderen Daten verwendet.",
            409,
            "IDEMPOTENCY_CONFLICT",
            {
              messageKey: "serverFeature:snapshot.operationConflict",
              params: {},
            },
          );
        return summary(old);
      }
    }
    await assertSessionWritable(sessionId);
    const runtime = (await getRuntimes()).find((r) => r.language === "python");
    if (!runtime?.available)
      throw new AppError(
        runtime?.reason || "Python-Laufzeit fehlt.",
        400,
        "RUNTIME_MISSING",
        {
          messageKey:
            runtime?.reasonKey || "serverFeature:process.pythonMissing",
          params: runtime?.reasonParams || {},
        },
      );
    if (!runtime.modes?.includes("trace") || runtime.traceAdapterVersion !== 1)
      throw new AppError(
        "Dieser Runner unterstützt noch keine Python-Traces.",
        503,
        "TRACE_UNAVAILABLE",
        { messageKey: "serverFeature:trace.runnerUnsupported", params: {} },
      );
    const files = await serial(`workspace:${sessionId}`, async () => {
      const result = [];
      for (const p of paths) {
        const file = await readFile(sessionId, p);
        if (file.version !== expected[p])
          throw new AppError(
            "Dateistand geändert. Bitte speichern und erneut starten.",
            409,
            "CONFLICT",
            { messageKey: "serverFeature:trace.fileChanged", params: {} },
          );
        result.push(file);
      }
      for (const f of result)
        if ((await readFile(sessionId, f.path)).version !== f.version)
          throw new AppError(
            "Datei während der Snapshot-Erfassung geändert.",
            409,
            "CONFLICT",
            { messageKey: "serverFeature:trace.snapshotChanged", params: {} },
          );
      return result;
    });
    const trace = validateTrace(
      { entry, files, stdin: body.stdin ?? "" },
      (m, metadata = {}) => {
        throw new AppError(m, 400, "INVALID_REQUEST", metadata);
      },
    );
    await requireSpace(DATA_DIR, 8 * 1024 * 1024);
    const id = randomUUID();
    const run = {
      schemaVersion: 1,
      traceRunId: id,
      operationId: body.operationId,
      sessionId,
      processId: id,
      snapshot: { snapshotId: randomUUID(), entry, files },
      limits: TRACE_LIMITS,
      request,
      status: "starting",
      reason: null,
      complete: false,
      events: [],
      createdAt: new Date().toISOString(),
      limitations:
        "Nur Python-Hauptthread und ausgewählte Quellen; native Bibliotheken, Threads und asynchrone Abläufe werden nicht vollständig beobachtet. Rückwärtsschritte spielen gespeicherte Zustände ab und machen keine Seiteneffekte rückgängig.",
      limitationsKey: "serverFeature:trace.limitations",
      limitationsParams: {},
    };
    await save(run);
    try {
      const job = await startProcess({
        sessionId,
        file: entry,
        language: "python",
        trace,
        idempotencyId: id,
      });
      run.processId = job.processId;
      collect(run, job);
      await save(run);
      monitor(sessionId, id);
    } catch (error) {
      if (error.code === "RUNNER_UNAVAILABLE") {
        run.status = "starting";
        run.reason = "connection_lost";
        run.error = error.message;
        if (error.messageKey) {
          run.errorKey = error.messageKey;
          run.errorParams = error.params || {};
        }
        await save(run);
        monitor(sessionId, id);
        return summary(run);
      }
      run.status = "interrupted";
      run.reason = error.code || "start_failed";
      run.error = error.message;
      if (error.messageKey) {
        run.errorKey = error.messageKey;
        run.errorParams = error.params || {};
      }
      await save(run);
      throw error;
    }
    return summary(run);
  });
}
export async function getTrace(session, id) {
  return serial(`trace:${id}`, async () => {
    const run = await load(session, id);
    if (["starting", "running"].includes(run.status)) {
      await refresh(run);
      if (!live.has(id) && ["starting", "running"].includes(run.status))
        monitor(session, id);
    }
    return summary(run);
  });
}
export async function traceEvents(
  session,
  id,
  fromStep = 1,
  limit = 50,
  detail = "full",
) {
  if (
    !Number.isInteger(fromStep) ||
    fromStep < 1 ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > 50 ||
    !["full", "summary"].includes(detail)
  )
    throw new AppError(
      "Ungültige Trace-Seite (höchstens 50 Ereignisse).",
      undefined,
      undefined,
      { messageKey: "serverFeature:trace.invalidPage", params: {} },
    );
  const info = await getTrace(session, id);
  const run = await load(session, id);
  const events = run.events
    .slice(fromStep - 1, fromStep - 1 + limit)
    .map((e) =>
      detail === "summary"
        ? {
            step: e.step,
            event: e.event,
            file: e.file,
            line: e.line,
            function: e.function,
            exception: e.exception,
          }
        : e,
    );
  return {
    traceRunId: id,
    status: info.status,
    reason: info.reason,
    ...reasonMetadata(info.reason, info.errorKey, info.errorParams),
    complete: info.complete,
    events,
    nextStep: fromStep + events.length,
    eventCount: run.events.length,
  };
}
export async function cancelTrace(session, id) {
  return serial(`trace:${id}`, async () => {
    const run = await load(session, id);
    if (["starting", "running"].includes(run.status)) {
      try {
        collect(run, await stopProcess(run.processId, session));
      } catch (error) {
        if (error.status !== 404) throw error;
        run.status = "interrupted";
        run.reason = "process_unavailable";
      }
      await save(run);
    }
    return summary(run);
  });
}
export async function listTraces(session) {
  await getWorkspacePath(session);
  await prune(session);
  const dir = path.join(DATA_DIR, "traces", session);
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
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, 20)
    .map((r) => ({
      traceRunId: r.traceRunId,
      status: r.status,
      entry: r.snapshot.entry,
      createdAt: r.createdAt,
    }));
}

// Housekeeping never replays a start. Active or unreachable jobs are retained.
const expiryTimer = setInterval(
  async () => {
    const root = path.join(DATA_DIR, "traces");
    try {
      for (const session of await fs.readdir(root)) {
        try {
          validateSessionId(session);
          await prune(session);
        } catch {
          /* deleted/locked session or unavailable storage */
        }
      }
    } catch {
      /* No traces yet, or storage temporarily unavailable. */
    }
  },
  60 * 60 * 1000,
);
expiryTimer.unref();
