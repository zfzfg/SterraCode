import { randomUUID } from "node:crypto";
import {
  AppError,
  getSettings,
  validateSessionId,
  assertSessionWritable,
} from "./storage.js";
import * as local from "./localProcesses.js";
import { describeProcess } from "./processReasons.js";
import {
  runnerEnabled,
  runnerRequest,
  blockSession as remoteBlock,
  unblockSession as remoteUnblock,
} from "./runnerClient.js";

export const MAX_OUTPUT = local.MAX_OUTPUT;
export const probe = local.probe;
export const killTree = local.killTree;
export async function getRuntimes(probeFn) {
  if (!runnerEnabled()) return local.getRuntimes(probeFn);
  const settings = await getSettings();
  return (await runnerRequest("/v1/runtimes")).map((runtime) => {
    const enabled = settings.allowedLanguages.includes(runtime.language);
    return {
      ...runtime,
      enabled,
      available: Boolean(runtime.installed && runtime.available && enabled),
      reason: enabled
        ? runtime.reason
        : "Diese Sprache ist in den Einstellungen deaktiviert.",
      ...(!enabled
        ? {
            reasonKey: "serverFeature:process.languageDisabled",
            reasonParams: {},
          }
        : {}),
    };
  });
}
export async function startProcess(options) {
  if (options.test)
    options = {
      ...options,
      file: options.test.suite.entry.path,
      language: "python",
    };
  if (options.trace)
    options = { ...options, file: options.trace.entry, language: "python" };
  if (!runnerEnabled()) return local.startProcess(options);
  validateSessionId(options.sessionId);
  await assertSessionWritable(options.sessionId);
  const settings = await getSettings();
  if (options.actor === "ai" && !settings.allowAITerminalCommands)
    throw new AppError(
      "KI-Terminalbefehle sind deaktiviert.",
      403,
      "TERMINAL_DISABLED",
      { messageKey: "serverFeature:process.aiDisabled", params: {} },
    );
  if (options.file && !settings.allowedLanguages.includes(options.language))
    throw new AppError(
      "Diese Sprache ist in den Einstellungen deaktiviert.",
      400,
      "RUNTIME_MISSING",
      { messageKey: "serverFeature:process.languageDisabled", params: {} },
    );
  const id = options.idempotencyId || randomUUID();
  const payload = {
    id,
    sessionId: options.sessionId,
    type: options.test
      ? "test"
      : options.trace
        ? "trace"
        : options.file
          ? "file"
          : "command",
    actor: options.actor || "user",
    ...(options.file
      ? { file: options.file, language: options.language }
      : { command: options.command }),
    ...(options.test ? { test: options.test } : {}),
    executionTimeout: settings.executionTimeout,
    compilationTimeout: settings.compilationTimeout,
    ...(options.trace
      ? { trace: options.trace, language: "python", executionTimeout: 10000 }
      : {}),
  };
  try {
    return describeProcess(
      await runnerRequest("/v1/jobs", {
        method: "POST",
        body: payload,
        timeout: 15000,
      }),
    );
  } catch (error) {
    if (error.code !== "RUNNER_UNAVAILABLE") throw error;
    try {
      return await readProcess(id, options.sessionId);
    } catch (readError) {
      if (readError.status !== 404) throw readError;
    }
    return runnerRequest("/v1/jobs", {
      method: "POST",
      body: payload,
      timeout: 15000,
      retries: 1,
    }).then(describeProcess);
  }
}
export function readProcess(id, sessionId, offset = 0) {
  if (!runnerEnabled()) return local.readProcess(id, sessionId, offset);
  if (!Number.isInteger(offset) || offset < 0)
    throw new AppError("Ungültige Ausgabeposition.", undefined, undefined, {
      messageKey: "serverFeature:process.invalidOffset",
      params: {},
    });
  return runnerRequest(
    `/v1/jobs/${encodeURIComponent(id)}/output?sessionId=${encodeURIComponent(sessionId)}&offset=${offset}`,
  ).then(describeProcess);
}
export function inputProcess(id, sessionId, input) {
  return runnerEnabled()
    ? runnerRequest(`/v1/jobs/${encodeURIComponent(id)}/input`, {
        method: "POST",
        body: { sessionId, input },
      }).then(describeProcess)
    : local.inputProcess(id, sessionId, input);
}
export function stopProcess(id, sessionId) {
  return runnerEnabled()
    ? runnerRequest(`/v1/jobs/${encodeURIComponent(id)}`, {
        method: "DELETE",
        body: { sessionId },
        timeout: 15000,
      }).then(describeProcess)
    : local.stopProcess(id, sessionId);
}
export async function waitProcess(id, sessionId) {
  if (!runnerEnabled()) return local.waitProcess(id, sessionId);
  for (;;) {
    const job = await readProcess(id, sessionId);
    if (job.exited) return job;
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}
export function stopAllProcesses() {
  return runnerEnabled()
    ? runnerRequest("/v1/stop", {
        method: "POST",
        body: {},
        timeout: 15000,
        retries: 1,
      })
    : local.stopAllProcesses();
}
export function stopSessionProcesses(sessionId) {
  return runnerEnabled()
    ? runnerRequest(`/v1/sessions/${encodeURIComponent(sessionId)}/stop`, {
        method: "POST",
        body: {},
        timeout: 15000,
        retries: 1,
      })
    : local.stopSessionProcesses(sessionId);
}
export function blockSession(sessionId) {
  validateSessionId(sessionId);
  return runnerEnabled()
    ? remoteBlock(sessionId)
    : local.stopSessionProcesses(sessionId);
}
export function unblockSession(sessionId) {
  validateSessionId(sessionId);
  return runnerEnabled()
    ? remoteUnblock(sessionId)
    : Promise.resolve({ blocked: false });
}
