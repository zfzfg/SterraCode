import { api, sessionURL } from "./api.js";
import { state, emit } from "./state.js";
import { button } from "./icons.js";
import { $, node, formDialog, confirmDialog } from "./ui.js";
import { flush, openEditorFile } from "./editor.js";
import { t, getLocale, LOCALES, formatDate } from "./i18n.js";
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
  const importButton = button(t("features:codebase.import"), "folder", () =>
    emit("codebase-import"),
  );
  importButton.id = "codebase-import-btn";
  importButton.setAttribute("aria-haspopup", "dialog");
  list.append(importButton);
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
        `${s.mode === "codebase" ? t("features:codebase.project") : languageOptions.find((l) => l.value === s.language)?.label || s.language} · ${formatDate(s.updatedAt)}`,
      ),
    );
    if (s.deleting) {
      open.disabled = true;
      open.append(node("span", "session-meta", t("sessions:deletion.pending")));
    }
    row.append(
      open,
      button(
        t("sessions:manage.title"),
        "settings",
        () => manageSession(s),
        "icon-only",
      ),
    );
    list.append(row);
  }
  if (!state.sessions.length)
    list.append(node("p", "empty-small", t("sessions:empty")));
  const recent = $("recent-sessions");
  recent.replaceChildren();
  if (state.sessions.length)
    recent.append(node("span", "eyebrow", t("sessions:recent")));
  for (const s of state.sessions.slice(0, 3))
    recent.append(button(s.title, "file", () => openSession(s.id)));
}
export async function createSession() {
  await flush();
  await formDialog({
    title: t("sessions:new.title"),
    description: state.server.authRequired
      ? t("sessions:new.server")
      : t("sessions:new.local"),
    fields: [
      {
        name: "title",
        label: t("sessions:name"),
        value: t("sessions:new.defaultTitle"),
        required: true,
        maxLength: 200,
      },
      {
        name: "language",
        label: t("app:static.programmingLanguage"),
        type: "select",
        value: state.session?.language || "python",
        options: languageOptions,
      },
      {
        name: "tutorLocale",
        label: t("sessions:tutor.label"),
        type: "select",
        value: getLocale(),
        options: Object.entries(LOCALES).map(([value, entry]) => ({
          value,
          label: entry.name,
        })),
        help: t("sessions:tutor.help"),
      },
    ],
    submit: t("sessions:new.create"),
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
  $("language-select").hidden = session.mode === "codebase";
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
    title: t("sessions:manage.title"),
    fields: [
      {
        name: "title",
        label: t("sessions:name"),
        value: session.title,
        required: true,
        maxLength: 200,
      },
      {
        name: "action",
        label: t("sessions:action"),
        type: "select",
        options: [
          { value: "rename", label: t("sessions:rename") },
          { value: "delete", label: t("sessions:delete.action") },
        ],
      },
      {
        name: "tutorLocale",
        label: t("sessions:tutor.label"),
        type: "select",
        value: session.tutorLocale || "legacy",
        options: [
          ...(!session.tutorLocale
            ? [{ value: "legacy", label: t("sessions:tutor.legacy") }]
            : []),
          ...Object.entries(LOCALES).map(([value, entry]) => ({
            value,
            label: entry.name,
          })),
        ],
        help: t("sessions:tutor.help"),
      },
    ],
  });
  if (!result) return;
  if (result.action === "delete") {
    if (state.busy) throw new Error(t("sessions:delete.stop"));
    const demos =
      session.mode === "codebase"
        ? (
            await api(
              `/api/codebase/sessions/${encodeURIComponent(session.id)}/demos`,
            )
          ).demos || []
        : [];
    if (
      !(await confirmDialog(
        t("sessions:delete.confirm"),
        `${t("sessions:delete.description", { title: session.title })}${session.mode === "codebase" ? ` ${t("features:codebase.deletionBackups")} ${t("features:codebase.retainedDemos", { count: demos.length })}` : ""}`,
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
      $("session-title").textContent = t("app:static.workplace");
      emit("session-opened", null);
    }
  } else {
    const updated = await api(sessionURL(session.id), {
      method: "PATCH",
      body: {
        title: result.title,
        ...(result.tutorLocale !== "legacy"
          ? { tutorLocale: result.tutorLocale }
          : {}),
        expectedRevision:
          state.session?.id === session.id ? state.session.revision : undefined,
      },
    });
    if (state.session?.id === session.id) {
      state.session = updated;
      $("session-title").textContent = updated.title;
      document.title = `${updated.title} – SterraCode`;
    }
  }
  await loadSessions();
}
