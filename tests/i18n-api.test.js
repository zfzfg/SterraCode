import { beforeAll, afterAll, describe, it, expect, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { randomUUID } from "node:crypto";

vi.mock("../server/services/teacher.js", async (original) => ({
  ...(await original()),
  runTeacher: async ({ userMessage, onEvent }) => {
    if (userMessage === "internal")
      throw new Error("private upstream detail: never expose");
    if (userMessage === "events") {
      onEvent("notice", {
        message: "Abgebrochen.",
        messageKey: "serverFeature:tools.aborted",
        params: {},
      });
      onEvent("token", { token: "Abgebrochen." });
      return { original: "Abgebrochen." };
    }
    throw Object.assign(new Error("Ungültiges Tool-Feld: A&B.py"), {
      status: 409,
      code: "CONFLICT",
      messageKey: "serverFeature:tools.invalidField",
      params: { name: "A&B.py" },
    });
  },
}));

let temp, storage, sessions, workspace, origin, protectedOrigin, auth;
const servers = [];
async function serve(app) {
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}
beforeAll(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), "sterracode-i18n-api-"));
  vi.stubEnv("STERRACODE_DATA_DIR", temp);
  vi.stubEnv("STERRACODE_MODE", "local");
  vi.stubEnv("STERRACODE_RUNNER_URL", "");
  storage = await import("../server/services/storage.js");
  sessions = await import("../server/services/sessions.js");
  workspace = await import("../server/services/workspace.js");
  await storage.ensureDataDirs();
  const { createApp } = await import("../server/app.js");
  const { loadConfig } = await import("../server/config.js");
  const { createAuthService } = await import("../server/services/auth.js");
  origin = await serve(
    createApp({ config: loadConfig({ STERRACODE_DATA_DIR: temp }) }),
  );
  const authDir = path.join(temp, "protected");
  auth = createAuthService({ dataDir: authDir });
  protectedOrigin = await serve(
    createApp({
      config: loadConfig({
        STERRACODE_MODE: "server",
        STERRACODE_PUBLIC_URL: "http://127.0.0.1:3000",
        STERRACODE_DATA_DIR: authDir,
      }),
      auth,
    }),
  );
});
afterAll(async () => {
  await Promise.all(
    servers.map((server) => new Promise((resolve) => server.close(resolve))),
  );
  vi.unstubAllEnvs();
  await fs.rm(temp, { recursive: true, force: true });
});
async function request(
  endpoint,
  locale,
  {
    base = origin,
    body,
    method = body === undefined ? "GET" : "POST",
    headers = {},
  } = {},
) {
  const response = await fetch(base + endpoint, {
    method,
    headers: {
      "Accept-Language": locale,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { response, value: await response.json() };
}
function frames(text) {
  return text
    .trim()
    .split("\n\n")
    .filter((frame) => frame.startsWith("event:"))
    .map((frame) => {
      const [event, data] = frame.split("\n");
      return { event: event.slice(7), data: JSON.parse(data.slice(6)) };
    });
}

describe("request-local server messages", () => {
  it("serves only registered public catalogs and reports their actual language", async () => {
    const spanish = await fetch(`${origin}/i18n/locales/es/auth.json`, {
      headers: { "Accept-Language": "de" },
    });
    expect(spanish.status).toBe(200);
    expect(spanish.headers.get("Content-Language")).toBe("es");
    expect((await spanish.json())["login.submit"]).toBe("Iniciar sesión");
    for (const url of [
      "/i18n/locales/constructor/auth.json",
      "/i18n/locales/es/unknown.json",
      "/i18n/locales/es/%2e%2e%2fserver%2fconfig.json",
    ])
      expect((await fetch(origin + url)).status).toBe(404);
    const created = await request("/api/sessions", "es", { body: {} });
    expect(created.value).toMatchObject({
      title: "Nueva sesión",
      tutorLocale: "es",
    });
  });
  it("localizes malformed and oversized JSON without returning request fragments", async () => {
    const invalid = await fetch(origin + "/api/chat/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept-Language": "en" },
      body: '{"password":"fixture-private-fragment",}',
    });
    const invalidText = await invalid.text();
    expect(invalid.status).toBe(400);
    expect(JSON.parse(invalidText)).toEqual({
      error: "Invalid JSON.",
      messageKey: "errors:http.invalidJson",
      params: {},
      code: "SERVER_ERROR",
    });
    expect(invalidText).not.toContain("fixture-private-fragment");
    expect(invalidText).not.toContain("SyntaxError");
    const large = await fetch(origin + "/api/chat/feedback", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept-Language": "en" },
      body: JSON.stringify({
        password: "fixture-private-fragment",
        text: "x".repeat(4 * 1024 * 1024),
      }),
    });
    const largeText = await large.text();
    expect(large.status).toBe(413);
    expect(JSON.parse(largeText)).toEqual({
      error: "The request is too large.",
      messageKey: "errors:http.requestTooLarge",
      params: {},
      code: "SERVER_ERROR",
    });
    expect(largeText).not.toContain("fixture-private-fragment");
  });
  it("keeps simultaneous REST locales independent and preserves codes and status", async () => {
    const messages = {
      de: "Ungültiges Feedback.",
      en: "Invalid feedback.",
      es: "La valoración no es válida.",
    };
    const results = await Promise.all(
      Array.from({ length: 24 }, async (_, index) => {
        const locale = ["de", "es", "en"][index % 3];
        const result = await request("/api/chat/feedback", locale, {
          body: { value: 0 },
        });
        return { locale, ...result };
      }),
    );
    for (const { locale, response, value } of results) {
      expect(response.status).toBe(400);
      expect(response.headers.get("Content-Language")).toBe(locale);
      expect(response.headers.get("Cache-Control")).toBe("no-store");
      expect(value).toEqual({
        error: messages[locale],
        code: "INVALID_REQUEST",
        messageKey: "serverFeature:chat.invalidFeedback",
        params: {},
      });
    }
  });
  it("preserves file versions, conflict codes and original source under localized errors", async () => {
    const session = await sessions.createSession({
      title: "Original",
      language: "python",
    });
    const initial = await workspace.readFile(session.id, session.activeFile);
    for (const locale of ["en", "es"]) {
      const { response, value } = await request(
        `/api/workspaces/${session.id}/files/content`,
        locale,
        {
          method: "PUT",
          body: {
            path: session.activeFile,
            content: "must not overwrite",
            expectedVersion: "0".repeat(64),
          },
        },
      );
      expect(response.status).toBe(409);
      expect(value).toMatchObject({
        code: "CONFLICT",
        messageKey: "serverFeature:workspace.versionConflict",
      });
      expect(value.error).toContain(
        locale === "en" ? "your changes remain" : "tus cambios permanecen",
      );
    }
    expect(await workspace.readFile(session.id, session.activeFile)).toEqual(
      initial,
    );
    const denied = await request(
      `/api/workspaces/${session.id}/files/content?path=../outside.py`,
      "es",
    );
    expect(denied.response.status).toBe(400);
    expect(denied.value).toMatchObject({
      code: "INVALID_REQUEST",
      messageKey: "serverFeature:workspace.invalidPath",
    });
  });
  it("localizes concurrent SSE errors with safe parameters and keeps model tokens original", async () => {
    const results = await Promise.all(
      ["en", "es"].map(async (locale) => {
        const response = await fetch(origin + "/api/chat/stream", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "Accept-Language": locale,
          },
          body: JSON.stringify({ userMessage: "failure" }),
        });
        return { locale, values: frames(await response.text()) };
      }),
    );
    for (const { locale, values } of results) {
      expect(values).toHaveLength(1);
      expect(values[0]).toMatchObject({
        event: "error",
        data: {
          code: "CONFLICT",
          messageKey: "serverFeature:tools.invalidField",
          params: { name: "A&B.py" },
        },
      });
      expect(values[0].data.message).toBe(
        locale === "en"
          ? "Invalid tool field: A&B.py"
          : "El campo de la herramienta no es válido: A&B.py",
      );
    }
    const response = await fetch(origin + "/api/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept-Language": "en" },
      body: JSON.stringify({ userMessage: "events" }),
    });
    const values = frames(await response.text());
    expect(values[0].data.message).toBe("Cancelled.");
    expect(values.find((frame) => frame.event === "token").data.token).toBe(
      "Abgebrochen.",
    );
    expect(values.find((frame) => frame.event === "done").data.original).toBe(
      "Abgebrochen.",
    );
    const internal = await fetch(origin + "/api/chat/stream", {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept-Language": "en" },
      body: JSON.stringify({ userMessage: "internal" }),
    });
    const internalFrames = frames(await internal.text());
    expect(internalFrames[0].data).toMatchObject({
      code: "SERVER_ERROR",
      messageKey: "errors:http.internal",
    });
    expect(internalFrames[0].data.message).not.toContain("private upstream");
  });
  it("localizes protected setup, password validation and login without changing authentication", async () => {
    const setup = await request("/api/server", "es", { base: protectedOrigin });
    expect(setup.response.status).toBe(401);
    expect(setup.value).toMatchObject({
      code: "SETUP_REQUIRED",
      error: "Completa primero la configuración protegida.",
    });
    const setupKey = await auth.createSetupKey();
    const invalid = await request("/api/setup", "en", {
      base: protectedOrigin,
      body: { setupKey, password: "short" },
    });
    expect(invalid.response.status).toBe(400);
    expect(invalid.value).toMatchObject({
      code: "INVALID_PASSWORD",
      error: "The password must contain between 12 and 1024 characters.",
      messageKey: "serverFeature:auth.passwordLength",
    });
    const completed = await request("/api/setup", "en", {
      base: protectedOrigin,
      body: { setupKey, password: "fixture-long-password" },
    });
    expect(completed.response.status).toBe(200);
    const unauthenticated = await request("/api/server", "en", {
      base: protectedOrigin,
    });
    expect(unauthenticated.response.status).toBe(401);
    expect(unauthenticated.value).toMatchObject({
      code: "AUTH_REQUIRED",
      error: "Please log in to the server.",
    });
    const denied = await request("/api/login", "es", {
      base: protectedOrigin,
      body: { password: "wrong-password" },
    });
    expect(denied.response.status).toBe(401);
    expect(denied.value).toMatchObject({
      code: "INVALID_CREDENTIALS",
      messageKey: "serverFeature:auth.invalidPassword",
      error: "La contraseña no es válida.",
    });
  });
  it("localizes only explicit owned descriptors and leaves legacy/program data untouched", async () => {
    const { localizeProcess, localizeRun, localizePreview } =
      await import("../server/services/messageOutput.js");
    const process = {
      output: "Abgebrochen.",
      reason: "stopped",
      systemMessages: [
        {
          message: "Abgebrochen.",
          messageKey: "serverFeature:tools.aborted",
          params: {},
          outputOffset: 12,
        },
      ],
      traceData: '{"message":"Abgebrochen."}',
    };
    const translated = localizeProcess(process, "en");
    expect(translated.systemMessages[0].message).toBe("Cancelled.");
    expect(translated.output).toBe(process.output);
    expect(translated.traceData).toBe(process.traceData);
    expect(process.systemMessages[0].message).toBe("Abgebrochen.");
    expect(
      localizeRun(
        {
          error: "Abgebrochen.",
          cases: [{ message: "Abgebrochen.", output: "Original" }],
        },
        "es",
      ),
    ).toEqual({
      error: "Abgebrochen.",
      cases: [{ message: "Abgebrochen.", output: "Original" }],
    });
    const preview = {
      diagnostics: [
        {
          message: "script wird in der Vorschau entfernt.",
          messageKey: "serverFeature:preview.removedElement",
          params: { tag: "script" },
        },
      ],
      manifest: [{ path: "index.html", version: "unchanged" }],
    };
    expect(localizePreview(preview, "es")).toMatchObject({
      diagnostics: [{ message: "Se elimina script de la vista previa." }],
      manifest: preview.manifest,
    });
  });
  it("adds trace marker display fields while preserving all original values and reason IDs", async () => {
    const {
      localizeTracePage,
      localizeRun,
      localizeProposal,
      localizeTeacherResult,
    } = await import("../server/services/messageOutput.js");
    const marker = {
      type: "unsupported",
      value: "<Objekt nicht ausgewertet>",
      valueMessage: { key: "runner:trace.unsupported", params: {} },
    };
    const original = { type: "str", value: "<Objekt nicht ausgewertet>" };
    const page = {
      reason: "timeout",
      events: [
        {
          locals: { marker, original },
          stack: [{ locals: { original } }],
          objects: {
            "object-1": { type: "dict", items: [[original, marker]] },
          },
          returnValue: marker,
          exception: {
            type: "ValueError",
            message: "<Ausnahme aufgetreten; siehe Gesamtergebnis>",
            messageKey: "runner:trace.exception",
            params: {},
          },
        },
      ],
    };
    const translated = localizeTracePage(page, "en");
    expect(translated.events[0].locals.marker).toMatchObject({
      value: marker.value,
      type: marker.type,
      displayValue: expect.stringContaining("not evaluated"),
    });
    expect(translated.events[0].locals.original).toEqual(original);
    expect(translated.events[0].objects["object-1"].items[0][0]).toEqual(
      original,
    );
    expect(translated.events[0].exception.message).toBe(
      page.events[0].exception.message,
    );
    expect(translated.events[0].exception.displayMessage).not.toBe(
      page.events[0].exception.message,
    );
    expect(page.events[0].locals.marker).not.toHaveProperty("displayValue");
    expect(
      localizeRun({ reason: "timeout", error: "Legacy" }, "es"),
    ).toMatchObject({
      reason: "timeout",
      reasonKey: "serverFeature:reason.timeout",
      error: "Legacy",
    });
    const proposal = {
      hunks: [
        {
          summary: "Zeile 1: 2 entfernt, 3 hinzugefügt",
          summaryKey: "serverFeature:proposal.hunkSummary",
          summaryParams: { line: 1, removed: 2, added: 3 },
        },
      ],
    };
    expect(localizeProposal(proposal, "en").hunks[0].summary).toBe(
      "Line 1: 2 removed, 3 added",
    );
    expect(proposal.hunks[0].summary).toBe(
      "Zeile 1: 2 entfernt, 3 hinzugefügt",
    );
    const error = {
      error: "Abgebrochen.",
      errorKey: "serverFeature:tools.aborted",
      errorParams: {},
    };
    const result = {
      turn: error,
      contextUsage: error,
      session: {
        turns: { original: error },
        messages: [{ content: "Abgebrochen." }],
      },
    };
    expect(localizeTeacherResult(result, "en")).toMatchObject({
      turn: { error: "Cancelled." },
      contextUsage: { error: "Cancelled." },
      session: result.session,
    });
    expect(result.session.turns.original.error).toBe("Abgebrochen.");
  });
  it("localizes runner progress, program descriptions and journal errors at the API boundary", async () => {
    const jobId = "8f98f801-ce4f-4af7-9218-de088b736283";
    const job = {
      id: jobId,
      state: "failed",
      error: "Herstellerdownload fehlgeschlagen (503).",
      errorKey: "runner:programs.downloadStatus",
      errorParams: { status: 503 },
      progress: "Fertig.",
      progressMessage: { key: "runner:programs.done", params: {} },
      log: "Fertig. Unveränderte Originalausgabe",
      stage: { current: 6, total: 6 },
    };
    const runner = http.createServer((req, res) => {
      res.setHeader("Content-Type", "application/json");
      res.setHeader("X-Runner-Protocol", "1");
      if (req.url.endsWith("/actions")) {
        res.statusCode = 503;
        res.end(
          JSON.stringify({
            error: job.error,
            code: "DOWNLOAD_FAILED",
            messageKey: job.errorKey,
            params: job.errorParams,
          }),
        );
      } else if (req.url === "/v1/programs") {
        res.end(
          JSON.stringify({
            programs: [
              {
                id: "python",
                description: "Python-Skripte",
                descriptionKey: "runner:catalog.python",
                descriptionParams: {},
                error: job.error,
                errorKey: job.errorKey,
                errorParams: job.errorParams,
              },
            ],
            activeJob: null,
            latestJob: job,
          }),
        );
      } else res.end(JSON.stringify(job));
    });
    await new Promise((resolve) => runner.listen(0, "127.0.0.1", resolve));
    const secret = path.join(temp, "runner-secret");
    await fs.writeFile(secret, "fixture-runner-secret".repeat(3));
    vi.stubEnv(
      "STERRACODE_RUNNER_URL",
      `http://127.0.0.1:${runner.address().port}`,
    );
    vi.stubEnv("STERRACODE_RUNNER_SECRET_FILE", secret);
    try {
      const status = await request("/api/programs", "en");
      expect(status.value.programs[0]).toMatchObject({
        description: "Python scripts",
        error: "Vendor download failed (503).",
      });
      expect(status.value.latestJob).toMatchObject({
        progress: "Done.",
        log: job.log,
        stage: job.stage,
      });
      const saved = await request(`/api/programs/jobs/${jobId}`, "es");
      expect(saved.value.error).toBe(
        "La descarga del proveedor ha fallado (503).",
      );
      expect(saved.value.log).toBe(job.log);
      const failed = await request("/api/programs/python/actions", "en", {
        body: { action: "install" },
      });
      expect(failed.response.status).toBe(503);
      expect(failed.value).toEqual({
        error: "Vendor download failed (503).",
        code: "DOWNLOAD_FAILED",
        messageKey: job.errorKey,
        params: job.errorParams,
      });
    } finally {
      vi.stubEnv("STERRACODE_RUNNER_URL", "");
      vi.stubEnv("STERRACODE_RUNNER_SECRET_FILE", "");
      runner.closeAllConnections();
      await new Promise((resolve) => runner.close(resolve));
    }
  });
  it("localizes derived profile mutation labels while preserving evidence and user goals", async () => {
    await storage.updateSettings({ crossChatProfileEnabled: true });
    const result = await request(
      "/api/profile/concepts/python.variables/self-assessments",
      "en",
      { body: { operationId: randomUUID(), outcome: "confident" } },
    );
    expect(result.response.status).toBe(200);
    expect(
      result.value.concepts.find((item) => item.id === "python.variables")
        .title,
    ).toBe("Variables");
    const events = result.value.events;
    const changed = await request("/api/profile", "es", {
      method: "PATCH",
      body: { goal: "Mein Originalziel" },
    });
    expect(changed.value.goal).toBe("Mein Originalziel");
    expect(changed.value.events).toEqual(events);
    const profile = await request("/api/profile", "en");
    expect(profile.value.tutorContext).toContain("SHARED LEARNING PROFILE");
    expect(profile.value.tutorContext).toContain("Mein Originalziel");
  });
  it("retains tracer end-marker provenance and distinguishes identical user exception strings", async () => {
    const session = await sessions.createSession({ language: "python" });
    const traces = await import("../server/services/traces.js");
    for (const [expression, marker] of [
      ["42", true],
      ['"<Fehlerdetails nicht ausgewertet>"', false],
    ]) {
      const previous = await workspace.readFile(session.id, session.activeFile);
      const saved = await workspace.writeFile(
        session.id,
        session.activeFile,
        `print("Originalausgabe")\nraise ValueError(${expression})\n`,
        previous.version,
      );
      let run = await traces.startTrace(session.id, {
        operationId: randomUUID(),
        entry: session.activeFile,
        expectedVersions: { [session.activeFile]: saved.version },
      });
      for (
        let count = 0;
        count < 100 && ["starting", "running"].includes(run.status);
        count++
      ) {
        await new Promise((resolve) => setTimeout(resolve, 25));
        run = await traces.getTrace(session.id, run.traceRunId);
      }
      expect(run.reason).toBe("program_error");
      expect(run.output).toContain("Originalausgabe");
      expect(run.programError.message).toBe(
        "<Fehlerdetails nicht ausgewertet>",
      );
      const response = await request(
        `/api/workspaces/${session.id}/traces/${run.traceRunId}`,
        "en",
      );
      expect(response.value.programError.message).toBe(
        run.programError.message,
      );
      if (marker) {
        expect(run.programError.messageKey).toBe("runner:trace.errorDetails");
        expect(response.value.programError.displayMessage).toBe(
          "<error details not evaluated>",
        );
      } else {
        expect(run.programError).not.toHaveProperty("messageKey");
        expect(response.value.programError).not.toHaveProperty(
          "displayMessage",
        );
      }
    }
  });
});
