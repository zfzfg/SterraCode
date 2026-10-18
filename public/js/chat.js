import { api, streamChat, workspaceURL, sessionURL } from "./api.js";
import { state, emit, on } from "./state.js";
import { $, node, markdown, toast, formDialog } from "./ui.js";
import { button, createIcon } from "./icons.js";
import { flush, refreshEditor } from "./editor.js";
import { loadFiles, renderPlan, renderTabs } from "./workspace.js";
import { loadSessions } from "./sessions.js";
import { attachProcess } from "./terminal.js";

let controller;
function usageText(usage) {
  if (!usage) return "Kontext bereit";
  const number = (n) =>
    Number.isFinite(n) ? n.toLocaleString("de-DE") : "unbekannt";
  const prefix = usage.stale
    ? "Kontext (letzte Messung)"
    : usage.measurementQuality === "exact"
      ? "Kontext"
      : "Kontext (geschätzt)";
  return `${prefix}: ${number(usage.promptTokens)}${usage.contextLength ? ` / ${number(usage.contextLength)}` : ""} Tokens${usage.contextLength ? ` · ${Math.round((100 * usage.promptTokens) / usage.contextLength)} % · frei für weiteren Kontext: ${number(usage.remainingTokens)}` : ""}`;
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
  counter.title = usage
    ? `Antwortreserve: ${usage.reservedOutputTokens.toLocaleString("de-DE")} Tokens · ${usage.coveredMessages} Nachrichten komprimiert · ${usage.chunkCount} Zusammenfassungen · zuletzt gemessen: ${new Date(usage.sampledAt).toLocaleString("de-DE")}`
    : "/compact komprimiert ältere Abschnitte, /usage zeigt die Kontextnutzung.";
}
const typeInfo = {
  trigger_summarize: ["plan", "Kontextzusammenfassung"],
  context_compaction: ["plan", "Kontext komprimiert"],
  context_usage: ["plan", "Kontextnutzung"],
  get_context_usage: ["plan", "Kontextnutzung gelesen"],
  read_tool_result: ["file", "Werkzeugergebnis nachgelesen"],
  write_file: ["file", "Datei geändert"],
  read_file: ["file", "Datei gelesen"],
  list_files: ["folder", "Dateien gelesen"],
  create_task: ["plan", "Neue Aufgabe"],
  mark_task_done: ["check", "Aufgabe abgeschlossen"],
  add_explanation: ["bulb", "Erklärung"],
  ask_question: ["question", "Frage"],
  update_learning_plan: ["plan", "Lernplan aktualisiert"],
  run_terminal_command: ["terminal", "KI-Terminal"],
  read_terminal_output: ["terminal", "Terminalausgabe"],
  tool_error: ["warning", "Werkzeugfehler"],
  write_editor: ["file", "Frühere Editoränderung"],
  insert_at_line: ["file", "Frühere Editoränderung"],
};
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
  toast(`Änderung an ${event.path} rückgängig gemacht.`);
}
function eventCard(event, sessionId) {
  const info = typeInfo[event.type];
  if (!info) return null;
  const card = node(
      "article",
      `event-card${event.type === "tool_error" ? " error" : ""}`,
    ),
    heading = node("div", "event-heading");
  heading.append(createIcon(info[0]), node("span", "", event.title || info[1]));
  card.append(heading);
  if (event.path) card.append(node("p", "", event.path));
  if (event.reason) card.append(node("p", "muted", event.reason));
  if (event.type === "trigger_summarize")
    card.append(
      node(
        "p",
        "",
        event.status === "completed"
          ? "Der Modellkontext wurde zusammengefasst. Der vollständige Verlauf bleibt erhalten."
          : event.status === "scheduled"
            ? "Komprimierung nach dieser Werkzeugrunde angefordert."
            : "Der Verlauf ist noch zu kurz für eine Zusammenfassung.",
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
          event.changed
            ? `${event.beforeTokens.toLocaleString("de-DE")} → ${event.afterTokens.toLocaleString("de-DE")} Tokens im Modellkontext. Der vollständige Chat bleibt erhalten.`
            : "Es konnten keine weiteren Abschnitte sinnvoll komprimiert werden. Der vollständige Chat bleibt erhalten.",
        ),
      );
    card.append(node("p", "", usageText(usage)));
    if (usage.error) card.append(node("p", "muted", usage.error));
    if (usage.effectiveSettings) {
      const details = node("details");
      details.append(
        node("summary", "", "Effektive Kontextbudgets"),
        node(
          "p",
          "",
          `Antwort: ${usage.reservedOutputTokens.toLocaleString("de-DE")} · Wörtlicher Kontext: ${usage.effectiveSettings.keepRecentTokens.toLocaleString("de-DE")} · Zusammenfassungen: ${usage.effectiveSettings.summaryBudgetTokens.toLocaleString("de-DE")} Tokens`,
        ),
      );
      card.append(details);
    }
  }
  if (event.type === "tool_error") card.append(node("p", "", event.error));
  if (event.type === "create_task")
    card.append(node("p", "", event.task?.title || ""));
  if (event.type === "add_explanation") card.append(markdown(event.content));
  if (event.type === "update_learning_plan")
    card.append(node("p", "", event.goal));
  if (event.type === "mark_task_done" && event.feedback)
    card.append(node("p", "", event.feedback));
  if (event.type === "write_file" && event.changeId) {
    const b = button(
      event.undone ? "Rückgängig gemacht" : "Rückgängig",
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
        `Ausgabe${event.exited || event.exitCode !== undefined ? " · Exit " + event.exitCode : " · Prozess gestartet"}`,
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
    card.append(node("p", "", event.question));
    if (event.answer)
      card.append(node("p", "answered", `Deine Antwort: ${event.answer}`));
    else if (!event.questionId)
      card.append(
        node(
          "p",
          "muted",
          "Frühere Frage. Die damalige Antwort steht im Verlauf.",
        ),
      );
    else {
      const options = node("div", "question-options");
      for (const option of event.options || []) {
        const b = button(option, null, () =>
          answer(event.questionId, option, sessionId),
        );
        b.disabled = state.busy;
        options.append(b);
      }
      card.append(options);
      const form = node("form", "question-form"),
        input = node("input"),
        send = button("Antworten", null);
      input.placeholder = "Eigene Antwort …";
      input.setAttribute("aria-label", `Eigene Antwort auf: ${event.question}`);
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
          node("summary", "", "Denkprozess"),
          markdown(m.thinking),
        );
        bubble.append(thinking);
      }
      bubble.append(markdown(m.content));
    } else bubble.append(node("div", "", m.content));
    if (m.edited) bubble.append(node("small", "muted", "Bearbeitet"));
    if (m.incomplete)
      bubble.append(node("small", "muted", "Unvollständige Antwort"));
    const actions = node("div", "message-actions");
    if (m.role === "user") {
      const edit = button(
        "Nachricht bearbeiten",
        "edit",
        () => editMessage(m),
        "icon-only",
      );
      edit.disabled = state.busy;
      actions.append(edit);
      if (m.id === lastUser?.id) {
        const remove = button(
          "Letzte Nachricht und Antwort löschen",
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
          value === 1 ? "Hilfreich" : "Nicht hilfreich",
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
        lastTurn.error ||
          "Die vorherige Antwort wurde unterbrochen. Bereits ausgeführte Schritte sind gespeichert.",
      ),
    );
    const retry = button(
      lastTurn.contextAction
        ? "Kontextaktion wiederholen"
        : "Antwort fortsetzen",
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
    c.append(node("p", "muted", "Was möchtest du heute lernen?"));
  if (bottom) scroll(true);
  else c.scrollTop = position;
  renderTask();
  updateChatState();
}
function renderTask() {
  const container = $("task-panel"),
    task = state.session?.currentTask;
  container.hidden = !task;
  if (!task) return;
  container.replaceChildren(
    node("strong", "", task.title),
    node("p", "", task.description),
  );
  if (task.hints?.length) {
    const details = node("details");
    details.append(node("summary", "", "Hinweise"));
    for (const hint of task.hints) details.append(node("p", "", hint));
    container.append(details);
  }
  const done = button(
    task.done ? "Aufgabe abgeschlossen" : "Aufgabe prüfen lassen",
    "check",
    () =>
      sendMessage(
        "Ich habe die Aufgabe abgeschlossen. Bitte prüfe meine Dateien und gib mir Feedback.",
      ),
  );
  done.disabled = task.done || state.busy || !state.ready;
  container.append(done);
}
export function updateChatState() {
  const usage = /^\/usage$/i.test($("chat-input").value.trim());
  $("send-btn").disabled =
    !state.session || (!state.ready && !usage) || state.busy;
  $("stop-chat-btn").hidden = !state.busy;
  $("app").classList.toggle("chat-busy", state.busy);
  $("chat-state").textContent = state.busy
    ? "Antwort wird erstellt …"
    : !state.ready
      ? "Dateiarbeit funktioniert auch ohne KI-Verbindung."
      : "Enter sendet, Umschalt+Enter fügt eine Zeile ein";
}
async function answer(questionId, text, sessionId) {
  if (state.busy) return;
  await flush();
  const result = await api("/api/chat/answer", {
    method: "POST",
    body: { sessionId, questionId, answer: text },
  });
  if (state.session?.id !== sessionId) return;
  state.session = result.session;
  renderChat();
  if (state.ready)
    await sendMessage("", { existingUserMessageId: result.messageId });
  else
    toast(
      "Antwort gespeichert. Dein KI-Tutor kann sie nach dem Verbinden berücksichtigen.",
    );
}
export async function sendMessage(
  text,
  { existingUserMessageId, retryOf, contextAction } = {},
) {
  if (state.busy) return;
  if (!state.session) throw new Error("Bitte zuerst eine Session auswählen.");
  contextAction ||=
    !existingUserMessageId && !retryOf
      ? /^\/(compress|compact)$/i.test(text.trim())
        ? "compact"
        : /^\/usage$/i.test(text.trim())
          ? "usage"
          : undefined
      : undefined;
  if (!state.ready && contextAction !== "usage")
    throw new Error(
      "Bitte den KI-Anbieter verbinden und ein Modell auswählen.",
    );
  await flush();
  const sessionId = state.session.id,
    turnId = crypto.randomUUID();
  controller = new AbortController();
  state.busy = true;
  state.turnId = turnId;
  updateChatState();
  const c = $("chat-messages");
  if (text && !contextAction) {
    c.append(node("article", "message user", text));
    $("chat-input").value = "";
  }
  if (contextAction) $("chat-input").value = "";
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
      details.append(node("summary", "", "Denkprozess"), markdown(thinking));
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
        `${typeInfo[value.tool]?.[1] || "Werkzeug wird ausgeführt"} …`;
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
    if (event === "notice") toast(value.message);
    if (event === "context-progress")
      $("chat-state").textContent = value.message;
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
      if (result.turn.status === "error") toast(result.turn.error, "error");
    }
  } catch (error) {
    toast(
      error.name === "AbortError" ? "Antwort abgebrochen." : error.message,
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
export async function showChanges() {
  if (!state.session) throw new Error("Bitte zuerst eine Session auswählen.");
  const id = state.session.id,
    changes = (await api(`${workspaceURL(id)}/changes`)).filter(
      (c) => c.status !== "undone",
    );
  if (!changes.length) {
    toast("Keine offenen KI-Dateiänderungen vorhanden.");
    return;
  }
  const result = await formDialog({
    title: "KI-Dateiänderungen",
    description:
      "Die Änderungshistorie bleibt auch nach dem Bearbeiten oder Löschen von Chatnachrichten erhalten. Neuere Dateistände werden durch Versionsprüfungen geschützt.",
    fields: [
      {
        name: "changeId",
        label: "Änderung",
        type: "select",
        options: changes.map((c) => ({
          value: c.changeId,
          label: `${c.path} · ${c.reason || "KI-Änderung"}`,
        })),
      },
    ],
    submit: "Rückgängig machen",
  });
  if (result)
    await undo(
      changes.find((c) => c.changeId === result.changeId),
      id,
    );
}
async function editMessage(message) {
  await flush();
  const result = await formDialog({
    title: "Nachricht bearbeiten",
    description:
      "Die folgenden Antworten werden aus dem Verlauf entfernt. Vorhandene Dateiänderungen bleiben über ihre Rückgängig-Aktionen kontrollierbar.",
    fields: [
      {
        name: "newContent",
        label: "Nachricht",
        type: "textarea",
        value: message.content,
        required: true,
      },
    ],
    submit: "Änderung speichern",
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
    title: "Letzte Nachricht und Antwort löschen?",
    description: "Der Modellkontext wird ebenfalls aktualisiert.",
    fields: [
      {
        name: "undo",
        label: "Zugehörige Dateiänderungen ebenfalls rückgängig machen",
        type: "checkbox",
        value: false,
      },
    ],
    submit: "Löschen",
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
  $("chat-input").addEventListener("input", updateChatState);
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
  on("session-opened", () => renderChat(true));
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
    sendMessage(
      `Erkläre mir diesen ausgewählten Code:\n\n\`\`\`\n${text}\n\`\`\``,
    ),
  );
}
