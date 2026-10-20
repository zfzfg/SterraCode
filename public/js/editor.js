import { t, getLocale, LOCALES } from "./i18n.js";
import { api, workspaceURL } from "./api.js";
import { state, emit } from "./state.js";
import { $, node, toast, formDialog } from "./ui.js";

const models = new Map();
export const hasUnsavedChanges = () =>
  [...models.values()].some((record) => record.dirty || record.saving);
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
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  tsx: "typescript",
  c: "c",
  cc: "cpp",
  hpp: "cpp",
  yml: "yaml",
  yaml: "yaml",
  toml: "ini",
  xml: "xml",
  rb: "ruby",
  php: "php",
  kt: "kotlin",
  kts: "kotlin",
  swift: "swift",
  sql: "sql",
  scss: "scss",
  vue: "html",
};
export const fileLanguage = (file) =>
  languages[file?.split(".").pop()?.toLowerCase()] || "plaintext";
const draftKey = (record) =>
  `sterracode:draft:${record.sessionId}:${record.path}`;
function removeDraft(record) {
  try {
    localStorage.removeItem(draftKey(record));
  } catch {
    /* Successful server saves do not depend on Web Storage. */
  }
}
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
      toast(t("features:editor.backupFull"), "error");
    }
  }
}
function status(record = current) {
  if (record === current) {
    $("save-status").textContent = record?.error
      ? t("features:editor.saveError")
      : record?.saving
        ? t("features:editor.saving")
        : record?.dirty
          ? t("features:editor.changed")
          : t("features:editor.saved");
    $("save-status").classList.toggle("error", Boolean(record?.error));
    $("save-status").title =
      record?.error?.message || t("features:editor.fileState");
    emit("save-state", record);
  }
}
export function initEditor() {
  return new Promise((resolve, reject) => {
    window.require.config({
      paths: { vs: "/monaco/vs" },
      "vs/nls": { availableLanguages: { "*": LOCALES[getLocale()].monaco } },
    });
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
          label: t("features:editor.explain"),
          contextMenuGroupId: "navigation",
          run: (ed) => {
            const text = ed.getModel()?.getValueInRange(ed.getSelection());
            if (text?.trim()) explainSelection();
            else toast(t("features:codebase.selectCode"));
          },
        });
        editor.addAction({
          id: "explain-project-context",
          label: t("features:codebase.explainContext"),
          contextMenuGroupId: "navigation",
          run: () => explainSelection(true),
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
      if (!record.dirty) removeDraft(record);
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
// A language reload must also wait for records that are no longer selected.
export async function flushAll() {
  for (const record of models.values()) {
    clearTimeout(record.timer);
    if (record.saving) await record.saving;
    while (record.dirty) await save(record);
  }
}
export function captureEditorState() {
  return current
    ? {
        sessionId: current.sessionId,
        path: current.path,
        viewState: editor?.saveViewState(),
      }
    : null;
}
export function restoreEditorState(saved) {
  if (
    saved?.sessionId === current?.sessionId &&
    saved?.path === current?.path &&
    saved.viewState
  ) {
    editor.restoreViewState(saved.viewState);
  }
}
export async function openEditorFile(sessionId, file) {
  const request = ++navigationVersion;
  await flush();
  if (!file) {
    current = null;
    editor.setModel(null);
    $("codebase-file-info")?.remove();
    $("file-path").textContent = t("features:editor.noFile");
    status();
    return true;
  }
  let result;
  try {
    result = await api(
      `${workspaceURL(sessionId)}/files/content?path=${encodeURIComponent(file)}`,
    );
  } catch (error) {
    if (
      error.code !== "TEXT_REQUIRED" &&
      !([413, 415].includes(error.status) && state.session?.mode === "codebase")
    )
      throw error;
    if (state.session?.id !== sessionId || request !== navigationVersion)
      return false;
    if (state.session?.mode === "codebase") {
      const metadata = await api(
        `/api/codebase/sessions/${encodeURIComponent(sessionId)}/file?path=${encodeURIComponent(file)}`,
      );
      if (state.session?.id !== sessionId || request !== navigationVersion)
        return false;
      current = null;
      editor.setModel(null);
      $("codebase-file-info")?.remove();
      const info = node("section", "codebase-file-info");
      info.id = "codebase-file-info";
      info.append(
        node("h3", "", file),
        node(
          "p",
          "",
          t(
            metadata.kind === "binary"
              ? "features:codebase.binaryInfo"
              : "features:codebase.largeInfo",
          ),
        ),
        node(
          "p",
          "muted",
          t("features:codebase.fileBytes", { bytes: metadata.bytes }),
        ),
      );
      if (metadata.preview) info.append(node("pre", "", metadata.preview));
      $("editor-container").after(info);
      $("file-path").textContent = file;
      emit("file-active", file);
      return true;
    }
    const name = file.split("/").pop();
    const isJavaClass = /\.class$/i.test(file);
    await formDialog({
      title: isJavaClass
        ? t("features:editor.javaClass")
        : t("features:editor.notText"),
      description: isJavaClass
        ? t("features:editor.binaryJava", { p1: name })
        : t("features:editor.binary", { p1: name }),
      submit: t("features:editor.understood"),
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
        toast(t("features:editor.recovered"));
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
  $("codebase-file-info")?.remove();
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
    if (e.status === 404) return { content: t("features:editor.removed") };
    throw e;
  });
  const result = await formDialog({
    title: t("features:editor.compare"),
    description: t("features:editor.keepLocal"),
    fields: [
      {
        name: "remote",
        label: t("features:editor.serverVersion"),
        type: "textarea",
        value: remote.content,
        readOnly: true,
      },
      {
        name: "local",
        label: t("features:editor.localVersion"),
        type: "textarea",
        value: record.model.getValue(),
        readOnly: true,
      },
      {
        name: "action",
        label: t("features:editor.action"),
        type: "select",
        options: [
          { value: "copy", label: t("features:editor.copyLocal") },
          { value: "reload", label: t("features:editor.loadServer") },
        ],
      },
      {
        name: "path",
        label: t("features:editor.backupName"),
        value: `recovered-${Date.now()}-${record.path.split("/").pop()}`,
      },
    ],
    submit: t("features:editor.execute"),
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
    toast(t("features:editor.localSaved", { p1: result.path }));
  }
  record.dirty = false;
  record.error = null;
  removeDraft(record);
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

export function revealLine(line) {
  editor?.setPosition({ lineNumber: line, column: 1 });
  editor?.revealLineInCenter(line);
  editor?.focus();
}
export function revealRange(startLine, endLine = startLine) {
  const count = editor?.getModel()?.getLineCount();
  if (
    !count ||
    !Number.isInteger(startLine) ||
    !Number.isInteger(endLine) ||
    startLine < 1 ||
    endLine < startLine ||
    endLine > count
  )
    throw new Error(t("features:codebase.invalidRange"));
  editor.setSelection({
    startLineNumber: startLine,
    startColumn: 1,
    endLineNumber: endLine,
    endColumn: editor.getModel().getLineMaxColumn(endLine),
  });
  editor.revealLinesInCenter(startLine, endLine);
  editor.focus();
}
export function explainSelection(projectContext = false) {
  const selection = editor?.getSelection();
  if (!current || !selection || selection.isEmpty())
    return toast(t("features:codebase.selectCode"));
  const reference = {
    sessionId: current.sessionId,
    path: current.path,
    startLine: selection.startLineNumber,
    endLine: selection.endLineNumber,
    fileVersion: current.version,
  };
  if (state.session?.mode === "codebase")
    emit("explain-code-reference", {
      reference,
      projectContext,
      draft: current.dirty,
    });
  else emit("explain-code", current.model.getValueInRange(selection));
}
