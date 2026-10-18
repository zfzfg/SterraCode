import { beforeEach, afterEach, describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { JobManager, MAX_OUTPUT, validatePayload } from "../runner/jobs.js";
import { safeRead, sources, atomicJSON } from "../runner/common.js";
import { childEnvironment, runtimes } from "../runner/runtime.js";
import { createRunner } from "../runner/index.js";

// Gate execution at the scheduler boundary. Actual UID, Bash, compilers and
// descendant cleanup are exercised by test:docker on the Linux runner.
class Scheduler extends JobManager {
  starts = 0;
  execute(job) {
    this.starts++;
    return new Promise((resolve) => {
      job.finish = async () => {
        job.state = job.stopping ? "cancelled" : "succeeded";
        job.exitCode = 0;
        job.endedAt = Date.now();
        await this.persist(job);
        resolve(this.snapshot(job));
      };
    });
  }
  async stop(id, session) {
    const job = this.owned(id, session);
    job.stopping = true;
    await job.finish?.();
    return this.snapshot(job);
  }
}
let root, config, manager;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "sterra-runner-contract-"));
  config = Object.fromEntries(
    ["workspaceDir", "stateDir", "cacheDir", "toolCacheDir", "tempDir"].map(
      (key) => [key, path.join(root, key)],
    ),
  );
  for (const dir of Object.values(config)) await fs.mkdir(dir);
  config.secretFile = path.join(root, "secret");
  await fs.writeFile(config.secretFile, "a".repeat(64), { mode: 0o600 });
  manager = new Scheduler(config);
  await manager.initialize();
  manager.state = "ready";
});
afterEach(async () => {
  await manager.close();
  await fs.rm(root, { recursive: true, force: true });
});
async function payload(extra = {}) {
  const sessionId = randomUUID();
  await fs.mkdir(path.join(config.workspaceDir, sessionId));
  return { sessionId, command: "echo runner", ...extra };
}

describe("dauerhafter Runner-Vertrag", () => {
  it("startet parallele Wiederholungen genau einmal und erkennt geänderte Nutzdaten", async () => {
    const value = await payload(),
      id = randomUUID();
    const results = await Promise.all(
      Array.from({ length: 12 }, () => manager.start(id, value)),
    );
    expect(new Set(results.map((result) => result.processId)).size).toBe(1);
    expect(manager.starts).toBe(1);
    await expect(
      manager.start(id, { ...value, command: "echo changed" }),
    ).rejects.toMatchObject({ status: 409, code: "IDEMPOTENCY_CONFLICT" });
    await manager.jobs.get(id).finish();
    manager.jobs.get(id).endedAt = Date.now() - 301000;
    await manager.expire();
    expect((await manager.start(id, value)).outputExpired).toBe(true);
    expect(manager.starts).toBe(1);
    const recovered = new Scheduler(config);
    await recovered.initialize();
    recovered.state = "ready";
    expect((await recovered.start(id, value)).state).toBe("succeeded");
    expect(recovered.starts).toBe(0);
    await recovered.close();
  });
  it("führt einen vor dem Start journalisierten Auftrag nach Neustart nicht aus", async () => {
    const value = await payload(),
      id = randomUUID();
    await manager.start(id, value);
    const recovered = new Scheduler(config);
    await recovered.initialize();
    recovered.state = "ready";
    expect((await recovered.start(id, value)).state).toBe("interrupted");
    expect(recovered.starts).toBe(0);
    await recovered.close();
  });
  it("reserviert vier Plätze atomar und erlaubt höchstens einen Auftrag je Session", async () => {
    const values = await Promise.all(
      Array.from({ length: 6 }, () => payload()),
    );
    const results = await Promise.allSettled(
      values.map((value) => manager.start(randomUUID(), value)),
    );
    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(4);
    expect(
      results
        .filter((result) => result.status === "rejected")
        .every((result) => result.reason.code === "RUNNER_BUSY"),
    ).toBe(true);
    await expect(manager.start(randomUUID(), values[0])).rejects.toMatchObject({
      code: "SESSION_BUSY",
    });
  });
  it("begrenzt gleichzeitig reservierte Kompilierungen auf zwei", async () => {
    for (const language of ["cpp", "java"]) {
      const value = await payload({ file: "main.cpp", language });
      const id = randomUUID();
      manager.jobs.set(id, {
        id,
        payload: value,
        state: "running",
        finish: async () => {},
        done: Promise.resolve(),
      });
    }
    await expect(
      manager.start(
        randomUUID(),
        await payload({ file: "main.rs", language: "rust" }),
      ),
    ).rejects.toMatchObject({ status: 429, code: "RUNNER_BUSY" });
    manager.jobs.clear();
  });
  it("startet bei fehlgeschlagener dauerhafter Journalisierung keinen Auftrag", async () => {
    const file = path.join(root, "not-a-directory");
    await fs.writeFile(file, "x");
    config.stateDir = file;
    await expect(
      manager.start(randomUUID(), await payload()),
    ).rejects.toThrow();
    expect(manager.starts).toBe(0);
    expect(manager.active()).toHaveLength(0);
  });
  it("sperrt Session-Löschung dauerhaft vor neuen Starts und bestätigt das Stoppen", async () => {
    const value = await payload();
    await manager.start(randomUUID(), value);
    expect(await manager.block(value.sessionId)).toMatchObject({
      blocked: true,
    });
    expect(manager.active()).toHaveLength(0);
    await expect(manager.start(randomUUID(), value)).rejects.toMatchObject({
      code: "SESSION_BLOCKED",
    });
    const recovered = new Scheduler(config);
    await recovered.initialize();
    recovered.state = "ready";
    await expect(recovered.start(randomUUID(), value)).rejects.toMatchObject({
      code: "SESSION_BLOCKED",
    });
    await recovered.close();
  });
  it("hält vollständiges UTF-8, monotone Byteoffsets und die Ausgabegrenze ein", () => {
    const job = {
      id: randomUUID(),
      payload: { sessionId: randomUUID() },
      output: "",
      bytes: 0,
      decoder: new StringDecoder("utf8"),
      state: "running",
    };
    const data = Buffer.from("Grüße 🌍");
    for (const byte of data) manager.append(job, Buffer.from([byte]));
    expect(manager.snapshot(job).output).toBe("Grüße 🌍");
    expect(manager.snapshot(job).nextOffset).toBe(data.length);
    expect(manager.snapshot(job, 3).output).not.toContain("�");
    manager.append(job, Buffer.alloc(MAX_OUTPUT, 65));
    manager.append(job, Buffer.alloc(MAX_OUTPUT, 66));
    expect(Buffer.byteLength(job.output)).toBeLessThanOrEqual(MAX_OUTPUT);
    expect(job.truncated).toBe(true);
  });
  it("dekodiert ineinander verschachtelte stdout-/stderr-Bytes getrennt", () => {
    const job = {
      id: randomUUID(),
      payload: { sessionId: randomUUID() },
      output: "",
      bytes: 0,
      decoder: new StringDecoder("utf8"),
      state: "running",
    };
    const stdout = Buffer.from("🌍"),
      stderr = Buffer.from("ü");
    manager.append(job, stdout.subarray(0, 1));
    manager.append(job, stderr, true);
    manager.append(job, stdout.subarray(1));
    expect(job.output).toBe("ü🌍");
    expect(job.bytes).toBe(6);
  });
  it("prüft relative Pfade und Zeitlimits an der Runner-Grenze", async () => {
    const value = await payload();
    for (const file of [
      "/etc/passwd",
      "../secret",
      "a/../secret",
      "C:\\secret",
      "a\0b",
      "a//b",
    ])
      expect(() =>
        validatePayload({ ...value, file, language: "python" }),
      ).toThrow();
    for (const executionTimeout of [-1, 600001, "1000"])
      expect(() => validatePayload({ ...value, executionTimeout })).toThrow();
    expect(
      validatePayload({ ...value, executionTimeout: 0 }).executionTimeout,
    ).toBe(0);
  });
  it("liest keine übergroßen Quellen und begrenzt Quellbaumtiefe", async () => {
    const value = await payload(),
      workspace = path.join(config.workspaceDir, value.sessionId);
    await fs.writeFile(
      path.join(workspace, "large.py"),
      Buffer.alloc(2 * 1024 * 1024 + 1),
    );
    await expect(safeRead(workspace, "large.py")).rejects.toMatchObject({
      code: "FILE_TOO_LARGE",
    });
    await fs.writeFile(path.join(workspace, "bad.py"), Buffer.from([255]));
    await expect(safeRead(workspace, "bad.py")).rejects.toThrow("UTF-8");
    await fs.mkdir(path.join(workspace, ...Array(22).fill("deep")), {
      recursive: true,
    });
    await expect(sources(workspace, ".py")).rejects.toThrow("zu tief");
  });
  it("meldet python3/lua5.4 und prüft Java mit Compiler und Laufzeit", async () => {
    const found = await runtimes(async (command) => ({
      available: ["python3", "lua5.4", "javac"].includes(command),
      output: "1.0",
    }));
    expect(found.find((r) => r.language === "python").command).toBe("python3");
    expect(found.find((r) => r.language === "lua").command).toBe("lua5.4");
    expect(found.find((r) => r.language === "java").installed).toBe(false);
  });
  it("vererbt weder Steuerumgebung noch Geheimnisse an ausgeführten Code", () => {
    process.env.STERRA_TEST_SECRET = "secret";
    const env = childEnvironment(config, "/workspaces/example");
    delete process.env.STERRA_TEST_SECRET;
    expect(env.STERRA_TEST_SECRET).toBeUndefined();
    expect(env.DEBIAN_FRONTEND).toBeUndefined();
    expect(env.BASH_ENV).toBe("");
    expect(env.PATH).not.toContain(process.cwd());
    expect(env.GIT_CONFIG_VALUE_0).toBe("/workspaces/example");
    expect(env.XDG_RUNTIME_DIR).toBe(`${config.toolCacheDir}/runtime`);
  });
  it("authentifiziert auch lokale Health-Aufrufe und prüft die Protokollversion", async () => {
    const instance = await createRunner(config, {
      jobs: manager,
      programs: {},
    });
    await new Promise((resolve) =>
      instance.server.listen(0, "127.0.0.1", resolve),
    );
    const base = `http://127.0.0.1:${instance.server.address().port}`;
    try {
      expect((await fetch(`${base}/v1/health`)).status).toBe(401);
      const headers = { Authorization: `Bearer ${"a".repeat(64)}` };
      expect(
        await (await fetch(`${base}/v1/health`, { headers })).json(),
      ).toEqual({ ok: true });
      const mismatch = await fetch(`${base}/v1/status`, {
        headers: { ...headers, "X-Runner-Protocol": "2" },
      });
      expect(mismatch.status).toBe(409);
      expect((await mismatch.json()).code).toBe("PROTOCOL_MISMATCH");
    } finally {
      await new Promise((resolve) => instance.server.close(resolve));
    }
  });
});
