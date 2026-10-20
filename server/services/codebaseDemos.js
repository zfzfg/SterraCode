import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import {
  AppError,
  DATA_DIR,
  LANGUAGES,
  getSettings,
  serial,
  readJSON,
  writeJSON,
  validateSessionId,
  assertSessionWritable,
} from "./storage.js";
import { createSession, loadSession } from "./sessions.js";
import { normalizePath, readFile, writeFile } from "./workspace.js";
import { proposeFile } from "./proposals.js";
import {
  getRuntimes,
  readProcess,
  startIsolatedDemoProcess,
} from "./processes.js";
import { runnerEnabled, runnerRequest } from "./runnerClient.js";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const error = (key, code = "DEMO_INVALID_REQUEST", status = 400) =>
  new AppError("Demo operation could not be completed.", status, code, {
    messageKey: `serverFeature:demo.${key}`,
    params: {},
  });
const root = (id) =>
  path.join(DATA_DIR, "codebase-demos", validateSessionId(id));
const recordFile = (id, demoId) =>
  path.join(root(id), `${validateSessionId(demoId)}.json`);
const actionFile = (id, requestId) =>
  path.join(root(id), "actions", `${validateSessionId(requestId)}.json`);
async function parentSession(id) {
  await assertSessionWritable(id);
  const parent = await loadSession(id);
  if (parent.mode !== "codebase")
    throw error("parent", "CODEBASE_REQUIRED", 409);
  return parent;
}
async function record(id, demoId) {
  await parentSession(id);
  let demo;
  try {
    demo = await readJSON(recordFile(id, demoId));
  } catch (e) {
    if (e.code === "ENOENT") throw error("notFound", "NOT_FOUND", 404);
    throw e;
  }
  if (demo.parentSessionId !== id) throw error("notFound", "NOT_FOUND", 404);
  return demo;
}
export async function getExecutionCapabilities() {
  const settings = await getSettings();
  let runtimes = [],
    runtimeError = null;
  try {
    runtimes = await getRuntimes();
  } catch (e) {
    runtimeError = e.code || "RUNTIME_UNAVAILABLE";
  }
  let isolation = {
    executionAllowed: false,
    reasonCode: "DEMO_ISOLATION_REQUIRED",
    isolation: {
      verified: false,
      sourcesRestricted: false,
      networkRestricted: false,
    },
  };
  if (runnerEnabled())
    try {
      isolation = await runnerRequest("/v1/demo-capabilities");
    } catch {}
  return {
    mode: runnerEnabled() ? "docker" : "local",
    runtimes,
    runtimeError,
    installationAvailable: runnerEnabled(),
    aiTerminalAllowed: settings.allowAITerminalCommands,
    ...isolation,
    executionAllowed: Boolean(
      isolation.executionAllowed && settings.allowAITerminalCommands,
    ),
    ...(!isolation.executionAllowed
      ? { reasonKey: "serverFeature:demo.isolation", reasonParams: {} }
      : {}),
  };
}
export async function createCodebaseDemo(id, input, context = {}) {
  const parent = await parentSession(id),
    settings = await getSettings();
  const {
    operationId,
    language,
    code,
    description = "",
    title = "Demo",
  } = input || {};
  const relative = normalizePath(input?.path);
  if (
    typeof operationId !== "string" ||
    !operationId ||
    operationId.length > 200 ||
    !LANGUAGES.includes(language) ||
    !settings.allowedLanguages.includes(language) ||
    typeof code !== "string" ||
    code.includes("\0") ||
    Buffer.byteLength(code) > 2 * 1024 * 1024 ||
    typeof description !== "string" ||
    description.length > 4000 ||
    typeof title !== "string" ||
    !title.trim() ||
    title.length > 200
  )
    throw error("invalid");
  const fingerprint = hash(
    JSON.stringify([language, code, description, title, relative]),
  );
  return serial(`codebase-demo:${id}`, () =>
    serial(`lifecycle:${id}`, async () => {
      await parentSession(id);
      await assertSessionWritable(id);
      const receipt = path.join(
        root(id),
        `operation-${hash(operationId)}.json`,
      );
      let demo;
      try {
        const saved = await readJSON(receipt);
        if (saved.fingerprint !== fingerprint)
          throw error("conflict", "IDEMPOTENCY_CONFLICT", 409);
        demo = await readJSON(recordFile(id, saved.demoId));
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      if (!demo) {
        demo = {
          schemaVersion: 1,
          demoId: randomUUID(),
          sessionId: randomUUID(),
          parentSessionId: id,
          operationId,
          language,
          path: relative,
          title: title.trim(),
          description,
          fileVersion: hash(code),
          status: "creating",
          createdAt: new Date().toISOString(),
          sourceRevision: parent.revision,
        };
        // Never persist code in the receipt, or copy files from the original.
        await writeJSON(recordFile(id, demo.demoId), demo);
        await writeJSON(receipt, { demoId: demo.demoId, fingerprint });
      }
      if (demo.status !== "creating")
        return { ...demo, execution: await getExecutionCapabilities() };
      let session;
      try {
        session = await loadSession(demo.sessionId);
      } catch (e) {
        if (e.code !== "ENOENT" && e.status !== 404) throw e;
      }
      if (!session)
        session = await createSession(
          { title, language, tutorLocale: parent.tutorLocale },
          {
            id: demo.sessionId,
            mode: "demo",
            files: [],
            activeFile: relative,
            project: {
              kind: "codebase-demo",
              parentSessionId: id,
              demoId: demo.demoId,
            },
          },
        );
      if (
        session.project?.parentSessionId !== id ||
        session.project?.demoId !== demo.demoId
      )
        throw error("conflict", "CONFLICT", 409);
      let current;
      try {
        current = await readFile(session.id, relative);
      } catch (e) {
        if (e.status !== 404) throw e;
      }
      let result;
      if (current) {
        if (current.version !== demo.fileVersion)
          throw error("conflict", "CONFLICT", 409);
        result = { status: "applied", version: current.version };
      } else {
        result = await (settings.reviewAIChanges ? proposeFile : writeFile)(
          session.id,
          relative,
          code,
          null,
          {
            actor: "ai",
            reason: description,
            operationId: demo.demoId,
            changeId: demo.demoId,
            turnId: context.turnId || null,
          },
        );
      }
      demo.status = result.status;
      if (result.proposalId) demo.proposalId = result.proposalId;
      await writeJSON(recordFile(id, demo.demoId), demo);
      return { ...demo, execution: await getExecutionCapabilities() };
    }),
  );
}
export async function listCodebaseDemos(id) {
  await parentSession(id);
  let names;
  try {
    names = await fs.readdir(root(id));
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
  const demos = [];
  for (const name of names.filter((v) => /^[a-f0-9-]{36}\.json$/i.test(v))) {
    const demo = await readJSON(path.join(root(id), name));
    try {
      const current = await readFile(demo.sessionId, demo.path);
      demo.status = "applied";
      demo.currentFileVersion = current.version;
      demo.changed = current.version !== demo.fileVersion;
    } catch (e) {
      if (![404, 409].includes(e.status) && e.code !== "ENOENT") throw e;
      demo.status = demo.status === "proposed" ? "proposed" : "unavailable";
    }
    demos.push(demo);
  }
  return demos;
}
async function programStatus() {
  if (!runnerEnabled()) throw error("local", "LOCAL_MODE", 409);
  return runnerRequest("/v1/programs");
}
export async function requestRuntimeInstallation(
  id,
  demoId,
  { programId, reason = "", operationId } = {},
) {
  const demo = await record(id, demoId),
    settings = await getSettings();
  if (
    !LANGUAGES.includes(programId) ||
    programId !== demo.language ||
    !settings.allowedLanguages.includes(programId) ||
    typeof reason !== "string" ||
    reason.length > 2000 ||
    typeof operationId !== "string" ||
    !operationId ||
    operationId.length > 200
  )
    throw error("invalid");
  if (!settings.allowAITerminalCommands)
    throw error("disabled", "TERMINAL_DISABLED", 403);
  const status = await programStatus(),
    program = status.programs?.find((p) => p.id === programId);
  if (!program) throw error("invalid");
  return serial(`codebase-demo:${id}`, () =>
    serial(`lifecycle:${id}`, async () => {
      await parentSession(id);
      const receipt = path.join(
        root(id),
        "actions",
        `operation-${hash(operationId)}.json`,
      );
      const fingerprint = hash(
        JSON.stringify([demoId, programId, reason, demo.fileVersion]),
      );
      try {
        const saved = await readJSON(receipt);
        if (saved.fingerprint !== fingerprint)
          throw error("conflict", "IDEMPOTENCY_CONFLICT", 409);
        return await readJSON(actionFile(id, saved.requestId));
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      const action = {
        schemaVersion: 1,
        requestId: randomUUID(),
        kind: "runtime-installation",
        action: "install",
        parentSessionId: id,
        demoId,
        demoSessionId: demo.sessionId,
        fileVersion: demo.fileVersion,
        programId,
        reason,
        catalogVersion: status.catalogVersion,
        program: {
          id: program.id,
          name: program.name,
          version: program.version,
          sizeMB: program.sizeMB,
        },
        impactsSharedRunner: true,
        stopRunning: false,
        status: "pending",
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      };
      await writeJSON(actionFile(id, action.requestId), action);
      await writeJSON(receipt, { requestId: action.requestId, fingerprint });
      return action;
    }),
  );
}
export async function listCodebaseActions(id) {
  await parentSession(id);
  let names;
  const directory = path.join(root(id), "actions");
  try {
    names = await fs.readdir(directory);
  } catch (e) {
    if (e.code === "ENOENT") return [];
    throw e;
  }
  return Promise.all(
    names
      .filter((name) => /^[a-f0-9-]{36}\.json$/i.test(name))
      .map(async (name) => {
        const action = await readJSON(path.join(directory, name));
        if (action.processId)
          try {
            action.process = await readProcess(
              action.processId,
              action.demoSessionId,
            );
          } catch {}
        if (action.programJobId)
          try {
            action.programJob = await runnerRequest(
              `/v1/program-jobs/${action.programJobId}`,
            );
          } catch {}
        return action;
      }),
  );
}
export async function decideCodebaseAction(id, requestId, decision) {
  if (!["install", "run", "code-only", "cancel"].includes(decision))
    throw error("invalid");
  return serial(`codebase-demo:${id}`, () =>
    serial(`lifecycle:${id}`, async () => {
      await parentSession(id);
      let action;
      try {
        action = await readJSON(actionFile(id, requestId));
      } catch (e) {
        if (e.code === "ENOENT") throw error("notFound", "NOT_FOUND", 404);
        throw e;
      }
      if (action.decision && action.decision !== decision)
        throw error("decided", "ACTION_ALREADY_DECIDED", 409);
      if (action.status !== "pending" && action.status !== "submitting")
        return action;
      if (
        action.status === "pending" &&
        Date.parse(action.expiresAt) < Date.now()
      ) {
        action.status = "expired";
        await writeJSON(actionFile(id, requestId), action);
        throw error("expired", "ACTION_EXPIRED", 409);
      }
      if (decision === "cancel" || decision === "code-only") {
        action.decision = decision;
        action.status = decision === "cancel" ? "cancelled" : "code-only";
        await writeJSON(actionFile(id, requestId), action);
        return action;
      }
      if (
        (action.kind === "runtime-installation" && decision !== "install") ||
        (action.kind === "demo-execution" && decision !== "run")
      )
        throw error("invalid");
      const settings = await getSettings();
      if (
        !settings.allowAITerminalCommands ||
        !settings.allowedLanguages.includes(action.programId)
      )
        throw error("disabled", "TERMINAL_DISABLED", 403);
      const demo = await record(id, action.demoId);
      let current;
      try {
        current = await readFile(demo.sessionId, demo.path);
      } catch {
        throw error("changed", "DEMO_SOURCE_CHANGED", 409);
      }
      if (current.version !== action.fileVersion)
        throw error("changed", "DEMO_SOURCE_CHANGED", 409);
      if (action.kind === "demo-execution") {
        const capabilities = await getExecutionCapabilities();
        if (
          !capabilities.executionAllowed ||
          !capabilities.isolation?.verified ||
          !capabilities.allowedLanguages?.includes(demo.language)
        )
          throw error("isolation", "DEMO_ISOLATION_REQUIRED", 409);
        if (
          !capabilities.runtimes.some(
            (r) => r.language === demo.language && r.available,
          )
        )
          throw error("runtime", "RUNTIME_MISSING", 409);
        action.decision = decision;
        action.status = "submitting";
        action.processId = requestId;
        await writeJSON(actionFile(id, requestId), action);
        // Private server wrapper prevents ordinary terminal JSON from authorizing
        // this path. Runner independently verifies the immutable source hash.
        action.process = await startIsolatedDemoProcess({
          sessionId: demo.sessionId,
          file: demo.path,
          language: demo.language,
          actor: "ai",
          isolatedDemo: { fileVersion: action.fileVersion },
          idempotencyId: requestId,
        });
        action.status = "submitted";
        await writeJSON(actionFile(id, requestId), action);
        return action;
      }
      const status = await programStatus();
      if (status.catalogVersion !== action.catalogVersion)
        throw error("catalog", "CATALOG_CHANGED", 409);
      const program = status.programs?.find((p) => p.id === action.programId);
      if (program?.installed && program.state !== "error") {
        action.status = "already-installed";
        action.decision = decision;
        await writeJSON(actionFile(id, requestId), action);
        return action;
      }
      // Persist identity before the side effect. The runner uses requestId as its
      // durable job ID, including when the original HTTP response was lost.
      action.decision = decision;
      action.status = "submitting";
      action.programJobId = requestId;
      await writeJSON(actionFile(id, requestId), action);
      let job;
      try {
        job = await runnerRequest(`/v1/program-jobs/${requestId}`);
      } catch (e) {
        if (e.status !== 404) throw e;
      }
      if (!job) {
        const response = await runnerRequest(
          `/v1/programs/${action.programId}/actions`,
          {
            method: "POST",
            body: {
              action: "install",
              stopRunning: false,
              clearCache: false,
              operationId: requestId,
            },
          },
        );
        job = response.job || response;
      }
      action.programJobId = job.id;
      action.status = "submitted";
      action.programJob = job;
      await writeJSON(actionFile(id, requestId), action);
      return action;
    }),
  );
}
export async function requestDemoExecution(
  id,
  demoId,
  { fileVersion, operationId } = {},
) {
  const demo = await record(id, demoId),
    current = await readFile(demo.sessionId, demo.path);
  if (
    typeof operationId !== "string" ||
    !operationId ||
    operationId.length > 200
  )
    throw error("invalid");
  if (
    typeof fileVersion !== "string" ||
    current.version !== fileVersion ||
    demo.fileVersion !== fileVersion
  )
    throw error("changed", "DEMO_SOURCE_CHANGED", 409);
  return serial(`codebase-demo:${id}`, () =>
    serial(`lifecycle:${id}`, async () => {
      await parentSession(id);
      const receipt = path.join(
          root(id),
          "actions",
          `operation-${hash(operationId)}.json`,
        ),
        fingerprint = hash(JSON.stringify([demoId, "run", fileVersion]));
      try {
        const saved = await readJSON(receipt);
        if (saved.fingerprint !== fingerprint)
          throw error("conflict", "IDEMPOTENCY_CONFLICT", 409);
        return await readJSON(actionFile(id, saved.requestId));
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
      const action = {
        schemaVersion: 1,
        requestId: randomUUID(),
        kind: "demo-execution",
        action: "run",
        parentSessionId: id,
        demoId,
        demoSessionId: demo.sessionId,
        fileVersion,
        programId: demo.language,
        language: demo.language,
        path: demo.path,
        status: "pending",
        createdAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
      };
      await writeJSON(actionFile(id, action.requestId), action);
      await writeJSON(receipt, { requestId: action.requestId, fingerprint });
      return action;
    }),
  );
}
export const runCodebaseDemo = requestDemoExecution;
