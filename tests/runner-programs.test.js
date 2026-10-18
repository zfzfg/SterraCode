import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import { randomUUID, createHash } from "node:crypto";
import { ProgramManager } from "../runner/programs.js";
import { PROGRAMS } from "../runner/catalog.js";
import { atomicJSON } from "../runner/common.js";
import { runtimes } from "../runner/runtime.js";
import { createRunner } from "../runner/index.js";

vi.mock("../runner/runtime.js", () => ({
  TOOL_PATH: "/usr/bin:/bin",
  probe: vi.fn(),
  runtimes: vi.fn(async () =>
    PROGRAMS.filter((p) => p.language).map((p) => ({
      language: p.id,
      installed: true,
      available: true,
      version: "test-locked-version",
    })),
  ),
}));
let root, config, jobs, manager, active, initialEnv;
function makeManager() {
  const value = new ProgramManager(config, jobs);
  vi.spyOn(value, "run").mockResolvedValue("");
  vi.spyOn(value, "installedPackages").mockResolvedValue(
    new Map([["bash", { name: "bash", version: "1", architecture: "amd64" }]]),
  );
  return value;
}
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "sterra-program-contract-"));
  config = Object.fromEntries(
    ["stateDir", "cacheDir", "toolCacheDir", "tempDir"].map((key) => [
      key,
      path.join(root, key),
    ]),
  );
  for (const dir of Object.values(config)) await fs.mkdir(dir);
  active = [];
  jobs = {
    state: "starting",
    maintenance: false,
    active: () => active,
    snapshot: (j) => ({
      processId: j.id,
      sessionId: j.sessionId,
      command: "blocked terminal",
    }),
    serial: async (fn) => fn(),
    stopAll: vi.fn(async () => {
      active = [];
    }),
  };
  initialEnv = process.env.STERRACODE_INITIAL_PROGRAMS;
  delete process.env.STERRACODE_INITIAL_PROGRAMS;
  manager = makeManager();
  await manager.initialize();
  vi.mocked(runtimes).mockResolvedValue(
    PROGRAMS.filter((p) => p.language).map((p) => ({
      language: p.id,
      installed: true,
      available: true,
      version: "test-locked-version",
    })),
  );
});
afterEach(async () => {
  if (initialEnv === undefined) delete process.env.STERRACODE_INITIAL_PROGRAMS;
  else process.env.STERRACODE_INITIAL_PROGRAMS = initialEnv;
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});
function record(extra = {}) {
  return {
    ...manager.identity(),
    packages: [
      { name: "python3", version: "3.11.2-locked", architecture: "amd64" },
    ],
    cache: [],
    version: "test-locked-version",
    ...extra,
  };
}
const python = PROGRAMS.find((p) => p.id === "python");
const job = () => ({
  id: randomUUID(),
  programId: "python",
  state: "installing",
  action: "install",
  startedAt: Date.now(),
});

describe("Paketmanifest und Wiederherstellung", () => {
  it("behält beim Reparieren einer unterbrochenen Deinstallation den Entfernungswunsch bei", async () => {
    manager.manifest.desired.python = false;
    manager.manifest.installed.python = record();
    vi.mocked(runtimes).mockResolvedValue([]);
    vi.spyOn(manager, "apt").mockResolvedValue("");
    const install = vi.spyOn(manager, "install");
    const operation = { ...job(), action: "repair", state: "queued" };
    await manager.process(operation, python);
    expect(operation.state).toBe("succeeded");
    expect(manager.manifest.desired.python).toBe(false);
    expect(manager.manifest.installed.python).toBeUndefined();
    expect(install).not.toHaveBeenCalled();
  });
  it("gibt nach einem Paketfehler Ausführungen durch Wartungsende nicht frei", async () => {
    vi.spyOn(manager, "install").mockRejectedValue(
      Object.assign(new Error("Download unterbrochen"), {
        code: "DOWNLOAD_FAILED",
      }),
    );
    await manager.process(job(), python);
    expect(jobs.state).toBe("error");
    expect(jobs.initializationError).toMatchObject({ code: "DOWNLOAD_FAILED" });
    const secret = "b".repeat(64),
      secretFile = path.join(root, "runner-key");
    await fs.writeFile(secretFile, secret, { mode: 0o600 });
    const instance = await createRunner(
      { ...config, secretFile },
      { jobs, programs: manager },
    );
    await new Promise((resolve) =>
      instance.server.listen(0, "127.0.0.1", resolve),
    );
    try {
      const response = await fetch(
        `http://127.0.0.1:${instance.server.address().port}/v1/maintenance`,
        { method: "DELETE", headers: { Authorization: `Bearer ${secret}` } },
      );
      expect((await response.json()).status).toBe("error");
      expect(jobs.state).not.toBe("ready");
    } finally {
      instance.server.closeAllConnections();
      await new Promise((resolve) => instance.server.close(resolve));
    }
  });
  it("beendet einen echten HTTP-Download nach EOF und verwendet den geprüften Cache erneut", async () => {
    const bytes = Buffer.from("real-download-regression-ü🌍");
    let calls = 0;
    const server = http.createServer((req, res) => {
      calls++;
      res.writeHead(200, { "Content-Length": bytes.length });
      res.end(bytes);
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    let timer;
    try {
      const url = `http://127.0.0.1:${server.address().port}/artifact`,
        checksum = createHash("sha256").update(bytes).digest("hex");
      const file = await Promise.race([
        manager.download(url, checksum, "artifact.tar.gz", job()),
        new Promise((resolve, reject) => {
          timer = setTimeout(
            () => reject(new Error("Download blieb nach EOF hängen.")),
            2000,
          );
        }),
      ]);
      expect(await fs.readFile(file)).toEqual(bytes);
      expect(
        await manager.download(url, checksum, "artifact.tar.gz", job()),
      ).toBe(file);
      expect(calls).toBe(1);
      expect(
        (await fs.readdir(path.join(config.cacheDir, "downloads"))).filter(
          (name) => name.endsWith(".part"),
        ),
      ).toEqual([]);
    } finally {
      clearTimeout(timer);
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
  it("verwirft einen echten HTTP-Download mit falscher Prüfsumme samt temporären Dateien", async () => {
    const server = http.createServer((req, res) => {
      res.writeHead(200);
      res.end("corrupted archive");
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const url = `http://127.0.0.1:${server.address().port}/artifact`;
      await expect(
        manager.download(url, "0".repeat(64), "bad.tar.gz", job()),
      ).rejects.toMatchObject({ code: "CHECKSUM_MISMATCH" });
      expect(await fs.readdir(path.join(config.cacheDir, "downloads"))).toEqual(
        [],
      );
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
  it("lädt fehlenden Cache mit den gespeicherten exakten Paketversionen erneut", async () => {
    const locked = record({
      cache: [{ file: "python.deb", sha256: "a".repeat(64) }],
    });
    const installApt = vi.spyOn(manager, "installApt").mockResolvedValue();
    await manager.install(python, locked, job());
    expect(installApt).toHaveBeenCalledOnce();
    expect(installApt.mock.calls[0][1].packages[0].version).toBe(
      "3.11.2-locked",
    );
  });
  it("weist beschädigten Cache vor jeder Paketänderung ab", async () => {
    await fs.writeFile(
      path.join(config.cacheDir, "apt", "python.deb"),
      "tampered",
    );
    const apt = vi.spyOn(manager, "apt").mockResolvedValue();
    const installApt = vi.spyOn(manager, "installApt").mockResolvedValue();
    await expect(
      manager.install(
        python,
        record({ cache: [{ file: "python.deb", sha256: "0".repeat(64) }] }),
        job(),
      ),
    ).rejects.toMatchObject({ code: "CACHE_CORRUPTED" });
    expect(apt).not.toHaveBeenCalled();
    expect(installApt).not.toHaveBeenCalled();
  });
  it("stellt verifizierte Cachepakete ohne Download wieder her", async () => {
    const content = Buffer.from("verified-deb-fixture");
    const file = path.join(config.cacheDir, "apt", "python.deb");
    await fs.writeFile(file, content);
    const apt = vi.spyOn(manager, "apt").mockResolvedValue();
    const installApt = vi.spyOn(manager, "installApt").mockResolvedValue();
    await manager.install(
      python,
      record({
        cache: [
          {
            file: "python.deb",
            sha256: createHash("sha256").update(content).digest("hex"),
          },
        ],
      }),
      job(),
    );
    expect(apt.mock.calls[0][0]).toContain("--no-download");
    expect(apt.mock.calls[0][0]).toContain(file);
    expect(installApt).not.toHaveBeenCalled();
  });
  it("schließt eine unterbrochene Entfernung ab und installiert sie nicht erneut", async () => {
    manager.manifest.desired.python = false;
    manager.manifest.installed.python = record();
    await manager.save();
    const old = { ...job(), state: "removing", action: "remove", startedAt: 1 };
    await manager.persist(old);
    const recovered = makeManager();
    const install = vi.spyOn(recovered, "install").mockResolvedValue(record());
    const remove = vi
      .spyOn(recovered, "remove")
      .mockImplementation(async (program) => {
        delete recovered.manifest.installed[program.id];
        await recovered.save();
      });
    await recovered.initialize();
    expect(remove).toHaveBeenCalledOnce();
    expect(install).not.toHaveBeenCalled();
    expect(recovered.manifest.desired.python).toBe(false);
    expect(jobs.state).toBe("ready");
  });
  it("sperrt Ausführungen nach unterbrochener unvollständiger Installation", async () => {
    await manager.persist({ ...job(), state: "installing", startedAt: 1 });
    const recovered = makeManager();
    await expect(recovered.initialize()).rejects.toMatchObject({
      code: "PACKAGE_REPAIR_REQUIRED",
    });
    expect(jobs.state).not.toBe("ready");
    expect(recovered.operations.values().next().value.state).toBe(
      "interrupted",
    );
  });
  it("verlangt eine explizite Migration bei Suite-/Architekturwechsel", async () => {
    for (const change of [
      { suite: "trixie" },
      { architecture: "arm64" },
      { schema: 999 },
    ]) {
      await atomicJSON(manager.manifestPath, {
        ...manager.manifest,
        ...change,
      });
      const incompatible = makeManager();
      await expect(incompatible.initialize()).rejects.toMatchObject({
        code: "MANIFEST_MIGRATION_REQUIRED",
      });
      await expect(
        incompatible.action("python", { action: "install" }),
      ).rejects.toMatchObject({ code: "MANIFEST_MIGRATION_REQUIRED" });
      expect(incompatible.run).not.toHaveBeenCalled();
    }
  });
  it("übernimmt initiale Programme genau einmal und respektiert spätere Entfernung", async () => {
    await fs.rm(manager.manifestPath);
    process.env.STERRACODE_INITIAL_PROGRAMS = "python,python";
    const first = makeManager();
    const install = vi.spyOn(first, "install").mockResolvedValue(record());
    await first.initialize();
    expect(install).toHaveBeenCalledOnce();
    expect(first.manifest.desired.python).toBe(true);
    expect(first.manifest.initialPending).toEqual([]);
    first.manifest.desired.python = false;
    delete first.manifest.installed.python;
    await first.save();
    process.env.STERRACODE_INITIAL_PROGRAMS = "python,java";
    const next = makeManager();
    const nextInstall = vi.spyOn(next, "install").mockResolvedValue(record());
    await next.initialize();
    expect(nextInstall).not.toHaveBeenCalled();
    expect(next.manifest.desired.python).toBe(false);
    expect(next.manifest.desired.java).toBeUndefined();
  });
  it("sperrt neue Starts vor dem Warten und erlaubt Abbruch einer wartenden Paketaktion", async () => {
    active = [{ id: randomUUID(), sessionId: randomUUID() }];
    const install = vi.spyOn(manager, "install").mockResolvedValue(record());
    const result = await manager.action("python", { action: "install" });
    expect(jobs.maintenance).toBe(true);
    expect(result.job.state).toBe("queued");
    expect(result.job.blockingJobs).toHaveLength(1);
    await manager.cancel(result.job.id);
    expect(jobs.maintenance).toBe(false);
    expect(jobs.state).toBe("ready");
    active = [];
    await vi.waitFor(() =>
      expect(manager.operations.get(result.job.id).endedAt).toBeTruthy(),
    );
    expect(install).not.toHaveBeenCalled();
  });
  it("stoppt blockierende Prozesse erst nach ausdrücklicher Aktion und führt denselben Paketjob fort", async () => {
    active = [{ id: randomUUID(), sessionId: randomUUID() }];
    vi.spyOn(manager, "install").mockResolvedValue(record());
    const first = await manager.action("python", { action: "install" });
    expect(jobs.stopAll).not.toHaveBeenCalled();
    const resumed = await manager.action("python", {
      action: "install",
      stopRunning: true,
    });
    expect(resumed.job.id).toBe(first.job.id);
    expect(jobs.stopAll).toHaveBeenCalledOnce();
    await vi.waitFor(() =>
      expect(manager.getJob(first.job.id).state).toBe("succeeded"),
    );
    expect(manager.manifest.desired.python).toBe(true);
    expect((await manager.status()).activeJob).toBeNull();
  });
  it("schützt Grundkomponenten und gemeinsam benötigte Pakete bei Entfernung", async () => {
    await expect(
      manager.action("javascript", { action: "remove" }),
    ).rejects.toMatchObject({ code: "BASE_PROGRAM" });
    manager.manifest.desired.python = true;
    manager.manifest.installed.python = record({
      packages: [{ name: "bash" }, { name: "shared" }, { name: "python3" }],
    });
    manager.manifest.desired.java = true;
    manager.manifest.installed.java = record({
      packages: [{ name: "shared" }],
    });
    vi.mocked(runtimes).mockResolvedValue([]);
    const apt = vi.spyOn(manager, "apt").mockResolvedValue();
    await manager.remove(python, { clearCache: false });
    expect(apt.mock.calls[0][0]).toEqual(["remove", "python3"]);
    expect(manager.manifest.desired.python).toBe(false);
    expect(manager.manifest.installed.java).toBeDefined();
  });
  it("bereinigt keine aktiven Caches und bewahrt gewünschte Offlinepakete", async () => {
    await fs.writeFile(path.join(config.cacheDir, "apt", "keep.deb"), "keep");
    await fs.writeFile(path.join(config.cacheDir, "apt", "old.deb"), "old");
    manager.manifest.desired.python = true;
    manager.manifest.installed.python = record({
      cache: [{ file: "keep.deb" }],
    });
    active = [{ id: randomUUID() }];
    await expect(manager.cleanCache()).rejects.toMatchObject({
      code: "CACHE_BUSY",
    });
    active = [];
    await manager.cleanCache();
    expect(
      await fs.readFile(path.join(config.cacheDir, "apt", "keep.deb"), "utf8"),
    ).toBe("keep");
    await expect(
      fs.stat(path.join(config.cacheDir, "apt", "old.deb")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
  it("entfernt nach erfolgreicher Deinstallation auf Wunsch auch unbenutzte Downloadpakete", async () => {
    manager.manifest.desired.python = true;
    manager.manifest.installed.python = record();
    await fs.writeFile(
      path.join(config.cacheDir, "apt", "old-python.deb"),
      "old-package",
    );
    vi.mocked(runtimes).mockResolvedValue([]);
    vi.spyOn(manager, "apt").mockResolvedValue();
    const operation = {
      ...job(),
      action: "remove",
      state: "queued",
      clearCache: true,
    };
    manager.activeJob = operation;
    await manager.process(operation, python);
    expect(operation.state).toBe("succeeded");
    expect(manager.manifest.desired.python).toBe(false);
    await expect(
      fs.stat(path.join(config.cacheDir, "apt", "old-python.deb")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
