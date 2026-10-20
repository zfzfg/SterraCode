import { beforeEach, afterEach, it, expect, vi } from "vitest";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { ProgramManager } from "../runner/programs.js";
import { RunnerError, safeOpen } from "../runner/common.js";
import { PROGRAMS } from "../runner/catalog.js";
import { createRunner } from "../runner/index.js";

vi.mock("../runner/runtime.js", () => ({
  TOOL_PATH: "/usr/bin:/bin",
  probe: vi.fn(),
  runtimes: vi.fn(async () => []),
}));
let root, config, jobs, manager;
beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "sterra-i18n-runner-"));
  config = Object.fromEntries(
    ["stateDir", "cacheDir", "toolCacheDir", "tempDir", "workspaceDir"].map(
      (name) => [name, path.join(root, name)],
    ),
  );
  for (const directory of Object.values(config)) await fs.mkdir(directory);
  jobs = {
    state: "ready",
    active: () => [],
    snapshot: (job) => job,
    maintenance: false,
  };
  manager = new ProgramManager(config, jobs);
  manager.manifest = { desired: {}, installed: {} };
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});
it("keeps package failure metadata in the journal, initialization error and program status", async () => {
  const failure = new RunnerError(
    "Herstellerdownload fehlgeschlagen (503).",
    503,
    "DOWNLOAD_FAILED",
    {
      messageKey: "runner:programs.downloadStatus",
      params: { status: 503 },
    },
  );
  vi.spyOn(manager, "run").mockResolvedValue("");
  vi.spyOn(manager, "install").mockRejectedValue(failure);
  const program = PROGRAMS.find((item) => item.id === "python");
  const job = {
    id: randomUUID(),
    programId: program.id,
    action: "install",
    state: "queued",
    startedAt: 1,
  };
  manager.operations.set(job.id, job);
  await manager.process(job, program);
  const saved = JSON.parse(
    await fs.readFile(
      path.join(config.stateDir, "program-jobs", `${job.id}.json`),
      "utf8",
    ),
  );
  expect(saved).toMatchObject({
    state: "failed",
    error: failure.message,
    errorKey: failure.messageKey,
    errorParams: failure.params,
  });
  expect(jobs.initializationError).toEqual({
    code: failure.code,
    message: failure.message,
    messageKey: failure.messageKey,
    params: failure.params,
  });
  expect(
    (await manager.status()).programs.find((item) => item.id === program.id),
  ).toMatchObject({
    error: failure.message,
    errorKey: failure.messageKey,
    errorParams: failure.params,
  });
});
it("keeps command output original and supplies explicit clock and timeout message variants", async () => {
  const ordinary = await manager
    .run(process.execPath, [
      "-e",
      "console.error('original output'); process.exit(1)",
    ])
    .catch((error) => error);
  expect(ordinary).toMatchObject({
    code: "PACKAGE_COMMAND_FAILED",
    messageKey: "runner:programs.commandFailed",
    params: {
      command: process.execPath,
      details: expect.stringContaining("original output"),
    },
  });
  const clock = await manager
    .run(process.execPath, [
      "-e",
      "console.error('EXPKEYSIG original'); process.exit(1)",
    ])
    .catch((error) => error);
  expect(clock.messageKey).toBe("runner:programs.commandFailedClock");
  expect(clock.params.details).toContain("EXPKEYSIG original");
  const timeout = await manager
    .run(process.execPath, ["-e", "setTimeout(()=>{},5000)"], undefined, 80)
    .catch((error) => error);
  expect(timeout.messageKey).toBe("runner:programs.commandFailedTimeout");
});
it("describes path denial and runner initialization failures without altering machine codes", async () => {
  await expect(
    safeOpen(config.workspaceDir, "missing.py"),
  ).rejects.toMatchObject({
    code: "INVALID_PATH",
    status: 400,
    messageKey: "runner:path.denied",
    params: { reason: "ENOENT" },
  });
  config.secretFile = path.join(root, "secret");
  await fs.writeFile(config.secretFile, "x".repeat(64), { mode: 0o600 });
  const failure = new RunnerError(
    "Paketdatenbank benötigt Reparatur: ORIGINAL",
    503,
    "PACKAGE_REPAIR_REQUIRED",
    {
      messageKey: "runner:programs.databaseDetails",
      params: { details: "ORIGINAL" },
    },
  );
  const fakeJobs = {
    initialize: async () => {
      throw failure;
    },
    close: async () => {},
    state: "starting",
  };
  const runner = await createRunner(config, {
    jobs: fakeJobs,
    programs: { initialize: async () => {} },
  });
  vi.spyOn(console, "error").mockImplementation(() => {});
  await runner.initialize();
  expect(fakeJobs.initializationError).toEqual({
    code: failure.code,
    message: failure.message,
    messageKey: failure.messageKey,
    params: failure.params,
  });
});
