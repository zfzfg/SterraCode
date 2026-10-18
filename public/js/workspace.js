import { api, sessionURL, workspaceURL } from "./api.js";
import { state, emit, on } from "./state.js";
import { $, node, formDialog, confirmDialog } from "./ui.js";
import { createIcon, button } from "./icons.js";
import { flush, openEditorFile, currentFile } from "./editor.js";
const expanded = new Set();
let navigation = Promise.resolve();
export function selectFile(file) {
  const id = state.session?.id;
  navigation = navigation.catch(() => {}).then(() => selectFileNow(id, file));
  return navigation;
}
async function selectFileNow(id, file) {
  const session = state.session;
  if (!session || session.id !== id) return;
  await flush();
  if (!(await openEditorFile(session.id, file))) return;
  if (state.session?.id !== session.id) return;
  const openFiles = [...new Set([...session.openFiles, file])];
  const updated = await api(sessionURL(session.id), {
    method: "PATCH",
    body: { activeFile: file, openFiles },
  });
  if (state.session?.id !== id) return;
  state.session = updated;
  renderTabs();
  await loadFiles();
  emit("close-sidebar");
}
export function renderTabs() {
  const container = $("file-tabs");
  container.replaceChildren();
  if (!state.session) return;
  const ownerId = state.session.id;
  for (const path of state.session.openFiles) {
    const tab = node("div", "file-tab");
    tab.setAttribute("role", "tab");
    tab.setAttribute("aria-selected", String(path === currentFile()));
    const open = button(path.split("/").pop(), "file", () => selectFile(path));
    open.title = path;
    tab.append(
      open,
      button(
        `Datei ${path} schließen`,
        "close",
        async () => {
          await flush();
          const s = state.session;
          if (s?.id !== ownerId) return;
          const openFiles = s.openFiles.filter((f) => f !== path);
          const activeFile =
            s.activeFile === path ? openFiles[0] || null : s.activeFile;
          const updated = await api(sessionURL(s.id), {
            method: "PATCH",
            body: { openFiles, activeFile },
          });
          if (state.session?.id !== ownerId) return;
          state.session = updated;
          await openEditorFile(s.id, activeFile);
          renderTabs();
          emit("runtime-changed");
        },
        "icon-only",
      ),
    );
    container.append(tab);
  }
  emit("runtime-changed");
}
export async function loadFiles() {
  const session = state.session,
    container = $("file-tree");
  if (!session) {
    container.replaceChildren(
      node("p", "empty-small", "Wähle zuerst eine Session."),
    );
    return;
  }
  const files = await api(`${workspaceURL(session.id)}/files`);
  if (state.session?.id !== session.id) return;
  container.replaceChildren();
  function tree(items, parent) {
    for (const f of items) {
      const group = node("div"),
        row = node(
          "div",
          `tree-item${currentFile() === f.path ? " active" : ""}`,
        ),
        open = button(
          f.name,
          null,
          f.type === "folder" ? null : () => selectFile(f.path),
          "tree-open",
        );
      open.replaceChildren();
      open.setAttribute("role", "treeitem");
      open.title = f.path;
      if (f.type === "folder") {
        const arrow = createIcon("chevron");
        arrow.classList.add("chevron");
        open.append(arrow);
        open.setAttribute(
          "aria-expanded",
          String(expanded.has(`${session.id}:${f.path}`)),
        );
      }
      open.append(
        createIcon(f.type === "folder" ? "folder" : "file"),
        node("span", "name", f.name),
      );
      row.append(
        open,
        button(
          `Umbenennen: ${f.name}`,
          "edit",
          () => rename(f.path),
          "icon-only",
        ),
        button(
          `Löschen: ${f.name}`,
          "trash",
          () => remove(f.path),
          "icon-only",
        ),
      );
      group.append(row);
      parent.append(group);
      if (f.type === "folder") {
        const children = node("div", "tree-children");
        children.setAttribute("role", "group");
        children.hidden = !expanded.has(`${session.id}:${f.path}`);
        tree(f.children, children);
        group.append(children);
        function apply() {
          const isOpen = expanded.has(`${session.id}:${f.path}`);
          children.hidden = !isOpen;
          open.setAttribute("aria-expanded", String(isOpen));
        }
        function toggle() {
          const key = `${session.id}:${f.path}`;
          expanded.has(key) ? expanded.delete(key) : expanded.add(key);
          apply();
        }
        open.onclick = (event) => {
          event.stopPropagation();
          toggle();
        };
        open.addEventListener("keydown", (e) => {
          if (e.key === "ArrowRight") {
            expanded.add(`${session.id}:${f.path}`);
            apply();
            e.preventDefault();
          }
          if (e.key === "ArrowLeft") {
            expanded.delete(`${session.id}:${f.path}`);
            apply();
            e.preventDefault();
          }
        });
      }
    }
  }
  tree(files, container);
  if (!files.length)
    container.append(
      node(
        "p",
        "empty-small",
        "Noch keine Dateien. Erstelle eine Datei oder einen Ordner.",
      ),
    );
}
export async function createFile(type) {
  if (!state.session) throw new Error("Bitte zuerst eine Session auswählen.");
  await flush();
  const id = state.session.id;
  const data = await formDialog({
    title: type === "folder" ? "Neuer Ordner" : "Neue Datei",
    fields: [
      {
        name: "path",
        label: "Relativer Pfad",
        placeholder: type === "folder" ? "src" : "src/beispiel.py",
        required: true,
      },
    ],
    submit: "Erstellen",
    onSave: async (values) => {
      await api(`${workspaceURL(id)}/files`, {
        method: "POST",
        body: { ...values, type },
      });
    },
  });
  if (!data) return;
  if (type === "file") await selectFile(data.path);
  else await loadFiles();
}
async function rename(oldPath) {
  await flush();
  const id = state.session.id;
  const result = await formDialog({
    title: "Umbenennen oder verschieben",
    fields: [
      {
        name: "newPath",
        label: "Neuer relativer Pfad",
        value: oldPath,
        required: true,
      },
    ],
    onSave: async (values) => {
      await api(`${workspaceURL(id)}/files`, {
        method: "PATCH",
        body: { oldPath, newPath: values.newPath },
      });
    },
  });
  if (result) await refreshWorkspace();
}
async function remove(path) {
  await flush();
  if (
    !(await confirmDialog(
      "Datei oder Ordner löschen?",
      `„${path}“ und enthaltene Dateien werden gelöscht. Eine lokale Sicherung wird vorher angelegt.`,
    ))
  )
    return;
  await api(
    `${workspaceURL(state.session.id)}/files?path=${encodeURIComponent(path)}`,
    { method: "DELETE", body: {} },
  );
  await refreshWorkspace();
}
export async function refreshWorkspace() {
  const id = state.session?.id;
  if (!id) return;
  const s = await api(sessionURL(id));
  if (state.session?.id !== id) return;
  state.session = s;
  await openEditorFile(id, s.activeFile);
  renderTabs();
  await loadFiles();
  emit("session-data", s);
}
export function renderPlan() {
  const container = $("learning-plan");
  container.replaceChildren();
  if (!state.session) {
    container.append(
      node(
        "p",
        "empty-small",
        "Dein Lernplan erscheint nach dem Öffnen einer Session.",
      ),
    );
    return;
  }
  const plan = state.session.learningPlan;
  if (plan) {
    container.append(node("h2", "plan-goal", plan.goal));
    const count = plan.topics.filter((t) => t.done).length;
    const progress = node("progress", "plan-progress");
    progress.max = plan.topics.length || 1;
    progress.value = count;
    progress.setAttribute("aria-label", "Lernfortschritt");
    container.append(
      progress,
      node(
        "p",
        "muted",
        `${count} von ${plan.topics.length} Themen abgeschlossen`,
      ),
    );
    for (const topic of plan.topics) {
      const label = node("label", `plan-topic${topic.done ? " done" : ""}`),
        input = node("input");
      input.type = "checkbox";
      input.checked = topic.done;
      input.addEventListener("change", async () => {
        input.disabled = true;
        try {
          const updated = structuredClone(state.session.learningPlan);
          updated.topics.find((t) => t.id === topic.id).done = input.checked;
          await savePlan(updated);
        } catch (error) {
          input.checked = !input.checked;
          window.dispatchEvent(new CustomEvent("app-error", { detail: error }));
        } finally {
          input.disabled = false;
        }
      });
      label.append(input, node("span", "", topic.title));
      container.append(label);
    }
  } else
    container.append(
      node(
        "p",
        "empty-small",
        "Noch kein Lernplan. Erstelle ihn selbst oder frage deinen KI-Tutor.",
      ),
    );
  container.append(
    button(
      plan ? "Lernplan bearbeiten" : "Lernplan erstellen",
      "edit",
      editPlan,
    ),
  );
}
async function savePlan(plan) {
  const s = state.session;
  const updated = await api(sessionURL(s.id), {
    method: "PATCH",
    body: { learningPlan: plan, expectedRevision: s.revision },
  });
  if (state.session?.id !== s.id) return;
  state.session = updated;
  renderPlan();
  emit("session-data", updated);
}
async function editPlan() {
  const plan = state.session.learningPlan;
  await formDialog({
    title: "Lernplan bearbeiten",
    description:
      "Eine Zeile pro Thema. Vorhandene Abschlüsse bleiben für gleich benannte Themen erhalten.",
    fields: [
      {
        name: "goal",
        label: "Lernziel",
        value: plan?.goal || "",
        required: true,
        maxLength: 500,
      },
      {
        name: "topics",
        label: "Themen",
        type: "textarea",
        value: plan?.topics.map((t) => t.title).join("\n") || "",
        required: true,
      },
    ],
    onSave: async (values) => {
      const topics = values.topics
        .split("\n")
        .map((t) => t.trim())
        .filter(Boolean)
        .map((title) => ({
          ...plan?.topics.find((t) => t.title === title),
          title,
        }))
        .map((t) => ({
          id: t.id || crypto.randomUUID(),
          title: t.title,
          done: t.done || false,
        }));
      await savePlan({ goal: values.goal, topics });
    },
  });
}
export function initWorkspace() {
  $("file-actions").append(
    button("Neue Datei", "file", () => createFile("file"), "icon-only"),
    button("Neuer Ordner", "folder", () => createFile("folder"), "icon-only"),
  );
  $("file-tree").addEventListener("keydown", (event) => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const buttons = [...$("file-tree").querySelectorAll(".tree-open")].filter(
      (b) => b.getClientRects().length,
    );
    let index = buttons.indexOf(document.activeElement);
    index =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? buttons.length - 1
          : event.key === "ArrowDown"
            ? Math.min(index + 1, buttons.length - 1)
            : Math.max(index - 1, 0);
    buttons[index]?.focus();
    event.preventDefault();
  });
  on("session-opened", () => {
    renderTabs();
    renderPlan();
    return loadFiles();
  });
  on("session-data", renderPlan);
  on("files-changed", loadFiles);
  on("file-active", renderTabs);
}
