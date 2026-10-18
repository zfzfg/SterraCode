import { randomUUID } from "node:crypto";
import { AppError, getSettings, validateSessionId } from "./storage.js";
import { loadSession, mutateSession, message } from "./sessions.js";
import { callLMStudio, completionStream } from "./lmStudio.js";
import { TOOL_DEFINITIONS } from "./tools.js";
import { executeTool } from "./toolExecutor.js";
import {
  estimateTokens,
  shouldSummarize,
  summarizeSession,
  contextHistory,
} from "./summarizer.js";
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
  if (active.has(sessionId))
    throw new AppError(
      "Für diese Session läuft bereits eine Antwort.",
      409,
      "TURN_BUSY",
    );
  const controller = new AbortController();
  active.set(sessionId, controller);
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  let started = false,
    fullText = "",
    thinking = "",
    toolCount = 0;
  const emit = (event, data) => {
    onEvent(event, data);
  };
  try {
    let session = await loadSession(sessionId);
    if (session.turns?.[turnId]) {
      const turn = session.turns[turnId];
      return {
        session,
        turn,
        tokenCount: estimateTokens(contextHistory(session)),
        replayed: true,
      };
    }
    const settings = await getSettings();
    if (!settings.activeModel)
      throw new AppError(
        "Bitte in LM Studio ein Modell laden und auswählen.",
        400,
        "NO_MODEL",
      );
    session = await mutateSession(sessionId, (s) => {
      if (retryOf) {
        const previous = s.turns[retryOf];
        if (
          !previous ||
          !["error", "aborted", "running"].includes(previous.status)
        )
          throw new AppError("Diese Antwort kann nicht fortgesetzt werden.");
        // No controller existed before this request: a persisted running turn was interrupted by a server restart.
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
      } else {
        if (!userMessage.trim())
          throw new AppError("Eine Nachricht ist erforderlich.");
        s.messages.push(message("user", userMessage.trim(), { turnId }));
      }
      s.turns[turnId] = {
        id: turnId,
        status: "running",
        startedAt: new Date().toISOString(),
        retryOf: retryOf || null,
      };
    });
    started = true;
    if (shouldSummarize(contextHistory(session), settings.tokenThreshold)) {
      try {
        const summary = await summarizeSession(
          session,
          settings,
          controller.signal,
        );
        if (summary?.text)
          session = await mutateSession(sessionId, (s) => {
            s.summaries.push(summary);
          });
      } catch (error) {
        if (controller.signal.aborted) throw error;
        emit("notice", {
          message:
            "Kontextzusammenfassung fehlgeschlagen. Der vollständige Verlauf bleibt erhalten.",
        });
      }
    }
    let prompt = `${settings.systemPrompt}\nAktuelle Sprache: ${session.language}. Aktive Datei: ${session.activeFile || "keine"}.\nLernplan: ${JSON.stringify(session.learningPlan)}\nAufgabe: ${JSON.stringify(session.currentTask)}`;
    if (settings.crossChatProfileEnabled)
      prompt += profileToPromptText(await getProfile(), session.language);
    const messages = [
      { role: "system", content: prompt },
      ...contextHistory(session),
    ];
    if (retryOf)
      messages.push({
        role: "system",
        content:
          "Setze die abgebrochene Antwort fort. Bereits gespeicherte Tool-Ergebnisse sind wirksam. Wiederhole diese Dateiänderungen und Befehle nicht.",
      });
    const callResults = new Map();
    const context = {
      sessionId,
      turnId,
      language: session.language,
      learningPlan: session.learningPlan,
      signal: controller.signal,
      onProcess: (job) => emit("process", job),
    };
    while (true) {
      controller.signal.throwIfAborted();
      fullText = "";
      thinking = "";
      const response = stream
        ? await completionStream({
            messages,
            tools: TOOL_DEFINITIONS,
            model: settings.activeModel,
            ...settings,
            signal: controller.signal,
            onToken: (token) => {
              fullText += token;
              emit("token", { token, turnId });
            },
            onReasoning: (token) => {
              thinking += token;
              emit("reasoning", { token, turnId });
            },
          })
        : await callLMStudio({
            messages,
            tools: TOOL_DEFINITIONS,
            model: settings.activeModel,
            ...settings,
            signal: controller.signal,
          }).then((r) => r.choices?.[0]?.message);
      if (!response)
        throw new AppError("Das Modell hat keine Antwort geliefert.", 502);
      if (!stream && response.content) {
        fullText += response.content;
        emit("token", { token: response.content, turnId });
      }
      if (response.tool_calls && !Array.isArray(response.tool_calls))
        throw new AppError("Ungültige Werkzeugantwort des Modells.", 502);
      const calls = response.tool_calls || [];
      if (
        calls.some(
          (c) =>
            typeof c.id !== "string" ||
            !c.id ||
            typeof c.function?.name !== "string" ||
            typeof c.function?.arguments !== "string",
        )
      )
        throw new AppError("Unvollständiger Werkzeugaufruf des Modells.", 502);
      if (!calls.length) {
        const assistant = message("assistant", response.content || "", {
          turnId,
          thinking,
        });
        session = await mutateSession(sessionId, (s) => {
          s.messages.push(assistant);
          s.turns[turnId].status = "done";
          s.turns[turnId].completedAt = new Date().toISOString();
        });
        emit("message", assistant);
        break;
      }
      const assistant = message("assistant", response.content || "", {
        turnId,
        tool_calls: calls,
      });
      await mutateSession(sessionId, (s) => {
        s.messages.push(assistant);
      });
      messages.push({
        role: "assistant",
        content: response.content || "",
        tool_calls: calls,
      });
      let compacted = false;
      for (const call of calls) {
        let result;
        if (callResults.has(call.id)) result = callResults.get(call.id);
        else if (toolCount++ >= settings.maxToolCallsPerTurn)
          result = {
            type: "tool_error",
            tool: call.function.name,
            error: "Tool-Limit erreicht.",
          };
        else if (controller.signal.aborted)
          result = {
            type: "tool_error",
            tool: call.function.name,
            error: "Abgebrochen.",
          };
        else {
          emit("tool", { tool: call.function.name, turnId });
          try {
            result = await executeTool(
              call.function.name,
              JSON.parse(call.function.arguments || "{}"),
              context,
            );
          } catch (error) {
            result = {
              type: "tool_error",
              tool: call.function.name,
              error: `Ungültiger Tool-Aufruf: ${error.message}`,
            };
          }
        }
        callResults.set(call.id, result);
        compacted ||=
          result.type === "trigger_summarize" && result.status === "completed";
        const m = message("tool", JSON.stringify(result), {
          tool_call_id: call.id,
          turnId,
        });
        await mutateSession(sessionId, (s) => {
          s.messages.push(m);
        });
        messages.push({
          role: "tool",
          tool_call_id: call.id,
          content: m.content,
        });
        emit("message", m);
      }
      if (compacted)
        messages.splice(
          1,
          messages.length - 1,
          ...contextHistory(await loadSession(sessionId)),
        );
      if (toolCount >= settings.maxToolCallsPerTurn) {
        const m = message(
          "assistant",
          "Das Tool-Limit wurde erreicht. Die ausgeführten Schritte sind gespeichert. Du kannst die Arbeit mit einer weiteren Nachricht fortsetzen.",
          { turnId },
        );
        session = await mutateSession(sessionId, (s) => {
          s.messages.push(m);
          s.turns[turnId].status = "done";
        });
        emit("message", m);
        break;
      }
    }
    return {
      session,
      turn: session.turns[turnId],
      tokenCount: estimateTokens(contextHistory(session)),
    };
  } catch (error) {
    const aborted = controller.signal.aborted;
    if (started) {
      const session = await mutateSession(sessionId, (s) => {
        s.turns[turnId].status = aborted ? "aborted" : "error";
        s.turns[turnId].error = aborted
          ? "Antwort abgebrochen."
          : error.message;
        if (fullText)
          s.messages.push(
            message("assistant", fullText, {
              turnId,
              incomplete: true,
              thinking,
            }),
          );
      });
      return {
        session,
        turn: session.turns[turnId],
        tokenCount: estimateTokens(contextHistory(session)),
      };
    }
    throw error;
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
  s.summaries = [];
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
      ...s.messages.slice(index + 1).filter((m) => m.role === "event"),
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
      ...deletedMessages.filter((m) => m.role === "event"),
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
