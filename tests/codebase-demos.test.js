import { beforeAll, afterAll, beforeEach, it, expect, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const mocked = vi.hoisted(() => ({
  enabled: false,
  requests: vi.fn(),
  start: vi.fn(),
  runtimes: vi.fn(),
}));
vi.mock("../server/services/runnerClient.js", () => ({
  runnerEnabled: () => mocked.enabled,
  runnerRequest: (...args) => mocked.requests(...args),
}));
vi.mock("../server/services/processes.js", () => ({
  getRuntimes: () => mocked.runtimes(),
  readProcess: vi.fn(),
  startIsolatedDemoProcess: (...args) => mocked.start(...args),
}));
let root, storage, sessions, ws, demos;
beforeAll(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), "sterra-codebase-demos-"));
  vi.stubEnv("STERRACODE_DATA_DIR", root);
  vi.stubEnv("STERRACODE_WORKSPACE_DIR", path.join(root, "workspaces"));
  storage = await import("../server/services/storage.js");
  sessions = await import("../server/services/sessions.js");
  ws = await import("../server/services/workspace.js");
  demos = await import("../server/services/codebaseDemos.js");
  await storage.ensureDataDirs();
});
afterAll(async () => {
  vi.unstubAllEnvs();
  await fs.rm(root, { recursive: true, force: true });
});
beforeEach(async () => {
  mocked.enabled = false;
  mocked.requests.mockReset();
  mocked.start.mockReset();
  mocked.runtimes.mockResolvedValue([{ language: "rust", available: true }]);
  await storage.updateSettings({
    reviewAIChanges: false,
    allowAITerminalCommands: true,
    allowedLanguages: storage.LANGUAGES,
  });
});
async function fixture() {
  const parent = await sessions.createSession(
    { title: "Original", language: null },
    { mode: "codebase" },
  );
  const original = await ws.writeFile(parent.id, "main.rs", "original", null);
  const input = {
    operationId: randomUUID(),
    language: "rust",
    title: "Small demo",
    description: "Independent example",
    path: "main.rs",
    code: 'fn main() { println!("demo"); }',
  };
  const demo = await demos.createCodebaseDemo(parent.id, input);
  return { parent, input, demo, original };
}
function runner({ lostResponse = false } = {}) {
  mocked.enabled = true;
  const jobs = new Map();
  mocked.requests.mockImplementation(async (endpoint, options) => {
    if (endpoint === "/v1/demo-capabilities")
      return {
        executionAllowed: true,
        allowedLanguages: ["rust"],
        isolation: {
          verified: true,
          networkRestricted: true,
          sourcesRestricted: true,
        },
      };
    if (endpoint === "/v1/programs")
      return {
        catalogVersion: "test-catalog",
        programs: [
          { id: "rust", name: "Rust", installed: false, sizeMB: 1000 },
        ],
      };
    if (endpoint.startsWith("/v1/program-jobs/")) {
      const job = jobs.get(endpoint.split("/").at(-1));
      if (!job) throw { status: 404 };
      return job;
    }
    if (endpoint === "/v1/programs/rust/actions") {
      expect(options.body.stopRunning).toBe(false);
      const job = {
        id: options.body.operationId,
        programId: "rust",
        state: "queued",
      };
      jobs.set(job.id, job);
      if (lostResponse) throw { status: 503, code: "RUNNER_UNAVAILABLE" };
      return { job };
    }
    throw new Error("Unexpected test endpoint");
  });
}
it("creates an independent session once without overwriting original source", async () => {
  const { parent, input, demo, original } = await fixture();
  expect(demo.status).toBe("applied");
  expect(demo.sessionId).not.toBe(parent.id);
  expect((await sessions.loadSession(demo.sessionId)).mode).toBe("demo");
  expect((await ws.readFile(parent.id, "main.rs")).version).toBe(
    original.version,
  );
  expect((await demos.createCodebaseDemo(parent.id, input)).demoId).toBe(
    demo.demoId,
  );
  await expect(
    demos.createCodebaseDemo(parent.id, { ...input, code: "different" }),
  ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  expect(await demos.listCodebaseDemos(parent.id)).toHaveLength(1);
});
it("keeps reviewed code proposed and never installs or executes implicitly", async () => {
  await storage.updateSettings({ reviewAIChanges: true });
  const { parent, input, demo } = await fixture();
  expect(demo.status).toBe("proposed");
  expect(demo.proposalId).toBeTruthy();
  await expect(ws.readFile(demo.sessionId, input.path)).rejects.toMatchObject({
    status: 404,
  });
  expect((await demos.createCodebaseDemo(parent.id, input)).proposalId).toBe(
    demo.proposalId,
  );
  expect(mocked.requests).not.toHaveBeenCalled();
  expect(mocked.start).not.toHaveBeenCalled();
});
it("does not install on a local host or on arbitrary chat-like answers", async () => {
  const { parent, demo } = await fixture();
  await expect(
    demos.requestRuntimeInstallation(parent.id, demo.demoId, {
      programId: "rust",
      operationId: randomUUID(),
    }),
  ).rejects.toMatchObject({ code: "LOCAL_MODE" });
  await expect(
    demos.decideCodebaseAction(parent.id, randomUUID(), "yes"),
  ).rejects.toMatchObject({ code: "DEMO_INVALID_REQUEST" });
  expect(mocked.requests).not.toHaveBeenCalled();
});
it("recovers a lost installation response through its durable request/job identity", async () => {
  const { parent, demo } = await fixture();
  runner({ lostResponse: true });
  const request = {
    programId: "rust",
    reason: "Needed for this example",
    operationId: randomUUID(),
  };
  const action = await demos.requestRuntimeInstallation(
    parent.id,
    demo.demoId,
    request,
  );
  expect(
    (await demos.requestRuntimeInstallation(parent.id, demo.demoId, request))
      .requestId,
  ).toBe(action.requestId);
  await expect(
    demos.decideCodebaseAction(parent.id, action.requestId, "install"),
  ).rejects.toMatchObject({ code: "RUNNER_UNAVAILABLE" });
  const result = await demos.decideCodebaseAction(
    parent.id,
    action.requestId,
    "install",
  );
  expect(result.programJobId).toBe(action.requestId);
  expect(result.status).toBe("submitted");
  expect(
    mocked.requests.mock.calls.filter(([endpoint]) =>
      endpoint.endsWith("/rust/actions"),
    ),
  ).toHaveLength(1);
  await expect(
    demos.decideCodebaseAction(parent.id, action.requestId, "cancel"),
  ).rejects.toMatchObject({ code: "ACTION_ALREADY_DECIDED" });
  expect(mocked.start).not.toHaveBeenCalled();
});
it("rejects source changes after authorization and disabled runtime settings", async () => {
  const { parent, demo } = await fixture();
  runner();
  const action = await demos.requestRuntimeInstallation(
    parent.id,
    demo.demoId,
    { programId: "rust", operationId: randomUUID() },
  );
  await ws.writeFile(demo.sessionId, demo.path, "changed", demo.fileVersion);
  await expect(
    demos.decideCodebaseAction(parent.id, action.requestId, "install"),
  ).rejects.toMatchObject({ code: "DEMO_SOURCE_CHANGED" });
  await storage.updateSettings({ allowedLanguages: ["python"] });
  await expect(
    demos.decideCodebaseAction(parent.id, action.requestId, "install"),
  ).rejects.toMatchObject({ code: "TERMINAL_DISABLED" });
  expect(
    mocked.requests.mock.calls.filter(([endpoint]) =>
      endpoint.endsWith("/rust/actions"),
    ),
  ).toHaveLength(0);
});
it("separates creating a run card from executing its exact version once", async () => {
  const { parent, demo } = await fixture();
  runner();
  const request = { fileVersion: demo.fileVersion, operationId: randomUUID() };
  const action = await demos.requestDemoExecution(
    parent.id,
    demo.demoId,
    request,
  );
  expect(mocked.start).not.toHaveBeenCalled();
  mocked.start.mockResolvedValue({
    processId: action.requestId,
    exited: true,
    state: "succeeded",
    output: "demo",
  });
  expect(
    (await demos.requestDemoExecution(parent.id, demo.demoId, request))
      .requestId,
  ).toBe(action.requestId);
  await expect(
    demos.decideCodebaseAction(parent.id, action.requestId, "install"),
  ).rejects.toMatchObject({ code: "DEMO_INVALID_REQUEST" });
  const results = await Promise.all(
    [1, 2, 3].map(() =>
      demos.decideCodebaseAction(parent.id, action.requestId, "run"),
    ),
  );
  expect(results.every((v) => v.processId === action.requestId)).toBe(true);
  expect(mocked.start).toHaveBeenCalledTimes(1);
  expect(mocked.start.mock.calls[0][0]).toMatchObject({
    sessionId: demo.sessionId,
    idempotencyId: action.requestId,
    isolatedDemo: { fileVersion: demo.fileVersion },
  });
});
it("fails closed when actual runner isolation has not passed its probe", async () => {
  const { parent, demo } = await fixture();
  runner();
  const original = mocked.requests.getMockImplementation();
  mocked.requests.mockImplementation((endpoint, options) =>
    endpoint === "/v1/demo-capabilities"
      ? { executionAllowed: false, isolation: { verified: false } }
      : original(endpoint, options),
  );
  const action = await demos.requestDemoExecution(parent.id, demo.demoId, {
    fileVersion: demo.fileVersion,
    operationId: randomUUID(),
  });
  await expect(
    demos.decideCodebaseAction(parent.id, action.requestId, "run"),
  ).rejects.toMatchObject({ code: "DEMO_ISOLATION_REQUIRED" });
  expect(mocked.start).not.toHaveBeenCalled();
});

it("finishes an authorized runner submission before parent deletion can acquire its lifecycle", async () => {
  const { parent, demo } = await fixture();
  runner();
  const action = await demos.requestRuntimeInstallation(
    parent.id,
    demo.demoId,
    { programId: "rust", operationId: randomUUID() },
  );
  const original = mocked.requests.getMockImplementation();
  let entered, release;
  const submitting = new Promise((resolve) => {
    entered = resolve;
  });
  const released = new Promise((resolve) => {
    release = resolve;
  });
  mocked.requests.mockImplementation(async (endpoint, options) => {
    if (endpoint === "/v1/programs/rust/actions") {
      entered();
      await released;
    }
    return original(endpoint, options);
  });
  const decision = demos.decideCodebaseAction(
    parent.id,
    action.requestId,
    "install",
  );
  await submitting;
  let deletionEntered = false;
  const deletion = storage.serial(`lifecycle:${parent.id}`, async () => {
    deletionEntered = true;
    await storage.writeJSON(path.join(root, "deletions", `${parent.id}.json`), {
      sessionId: parent.id,
      status: "pending",
    });
  });
  try {
    await new Promise((resolve) => setImmediate(resolve));
    expect(deletionEntered).toBe(false);
  } finally {
    release();
    await decision;
    await deletion;
  }
  await expect(
    demos.decideCodebaseAction(parent.id, action.requestId, "install"),
  ).rejects.toMatchObject({ code: "SESSION_DELETING" });
  expect(
    mocked.requests.mock.calls.filter(
      ([endpoint]) => endpoint === "/v1/programs/rust/actions",
    ),
  ).toHaveLength(1);
});

it("rechecks the parent after waiting for lifecycle so a queued create cannot leave an orphan", async () => {
  const { parent, input } = await fixture();
  const before = (await sessions.listSessions()).length;
  let enter, release;
  const entered = new Promise((resolve) => {
    enter = resolve;
  });
  const blocker = storage.serial(`lifecycle:${parent.id}`, async () => {
    enter();
    await new Promise((resolve) => {
      release = resolve;
    });
  });
  await entered;
  const outcome = demos
    .createCodebaseDemo(parent.id, { ...input, operationId: randomUUID() })
    .catch((error) => error);
  await storage.writeJSON(path.join(root, "deletions", `${parent.id}.json`), {
    sessionId: parent.id,
    status: "pending",
  });
  release();
  await blocker;
  expect(await outcome).toMatchObject({ code: "SESSION_DELETING" });
  expect((await sessions.listSessions()).length).toBe(before);
});
