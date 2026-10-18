import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { randomUUID } from "node:crypto";
import { runnerRequest } from "../server/services/runnerClient.js";
import * as processes from "../server/services/processes.js";
import * as local from "../server/services/localProcesses.js";
import { assertSessionWritable } from "../server/services/storage.js";

vi.mock("../server/services/localProcesses.js", async (original) => ({
  ...(await original()),
  startProcess: vi.fn(() => {
    throw new Error("Unexpected local fallback");
  }),
}));
vi.mock("../server/services/storage.js", async (original) => ({
  ...(await original()),
  assertSessionWritable: vi.fn(async () => {}),
  getSettings: vi.fn(async () => ({
    allowedLanguages: ["javascript", "python"],
    allowAITerminalCommands: true,
    executionTimeout: 0,
    compilationTimeout: 60000,
  })),
}));
let root, server, saved, handler, requests;
const envKeys = [
  "STERRACODE_MODE",
  "STERRACODE_RUNNER_URL",
  "STERRACODE_RUNNER_SECRET_FILE",
];
const secret = "test-runner-secret-".repeat(4);
function send(res, status, data) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "X-Runner-Protocol": "1",
  });
  res.end(JSON.stringify(data));
}
beforeEach(async () => {
  vi.mocked(local.startProcess).mockClear();
  vi.mocked(assertSessionWritable).mockClear();
  root = await fs.mkdtemp(path.join(os.tmpdir(), "sterra-runner-client-"));
  const file = path.join(root, "key");
  await fs.writeFile(file, secret);
  saved = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));
  requests = [];
  handler = async (req, res) => send(res, 200, { protocolVersion: 1 });
  server = http.createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    const record = {
      method: req.method,
      url: req.url,
      auth: req.headers.authorization,
      body: body ? JSON.parse(body) : null,
    };
    requests.push(record);
    await handler(req, res, record);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  process.env.STERRACODE_MODE = "docker";
  process.env.STERRACODE_RUNNER_URL = `http://127.0.0.1:${server.address().port}`;
  process.env.STERRACODE_RUNNER_SECRET_FILE = file;
});
afterEach(async () => {
  for (const key of envKeys)
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await fs.rm(root, { recursive: true, force: true });
});

describe("App-Runner-Anbindung", () => {
  it("liest Dienstauthentifizierung ausschließlich aus der Secret-Datei", async () => {
    expect(await runnerRequest("/v1/status")).toEqual({ protocolVersion: 1 });
    expect(requests[0].auth).toBe(`Bearer ${secret}`);
    expect(requests[0].body).toBeNull();
  });
  it("findet nach verlorener Startantwort denselben journalisierten Auftrag", async () => {
    let accepted;
    handler = async (req, res, record) => {
      if (record.method === "POST") {
        accepted = record.body;
        req.socket.destroy();
      } else
        send(res, 200, {
          processId: accepted.id,
          sessionId: accepted.sessionId,
          exited: false,
        });
    };
    const sessionId = randomUUID();
    const result = await processes.startProcess({
      sessionId,
      command: "echo idempotency",
    });
    expect(result.processId).toBe(accepted.id);
    expect(requests.filter((r) => r.method === "POST")).toHaveLength(1);
    expect(requests[1].url).toContain(accepted.id);
    expect(local.startProcess).not.toHaveBeenCalled();
    expect(assertSessionWritable).toHaveBeenCalledWith(sessionId);
  });
  it("verwendet bei verlorener Anfrage vor dem Journal für den Wiederholungsstart dieselbe ID", async () => {
    let starts = 0;
    handler = async (req, res, record) => {
      if (record.method === "POST") {
        starts++;
        if (starts === 1) req.socket.destroy();
        else send(res, 200, { processId: record.body.id, exited: false });
      } else
        send(res, 404, { error: "Prozess nicht gefunden.", code: "NOT_FOUND" });
    };
    const result = await processes.startProcess({
      sessionId: randomUUID(),
      command: "echo exactly-once",
    });
    const posts = requests.filter((r) => r.method === "POST");
    expect(posts).toHaveLength(2);
    expect(posts[0].body).toEqual(posts[1].body);
    expect(posts[0].body.id).toBe(result.processId);
    expect(local.startProcess).not.toHaveBeenCalled();
  });
  it("führt bei Runner-Ausfall keine lokalen Befehle aus", async () => {
    process.env.STERRACODE_RUNNER_URL = "http://127.0.0.1:1";
    await expect(
      processes.startProcess({
        sessionId: randomUUID(),
        command: "echo must-not-run",
      }),
    ).rejects.toMatchObject({ code: "RUNNER_UNAVAILABLE", status: 503 });
    expect(local.startProcess).not.toHaveBeenCalled();
  });
  it("weist inkompatible Runner-Antworten vor einer lokalen Ausführung zurück", async () => {
    handler = async (req, res) => {
      res.writeHead(200, {
        "X-Runner-Protocol": "2",
        "Content-Type": "application/json",
      });
      res.end("{}");
    };
    await expect(
      processes.startProcess({
        sessionId: randomUUID(),
        command: "echo protocol",
      }),
    ).rejects.toMatchObject({ code: "RUNNER_PROTOCOL_MISMATCH" });
    expect(local.startProcess).not.toHaveBeenCalled();
  });
  it("prüft ausstehendes Session-Löschen bevor eine Runner-Startanfrage gesendet wird", async () => {
    vi.mocked(assertSessionWritable).mockRejectedValueOnce(
      Object.assign(new Error("Session wird gelöscht."), {
        code: "SESSION_DELETING",
      }),
    );
    await expect(
      processes.startProcess({
        sessionId: randomUUID(),
        command: "echo deleted",
      }),
    ).rejects.toMatchObject({ code: "SESSION_DELETING" });
    expect(requests).toHaveLength(0);
  });
  it("sendet Session-Löschsperre und Stop an den Runner und wiederholt einen verlorenen Stop begrenzt", async () => {
    let deletes = 0;
    handler = async (req, res, record) => {
      if (record.method === "DELETE" && ++deletes === 1) req.socket.destroy();
      else send(res, 200, { stopped: true, exited: true });
    };
    const sessionId = randomUUID(),
      id = randomUUID();
    await processes.blockSession(sessionId);
    await processes.stopSessionProcesses(sessionId);
    await processes.stopProcess(id, sessionId);
    expect(requests[0].url).toBe(`/v1/sessions/${sessionId}/block`);
    expect(requests[1].url).toBe(`/v1/sessions/${sessionId}/stop`);
    expect(deletes).toBe(2);
    expect(
      requests
        .filter((r) => r.method === "DELETE")
        .every((r) => r.body.sessionId === sessionId),
    ).toBe(true);
  });
  it("trennt Runner-Installationsstand und App-Deaktivierung", async () => {
    handler = async (req, res) =>
      send(res, 200, [
        { language: "javascript", installed: true, available: true },
        { language: "java", installed: true, available: true },
        { language: "python", installed: false, available: false },
      ]);
    const result = await processes.getRuntimes();
    expect(result[0]).toMatchObject({
      installed: true,
      enabled: true,
      available: true,
    });
    expect(result[1]).toMatchObject({
      installed: true,
      enabled: false,
      available: false,
    });
    expect(result[2]).toMatchObject({
      installed: false,
      enabled: true,
      available: false,
    });
  });
});
