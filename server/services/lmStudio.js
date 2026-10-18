import { LMStudioClient, rawFunctionTool } from "@lmstudio/sdk";
import { randomUUID } from "node:crypto";
import { AppError } from "./storage.js";
import { createPassCap } from "./context/core/passCap.js";
import { stripReasoningMarkers } from "./context/core/reasoning.js";

const clients = new Map();
let clientFactory = (options) => new LMStudioClient(options);
// Module dependency injection for contract tests and the isolated browser fixture.
export function setLMStudioClientFactory(factory) {
  clients.clear();
  clientFactory = factory || ((options) => new LMStudioClient(options));
}
export function rpc(promise, signal, timeout = 10000) {
  return new Promise((resolve, reject) => {
    let timer;
    const finish = (fn, value) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      fn(value);
    };
    const abort = () =>
      finish(
        reject,
        signal.reason || new DOMException("Abgebrochen", "AbortError"),
      );
    timer = setTimeout(
      () =>
        finish(
          reject,
          new AppError(
            "LM-Studio-Kontextprüfung hat das Zeitlimit überschritten. Verbindung und geladenes Modell prüfen.",
            503,
            "CONTEXT_UNVERIFIED",
          ),
        ),
      timeout,
    );
    if (signal?.aborted) abort();
    else signal?.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(
      (v) => finish(resolve, v),
      (e) => finish(reject, e),
    );
  });
}
function clientFor(settings) {
  const url = new URL(settings.lmStudioUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  const baseUrl = url.href.replace(/\/$/, "");
  let client = clients.get(baseUrl);
  if (!client) {
    client = clientFactory({ baseUrl }, settings);
    clients.set(baseUrl, client);
    if (clients.size > 4) clients.delete(clients.keys().next().value);
  }
  return client;
}
export async function listLoadedModels(settings, signal) {
  return rpc(clientFor(settings).llm.listLoaded(), signal, 4000);
}
export async function connectModel(settings, signal) {
  signal?.throwIfAborted();
  if (!settings.activeModel)
    throw new AppError(
      "Bitte in LM Studio ein Modell laden und auswählen.",
      400,
      "NO_MODEL",
    );
  const loaded = await listLoadedModels(settings, signal);
  const native = loaded.find((m) => m.identifier === settings.activeModel);
  if (!native)
    throw new AppError(
      "Das ausgewählte Modell ist nicht geladen. Bitte in LM Studio laden und die Modellauswahl aktualisieren.",
      400,
      "NO_MODEL",
    );
  const info = await rpc(native.getModelInfo(), signal);
  const model = {
    identifier: native.identifier,
    trainedForToolUse: native.trainedForToolUse,
    getContextLength: () => rpc(native.getContextLength(), signal),
    getModelInfo: () => rpc(native.getModelInfo(), signal),
    applyPromptTemplate: (...args) =>
      rpc(native.applyPromptTemplate(...args), signal),
    countTokens: (...args) => rpc(native.countTokens(...args), signal),
    respond: (chat, opts = {}) =>
      native.respond(chat, {
        ...opts,
        rawTools: { type: "none" },
        signal: AbortSignal.any([
          opts.signal || signal || new AbortController().signal,
          AbortSignal.timeout(120000),
        ]),
      }),
    act: (...args) => native.act(...args),
  };
  return {
    model,
    info,
    identity: JSON.stringify([
      info.identifier,
      info.path,
      info.instanceReference,
    ]),
  };
}

/** SDK callbacks are synchronous. Tool implementations wait for a durable
 * assistant request; full results are saved before capped data returns to SDK. */
export async function runModelPass({
  model,
  chat,
  definitions,
  maxTokens,
  temperature,
  signal,
  onToken,
  onReasoning,
  onAssistant,
  onExecute,
  onInvalid,
  capResult,
  allocateCallId = () => randomUUID().replaceAll("-", "").slice(0, 9),
}) {
  const passController = new AbortController();
  const mirror = () => passController.abort(signal.reason);
  if (signal.aborted) mirror();
  else signal.addEventListener("abort", mirror, { once: true });
  const timer = setTimeout(
    () =>
      passController.abort(
        new Error(
          "LM Studio hat nicht innerhalb von 120 Sekunden geantwortet.",
        ),
      ),
    120000,
  );
  const passSignal = passController.signal;
  const cap = createPassCap({ maxRounds: 1, parentSignal: passSignal });
  const requests = new Map();
  const executions = [];
  const entries = [];
  const usedIds = new Set();
  const makeEntry = (r) => {
    // Provider IDs may restart at zero in each .act(). Nine alphanumeric
    // characters also satisfy strict Mistral-style tool templates.
    let id;
    do {
      id = allocateCallId();
    } while (usedIds.has(id));
    usedIds.add(id);
    const entry = {
      request: r,
      call: {
        id,
        type: "function",
        function: {
          name: r.name,
          arguments: JSON.stringify(r.arguments || {}),
        },
      },
    };
    entries.push(entry);
    return entry;
  };
  let resolveAssistant, rejectAssistant;
  const assistantReady = new Promise((resolve, reject) => {
    resolveAssistant = resolve;
    rejectAssistant = reject;
  });
  assistantReady.catch(() => {});
  let persistence = Promise.resolve();
  let prediction,
    hadTools = false,
    visibleChars = 0,
    executedTools = 0,
    failure,
    invalidUnparsed = false;
  const tools = definitions.map((d) =>
    rawFunctionTool({
      name: d.function.name,
      description: d.function.description,
      parametersJsonSchema: d.function.parameters,
      implementation: (args, ctx) => {
        const execution = (async () => {
          await rpc(assistantReady, passSignal, 120000);
          passSignal.throwIfAborted();
          const entry = requests.get(ctx.callId);
          if (!entry)
            throw new Error(
              "Werkzeugaufruf konnte nicht eindeutig zugeordnet werden.",
            );
          hadTools = true;
          executedTools++;
          const saved = await onExecute(entry.call, args, passSignal);
          return capResult(saved.content, saved.id);
        })();
        executions.push(execution);
        return execution;
      },
    }),
  );
  try {
    await model.act(chat, tools, {
      maxTokens,
      temperature,
      contextOverflowPolicy: "stopAtLimit",
      toolNaming: "passThrough",
      allowParallelToolExecution: false,
      signal: cap.signal,
      onPredictionFragment: (f) => {
        if (f.isStructural) return;
        if (f.reasoningType === "reasoning") {
          visibleChars += f.content.length;
          onReasoning?.(f.content);
        } else {
          visibleChars += f.content.length;
          onToken?.(f.content);
        }
      },
      onPredictionCompleted: (result) => {
        prediction = result;
      },
      onToolCallRequestEnd: (_round, id, info) => {
        const r = info.toolCallRequest;
        requests.set(id, makeEntry(r));
      },
      onMessage: (m) => {
        if (m.getRole() !== "assistant") return;
        try {
          const unmatched = new Set(entries);
          const calls = m.getToolCallRequests().map((r, index) => {
            const entry =
              entries.find(
                (e) =>
                  unmatched.has(e) &&
                  e.request.name === r.name &&
                  ((!r.id && !e.request.id) || r.id === e.request.id),
              ) || entries[index];
            if (!entry) throw new Error("Unvollständiger Werkzeugaufruf.");
            unmatched.delete(entry);
            return entry.call;
          });
          hadTools ||= calls.length > 0;
          const content =
            typeof prediction?.nonReasoningContent === "string"
              ? prediction.nonReasoningContent
              : stripReasoningMarkers(m.getText());
          persistence = persistence.then(() =>
            onAssistant({
              content,
              tool_calls: calls,
              thinking: prediction?.reasoningContent || "",
            }),
          );
          persistence.then(resolveAssistant, rejectAssistant);
        } catch (error) {
          rejectAssistant(error);
          passController.abort(error);
          failure = error;
        }
      },
      onRoundEnd: (index) => {
        if (hadTools) cap.onRoundEnd(index);
      },
      handleInvalidToolRequest: async (error, request) => {
        const result = {
          type: "tool_error",
          tool: request?.name || "unknown",
          error: String(error.message || error).slice(0, 1000),
          code: "INVALID_TOOL_REQUEST",
        };
        if (!request) {
          invalidUnparsed = true;
          await onInvalid?.(result);
          return undefined;
        }
        const entry = makeEntry(request);
        const save = (async () => {
          await rpc(assistantReady, passSignal, 120000);
          await onInvalid?.(result, entry.call);
        })();
        executions.push(save);
        await save;
        return result;
      },
    });
  } catch (error) {
    if (!cap.isCapAbort()) failure = error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", mirror);
    cap.dispose();
    if (failure) rejectAssistant(failure);
  }
  try {
    await persistence;
  } catch (error) {
    failure = error;
  }
  const settled = await Promise.allSettled(executions);
  for (const execution of settled)
    if (execution.status === "rejected" && !failure) failure = execution.reason;
  if (failure) {
    if (!(failure instanceof Error)) failure = new Error(String(failure));
    failure.passStats = { visibleChars, executedTools };
    throw failure;
  }
  signal.throwIfAborted();
  return {
    capped: cap.reason(),
    hadTools,
    invalidUnparsed,
    empty: !hadTools && !prediction?.nonReasoningContent?.trim(),
    stopReason: prediction?.stats?.stopReason,
  };
}
