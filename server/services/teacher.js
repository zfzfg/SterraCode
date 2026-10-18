import { randomUUID } from "node:crypto";
import { AppError, getSettings, validateSessionId } from "./storage.js";
import { loadSession, mutateSession, message } from "./sessions.js";
import { connectModel, runModelPass } from "./lmStudio.js";
import { setTimeout as delay } from "node:timers/promises";
import { TOOL_DEFINITIONS } from "./tools.js";
import { executeTool } from "./toolExecutor.js";
import { ContextManager, estimatedUsage } from "./context/index.js";
import { contextCommand } from "./context/settings.js";
import { isTransientEngineError } from "./context/core/retry.js";
import { getProfile, profileToPromptText } from "./profileManager.js";

const active = new Map();
export function abortTurn(sessionId) {
  active.get(sessionId)?.abort();
  return { ok: true };
}
export function isActive(sessionId) {
  return active.has(sessionId);
}
export async function answerQuestion(sessionId, questionId, answer) {
  if (typeof answer !== "string" || !answer.trim() || answer.length > 20000)
    throw new AppError("Eine Antwort ist erforderlich.");
  let answerMessage;
  const session = await mutateSession(sessionId, (s) => {
    const q = s.messages.find(
      (m) =>
        m.event?.questionId === questionId ||
        (m.role === "tool" &&
          (() => {
            try {
              return JSON.parse(m.content).questionId === questionId;
            } catch {
              return false;
            }
          })()),
    );
    if (!q) throw new AppError("Frage nicht gefunden.", 404);
    const event = q.event || JSON.parse(q.content);
    if (event.answer) {
      answerMessage = s.messages.find((m) => m.id === event.answerMessageId);
      if (answerMessage?.content === answer.trim()) return;
      throw new AppError("Diese Frage wurde bereits beantwortet.", 409);
    }
    answerMessage = message("user", answer.trim(), { questionId });
    event.answer = answer.trim();
    event.answerMessageId = answerMessage.id;
    if (q.event) q.event = event;
    else q.content = JSON.stringify(event);
    s.messages.push(answerMessage);
  });
  return { session, messageId: answerMessage.id };
}
export async function runTeacher({
  sessionId,
  userMessage = "",
  contextAction,
  turnId = randomUUID(),
  existingUserMessageId,
  retryOf,
  signal,
  onEvent = () => {},
  stream = false,
}) {
  validateSessionId(sessionId);
  validateSessionId(turnId);
  if (typeof userMessage !== "string" || userMessage.length > 50000)
    throw new AppError("Ungültige Nachricht.");
  if (
    contextAction !== undefined &&
    !["compact", "usage"].includes(contextAction)
  )
    throw new AppError("Ungültige Kontextaktion.");
  const action =
    contextAction ||
    (!existingUserMessageId && !retryOf ? contextCommand(userMessage) : null);
  if (
    action &&
    (!["compact", "usage"].includes(action) ||
      existingUserMessageId ||
      retryOf ||
      (userMessage.trim() && !contextCommand(userMessage)))
  )
    throw new AppError("Ungültige Kontextaktion.");
  if (active.has(sessionId))
    throw new AppError(
      "Für diese Session läuft bereits eine Antwort.",
      409,
      "TURN_BUSY",
    );
  const controller = new AbortController();
  active.set(sessionId, controller);
  const abort = () => controller.abort(signal?.reason);
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  let started = false,
    fullText = "",
    thinking = "",
    assistantSaved = false,
    toolCount = 0,
    manager,
    settings,
    usage;
  const reports = [];
  const emit = (event, data) => {
    if (event === "context-report") reports.push(data);
    onEvent(event, data);
  };
  const flushReports = async () => {
    if (!reports.length) return;
    const pending = reports.splice(0);
    const saved = pending.map((event) =>
      message("event", "", { turnId, event }),
    );
    await mutateSession(sessionId, (s) => s.messages.push(...saved));
    for (const m of saved) emit("message", m);
  };
  const completeMissing = async () => {
    return mutateSession(sessionId, (s) => {
      const answered = new Set(
        s.messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id),
      );
      const missing = [];
      for (const m of s.messages)
        for (const call of m.tool_calls || []) {
          if (answered.has(call.id)) continue;
          const began =
            s.turns?.[m.turnId]?.toolExecutions?.[call.id] === "started";
          missing.push(
            message(
              "tool",
              JSON.stringify({
                type: "tool_error",
                tool: call.function.name,
                code: began ? "TOOL_RESULT_UNKNOWN" : "TOOL_NOT_EXECUTED",
                originalCall: call,
                error: began
                  ? "Die Ausführung wurde unterbrochen; ihr Ergebnis ist unbekannt. Aktuellen Datei-/Prozesszustand prüfen, den Aufruf nicht automatisch wiederholen."
                  : "Dieser Werkzeugaufruf wurde vor der Ausführung abgebrochen.",
              }),
              { tool_call_id: call.id, turnId: m.turnId },
            ),
          );
          answered.add(call.id);
        }
      s.messages.push(...missing);
    });
  };
  try {
    let session = await loadSession(sessionId);
    settings = await getSettings();
    if (session.turns?.[turnId])
      return {
        session,
        turn: session.turns[turnId],
        contextUsage: session.contextUsage || estimatedUsage(session, settings),
        tokenCount:
          session.contextUsage?.promptTokens ??
          estimatedUsage(session, settings).promptTokens,
        replayed: true,
      };
    if (!action && !settings.activeModel)
      throw new AppError(
        "Bitte in LM Studio ein Modell laden und auswählen.",
        400,
        "NO_MODEL",
      );
    session = await mutateSession(sessionId, (s) => {
      s.turns ||= {};
      if (retryOf) {
        const previous = s.turns[retryOf];
        if (
          !previous ||
          !["error", "aborted", "running"].includes(previous.status)
        )
          throw new AppError("Diese Antwort kann nicht fortgesetzt werden.");
        if (previous.status === "running") {
          previous.status = "aborted";
          previous.error = "Die vorherige Serververbindung wurde unterbrochen.";
        }
      } else if (existingUserMessageId) {
        const m = s.messages.find(
          (m) => m.id === existingUserMessageId && m.role === "user",
        );
        if (!m || m.turnId)
          throw new AppError("Antwort bereits verarbeitet.", 409);
        m.turnId = turnId;
      } else if (!action) {
        if (!userMessage.trim())
          throw new AppError("Eine Nachricht ist erforderlich.");
        s.messages.push(message("user", userMessage.trim(), { turnId }));
      }
      s.turns[turnId] = {
        id: turnId,
        status: "running",
        startedAt: new Date().toISOString(),
        retryOf: retryOf || null,
        contextAction: action || null,
        toolExecutions: {},
      };
    });
    started = true;
    session = await completeMissing();
    let connection;
    try {
      connection = await connectModel(settings, controller.signal);
      manager = new ContextManager({
        connection,
        settings,
        sessionId,
        signal: controller.signal,
        onEvent: emit,
      });
      await manager.initialize();
    } catch (error) {
      if (action !== "usage" || controller.signal.aborted) throw error;
      usage = estimatedUsage(session, settings, error.message);
    }
    const definitions =
      connection?.model.trainedForToolUse === false ? [] : TOOL_DEFINITIONS;
    if (connection?.model.trainedForToolUse === false && !action)
      emit("notice", {
        message:
          "Dieses Modell unterstützt keine Werkzeuge. Datei- und Terminalaktionen stehen dem Tutor damit nicht zur Verfügung.",
      });
    const profile = settings.crossChatProfileEnabled
      ? profileToPromptText(await getProfile(), session.language)
      : "";
    if (action) {
      if (manager && !usage) {
        try {
          const prepared = await manager.prepare(session, definitions, {
            force: action === "compact",
            diagnostics: action === "usage",
            profile,
          });
          usage = prepared.contextUsage;
        } catch (error) {
          if (action !== "usage" || controller.signal.aborted) throw error;
          usage = estimatedUsage(session, settings, error.message);
        }
      }
      if (action === "usage")
        emit("context-report", { type: "context_usage", contextUsage: usage });
      emit("context-usage", usage);
      await flushReports();
    } else {
      const callResults = new Map();
      const usedCallIds = new Set(
        session.messages.flatMap((m) => (m.tool_calls || []).map((c) => c.id)),
      );
      const allocateCallId = () => {
        let id;
        do {
          id = randomUUID().replaceAll("-", "").slice(0, 9);
        } while (usedCallIds.has(id));
        usedCallIds.add(id);
        return id;
      };
      for (const m of session.messages)
        if (m.role === "tool" && m.turnId === turnId)
          callResults.set(m.tool_call_id, m);
      let force = false,
        retries = 0;
      const context = {
        sessionId,
        turnId,
        language: session.language,
        learningPlan: session.learningPlan,
        signal: controller.signal,
        onProcess: (job) => emit("process", job),
        requestCompaction: () => {
          force = true;
        },
        getContextUsage: () => manager.usage,
        readToolResult: async (messageId, offset) =>
          manager.readResult(await loadSession(sessionId), messageId, offset),
      };
      while (true) {
        controller.signal.throwIfAborted();
        session = await loadSession(sessionId);
        const prepared = await manager.prepare(session, definitions, {
          force,
          profile,
          retry: !!retryOf,
        });
        force = false;
        usage = prepared.contextUsage;
        await flushReports();
        fullText = "";
        thinking = "";
        assistantSaved = false;
        const limiter = manager.newLimiter();
        let result;
        try {
          result = await runModelPass({
            allocateCallId,
            model: manager.model,
            chat: prepared.chat,
            definitions,
            maxTokens: prepared.maxTokens,
            temperature: settings.temperature,
            signal: controller.signal,
            onToken: (token) => {
              fullText += token;
              if (stream) emit("token", { token, turnId });
            },
            onReasoning: (token) => {
              thinking += token;
              if (stream) emit("reasoning", { token, turnId });
            },
            onAssistant: async (response) => {
              const m = message("assistant", response.content || "", {
                turnId,
                thinking: response.thinking || thinking,
                ...(response.tool_calls.length
                  ? { tool_calls: response.tool_calls }
                  : {}),
              });
              await mutateSession(sessionId, (s) => s.messages.push(m));
              assistantSaved = true;
              if (!stream && m.content)
                emit("token", { token: m.content, turnId });
              emit("message", m);
            },
            onExecute: async (call, args, executionSignal) => {
              if (callResults.has(call.id)) return callResults.get(call.id);
              let value;
              if (toolCount++ >= settings.maxToolCallsPerTurn)
                value = {
                  type: "tool_error",
                  tool: call.function.name,
                  error: "Tool-Limit erreicht.",
                };
              else {
                controller.signal.throwIfAborted();
                await mutateSession(sessionId, (s) => {
                  s.turns[turnId].toolExecutions[call.id] = "started";
                });
                emit("tool", { tool: call.function.name, turnId });
                value = await executeTool(call.function.name, args, {
                  ...context,
                  signal: executionSignal,
                });
                if (value.type === "update_learning_plan")
                  context.learningPlan = {
                    goal: value.goal,
                    topics: value.topics,
                  };
              }
              const m = message("tool", JSON.stringify(value), {
                tool_call_id: call.id,
                turnId,
              });
              await mutateSession(sessionId, (s) => {
                s.messages.push(m);
                s.turns[turnId].toolExecutions[call.id] = "completed";
              });
              callResults.set(call.id, m);
              emit("message", m);
              return m;
            },
            onInvalid: async (event, call) => {
              if (call) toolCount++;
              const m = call
                ? message("tool", JSON.stringify(event), {
                    turnId,
                    tool_call_id: call.id,
                  })
                : message("event", "", { turnId, event });
              await mutateSession(sessionId, (s) => s.messages.push(m));
              emit("message", m);
              if (call) callResults.set(call.id, m);
            },
            capResult: (content, id) => limiter.cap(content, id),
          });
        } catch (error) {
          const stats = error.passStats;
          if (
            !controller.signal.aborted &&
            !assistantSaved &&
            stats?.visibleChars === 0 &&
            stats.executedTools === 0 &&
            retries < 3 &&
            isTransientEngineError(error)
          ) {
            const wait = [1000, 5000, 15000][retries++];
            emit("notice", {
              message: `LM Studio wurde unterbrochen. Neuer Versuch in ${wait / 1000} Sekunden (${retries}/3) …`,
            });
            await delay(wait, undefined, { signal: controller.signal });
            await manager.replaceConnection(
              await connectModel(settings, controller.signal),
            );
            continue;
          }
          throw error;
        }
        controller.signal.throwIfAborted();
        if (result.invalidUnparsed)
          throw new AppError(
            "Das Modell hat einen unlesbaren Werkzeugaufruf geliefert. Bitte mit einem werkzeugfähigen Modell fortsetzen.",
            502,
            "INVALID_TOOL_REQUEST",
          );
        if (!result.capped) {
          if (
            ["contextLengthReached", "maxPredictedTokensReached"].includes(
              result.stopReason,
            )
          )
            throw new AppError(
              "Das Modell hat sein Antwortlimit erreicht. Die Teilantwort ist gespeichert; du kannst sie fortsetzen.",
              400,
              "RESPONSE_LIMIT",
            );
          if (result.empty)
            throw new AppError(
              "Das Modell hat keine sichtbare Antwort geliefert. Bitte erneut senden oder ein anderes Modell auswählen.",
              502,
              "EMPTY_RESPONSE",
            );
          break;
        }
        if (toolCount >= settings.maxToolCallsPerTurn) {
          const m = message(
            "assistant",
            "Das Tool-Limit wurde erreicht. Die ausgeführten Schritte sind gespeichert. Du kannst die Arbeit mit einer weiteren Nachricht fortsetzen.",
            { turnId },
          );
          await mutateSession(sessionId, (s) => s.messages.push(m));
          emit("message", m);
          break;
        }
      }
      session = await loadSession(sessionId);
      try {
        usage = (
          await manager.prepare(session, definitions, {
            diagnostics: true,
            profile,
          })
        ).contextUsage;
      } catch (error) {
        if (controller.signal.aborted) throw error;
        usage = estimatedUsage(session, settings, error.message);
        emit("context-usage", usage);
      }
    }
    session = await mutateSession(sessionId, (s) => {
      s.turns[turnId].status = "done";
      s.turns[turnId].completedAt = new Date().toISOString();
      s.contextUsage = usage;
      s.turns[turnId].contextUsage = usage;
    });
    return {
      session,
      turn: session.turns[turnId],
      contextUsage: usage,
      tokenCount: usage.promptTokens,
    };
  } catch (error) {
    if (!started) throw error;
    const aborted = controller.signal.aborted;
    await flushReports();
    await completeMissing();
    const session = await mutateSession(sessionId, (s) => {
      const turn = s.turns[turnId];
      turn.status = aborted ? "aborted" : "error";
      turn.error = aborted ? "Antwort abgebrochen." : error.message;
      turn.code = error.code || "MODEL_ERROR";
      if (fullText && !assistantSaved)
        s.messages.push(
          message("assistant", fullText, {
            turnId,
            incomplete: true,
            thinking,
          }),
        );
      if (error.code === "RESPONSE_LIMIT") {
        const last = s.messages.findLast(
          (m) => m.role === "assistant" && m.turnId === turnId,
        );
        if (last) last.incomplete = true;
      }
      usage = manager?.usage
        ? {
            ...manager.usage,
            stale: true,
            error: aborted ? "Antwort abgebrochen." : error.message,
          }
        : estimatedUsage(s, settings, error.message);
      s.contextUsage = usage;
      turn.contextUsage = usage;
    });
    return {
      session,
      turn: session.turns[turnId],
      contextUsage: usage,
      tokenCount: usage.promptTokens,
    };
  } finally {
    signal?.removeEventListener("abort", abort);
    if (active.get(sessionId) === controller) active.delete(sessionId);
  }
}

function eventOf(m) {
  if (m.event) return m.event;
  if (m.role === "tool") {
    try {
      return JSON.parse(m.content);
    } catch {}
  }
  return null;
}
function rebuild(s) {
  s.contextUsage = null;
  s.currentTask = null;
  s.learningPlan = null;
  for (const m of s.messages) {
    const e = eventOf(m);
    if (e?.type === "create_task") s.currentTask = e.task;
    if (e?.type === "mark_task_done" && s.currentTask)
      s.currentTask.done = true;
    if (e?.type === "update_learning_plan")
      s.learningPlan = { goal: e.goal, topics: e.topics };
  }
}
export async function editUserMessage({ sessionId, messageId, newContent }) {
  if (isActive(sessionId))
    throw new AppError("Bitte die laufende Antwort zuerst stoppen.", 409);
  if (
    typeof newContent !== "string" ||
    !newContent.trim() ||
    newContent.length > 50000
  )
    throw new AppError("Ungültige Nachricht.");
  return mutateSession(sessionId, (s) => {
    const index = s.messages.findIndex(
      (m) => m.id === messageId && m.role === "user",
    );
    if (index < 0) throw new AppError("Nachricht nicht gefunden.", 404);
    s.messages = [
      ...s.messages.slice(0, index + 1),
      ...s.messages
        .slice(index + 1)
        .filter((m) => m.role === "event" && !m.turnId),
    ];
    const m = s.messages[index];
    m.content = newContent.trim();
    m.edited = true;
    delete m.turnId;
    if (m.questionId) {
      for (const q of s.messages) {
        const e = eventOf(q);
        if (e?.questionId === m.questionId) {
          e.answer = m.content;
          if (q.event) q.event = e;
          else q.content = JSON.stringify(e);
        }
      }
    }
    s.turns = {};
    rebuild(s);
  });
}
export async function deleteLastUserMessage({ sessionId }) {
  if (isActive(sessionId))
    throw new AppError("Bitte die laufende Antwort zuerst stoppen.", 409);
  let deletedMessages = [];
  const session = await mutateSession(sessionId, (s) => {
    let index = s.messages.findLastIndex((m) => m.role === "user");
    if (index < 0) throw new AppError("Keine Nutzer-Nachricht vorhanden.");
    deletedMessages = s.messages.slice(index);
    s.messages = [
      ...s.messages.slice(0, index),
      ...deletedMessages.filter((m) => m.role === "event" && !m.turnId),
    ];
    s.turns = {};
    for (const m of s.messages) {
      const e = eventOf(m);
      if (
        e?.answerMessageId &&
        deletedMessages.some((d) => d.id === e.answerMessageId)
      ) {
        delete e.answer;
        delete e.answerMessageId;
        if (m.event) m.event = e;
        else m.content = JSON.stringify(e);
      }
    }
    rebuild(s);
  });
  return {
    session,
    changes: deletedMessages
      .map(eventOf)
      .filter((e) => e?.changeId && !e.undone)
      .map((e) => ({ changeId: e.changeId, path: e.path }))
      .reverse(),
  };
}
