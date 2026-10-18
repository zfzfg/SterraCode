import { api, sessionURL } from "./api.js";
import { state, emit } from "./state.js";
import { button } from "./icons.js";
import { $, node, formDialog, confirmDialog } from "./ui.js";
import { flush, openEditorFile } from "./editor.js";
export const languageOptions = [
  ["python", "Python"],
  ["javascript", "JavaScript"],
  ["bash", "Bash"],
  ["go", "Go"],
  ["rust", "Rust"],
  ["cpp", "C++"],
  ["csharp", "C#"],
  ["lua", "Lua"],
  ["java", "Java"],
].map(([value, label]) => ({ value, label }));
let opening = 0;
export async function loadSessions() {
  state.sessions = await api("/api/sessions");
  renderSessions();
}
export function renderSessions() {
  const list = $("sessions-list");
  list.replaceChildren();
  for (const s of state.sessions) {
    const row = node(
        "div",
        `session-row${state.session?.id === s.id ? " active" : ""}`,
      ),
      open = button(s.title, null, () => openSession(s.id), "session-open");
    open.replaceChildren(
      node("strong", "", s.title),
      node(
        "span",
        "session-meta",
        `${languageOptions.find((l) => l.value === s.language)?.label || s.language} · ${new Date(s.updatedAt).toLocaleDateString("de-DE")}`,
      ),
    );
    if (s.deleting) {
      open.disabled = true;
      open.append(
        node(
          "span",
          "session-meta",
          "Löschen ausstehend · zum Fortsetzen verwalten",
        ),
      );
    }
    row.append(
      open,
      button(
        "Session verwalten",
        "settings",
        () => manageSession(s),
        "icon-only",
      ),
    );
    list.append(row);
  }
  if (!state.sessions.length)
    list.append(
      node(
        "p",
        "empty-small",
        "Noch keine Sessions. Starte mit einem eigenen Lernziel.",
      ),
    );
  const recent = $("recent-sessions");
  recent.replaceChildren();
  if (state.sessions.length)
    recent.append(node("span", "eyebrow", "Zuletzt bearbeitet"));
  for (const s of state.sessions.slice(0, 3))
    recent.append(button(s.title, "file", () => openSession(s.id)));
}
export async function createSession() {
  await flush();
  await formDialog({
    title: "Neue Session",
    description: state.server.authRequired
      ? "Dateien und Lernfortschritt werden auf dem SterraCode-Server gespeichert."
      : "Dateien und Lernfortschritt werden lokal auf deinem Rechner gespeichert.",
    fields: [
      {
        name: "title",
        label: "Name",
        value: "Meine neue Session",
        required: true,
        maxLength: 200,
      },
      {
        name: "language",
        label: "Programmiersprache",
        type: "select",
        value: state.session?.language || "python",
        options: languageOptions,
      },
    ],
    submit: "Session erstellen",
    onSave: async (data) => {
      const s = await api("/api/sessions", { method: "POST", body: data });
      await openSession(s.id);
      await loadSessions();
    },
  });
}
export async function openSession(id) {
  const sequence = ++opening;
  await flush();
  if (state.busy && state.session?.id !== id) await emitAbort();
  const session = await api(sessionURL(id));
  if (sequence !== opening) return;
  state.session = session;
  document.title = `${session.title} – SterraCode`;
  $("session-title").textContent = session.title;
  $("language-select").value = session.language;
  $("welcome").hidden = true;
  $("panes").hidden = false;
  $("compact-tabs").hidden = false;
  await openEditorFile(id, session.activeFile);
  renderSessions();
  emit("session-opened", session);
  emit("close-sidebar");
}
async function emitAbort() {
  await api("/api/chat/abort", {
    method: "POST",
    body: { sessionId: state.session.id },
  });
  while (state.busy) await new Promise((resolve) => setTimeout(resolve, 30));
}
async function manageSession(session) {
  const result = await formDialog({
    title: "Session verwalten",
    fields: [
      {
        name: "title",
        label: "Name",
        value: session.title,
        required: true,
        maxLength: 200,
      },
      {
        name: "action",
        label: "Aktion",
        type: "select",
        options: [
          { value: "rename", label: "Umbenennen" },
          { value: "delete", label: "Session löschen (mit Sicherung)" },
        ],
      },
    ],
  });
  if (!result) return;
  if (result.action === "delete") {
    if (state.busy)
      throw new Error("Bitte die laufende KI-Antwort zuerst stoppen.");
    if (
      !(await confirmDialog(
        "Session löschen?",
        `„${session.title}“ wird aus der Liste entfernt. Eine Sicherung bleibt lokal erhalten.`,
      ))
    )
      return;
    if (state.session?.id === session.id) await flush();
    try {
      await api(sessionURL(session.id), { method: "DELETE", body: {} });
    } finally {
      await loadSessions();
    }
    if (state.session?.id === session.id) {
      state.session = null;
      await openEditorFile(null, null);
      $("welcome").hidden = false;
      $("panes").hidden = true;
      $("compact-tabs").hidden = true;
      $("session-title").textContent = "Dein Lernarbeitsplatz";
      emit("session-opened", null);
    }
  } else {
    const updated = await api(sessionURL(session.id), {
      method: "PATCH",
      body: { title: result.title },
    });
    if (state.session?.id === session.id) {
      state.session = updated;
      $("session-title").textContent = updated.title;
      document.title = `${updated.title} – SterraCode`;
    }
  }
  await loadSessions();
}
