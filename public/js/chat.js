import {
  t,
  getLocale,
  getFormatLocale,
  formatPercent,
  translateMessage,
} from "./i18n.js";
import { inspectDiff, showDiffHistory } from "./diffInspector.js";
import { renderTaskTests } from "./taskTests.js";
import { renderLearningSupport } from "./learningSupport.js";
import { taskSection } from "./taskSections.js";
import { api, streamChat, workspaceURL, sessionURL } from "./api.js";
import { state, emit, on } from "./state.js";
import { $, node, markdown, toast, formDialog } from "./ui.js";
import { button, createIcon } from "./icons.js";
import { flush, refreshEditor } from "./editor.js";
import { loadFiles, renderPlan, renderTabs } from "./workspace.js";
import { loadSessions } from "./sessions.js";
import { attachProcess } from "./terminal.js";
import { randomUUID } from "./uuid.js";

let controller;
let continuingTask = false;
const chatDrafts = new Map();
const questionDrafts = new Map();
const tutorText = (key, params = {}) =>
  t(key, { ...params, lng: state.session?.tutorLocale || getLocale() });
export const chatWorkActive = () => state.busy || continuingTask;
export function captureChatDrafts() {
  if (state.session) chatDrafts.set(state.session.id, $("chat-input").value);
  return { messages: [...chatDrafts], questions: [...questionDrafts] };
}
export function restoreChatDrafts(saved) {
  for (const [name, map] of [
    ["messages", chatDrafts],
    ["questions", questionDrafts],
  ])
    if (Array.isArray(saved?.[name]))
      for (const entry of saved[name].slice(-100))
        if (
          Array.isArray(entry) &&
          typeof entry[0] === "string" &&
          typeof entry[1] === "string" &&
          entry[1].length <= 100000
        )
          map.set(entry[0], entry[1]);
}
function applicationQuestion(event) {
  const template =
    event.application?.version === 1
      ? event.application.template
      : event.onboarding === true
        ? "onboarding"
        : null;
  if (!["onboarding", "plan-completed"].includes(template)) return null;
  const ids =
    template === "onboarding"
      ? ["create_plan", "start_directly"]
      : ["continue_plan", "finish_today"];
  return {
    question: t(`learningContent:questions.${template}.question`),
    options: ids.map((id, index) => ({
      id: event.application?.version === 1 ? id : undefined,
      original: event.options?.[index],
      label: t(`learningContent:questions.${template}.options.${id}`),
    })),
  };
}
function consumptionText(usage) {
  const u = usage?.consumption;
  if (!u) return "";
  const number = (n) =>
    Number.isFinite(n)
      ? n.toLocaleString(getFormatLocale())
      : t("features:shared.unknown");
  const cache = Number.isFinite(u.cacheReadRatio)
    ? t("features:chat.cacheUsage", {
        p1: formatPercent(u.cacheReadRatio, {
          maximumFractionDigits: 1,
        }),
        p2:
          u.cacheMeasuredCalls < u.calls
            ? t("features:chat.partialMeasure")
            : "",
      })
    : "";
  return t("features:chat.turnUsage", {
    p1: number(u.inputTokens),
    p2: number(u.outputTokens),
    p3: cache,
  });
}
function usageText(usage) {
  if (!usage) return t("features:chat.contextReady");
  const number = (n) =>
    Number.isFinite(n)
      ? n.toLocaleString(getFormatLocale())
      : t("features:shared.unknown");
  if (usage.provider === "openai")
    return t("features:chat.openAIContext", {
      p1: number(usage.promptTokens),
      p2:
        usage.measurementQuality === "estimated"
          ? t("features:chat.estimated")
          : "",
      p3: consumptionText(usage),
    });
  const prefix = usage.stale
    ? t("features:chat.lastMeasurement")
    : usage.measurementQuality === "exact"
      ? t("features:chat.context")
      : t("features:chat.contextEstimated");
  return t("features:chat.contextUsageText", {
    p1: prefix,
    p2: number(usage.promptTokens),
    p3: usage.contextLength ? ` / ${number(usage.contextLength)}` : "",
    p4: usage.contextLength
      ? t("features:chat.contextFree", {
          p1: formatPercent(usage.promptTokens / usage.contextLength, {
            maximumFractionDigits: 0,
          }),
          p2: number(usage.remainingTokens),
        })
      : "",
    p5: consumptionText(usage),
  });
}
function renderUsage(usage) {
  if (
    (usage?.provider &&
      usage.provider !== (state.settings.provider || "lmstudio")) ||
    (usage?.model &&
      usage.model !==
        (state.settings.provider === "openai"
          ? state.settings.openAIModel
          : state.settings.activeModel))
  )
    usage = null;
  const counter = $("token-counter");
  counter.textContent = usageText(usage);
  counter.title =
    state.settings.provider === "openai"
      ? t("features:chat.openAIUsageHelp")
      : usage
        ? t("features:chat.contextDetails", {
            p1: usage.reservedOutputTokens.toLocaleString(getFormatLocale()),
            p2: usage.coveredMessages,
            p3: usage.chunkCount,
            p4: new Date(usage.sampledAt).toLocaleString(getFormatLocale()),
          })
        : t("features:chat.usageHelp");
  counter.title += consumptionText(usage);
}
const typeInfo = () => ({
  trigger_summarize: ["plan", t("features:chat.contextSummary")],
  context_compaction: ["plan", t("features:chat.contextCompacted")],
  context_usage: ["plan", t("features:chat.contextUsage")],
  get_context_usage: ["plan", t("features:chat.contextUsageRead")],
  read_tool_result: ["file", t("features:chat.toolResultRead")],
  write_file: ["file", t("features:chat.fileChanged")],
  read_file: ["file", t("features:chat.fileRead")],
  list_files: ["folder", t("features:chat.filesRead")],
  create_task: ["plan", t("features:chat.newTask")],
  mark_task_done: ["check", t("features:shared.taskDone")],
  add_explanation: ["bulb", t("features:chat.explanation")],
  ask_question: ["question", t("features:chat.question")],
  update_learning_plan: ["plan", t("features:chat.planUpdated")],
  run_terminal_command: ["terminal", t("features:chat.aiTerminal")],
  read_terminal_output: ["terminal", t("features:chat.terminalOutput")],
  tool_error: ["warning", t("features:chat.toolError")],
  write_editor: ["file", t("features:chat.legacyEditorChange")],
  insert_at_line: ["file", t("features:chat.legacyEditorChange")],
});
function eventOf(message, names) {
  if (message.event) return message.event;
  if (message.role === "tool") {
    try {
      const e = JSON.parse(message.content);
      if (!e.type) e.type = names?.get(message.tool_call_id) || "unknown";
      return e;
    } catch {
      return null;
    }
  }
  return null;
}
function isBottom() {
  const c = $("chat-messages");
  return c.scrollHeight - c.scrollTop - c.clientHeight < 100;
}
function scroll(bottom) {
  if (bottom) $("chat-messages").scrollTop = $("chat-messages").scrollHeight;
}
async function undo(event, sessionId) {
  await flush();
  await api(`${workspaceURL(sessionId)}/changes/${event.changeId}/undo`, {
    method: "POST",
    body: {},
  });
  if (state.session?.id === sessionId) {
    state.session = await api(sessionURL(sessionId));
    await refreshEditor();
    await loadFiles();
    renderChat();
  }
  toast(t("features:chat.undoSuccess", { p1: event.path }));
}
function eventCard(event, sessionId) {
  const info = typeInfo()[event.type];
  if (!info) return null;
  const card = node(
      "article",
      `event-card${event.type === "tool_error" ? " error" : ""}`,
    ),
    heading = node("div", "event-heading");
  heading.append(
    createIcon(info[0]),
    node(
      "span",
      "",
      event.status === "proposed"
        ? t("features:chat.changeProposed")
        : event.title || info[1],
    ),
  );
  card.append(heading);
  if (event.path) card.append(node("p", "", event.path));
  if (event.reason) card.append(node("p", "muted", event.reason));
  if (event.type === "trigger_summarize")
    card.append(
      node(
        "p",
        "",
        event.status === "completed"
          ? t("features:chat.summaryDone")
          : event.status === "scheduled"
            ? t("features:chat.summaryScheduled")
            : t("features:chat.summaryTooShort"),
      ),
    );
  if (
    ["context_compaction", "context_usage", "get_context_usage"].includes(
      event.type,
    )
  ) {
    const usage = event.contextUsage || event;
    if (event.type === "context_compaction")
      card.append(
        node(
          "p",
          "",
          event.provider === "openai"
            ? t("features:chat.openAICompacted")
            : event.changed
              ? t("features:chat.compactionResult", {
                  p1: event.beforeTokens.toLocaleString(getFormatLocale()),
                  p2: event.afterTokens.toLocaleString(getFormatLocale()),
                })
              : t("features:chat.nothingToCompress"),
        ),
      );
    card.append(node("p", "", usageText(usage)));
    if (usage.error || usage.errorKey)
      card.append(
        node(
          "p",
          "muted",
          translateMessage(
            { messageKey: usage.errorKey, params: usage.errorParams },
            usage.error,
          ),
        ),
      );
    if (usage.effectiveSettings) {
      const details = node("details");
      details.append(
        node("summary", "", t("features:chat.budgets")),
        node(
          "p",
          "",
          t("features:chat.budgetDetails", {
            p1: usage.reservedOutputTokens.toLocaleString(getFormatLocale()),
            p2: usage.effectiveSettings.keepRecentTokens.toLocaleString(
              getFormatLocale(),
            ),
            p3: usage.effectiveSettings.summaryBudgetTokens.toLocaleString(
              getFormatLocale(),
            ),
          }),
        ),
      );
      card.append(details);
    }
  }
  if (event.type === "tool_error")
    card.append(node("p", "", translateMessage(event, event.error)));
  if (event.type === "create_task")
    card.append(node("p", "", event.task?.title || ""));
  if (event.type === "add_explanation") card.append(markdown(event.content));
  if (event.type === "update_learning_plan")
    card.append(node("p", "", event.goal));
  if (event.type === "mark_task_done" && event.feedback)
    card.append(node("p", "", event.feedback));
  if (event.type === "write_file" && (event.changeId || event.proposalId)) {
    card.append(
      button(t("features:shared.inspectChange"), "file", () =>
        inspectDiff(
          sessionId,
          event.proposalId || event.changeId,
          Boolean(event.proposalId),
        ),
      ),
    );
  }
  if (event.type === "write_file" && event.changeId) {
    const b = button(
      event.undone ? t("features:shared.undone") : t("features:shared.undo"),
      "undo",
      () => undo(event, sessionId),
    );
    b.disabled = Boolean(event.undone) || state.busy;
    card.append(b);
  }
  if (
    event.type === "run_terminal_command" ||
    event.type === "read_terminal_output"
  ) {
    card.append(node("p", "", event.command || ""));
    const details = node("details"),
      summary = node(
        "summary",
        "",
        t("features:chat.outputLabel", {
          p1:
            event.exited || event.exitCode !== undefined
              ? t("features:chat.exit", { code: event.exitCode })
              : t("features:chat.processStarted"),
        }),
      );
    details.append(
      summary,
      node(
        "pre",
        "",
        event.output ?? `${event.stdout || ""}${event.stderr || ""}`,
      ),
    );
    card.append(details);
  }
  if (event.type === "ask_question") {
    const application = applicationQuestion(event);
    const question = application?.question || event.question;
    card.append(node("p", "", question));
    if (event.answer)
      card.append(
        node(
          "p",
          "answered",
          t("features:chat.yourAnswer", { p1: event.answer }),
        ),
      );
    else if (!event.questionId)
      card.append(node("p", "muted", t("features:chat.earlierQuestion")));
    else {
      const options = node("div", "question-options");
      for (const option of application?.options ||
        (event.options || []).map((label) => ({ label, original: label }))) {
        const b = button(option.label, null, () =>
          answer(event.questionId, option.original, sessionId, option.id),
        );
        b.disabled = state.busy;
        options.append(b);
      }
      card.append(options);
      const form = node("form", "question-form"),
        input = node("input"),
        send = button(t("features:chat.answer"), null);
      input.placeholder = t("features:chat.customAnswer");
      input.setAttribute(
        "aria-label",
        t("features:chat.answerLabel", { p1: question }),
      );
      const draftKey = `${sessionId}:${event.questionId}`;
      input.value = questionDrafts.get(draftKey) || "";
      input.oninput = () => questionDrafts.set(draftKey, input.value);
      input.required = true;
      send.type = "submit";
      send.disabled = state.busy;
      form.append(input, send);
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        if (input.value.trim())
          answer(event.questionId, input.value.trim(), sessionId).catch(
            (error) => toast(error.message, "error"),
          );
      });
      card.append(form);
    }
  }
  return card;
}
export function renderChat(forceBottom = false) {
  renderUsage(state.session?.contextUsage);
  const c = $("chat-messages"),
    bottom = forceBottom || isBottom(),
    position = c.scrollTop;
  c.replaceChildren();
  const session = state.session;
  if (!session) {
    renderTask();
    updateChatState();
    return;
  }
  const names = new Map();
  for (const m of session.messages)
    for (const call of m.tool_calls || [])
      names.set(call.id, call.function.name);
  const lastUser = session.messages.findLast((m) => m.role === "user");
  for (const m of session.messages) {
    const event = eventOf(m, names);
    if (event) {
      const card = eventCard(event, session.id);
      if (card) {
        card.dataset.messageId = m.id;
        c.append(card);
      }
      continue;
    }
    if (!["user", "assistant"].includes(m.role) || !m.content) continue;
    const bubble = node("article", `message ${m.role}`);
    bubble.dataset.messageId = m.id;
    if (m.role === "assistant") {
      bubble.append(node("div", "message-heading", "SterraCode"));
      if (m.thinking) {
        const thinking = node("details", "thinking");
        thinking.append(
          node("summary", "", t("features:chat.thinking")),
          markdown(m.thinking),
        );
        bubble.append(thinking);
      }
      bubble.append(markdown(m.content));
    } else bubble.append(node("div", "", m.content));
    if (m.edited)
      bubble.append(node("small", "muted", t("features:chat.edited")));
    if (m.incomplete)
      bubble.append(node("small", "muted", t("features:chat.incomplete")));
    const actions = node("div", "message-actions");
    if (m.role === "user") {
      const edit = button(
        t("features:chat.editMessage"),
        "edit",
        () => editMessage(m),
        "icon-only",
      );
      edit.disabled = state.busy;
      actions.append(edit);
      if (m.id === lastUser?.id) {
        const remove = button(
          t("features:chat.deleteLast"),
          "trash",
          deleteLast,
          "icon-only",
        );
        remove.disabled = state.busy;
        actions.append(remove);
      }
    } else if (!m.tool_calls) {
      for (const value of [1, -1]) {
        const b = button(
          value === 1
            ? t("features:chat.helpful")
            : t("features:chat.unhelpful"),
          value === 1 ? "thumb-up" : "thumb-down",
          async () => {
            await api("/api/chat/feedback", {
              method: "POST",
              body: { sessionId: session.id, messageId: m.id, value },
            });
            m.feedback = value;
            renderChat();
          },
          "icon-only",
        );
        b.setAttribute("aria-pressed", String(m.feedback === value));
        actions.append(b);
      }
    }
    bubble.append(actions);
    c.append(bubble);
  }
  const lastTurn = Object.values(session.turns || {}).at(-1);
  if (
    lastTurn &&
    ["error", "aborted", "running"].includes(lastTurn.status) &&
    !state.busy
  ) {
    const notice = node("div", "event-card error");
    notice.append(
      node(
        "p",
        "",
        translateMessage(
          { messageKey: lastTurn.errorKey, params: lastTurn.errorParams },
          lastTurn.error || t("features:chat.turnInterrupted"),
        ),
      ),
    );
    const retry = button(
      lastTurn.contextAction
        ? t("features:chat.retryContext")
        : t("features:chat.continueResponse"),
      "refresh",
      () =>
        sendMessage(
          "",
          lastTurn.contextAction
            ? { contextAction: lastTurn.contextAction }
            : { retryOf: lastTurn.id },
        ),
    );
    retry.disabled = !state.ready && lastTurn.contextAction !== "usage";
    notice.append(retry);
    c.append(notice);
  }
  if (!session.messages.length)
    c.append(node("p", "muted", t("features:chat.welcome")));
  if (bottom) scroll(true);
  else c.scrollTop = position;
  renderTask();
  updateChatState();
}
function renderTask() {
  const panel = $("task-panel"),
    task = state.session?.currentTask;
  panel.hidden = !task;
  if (!task) return;
  const container = taskSection(task, "task-details", task.title);
  container.append(node("p", "", task.description));
  panel.replaceChildren(container);
  if (state.session.project?.checklist?.length) {
    const checklist = node("details");
    checklist.append(node("summary", "", t("features:chat.checklist")));
    const list = node("ul");
    for (const item of state.session.project.checklist)
      list.append(node("li", "", item));
    checklist.append(list);
    container.append(checklist);
  }
  renderLearningSupport(container, task, renderTask);
  if (task.testSuite) {
    renderTaskTests(container, task, renderChat);
  } else {
    const done = button(
      task.done ? t("features:shared.taskDone") : t("features:chat.reviewTask"),
      "check",
      () => sendMessage(tutorText("features:chat.reviewTaskPrompt")),
    );
    done.disabled = task.done || state.busy || !state.ready;
    container.append(done);
  }
  const actions = node("div", "task-continuation");
  for (const [kind, label] of [
    ["next", t("features:chat.nextTask")],
    ["same", t("features:chat.sameTopic")],
  ]) {
    const next = button(label, null, () => continueTask(task, kind));
    next.disabled = continuingTask || state.busy || !state.ready;
    actions.append(next);
  }
  panel.append(actions);
}
async function continueTask(task, kind) {
  if (continuingTask || state.busy || !state.ready) return;
  const sessionId = state.session.id;
  const version = task.taskVersion || 1;
  const assistance =
    document.querySelector(".task-assistance")?.value || "not_recorded";
  const current = () =>
    state.session?.id === sessionId &&
    state.session.currentTask?.id === task.id &&
    (state.session.currentTask.taskVersion || 1) === version;
  continuingTask = true;
  renderTask();
  updateChatState();
  try {
    await flush();
    if (!current()) return;
    if (!state.session.currentTask.done) {
      const base = `${workspaceURL(sessionId)}/tasks/${encodeURIComponent(task.id)}`;
      let testRunId;
      if (task.testSuite) {
        const runs = await api(`${base}/test-runs`);
        if (!current()) return;
        if (runs.length) {
          const run = await api(
            `${workspaceURL(sessionId)}/test-runs/${encodeURIComponent(runs[0].testRunId)}`,
          );
          if (!current()) return;
          if (
            run.current &&
            run.status === "finished" &&
            run.assessment === "passed"
          )
            testRunId = run.testRunId;
        }
        if (!testRunId) throw new Error(t("features:chat.testsRequired"));
      }
      const result = await api(`${base}/complete`, {
        method: "POST",
        body: {
          taskVersion: version,
          assistance,
          ...(testRunId ? { testRunId } : {}),
        },
      });
      if (!current()) return;
      state.session = result;
      renderChat();
    }
    if (!current()) return;
    await sendMessage(
      tutorText("features:chat.completedPrompt", {
        p1: task.title,
        p2:
          kind === "same"
            ? tutorText("features:chat.sameTopicPrompt")
            : tutorText("features:chat.nextTaskPrompt"),
      }),
      { taskContinuation: true },
    );
  } catch (error) {
    toast(error.message, "error");
  } finally {
    continuingTask = false;
    renderTask();
    updateChatState();
  }
}
export function updateChatState() {
  for (const button of document.querySelectorAll(".task-continuation button"))
    button.disabled = continuingTask || state.busy || !state.ready;
  const usage = /^\/usage$/i.test($("chat-input").value.trim());
  $("send-btn").disabled =
    !state.session || (!state.ready && !usage) || state.busy || continuingTask;
  $("stop-chat-btn").hidden = !state.busy;
  $("app").classList.toggle("chat-busy", state.busy);
  $("chat-state").textContent = state.busy
    ? t("features:chat.responding")
    : !state.ready
      ? t("features:chat.offline")
      : t("features:chat.keyboardHelp");
}
async function answer(questionId, text, sessionId, optionId) {
  if (state.busy) return;
  await flush();
  const result = await api("/api/chat/answer", {
    method: "POST",
    body: {
      sessionId,
      questionId,
      answer: text,
      ...(optionId ? { optionId } : {}),
    },
  });
  questionDrafts.delete(`${sessionId}:${questionId}`);
  if (state.session?.id !== sessionId) return;
  state.session = result.session;
  renderChat();
  if (state.ready)
    await sendMessage("", { existingUserMessageId: result.messageId });
  else toast(t("features:chat.answerSaved"));
}
export async function sendMessage(
  text,
  {
    existingUserMessageId,
    retryOf,
    contextAction,
    taskContinuation = false,
  } = {},
) {
  if (state.busy || (continuingTask && !taskContinuation)) return;
  if (!state.session) throw new Error(t("features:shared.selectSession"));
  contextAction ||=
    !existingUserMessageId && !retryOf
      ? /^\/(compress|compact)$/i.test(text.trim())
        ? "compact"
        : /^\/usage$/i.test(text.trim())
          ? "usage"
          : undefined
      : undefined;
  if (!state.ready && contextAction !== "usage")
    throw new Error(t("features:chat.connectRequired"));
  await flush();
  const sessionId = state.session.id,
    turnId = randomUUID();
  controller = new AbortController();
  state.busy = true;
  state.turnId = turnId;
  updateChatState();
  const c = $("chat-messages");
  if (text && !contextAction) {
    c.append(node("article", "message user", text));
    $("chat-input").value = "";
    chatDrafts.delete(sessionId);
  }
  if (contextAction) {
    $("chat-input").value = "";
    chatDrafts.delete(sessionId);
  }
  let content = "",
    thinking = "",
    frame = false;
  const bubble = node("article", "message assistant streaming");
  bubble.hidden = Boolean(contextAction);
  c.append(bubble);
  scroll(true);
  function update() {
    frame = false;
    if (state.session?.id !== sessionId) return;
    const bottom = isBottom();
    bubble.replaceChildren();
    if (thinking) {
      const details = node("details", "thinking");
      details.append(
        node("summary", "", t("features:chat.thinking")),
        markdown(thinking),
      );
      bubble.append(details);
    }
    bubble.append(markdown(content));
    scroll(bottom);
  }
  const onEvent = (event, value) => {
    if (state.session?.id !== sessionId) return;
    if (event === "token") {
      content += value.token;
      if (!frame) {
        frame = true;
        requestAnimationFrame(update);
      }
    }
    if (event === "reasoning") {
      thinking += value.token;
      if (!frame) {
        frame = true;
        requestAnimationFrame(update);
      }
    }
    if (event === "tool") {
      $("chat-state").textContent =
        `${typeInfo()[value.tool]?.[1] || t("features:chat.toolRunning")} …`;
    }
    if (event === "process") attachProcess(value);
    if (event === "message" && value.role === "tool") {
      const bottom = isBottom();
      const card = eventCard(eventOf(value), sessionId);
      if (card) c.insertBefore(card, bubble);
      scroll(bottom);
      content = "";
      thinking = "";
    }
    if (event === "notice") toast(translateMessage(value, value.message));
    if (event === "context-progress")
      $("chat-state").textContent = translateMessage(value, value.message);
    if (event === "context-usage") renderUsage(value);
    if (event === "message" && value.role === "event") {
      const card = eventCard(value.event, sessionId);
      if (card) c.insertBefore(card, bubble);
    }
  };
  try {
    const body = {
      sessionId,
      userMessage: text,
      turnId,
      existingUserMessageId,
      retryOf,
      contextAction,
    };
    const result =
      state.settings.streaming !== false
        ? await streamChat(body, onEvent, controller.signal)
        : await api("/api/chat", {
            method: "POST",
            body,
            signal: controller.signal,
          });
    if (state.session?.id === sessionId) {
      state.session = result.session;
      renderUsage(result.contextUsage);
      if (result.turn.status === "error")
        toast(
          translateMessage(
            {
              messageKey: result.turn.errorKey,
              params: result.turn.errorParams,
            },
            result.turn.error,
          ),
          "error",
        );
    }
  } catch (error) {
    toast(
      error.name === "AbortError" ? t("features:chat.aborted") : error.message,
      "error",
    );
    if (state.session?.id === sessionId) {
      try {
        state.session = await api(sessionURL(sessionId));
      } catch {}
    }
  } finally {
    state.busy = false;
    state.turnId = null;
    controller = null;
    if (state.session?.id === sessionId) {
      renderChat();
      renderPlan();
      renderTabs();
      await refreshEditor().catch((e) => toast(e.message, "error"));
      await loadFiles().catch((e) => toast(e.message, "error"));
    }
    updateChatState();
    await loadSessions().catch((e) => toast(e.message, "error"));
  }
}
export const showChanges = showDiffHistory;
window.addEventListener("diff-decided", () => renderChat());
async function editMessage(message) {
  await flush();
  const result = await formDialog({
    title: t("features:chat.editMessage"),
    description: t("features:chat.editDescription"),
    fields: [
      {
        name: "newContent",
        label: t("features:chat.message"),
        type: "textarea",
        value: message.content,
        required: true,
      },
    ],
    submit: t("features:chat.saveEdit"),
  });
  if (!result) return;
  state.session = await api("/api/chat/edit", {
    method: "POST",
    body: {
      sessionId: state.session.id,
      messageId: message.id,
      newContent: result.newContent,
    },
  });
  renderChat();
  if (state.ready) await sendMessage("", { existingUserMessageId: message.id });
}
async function deleteLast() {
  await flush();
  const result = await formDialog({
    title: t("features:chat.deleteQuestion"),
    description: t("features:chat.deleteDescription"),
    fields: [
      {
        name: "undo",
        label: t("features:chat.undoFiles"),
        type: "checkbox",
        value: false,
      },
    ],
    submit: t("features:shared.delete"),
    danger: true,
  });
  if (!result) return;
  const id = state.session.id,
    data = await api("/api/chat/last", {
      method: "DELETE",
      body: { sessionId: id },
    });
  state.session = data.session;
  if (result.undo)
    for (const change of data.changes) {
      try {
        await api(`${workspaceURL(id)}/changes/${change.changeId}/undo`, {
          method: "POST",
          body: {},
        });
      } catch (e) {
        toast(e.message, "error");
        break;
      }
    }
  state.session = await api(sessionURL(id));
  renderChat();
  renderPlan();
  await refreshEditor();
  await loadFiles();
}
export function initChat() {
  $("token-counter").setAttribute("role", "status");
  $("token-counter").setAttribute("aria-live", "polite");
  $("chat-input").addEventListener("input", () => {
    if (state.session) chatDrafts.set(state.session.id, $("chat-input").value);
    updateChatState();
  });
  $("chat-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const text = $("chat-input").value.trim();
    if (text) sendMessage(text).catch((e) => toast(e.message, "error"));
  });
  $("chat-input").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      $("chat-form").requestSubmit();
    }
  });
  $("stop-chat-btn").addEventListener("click", () =>
    api("/api/chat/abort", {
      method: "POST",
      body: { sessionId: state.session.id },
    }).catch((e) => toast(e.message, "error")),
  );
  on("session-opened", () => {
    $("chat-input").value = chatDrafts.get(state.session?.id) || "";
    renderChat(true);
  });
  on("session-data", () => renderChat());
  on("summarize", () =>
    sendMessage("", { contextAction: "compact" }).catch((e) =>
      toast(e.message, "error"),
    ),
  );
  on("models-changed", () => {
    renderUsage(state.session?.contextUsage);
    updateChatState();
    renderTask();
  });
  on("explain-code", (text) =>
    sendMessage(tutorText("features:chat.explainPrompt", { p1: text })),
  );
}
