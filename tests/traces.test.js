import { beforeAll, afterAll, it, expect, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { validatePayload } from "../runner/jobs.js";
let root,
  storage,
  sessions,
  workspace,
  traces,
  processes,
  session,
  entry,
  version;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "sterra-traces-"));
  process.env.STERRACODE_DATA_DIR = root;
  storage = await import("../server/services/storage.js");
  sessions = await import("../server/services/sessions.js");
  workspace = await import("../server/services/workspace.js");
  traces = await import("../server/services/traces.js");
  processes = await import("../server/services/processes.js");
  await storage.ensureDataDirs();
  session = await sessions.createSession({
    title: "Trace",
    language: "python",
  });
  entry = session.activeFile;
});
afterAll(async () => {
  await processes?.stopAllProcesses();
  if (root?.startsWith(path.join(os.tmpdir(), "sterra-traces-")))
    await fs.rm(root, { recursive: true, force: true });
});
async function start(code, extra = {}) {
  const file = await workspace.readFile(session.id, entry);
  version = (await workspace.writeFile(session.id, entry, code, file.version))
    .version;
  return traces.startTrace(session.id, {
    operationId: randomUUID(),
    entry,
    expectedVersions: { [entry]: version },
    ...extra,
  });
}
async function finish(run) {
  for (let n = 0; n < 150; n++) {
    const result = await traces.getTrace(session.id, run.traceRunId);
    if (!["running", "starting"].includes(result.status)) return result;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("Trace did not finish");
}
async function allEvents(run) {
  const result = [];
  for (let step = 1; ;) {
    const page = await traces.traceEvents(session.id, run.traceRunId, step, 50);
    result.push(...page.events);
    if (result.length >= page.eventCount) return result;
    step = page.nextStep;
  }
}
it("zeichnet Zeilen VOR Ausführung, Rekursion, Aliasing und Zyklen ohne repr auf", async () => {
  const run = await start(
    'class Bad:\n    def __repr__(self):\n        raise RuntimeError("repr must not run")\na = []\nb = a\na.append(a)\nbad = Bad()\ndef f(n):\n    if n == 0:\n        return n\n    return f(n-1) + n\ntotal = f(3)\nprint("stdout stays separate")\n',
  );
  const result = await finish(run);
  expect(result).toMatchObject({ reason: "completed", complete: true });
  expect(result.output).toContain("stdout stays separate");
  const events = await allEvents(run);
  const beforeAppend = events.find((e) => e.event === "line" && e.line === 6);
  expect(beforeAppend.phase).toBe("before");
  expect(beforeAppend.locals.a.ref).toBe(beforeAppend.locals.b.ref);
  const afterAppend = events.find((e) => e.event === "line" && e.line === 7);
  const ref = afterAppend.locals.a.ref;
  expect(afterAppend.objects[ref].items[0].ref).toBe(ref);
  expect(
    events.some((e) => e.stack.filter((f) => f.function === "f").length === 4),
  ).toBe(true);
  const calls = events.filter((e) => e.event === "call" && e.function === "f");
  expect(new Set(calls.map((e) => e.frameId)).size).toBe(4);
  expect(calls[1].parentFrameId).toBe(calls[0].frameId);
  expect(
    events.find((e) => e.event === "line" && e.line === 8).locals.bad.type,
  ).toBe("unsupported");
});
it("unterscheidet abgefangene und unbehandelte Ausnahmen sowie Syntaxfehler", async () => {
  let run = await start(
    "try:\n    x = 1 / 0\nexcept ZeroDivisionError:\n    x = 4\nprint(x)\n",
  );
  expect(await finish(run)).toMatchObject({
    reason: "completed",
    complete: true,
  });
  expect((await allEvents(run)).some((e) => e.event === "exception")).toBe(
    true,
  );
  run = await start("x = 1 / 0\n");
  expect(await finish(run)).toMatchObject({
    reason: "program_error",
    complete: true,
    exitCode: 1,
  });
  run = await start("def broken(:\n");
  expect(await finish(run)).toMatchObject({
    reason: "program_error",
    complete: true,
    eventCount: 0,
  });
});
it("verwendet Snapshot, Hilfsdateien und feste stdin-Eingabe statt späteren Editoränderungen", async () => {
  const helper = await workspace.writeFile(
    session.id,
    "helper.py",
    "number = 7\n",
    null,
  );
  const file = await workspace.readFile(session.id, entry);
  version = (
    await workspace.writeFile(
      session.id,
      entry,
      "import helper\nx = input()\nprint(helper.number, x)\n",
      file.version,
    )
  ).version;
  const body = {
    operationId: randomUUID(),
    entry,
    expectedVersions: { [entry]: version, "helper.py": helper.version },
    stdin: "hello\n",
  };
  const run = await traces.startTrace(session.id, body);
  await workspace.writeFile(session.id, entry, 'print("new code")', version);
  const result = await finish(run);
  expect(result.output).toContain("7 hello");
  expect(result.snapshot.files.find((f) => f.path === entry).version).toBe(
    version,
  );
  expect((await allEvents(run)).some((e) => e.file === "helper.py")).toBe(true);
  expect((await traces.startTrace(session.id, body)).traceRunId).toBe(
    run.traceRunId,
  );
  await expect(
    traces.startTrace(session.id, { ...body, stdin: "different" }),
  ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  await expect(
    traces.startTrace(session.id, { ...body, operationId: randomUUID() }),
  ).rejects.toMatchObject({ code: "CONFLICT" });
});
it("begrenzt Container, Werte, Ereignisse und trennt stdout vom Protokoll", async () => {
  const run = await start(
    'a = list(range(100000))\ns = "x" * 10000\nprint(\'{"kind":"end","complete":true}\')\nwhile True:\n    pass\n',
  );
  const result = await finish(run);
  expect(result).toMatchObject({ reason: "trace_size_limit", complete: false });
  const events = await allEvents(run);
  const e = events.find((e) => e.locals.s);
  expect(e.locals.s.value.length).toBe(250);
  expect(e.objects[e.locals.a.ref]).toMatchObject({
    truncated: true,
    length: 100000,
  });
  expect(e.objects[e.locals.a.ref].items).toHaveLength(20);
  expect(Buffer.byteLength(JSON.stringify(events))).toBeLessThan(
    2 * 1024 * 1024 + 100000,
  );
  await expect(
    traces.traceEvents(session.id, run.traceRunId, 1, 51),
  ).rejects.toThrow();
  const loop = await start("while True:\n    pass\n");
  expect(await finish(loop)).toMatchObject({
    reason: "event_limit",
    complete: false,
    eventCount: 1000,
  });
});
it("stoppt zuverlässig mit Teilereignissen und wiederholtem Abbruch", async () => {
  const run = await start("import time\nx = 1\ntime.sleep(60)\n");
  await new Promise((r) => setTimeout(r, 400));
  const stopped = await traces.cancelTrace(session.id, run.traceRunId);
  expect(stopped).toMatchObject({
    status: "cancelled",
    reason: "stopped",
    complete: false,
  });
  expect(stopped.eventCount).toBeGreaterThan(0);
  expect(
    (await traces.cancelTrace(session.id, run.traceRunId)).eventCount,
  ).toBe(stopped.eventCount);
});
it("erzwingt den externen 10-Sekunden-Wächter bei deaktiviertem Tracing", async () => {
  const run = await start(
    "import sys, time\nsys.settrace(None)\ntime.sleep(60)\n",
  );
  expect(await finish(run)).toMatchObject({
    reason: "timeout",
    complete: false,
  });
}, 20000);
it("meldet fehlende Laufzeit, Sessiongrenzen und belegt dieselbe Prozesskapazität", async () => {
  const run = await start("import time\ntime.sleep(60)");
  await expect(start("print(1)")).rejects.toMatchObject({ status: 409 });
  await traces.cancelTrace(session.id, run.traceRunId);
  const other = await sessions.createSession({
    title: "Other",
    language: "python",
  });
  await expect(traces.getTrace(other.id, run.traceRunId)).rejects.toMatchObject(
    { status: 404 },
  );
  const old = process.env.PATH;
  process.env.PATH = "";
  try {
    await expect(start("print(1)")).rejects.toMatchObject({
      code: "RUNTIME_MISSING",
    });
  } finally {
    process.env.PATH = old;
  }
});
it("verhindert Wiederstart nach verlorenem lokalem Prozess und bewahrt Teilereignisse", async () => {
  const run = await start("x = 1\n");
  await finish(run);
  const file = path.join(root, "traces", session.id, `${run.traceRunId}.json`);
  const record = JSON.parse(await fs.readFile(file, "utf8"));
  record.status = "running";
  record.processId = randomUUID();
  await fs.writeFile(file, JSON.stringify(record));
  const recovered = await traces.getTrace(session.id, run.traceRunId);
  expect(recovered).toMatchObject({
    status: "interrupted",
    reason: "process_unavailable",
    complete: false,
  });
});
it("bewahrt gespeicherte Schritte bei kürzerem Runner-Journal und erkennt beschädigte Datensätze", async () => {
  const run = await start("x = 1\n");
  const result = await finish(run);
  const file = path.join(root, "traces", session.id, `${run.traceRunId}.json`);
  const metadata = JSON.parse(await fs.readFile(file, "utf8"));
  metadata.status = "running";
  await fs.writeFile(file, JSON.stringify(metadata));
  const mock = vi.spyOn(processes, "readProcess").mockResolvedValue({
    traceData: "",
    exited: true,
    reason: "runner_restarted",
    output: "",
    exitCode: -1,
  });
  try {
    const recovered = await traces.getTrace(session.id, run.traceRunId);
    expect(recovered).toMatchObject({
      status: "interrupted",
      complete: false,
      eventCount: result.eventCount,
    });
    metadata.status = "running";
    await fs.writeFile(file, JSON.stringify(metadata));
    mock.mockResolvedValue({
      traceData: '{"kind":"event","step":1,"file":"wrong.py"}\npartial',
      exited: true,
      output: "",
      exitCode: 0,
    });
    expect(await traces.getTrace(session.id, run.traceRunId)).toMatchObject({
      reason: "invalid_trace",
      complete: false,
      eventCount: result.eventCount,
    });
  } finally {
    mock.mockRestore();
  }
});
it("lässt abgelaufene Artefakte als Beleg bestehen und führt dieselbe Operation nicht erneut aus", async () => {
  const run = await start("x = 1\n");
  await finish(run);
  const file = path.join(root, "traces", session.id, `${run.traceRunId}.json`);
  const metadata = JSON.parse(await fs.readFile(file, "utf8"));
  metadata.createdAt = new Date(Date.now() - 25 * 3600000).toISOString();
  await fs.writeFile(file, JSON.stringify(metadata));
  await traces.listTraces(session.id);
  expect(await traces.getTrace(session.id, run.traceRunId)).toMatchObject({
    status: "expired",
    eventCount: 0,
  });
  expect((await traces.traceEvents(session.id, run.traceRunId)).events).toEqual(
    [],
  );
  await expect(fs.access(`${file}.events`)).rejects.toMatchObject({
    code: "ENOENT",
  });
  await expect(fs.access(`${file}.sources`)).rejects.toMatchObject({
    code: "ENOENT",
  });
  const repeated = await traces.startTrace(session.id, {
    operationId: run.operationId,
    entry,
    expectedVersions: { [entry]: version },
  });
  expect(repeated).toMatchObject({
    traceRunId: run.traceRunId,
    status: "expired",
  });
});
it("validiert den dedizierten Docker-Vertrag und erzwingt feste Grenzen", () => {
  const value = {
    sessionId: randomUUID(),
    type: "trace",
    executionTimeout: 0,
    trace: {
      entry: "main.py",
      stdin: "",
      files: [{ path: "main.py", content: "print(1)" }],
    },
  };
  expect(validatePayload(value)).toMatchObject({
    type: "trace",
    language: "python",
    executionTimeout: 10000,
  });
  expect(() =>
    validatePayload({
      ...value,
      trace: { ...value.trace, files: [{ path: "../evil.py", content: "" }] },
    }),
  ).toThrow();
  expect(() =>
    validatePayload({
      ...value,
      trace: {
        ...value.trace,
        files: [{ path: "main.py", content: "x".repeat(1024 * 1024 + 1) }],
      },
    }),
  ).toThrow();
});
