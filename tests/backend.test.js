import {
  beforeAll,
  afterAll,
  beforeEach,
  describe,
  it,
  expect,
  vi,
} from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { randomUUID, createHash } from "node:crypto";
import { httpFixtureFactory } from "./helpers/lmStudio.js";
let setLMStudioClientFactory;

let root,
  storage,
  sessions,
  workspace,
  teacher,
  processes,
  app,
  server,
  url,
  mock,
  mockURL;
const requests = [];
let responses = [],
  mockHandler;
const listen = (server) =>
  new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () =>
      resolve(`http://127.0.0.1:${server.address().port}`),
    ),
  );
async function json(route, method = "GET", body, headers = {}) {
  const response = await fetch(url + route, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: response.status, data: await response.json() };
}
function sse(res, delta, finish = null) {
  res.write(
    `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`,
  );
}
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "sterracode-tests-"));
  process.env.STERRACODE_DATA_DIR = root;
  storage = await import("../server/services/storage.js");
  sessions = await import("../server/services/sessions.js");
  workspace = await import("../server/services/workspace.js");
  teacher = await import("../server/services/teacher.js");
  ({ setLMStudioClientFactory } =
    await import("../server/services/lmStudio.js"));
  processes = await import("../server/services/processes.js");
  await storage.ensureDataDirs();
  app = (await import("../server/app.js")).createApp();
  server = http.createServer(app);
  url = await listen(server);
  mock = http.createServer(async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw || "{}");
    requests.push(body);
    if (mockHandler) return mockHandler(req, res, body);
    const response = responses.shift() || { content: "Fertig." };
    if (body.stream) {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      if (response.tool_calls) {
        for (const [index, c] of response.tool_calls.entries())
          sse(res, { tool_calls: [{ index, ...c }] });
        sse(res, {}, "tool_calls");
      } else {
        sse(res, { content: response.content }, "stop");
      }
      res.end("data: [DONE]\n\n");
    } else {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          choices: [
            {
              message: { role: "assistant", ...response },
              finish_reason: response.tool_calls ? "tool_calls" : "stop",
            },
          ],
        }),
      );
    }
  });
  mockURL = await listen(mock);
});
beforeEach(async () => {
  setLMStudioClientFactory(httpFixtureFactory());
  requests.length = 0;
  responses = [];
  mockHandler = null;
  await storage.updateSettings({
    ...storage.defaultSettings(),
    lmStudioUrl: mockURL,
    activeModel: "test-model",
    allowAITerminalCommands: true,
    executionTimeout: 30000,
    allowedLanguages: storage.LANGUAGES,
  });
});
afterAll(async () => {
  await processes?.stopAllProcesses();
  await Promise.all(
    [server, mock].filter(Boolean).map(
      (s) =>
        new Promise((r) => {
          s.closeAllConnections();
          s.close(r);
        }),
    ),
  );
  if (root?.startsWith(path.join(os.tmpdir(), "sterracode-tests-")))
    await fs.rm(root, { recursive: true, force: true });
});

describe("Workspace und Migration", () => {
  it("nimmt eine Migration nach einem unterbrochenen Session-Commit wieder auf", async () => {
    const id = randomUUID();
    await storage.writeJSON(sessions.sessionFile(id), {
      id,
      title: "Unterbrochen",
      language: "python",
      messages: [],
      editorSnapshot: 'print("erhalten")',
    });
    const rename = fs.rename.bind(fs),
      spy = vi.spyOn(fs, "rename").mockImplementation(async (from, to) => {
        if (to === sessions.sessionFile(id))
          throw new Error("Simulierter Schreibfehler");
        return rename(from, to);
      });
    try {
      await expect(sessions.loadSession(id)).rejects.toThrow(
        "Simulierter Schreibfehler",
      );
    } finally {
      spy.mockRestore();
    }
    expect((await sessions.loadSession(id)).schemaVersion).toBe(2);
    expect((await workspace.readFile(id, "main.py")).content).toContain(
      "erhalten",
    );
  });
  it("erhält die Änderungshistorie bei Umbenennen und Entfernen von Chatnachrichten", async () => {
    const s = await sessions.createSession();
    const f = await workspace.readFile(s.id, s.activeFile);
    const c = await workspace.writeFile(s.id, s.activeFile, "KI", f.version, {
      actor: "ai",
    });
    await workspace.renamePath(s.id, s.activeFile, "umbenannt.py");
    expect((await workspace.listChanges(s.id))[0].path).toBe("umbenannt.py");
    await workspace.undoChange(s.id, c.changeId);
    expect((await workspace.readFile(s.id, "umbenannt.py")).content).toBe("");
  });
  it("weist binäre Dateien ohne Änderung ihrer Bytes zurück", async () => {
    const s = await sessions.createSession();
    const file = path.join(root, "workspaces", s.id, "binary.bin"),
      bytes = Buffer.from([0, 255, 254]);
    await fs.writeFile(file, bytes);
    await expect(workspace.readFile(s.id, "binary.bin")).rejects.toMatchObject({
      status: 415,
    });
    expect(await fs.readFile(file)).toEqual(bytes);
  });
  it("kopiert gleiche Altordner getrennt, sichert Daten und erhält abweichende Snapshots", async () => {
    const title = "Gemeinsamer Altordner";
    await fs.mkdir(path.join(root, "workspaces", title));
    await fs.writeFile(
      path.join(root, "workspaces", title, "main.py"),
      'print("Datei")',
    );
    const ids = [randomUUID(), randomUUID()];
    for (const id of ids)
      await storage.writeJSON(sessions.sessionFile(id), {
        id,
        title,
        language: "python",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        messages: [],
        editorSnapshot: 'print("Snapshot")',
      });
    const [a, b] = await Promise.all(ids.map(sessions.loadSession));
    expect(a.schemaVersion).toBe(2);
    expect(a.activeFile).toBe("recovered-editor-1.py");
    expect((await workspace.readFile(a.id, a.activeFile)).content).toContain(
      "Snapshot",
    );
    expect((await workspace.readFile(a.id, "main.py")).content).toContain(
      "Datei",
    );
    const before = await workspace.readFile(a.id, "main.py");
    await workspace.writeFile(a.id, "main.py", "anders", before.version);
    expect((await workspace.readFile(b.id, "main.py")).content).toContain(
      "Datei",
    );
    expect(
      await fs.readFile(
        path.join(root, "workspaces", title, "main.py"),
        "utf8",
      ),
    ).toContain("Datei");
    expect(
      (await fs.readdir(path.join(root, "backups"))).filter((n) =>
        ids.some((id) => n.startsWith(id)),
      ).length,
    ).toBe(2);
    expect((await sessions.loadSession(a.id)).activeFile).toBe(a.activeFile);
  });
  it.each([
    "../escape.py",
    "..\\escape.py",
    "/absolute",
    "C:\\test",
    "C:relative",
    "file:stream",
    "folder/../escape",
    "CON.txt",
    "folder./file",
    "folder//file",
    ".",
    "..",
  ])("weist gefährlichen Pfad %s zurück", async (file) => {
    const s = await sessions.createSession();
    await expect(
      workspace.writeFile(s.id, file, "x", null),
    ).rejects.toBeInstanceOf(Error);
  });
  it("blockiert Verzeichnisverknüpfungen", async () => {
    const s = await sessions.createSession();
    const outside = path.join(root, "outside");
    await fs.mkdir(outside, { recursive: true });
    await fs.symlink(
      outside,
      path.join(root, "workspaces", s.id, "link"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(
      workspace.writeFile(s.id, "link/escape.txt", "x", null),
    ).rejects.toMatchObject({ status: 403 });
  });
  it("verhindert konkurrierendes Überschreiben", async () => {
    const s = await sessions.createSession();
    const f = await workspace.readFile(s.id, s.activeFile);
    const result = await Promise.allSettled(
      ["A", "B"].map((text) =>
        workspace.writeFile(s.id, s.activeFile, text, f.version),
      ),
    );
    expect(result.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(result.find((r) => r.status === "rejected").reason.status).toBe(409);
  });
  it("führt Session-Teiländerungen ohne verlorene Updates zusammen", async () => {
    const s = await sessions.createSession();
    await Promise.all([
      sessions.mutateSession(s.id, (v) => {
        v.title = "Neuer Name";
      }),
      sessions.mutateSession(s.id, (v) => {
        v.language = "java";
      }),
    ]);
    const updated = await sessions.loadSession(s.id);
    expect(updated.title).toBe("Neuer Name");
    expect(updated.language).toBe("java");
    expect(updated.revision).toBe(2);
  });
  it("erhält leere und Unicode-Dateien und löscht nur zuvor nicht existierende Dateien bei Undo", async () => {
    const s = await sessions.createSession();
    const f = await workspace.readFile(s.id, s.activeFile);
    const change = await workspace.writeFile(
      s.id,
      s.activeFile,
      "Grüße 世界",
      f.version,
      { actor: "ai" },
    );
    await workspace.undoChange(s.id, change.changeId);
    expect((await workspace.readFile(s.id, s.activeFile)).content).toBe("");
    const added = await workspace.writeFile(s.id, "neu.txt", "世界", null, {
      actor: "ai",
    });
    await workspace.undoChange(s.id, added.changeId);
    await expect(workspace.readFile(s.id, "neu.txt")).rejects.toMatchObject({
      status: 404,
    });
    expect(
      (await workspace.undoChange(s.id, added.changeId)).alreadyUndone,
    ).toBe(true);
  });
  it("überschreibt bei Undo keine spätere Änderung", async () => {
    const s = await sessions.createSession();
    const f = await workspace.readFile(s.id, s.activeFile);
    const change = await workspace.writeFile(
      s.id,
      s.activeFile,
      "KI",
      f.version,
      { actor: "ai" },
    );
    await workspace.writeFile(s.id, s.activeFile, "Nutzer", change.version);
    await expect(
      workspace.undoChange(s.id, change.changeId),
    ).rejects.toMatchObject({ status: 409 });
  });
  it("aktualisiert aktive Dateien beim Umbenennen und Löschen von Ordnern", async () => {
    const s = await sessions.createSession();
    await workspace.writeFile(s.id, "src/a.js", "x", null);
    await sessions.mutateSession(s.id, (v) => {
      v.activeFile = "src/a.js";
      v.openFiles = ["src/a.js"];
    });
    await workspace.renamePath(s.id, "src", "lib");
    expect((await sessions.loadSession(s.id)).activeFile).toBe("lib/a.js");
    await workspace.deletePath(s.id, "lib");
    expect((await sessions.loadSession(s.id)).activeFile).toBe(null);
  });
});

describe("Chat und Kontext", () => {
  it("setzt nach einem Serverneustart einen verwaisten Turn ohne doppelte Nutzernachricht fort", async () => {
    const s = await sessions.createSession(),
      old = randomUUID();
    await sessions.mutateSession(s.id, (v) => {
      v.messages.push(
        sessions.message("user", "Vor dem Neustart", { turnId: old }),
      );
      v.turns[old] = { id: old, status: "running" };
    });
    const result = await teacher.runTeacher({ sessionId: s.id, retryOf: old });
    expect(result.turn.status).toBe("done");
    expect(result.session.turns[old].status).toBe("aborted");
    expect(
      result.session.messages.filter((m) => m.role === "user"),
    ).toHaveLength(1);
    expect(requests).toHaveLength(1);
  });
  it("führt angeforderte Kontextkomprimierung aus und erhält den vollständigen Verlauf", async () => {
    const s = await sessions.createSession();
    await sessions.mutateSession(s.id, (v) => {
      for (let i = 0; i < 6; i++)
        v.messages.push(
          sessions.message(i % 2 ? "assistant" : "user", `Nachricht ${i}`),
        );
    });
    await storage.updateSettings({ keepRecentTokens: 0 });
    responses = [
      {
        tool_calls: [
          {
            id: "summary-call",
            type: "function",
            function: { name: "trigger_summarize", arguments: "{}" },
          },
        ],
      },
      { content: "Zusammenfassung" },
      { content: "Abgeschlossen" },
    ];
    const result = await teacher.runTeacher({
      sessionId: s.id,
      userMessage: "Kontext zusammenfassen",
    });
    expect(result.turn.status).toBe("done");
    expect(
      result.session.messages.filter((m) => m.role !== "event"),
    ).toHaveLength(10);
    expect(
      JSON.parse(result.session.messages.find((m) => m.role === "tool").content)
        .status,
    ).toBe("scheduled");
    expect(
      result.session.messages.some(
        (m) => m.event?.type === "context_compaction",
      ),
    ).toBe(true);
    expect(requests).toHaveLength(3);
  });
  it("erhält unabhängigen manuellen Lernfortschritt beim Löschen einer Chatantwort", async () => {
    const s = await sessions.createSession({ tutorLocale: "de" });
    await teacher.runTeacher({ sessionId: s.id, userMessage: "Hallo" });
    const plan = {
      goal: "Eigenes Ziel",
      topics: [{ id: "manual", title: "Manuell erledigt", done: true }],
    };
    await json(`/api/sessions/${s.id}`, "PATCH", { learningPlan: plan });
    const result = await teacher.deleteLastUserMessage({ sessionId: s.id });
    expect(result.session.learningPlan).toEqual(plan);
    expect(result.session.messages.some((m) => m.role === "user")).toBe(false);
    expect(
      result.session.messages.some((m) =>
        m.event?.question?.includes("weiterführenden"),
      ),
    ).toBe(true);
  });
  it("stellt nach Lernplanabschluss genau eine Anschlussfrage und übergibt Anwendungsfragen als Kontext", async () => {
    const s = await sessions.createSession({ tutorLocale: "de" });
    const plan = {
      goal: "Ziel",
      topics: [{ id: "eins", title: "Ein Thema", done: true }],
    };
    await sessions.mutateSession(s.id, (v) =>
      sessions.setLearningPlan(v, plan),
    );
    await sessions.mutateSession(s.id, (v) =>
      sessions.setLearningPlan(v, plan),
    );
    const done = await sessions.loadSession(s.id);
    expect(
      done.messages.filter((m) =>
        m.event?.question?.includes("weiterführenden"),
      ),
    ).toHaveLength(1);
    const { modelHistory } =
      await import("../server/services/context/history.js");
    expect(
      modelHistory(done).some((m) =>
        m.text.includes("Möchtest du einen Lernplan"),
      ),
    ).toBe(true);
  });
  it.each([true, false])(
    "erzeugt die finale Antwort einmal, mit Streaming=%s",
    async (stream) => {
      const s = await sessions.createSession();
      const turnId = randomUUID();
      const result = await teacher.runTeacher({
        sessionId: s.id,
        userMessage: "Hallo",
        turnId,
        stream,
      });
      expect(result.turn.status).toBe("done");
      expect(requests).toHaveLength(1);
      expect(
        result.session.messages.filter((m) => m.role === "assistant"),
      ).toHaveLength(1);
      const replay = await teacher.runTeacher({
        sessionId: s.id,
        userMessage: "Hallo",
        turnId,
        stream,
      });
      expect(replay.replayed).toBe(true);
      expect(requests).toHaveLength(1);
    },
  );
  it("speichert Tool-Ereignisse und ausgeführte Dateiänderungen dauerhaft", async () => {
    const s = await sessions.createSession();
    responses = [
      {
        tool_calls: [
          {
            id: "call1",
            type: "function",
            function: {
              name: "write_file",
              arguments: JSON.stringify({
                path: "übung.py",
                code: 'print("世界")',
                reason: "Vorlage",
                expectedVersion: null,
              }),
            },
          },
        ],
      },
      { content: "Vorlage erstellt." },
    ];
    const events = [];
    const result = await teacher.runTeacher({
      sessionId: s.id,
      userMessage: "Aufgabe",
      stream: true,
      onEvent: (name, data) => events.push({ name, data }),
    });
    expect(requests).toHaveLength(2);
    const tool = result.session.messages.find((m) => m.role === "tool");
    const event = JSON.parse(tool.content);
    expect(event.changeId).toBeTruthy();
    expect(
      events.some((e) => e.name === "message" && e.data.id === tool.id),
    ).toBe(true);
    expect((await workspace.readFile(s.id, "übung.py")).content).toContain(
      "世界",
    );
    await workspace.undoChange(s.id, event.changeId);
    expect(
      JSON.parse(
        (await sessions.loadSession(s.id)).messages.find(
          (m) => m.id === tool.id,
        ).content,
      ).undone,
    ).toBe(true);
  });
  it("speichert Antworten eindeutig und verhindert mehrfaches Beantworten", async () => {
    const s = await sessions.createSession();
    const questionId = s.messages[0].event.questionId;
    const answer = await teacher.answerQuestion(s.id, questionId, "Ja, bitte");
    expect(answer.session.messages[0].event.answer).toBe("Ja, bitte");
    await teacher.answerQuestion(s.id, questionId, "Ja, bitte");
    await expect(
      teacher.answerQuestion(s.id, questionId, "Nein"),
    ).rejects.toMatchObject({ status: 409 });
    const done = await teacher.runTeacher({
      sessionId: s.id,
      existingUserMessageId: answer.messageId,
    });
    expect(done.session.messages.filter((m) => m.role === "user")).toHaveLength(
      1,
    );
  });
  it("bewahrt vollständigen Verlauf trotz Kontextkomprimierung und verwirft veraltete Zusammenfassungen nach Edit", async () => {
    const s = await sessions.createSession();
    await sessions.mutateSession(s.id, (v) => {
      for (let i = 0; i < 12; i++)
        v.messages.push(
          sessions.message(
            i % 2 ? "assistant" : "user",
            "Langer Text ".repeat(150),
          ),
        );
    });
    await storage.updateSettings({
      thresholdPercent: 10,
      compactFloorPercent: 5,
      keepRecentTokens: 500,
    });
    const done = await teacher.runTeacher({
      sessionId: s.id,
      userMessage: "Weiter",
    });
    expect(
      done.session.messages.filter((m) => m.role !== "event"),
    ).toHaveLength(14);
    expect(done.contextUsage.coveredMessages).toBeGreaterThan(0);
    const first = done.session.messages.find((m) => m.role === "user");
    const edited = await teacher.editUserMessage({
      sessionId: s.id,
      messageId: first.id,
      newContent: "Geändert",
    });
    expect(edited.contextUsage).toBe(null);
    expect(edited.messages.at(-1).edited).toBe(true);
  });
  it("bricht Streaming ab und führt bereits gespeicherte Tools beim Wiederholen nicht erneut aus", async () => {
    const s = await sessions.createSession();
    mockHandler = (req, res) => {
      res.writeHead(200, { "Content-Type": "text/event-stream" });
      sse(res, { content: "Teilantwort" });
    };
    const controller = new AbortController(),
      turnId = randomUUID();
    const task = teacher.runTeacher({
      sessionId: s.id,
      userMessage: "Warte",
      turnId,
      stream: true,
      signal: controller.signal,
      onEvent: (name) => {
        if (name === "token") controller.abort();
      },
    });
    const result = await task;
    expect(result.turn.status).toBe("aborted");
    expect(result.session.messages.at(-1).incomplete).toBe(true);
    await teacher.runTeacher({
      sessionId: s.id,
      userMessage: "Warte",
      turnId,
      stream: true,
    });
    expect(requests).toHaveLength(1);
  });
});

describe("API-Grenzen und Prozesse", () => {
  it("prüft Ursprung, Host, JSON und fehlerhafte IDs", async () => {
    expect(
      (
        await json(
          "/api/sessions",
          "POST",
          {},
          { Origin: "https://example.com" },
        )
      ).status,
    ).toBe(403);
    const hostStatus = await new Promise((resolve, reject) => {
      const request = http.get(
        url + "/api/sessions",
        { headers: { Host: "example.com" } },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      );
      request.on("error", reject);
    });
    expect(hostStatus).toBe(403);
    const r = await fetch(url + "/api/sessions", { method: "POST", body: "x" });
    expect(r.status).toBe(415);
    expect((await json("/api/sessions/invalid")).status).toBe(400);
    expect((await json("/api/missing")).status).toBe(404);
  });
  it("liefert Versionskonflikte mit HTTP 409", async () => {
    const s = await sessions.createSession();
    const result = await json(`/api/workspaces/${s.id}/files/content`, "PUT", {
      path: s.activeFile,
      content: "x",
      expectedVersion: "stale",
    });
    expect(result.status).toBe(409);
    expect(result.data.code).toBe("CONFLICT");
  });
  it("erhält explizites Timeout 0", async () => {
    await storage.updateSettings({ executionTimeout: 0 });
    expect((await storage.getSettings()).executionTimeout).toBe(0);
  });
  it("prüft alle neun Adapter mit vorhandenen und fehlenden Laufzeiten", async () => {
    const available = await processes.getRuntimes(async () => ({
      available: true,
      output: "24.0.0",
    }));
    expect(available).toHaveLength(9);
    expect(available.every((r) => r.available)).toBe(true);
    const missing = await processes.getRuntimes(async () => ({
      available: false,
      output: "",
    }));
    expect(missing.every((r) => !r.available && r.reason)).toBe(true);
  });
  it("führt Dateien mit lokalen Imports im Workspace aus", async () => {
    const s = await sessions.createSession({ language: "javascript" });
    const f = await workspace.readFile(s.id, s.activeFile);
    await workspace.writeFile(
      s.id,
      "helper.cjs",
      'module.exports="IMPORT_OK"',
      null,
    );
    await workspace.writeFile(
      s.id,
      s.activeFile,
      'console.log(require("./helper.cjs"))',
      f.version,
    );
    const job = await processes.startProcess({
      sessionId: s.id,
      file: s.activeFile,
      language: "javascript",
    });
    const result = await processes.waitProcess(job.processId, s.id);
    expect(result.output).toContain("IMPORT_OK");
    expect(result.exitCode).toBe(0);
    expect(() => processes.readProcess(job.processId, randomUUID())).toThrow(
      "nicht gefunden",
    );
  });
  it("verarbeitet Eingaben, Stoppen, Timeout und Ausgabelimit", async () => {
    const s = await sessions.createSession({ language: "javascript" });
    const file = "input.cjs";
    await workspace.writeFile(
      s.id,
      file,
      'process.stdin.once("data", d => { console.log("INPUT:"+d.toString().trim());process.exit(0); });',
      null,
    );
    let job = await processes.startProcess({
      sessionId: s.id,
      file,
      language: "javascript",
    });
    for (let i = 0; i < 100; i++) {
      try {
        processes.inputProcess(job.processId, s.id, "Hallo");
        break;
      } catch {
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    expect((await processes.waitProcess(job.processId, s.id)).output).toContain(
      "INPUT:Hallo",
    );
    await workspace.writeFile(
      s.id,
      "loop.cjs",
      "setInterval(()=>{},1000)",
      null,
    );
    job = await processes.startProcess({
      sessionId: s.id,
      file: "loop.cjs",
      language: "javascript",
    });
    expect((await processes.stopProcess(job.processId, s.id)).reason).toBe(
      "stopped",
    );
    await storage.updateSettings({ executionTimeout: 100 });
    job = await processes.startProcess({
      sessionId: s.id,
      file: "loop.cjs",
      language: "javascript",
    });
    expect((await processes.waitProcess(job.processId, s.id)).reason).toBe(
      "timeout",
    );
    await storage.updateSettings({ executionTimeout: 30000 });
    await workspace.writeFile(
      s.id,
      "output.cjs",
      'setInterval(()=>process.stdout.write("x".repeat(65536)),1)',
      null,
    );
    job = await processes.startProcess({
      sessionId: s.id,
      file: "output.cjs",
      language: "javascript",
    });
    const capped = await processes.waitProcess(job.processId, s.id);
    expect(capped.reason).toBe("output_limit");
    expect(Buffer.byteLength(capped.output)).toBeLessThanOrEqual(
      processes.MAX_OUTPUT,
    );
  });
  it("setzt die KI-Terminal-Einstellung serverseitig durch", async () => {
    const s = await sessions.createSession();
    await storage.updateSettings({ allowAITerminalCommands: false });
    await expect(
      processes.startProcess({
        sessionId: s.id,
        command: "echo test",
        actor: "ai",
      }),
    ).rejects.toMatchObject({ status: 403 });
  });
});
