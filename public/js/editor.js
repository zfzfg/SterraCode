import { api, workspaceURL } from "./api.js";
import { state, emit } from "./state.js";
import { $, toast, formDialog } from "./ui.js";

const models = new Map();
let navigationVersion = 0;
let current = null,
  editor;
const languages = {
  py: "python",
  js: "javascript",
  ts: "typescript",
  sh: "shell",
  go: "go",
  rs: "rust",
  cpp: "cpp",
  h: "cpp",
  cs: "csharp",
  lua: "lua",
  java: "java",
  json: "json",
  md: "markdown",
  html: "html",
  css: "css",
};
export const fileLanguage = (file) =>
  languages[file?.split(".").pop()?.toLowerCase()] || "plaintext";
const draftKey = (record) =>
  `sterracode:draft:${record.sessionId}:${record.path}`;
function draft(record) {
  try {
    localStorage.setItem(
      draftKey(record),
      JSON.stringify({
        content: record.model.getValue(),
        baseVersion: record.version,
      }),
    );
  } catch {
    if (!record.storageWarning) {
      record.storageWarning = true;
      toast(
        "Die lokale Notfallsicherung ist voll. Bitte Datei speichern.",
        "error",
      );
    }
  }
}
function status(record = current) {
  if (record === current) {
    $("save-status").textContent = record?.error
      ? "Speichern fehlgeschlagen – prüfen"
      : record?.saving
        ? "Wird gespeichert"
        : record?.dirty
          ? "Geändert"
          : "Gespeichert";
    $("save-status").classList.toggle("error", Boolean(record?.error));
    $("save-status").title = record?.error?.message || "Dateistand";
    emit("save-state", record);
  }
}
export function initEditor() {
  return new Promise((resolve, reject) => {
    window.require.config({ paths: { vs: "/monaco/vs" } });
    window.require(
      ["vs/editor/editor.main"],
      () => {
        editor = window.monaco.editor.create($("editor-container"), {
          model: null,
          theme: "vs-dark",
          fontSize: state.settings.fontSize || 14,
          minimap: { enabled: false },
          automaticLayout: true,
          scrollBeyondLastLine: false,
          wordWrap: "on",
          tabSize: 4,
          accessibilitySupport: "auto",
        });
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () =>
          flush().catch((e) => toast(e.message, "error")),
        );
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () =>
          emit("run-code"),
        );
        editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyK, () =>
          emit("summarize"),
        );
        editor.addAction({
          // Keep the existing shortcut without embedding editor content in the request.
          id: "explain-selection",
          label: "Code erklären",
          contextMenuGroupId: "navigation",
          run: (ed) => {
            const text = ed.getModel()?.getValueInRange(ed.getSelection());
            if (text?.trim()) emit("explain-code", text);
          },
        });
        updateEditorTheme();
        resolve();
      },
      reject,
    );
  });
}
export function updateEditorTheme() {
  if (!editor) return;
  const css = getComputedStyle(document.documentElement),
    theme = document.documentElement.dataset.theme;
  monaco.editor.defineTheme("sterra", {
    base:
      theme === "light"
        ? "vs"
        : theme === "high-contrast"
          ? "hc-black"
          : "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": css
        .getPropertyValue("--bg")
        .trim()
        .replace(/^#([a-f\d])([a-f\d])([a-f\d])$/i, "#$1$1$2$2$3$3"),
      "editor.foreground": css
        .getPropertyValue("--text")
        .trim()
        .replace(/^#([a-f\d])([a-f\d])([a-f\d])$/i, "#$1$1$2$2$3$3"),
      "editorLineNumber.foreground": css
        .getPropertyValue("--muted")
        .trim()
        .replace(/^#([a-f\d])([a-f\d])([a-f\d])$/i, "#$1$1$2$2$3$3"),
      "editor.selectionBackground": theme === "light" ? "#c7dcff" : "#315477",
    },
  });
  monaco.editor.setTheme("sterra");
  editor.updateOptions({ fontSize: state.settings.fontSize || 14 });
}
window.addEventListener("theme-changed", updateEditorTheme);
async function save(record) {
  if (record.saving) return record.saving;
  if (!record.dirty) return;
  const content = record.model.getValue();
  record.error = null;
  record.saving = api(`${workspaceURL(record.sessionId)}/files/content`, {
    method: "PUT",
    body: { path: record.path, content, expectedVersion: record.version },
  })
    .then((result) => {
      record.version = result.version;
      record.dirty = record.model.getValue() !== content;
      if (!record.dirty) localStorage.removeItem(draftKey(record));
      else draft(record);
    })
    .catch((error) => {
      record.error = error;
      draft(record);
      throw error;
    })
    .finally(() => {
      record.saving = null;
      status(record);
    });
  status(record);
  return record.saving;
}
export async function flush() {
  const record = current;
  if (!record) return;
  clearTimeout(record.timer);
  if (record.saving) await record.saving;
  while (record.dirty) await save(record);
}
export async function openEditorFile(sessionId, file) {
  const request = ++navigationVersion;
  await flush();
  if (!file) {
    current = null;
    editor.setModel(null);
    $("file-path").textContent = "Keine Datei geöffnet";
    status();
    return true;
  }
  let result;
  try {
    result = await api(
      `${workspaceURL(sessionId)}/files/content?path=${encodeURIComponent(file)}`,
    );
  } catch (error) {
    if (error.code !== "TEXT_REQUIRED") throw error;
    if (state.session?.id !== sessionId || request !== navigationVersion)
      return false;
    const name = file.split("/").pop();
    const isJavaClass = /\.class$/i.test(file);
    await formDialog({
      title: isJavaClass ? "Kompilierte Java-Datei" : "Keine Textdatei",
      description: isJavaClass
        ? `„${name}“ enthält Java-Bytecode, den der Compiler aus einer .java-Datei erzeugt hat. Bearbeite die zugehörige .java-Datei und führe deinen Code anschließend erneut aus. Die .class-Datei wird dabei neu erzeugt. Deine aktuell geöffnete Datei bleibt erhalten.`
        : `„${name}“ ist eine Binärdatei oder verwendet eine andere Textkodierung als UTF-8. Sie kann hier nicht als Quelltext bearbeitet werden. Deine aktuell geöffnete Datei bleibt erhalten.`,
      submit: "Verstanden",
    });
    return false;
  }
  if (state.session?.id !== sessionId || request !== navigationVersion)
    return false;
  const key = `${sessionId}:${file}`;
  let record = models.get(key);
  if (!record) {
    const model = monaco.editor.createModel(
      result.content,
      fileLanguage(file),
      monaco.Uri.parse(`sterracode:///${sessionId}/${file}`),
    );
    record = {
      sessionId,
      path: file,
      version: result.version,
      model,
      dirty: false,
      saving: null,
      error: null,
      loading: false,
    };
    models.set(key, record);
    try {
      const recovered = JSON.parse(
        localStorage.getItem(draftKey(record)) || "null",
      );
      if (recovered && recovered.content !== result.content) {
        model.setValue(recovered.content);
        record.version = recovered.baseVersion;
        record.dirty = true;
        toast(
          "Ein ungespeicherter lokaler Stand wurde im Editor wiederhergestellt.",
        );
      }
    } catch {}
    model.onDidChangeContent(() => {
      if (record.loading) return;
      record.dirty = true;
      draft(record);
      status(record);
      clearTimeout(record.timer);
      record.timer = setTimeout(
        () => save(record).catch((e) => toast(e.message, "error")),
        800,
      );
    });
  } else if (!record.dirty && record.version !== result.version) {
    record.loading = true;
    record.model.setValue(result.content);
    record.version = result.version;
    record.loading = false;
  }
  current = record;
  editor.setModel(record.model);
  $("file-path").textContent = file;
  status();
  emit("file-active", file);
  return true;
}
export async function refreshEditor() {
  if (!current || current.sessionId !== state.session?.id) return;
  const record = current;
  const result = await api(
    `${workspaceURL(record.sessionId)}/files/content?path=${encodeURIComponent(record.path)}`,
  ).catch((e) => {
    if (e.status === 404) return null;
    throw e;
  });
  if (current !== record || state.session?.id !== record.sessionId) return;
  if (!result) {
    if (!record.dirty) {
      editor.setModel(null);
      current = null;
    }
    return;
  }
  if (!record.dirty && !record.saving && record.version !== result.version) {
    record.loading = true;
    record.model.setValue(result.content);
    record.version = result.version;
    record.loading = false;
    status(record);
  }
}
export async function resolveSave() {
  if (!current?.error) return flush();
  const record = current;
  if (record.error.status !== 409) return flush();
  const remote = await api(
    `${workspaceURL(record.sessionId)}/files/content?path=${encodeURIComponent(record.path)}`,
  ).catch((e) => {
    if (e.status === 404) return { content: "Die Datei wurde entfernt." };
    throw e;
  });
  const result = await formDialog({
    title: "Dateistände vergleichen",
    description:
      "Der lokale Text bleibt erhalten. Sichere ihn als neue Datei oder lade den Serverstand ausdrücklich neu.",
    fields: [
      {
        name: "remote",
        label: "Serverstand",
        type: "textarea",
        value: remote.content,
        readOnly: true,
      },
      {
        name: "local",
        label: "Dein lokaler Stand",
        type: "textarea",
        value: record.model.getValue(),
        readOnly: true,
      },
      {
        name: "action",
        label: "Aktion",
        type: "select",
        options: [
          { value: "copy", label: "Lokalen Stand als neue Datei sichern" },
          { value: "reload", label: "Serverstand laden" },
        ],
      },
      {
        name: "path",
        label: "Name der Sicherungsdatei",
        value: `recovered-${Date.now()}-${record.path.split("/").pop()}`,
      },
    ],
    submit: "Ausführen",
  });
  if (!result) return;
  if (result.action === "copy") {
    await api(`${workspaceURL(record.sessionId)}/files`, {
      method: "POST",
      body: {
        path: result.path,
        type: "file",
        content: record.model.getValue(),
      },
    });
    emit("files-changed");
    toast(`Lokaler Stand in ${result.path} gesichert.`);
  }
  record.dirty = false;
  record.error = null;
  localStorage.removeItem(draftKey(record));
  if (remote.version) {
    record.loading = true;
    record.model.setValue(remote.content);
    record.loading = false;
    record.version = remote.version;
  } else {
    editor.setModel(null);
    current = null;
  }
  status();
}
export function currentFile() {
  return current?.path || null;
}
export function layoutEditor() {
  editor?.layout();
}
window.addEventListener("beforeunload", (event) => {
  if ([...models.values()].some((r) => r.dirty || r.saving)) {
    event.preventDefault();
    event.returnValue = "";
  }
});
document.addEventListener("visibilitychange", () => {
  if (document.hidden) flush().catch((e) => toast(e.message, "error"));
});
