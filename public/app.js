import { api } from "./js/api.js";
import { state, emit, on } from "./js/state.js";
import { $, node, toast, formDialog, applyTheme } from "./js/ui.js";
import {
  initEditor,
  flush,
  resolveSave,
  layoutEditor,
  updateEditorTheme,
} from "./js/editor.js";
import { createSession, loadSessions, languageOptions } from "./js/sessions.js";
import { initWorkspace } from "./js/workspace.js";
import { initChat, updateChatState, showChanges } from "./js/chat.js";
import { initTerminal, updateRunState } from "./js/terminal.js";

let modelsLoading = false,
  layoutTimer;
async function refreshModels() {
  if (modelsLoading) return;
  modelsLoading = true;
  $("refresh-models").disabled = true;
  try {
    const data = await api("/api/models");
    state.connected = data.connected;
    state.models = data.models;
    const select = $("model-select");
    select.replaceChildren();
    for (const model of data.models) {
      const option = node("option", "", model.name);
      option.value = model.id;
      select.append(option);
    }
    if (data.models.length) {
      if (!data.models.some((m) => m.id === state.settings.activeModel))
        state.settings = await api("/api/chat/settings", {
          method: "PATCH",
          body: { activeModel: data.models[0].id },
        });
      select.value = state.settings.activeModel;
    } else {
      const option = node(
        "option",
        "",
        data.connected ? "Kein Modell geladen" : "LM Studio offline",
      );
      option.value = "";
      select.append(option);
    }
    select.disabled = !data.models.length;
    state.ready =
      data.connected &&
      data.models.some((m) => m.id === state.settings.activeModel);
    const text = state.ready
      ? "LM Studio verbunden"
      : data.connected
        ? "Bitte in LM Studio ein Modell laden."
        : data.error || "LM Studio starten und den lokalen Server aktivieren.";
    $("connection-badge").className =
      `status-dot ${state.ready ? "ready" : "offline"}`;
    $("connection-badge").setAttribute("aria-label", text);
    $("connection-badge").title = text;
    $("connection-text").textContent = state.ready
      ? "LM Studio verbunden"
      : data.connected
        ? "Kein Modell geladen"
        : "LM Studio offline";
    $("connection-help").textContent = state.ready ? "" : text;
    $("welcome-status").textContent = state.ready
      ? "Dein lokaler KI-Tutor ist bereit."
      : `${text} Du kannst Sessions und Dateien bereits offline bearbeiten.`;
  } finally {
    modelsLoading = false;
    $("refresh-models").disabled = false;
    emit("models-changed");
  }
}
async function refreshRuntimes() {
  state.runtimes = await api("/api/runtimes");
  updateRunState();
}
function sidebarState() {
  const narrow = innerWidth < 1280,
    open = narrow
      ? $("app").classList.contains("sidebar-open")
      : !$("app").classList.contains("sidebar-collapsed");
  $("sidebar").inert = !open;
  $("sidebar-toggle").setAttribute("aria-expanded", String(open));
  $("sidebar-backdrop").hidden = !(narrow && open);
}
function toggleSidebar() {
  const narrow = innerWidth < 1280;
  $("app").classList.toggle(narrow ? "sidebar-open" : "sidebar-collapsed");
  sidebarState();
  if (narrow && $("app").classList.contains("sidebar-open"))
    $("new-session-btn").focus();
  applyLayout();
}
function closeSidebar() {
  if (innerWidth < 1280) {
    $("app").classList.remove("sidebar-open");
    sidebarState();
  }
}
function applyLayout() {
  const root = document.documentElement.style;
  root.setProperty("--sidebar-w", `${state.settings.sidebarWidth || 256}px`);
  const width = $("panes").clientWidth || $("workbench").clientWidth;
  let ratio = state.settings.editorRatio || 0.6;
  if (width >= 684)
    ratio = Math.max(360 / width, Math.min(1 - 324 / width, ratio));
  root.setProperty("--editor-ratio", ratio);
  root.setProperty(
    "--terminal-h",
    `${Math.min(state.settings.terminalHeight || 180, innerHeight * 0.4)}px`,
  );
  for (const [id, value, min, max] of [
    ["sidebar-resizer", state.settings.sidebarWidth || 256, 220, 360],
    ["editor-resizer", Math.round(ratio * 100), 30, 75],
    [
      "terminal-resizer",
      Math.round(
        Math.min(state.settings.terminalHeight || 180, innerHeight * 0.4),
      ),
      120,
      Math.floor(innerHeight * 0.4),
    ],
  ]) {
    const e = $(id);
    e.setAttribute("aria-valuenow", value);
    e.setAttribute("aria-valuemin", min);
    e.setAttribute("aria-valuemax", max);
  }
  sidebarState();
  requestAnimationFrame(layoutEditor);
}
function persistLayout() {
  clearTimeout(layoutTimer);
  layoutTimer = setTimeout(
    () =>
      api("/api/chat/settings", {
        method: "PATCH",
        body: {
          sidebarWidth: state.settings.sidebarWidth,
          editorRatio: state.settings.editorRatio,
          terminalHeight: state.settings.terminalHeight,
          layoutVersion: 1,
        },
      }).catch((e) => toast(e.message, "error")),
    350,
  );
}
function initLayout() {
  for (const [id, change, keyChange] of [
    [
      "sidebar-resizer",
      (event) => {
        state.settings.sidebarWidth = Math.max(
          220,
          Math.min(360, event.clientX),
        );
      },
      (delta) => {
        state.settings.sidebarWidth = Math.max(
          220,
          Math.min(360, (state.settings.sidebarWidth || 256) + delta * 10),
        );
      },
    ],
    [
      "editor-resizer",
      (event) => {
        const rect = $("panes").getBoundingClientRect();
        state.settings.editorRatio = Math.max(
          0.3,
          Math.min(0.75, (event.clientX - rect.left) / rect.width),
        );
      },
      (delta) => {
        state.settings.editorRatio = Math.max(
          0.3,
          Math.min(0.75, (state.settings.editorRatio || 0.6) + delta * 0.02),
        );
      },
    ],
    [
      "terminal-resizer",
      (event) => {
        state.settings.terminalHeight = Math.max(
          120,
          Math.min(
            innerHeight * 0.4,
            $("terminal-panel").getBoundingClientRect().bottom - event.clientY,
          ),
        );
      },
      (delta) => {
        state.settings.terminalHeight = Math.max(
          120,
          Math.min(
            innerHeight * 0.4,
            (state.settings.terminalHeight || 180) - delta * 10,
          ),
        );
      },
    ],
  ]) {
    const handle = $(id);
    handle.addEventListener("pointerdown", (event) => {
      handle.setPointerCapture(event.pointerId);
      const move = (e) => {
        change(e);
        applyLayout();
      };
      const end = () => {
        handle.removeEventListener("pointermove", move);
        persistLayout();
      };
      handle.addEventListener("pointermove", move);
      handle.addEventListener("pointerup", end, { once: true });
      handle.addEventListener("pointercancel", end, { once: true });
    });
    handle.addEventListener("keydown", (event) => {
      const delta = ["ArrowRight", "ArrowDown"].includes(event.key)
        ? 1
        : ["ArrowLeft", "ArrowUp"].includes(event.key)
          ? -1
          : 0;
      if (delta) {
        event.preventDefault();
        keyChange(delta);
        applyLayout();
        persistLayout();
      }
    });
  }
  $("sidebar-toggle").addEventListener("click", toggleSidebar);
  $("sidebar-backdrop").addEventListener("click", closeSidebar);
  on("close-sidebar", closeSidebar);
  on("layout", applyLayout);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !$("app-dialog").open) {
      closeSidebar();
      $("sidebar-toggle").focus();
    }
  });
  window.addEventListener("resize", applyLayout);
  for (const view of ["editor", "chat"])
    $(`view-${view}`).addEventListener("click", () => {
      $("app").dataset.view = view;
      for (const v of ["editor", "chat"])
        $(`view-${v}`).setAttribute("aria-pressed", String(v === view));
      layoutEditor();
    });
  const tabs = ["sessions", "files", "plan"];
  function activate(name) {
    for (const tab of tabs) {
      const selected = tab === name;
      $(`tab-${tab}`).setAttribute("aria-selected", String(selected));
      $(`tab-${tab}`).tabIndex = selected ? 0 : -1;
      $(`${tab}-view`).hidden = !selected;
    }
  }
  for (const [index, name] of tabs.entries()) {
    $(`tab-${name}`).addEventListener("click", () => activate(name));
    $(`tab-${name}`).addEventListener("keydown", (event) => {
      if (["ArrowLeft", "ArrowRight"].includes(event.key)) {
        const next = tabs[(index + (event.key === "ArrowRight" ? 1 : 2)) % 3];
        activate(next);
        $(`tab-${next}`).focus();
        event.preventDefault();
      }
    });
  }
  activate("sessions");
  applyLayout();
}
async function openSettings() {
  const s = state.settings;
  const fields = [
    {
      name: "lmStudioUrl",
      label: "LM-Studio-URL",
      value: s.lmStudioUrl,
      required: true,
    },
    { name: "activeModel", label: "Modell-ID", value: s.activeModel || "" },
    {
      name: "theme",
      label: "Darstellung",
      type: "select",
      value: s.theme,
      options: [
        { value: "dark", label: "Dunkel" },
        { value: "light", label: "Hell" },
        { value: "high-contrast", label: "Hoher Kontrast" },
        { value: "solarized", label: "Solarized" },
      ],
    },
    {
      name: "fontSize",
      label: "Editor-Schriftgröße",
      type: "number",
      value: s.fontSize,
      min: 10,
      max: 24,
    },
    {
      name: "executionTimeout",
      label: "Ausführungszeit (Millisekunden)",
      type: "number",
      value: s.executionTimeout,
      min: 0,
      max: 600000,
      help: "0 bedeutet kein Zeitlimit. Prozesse lassen sich jederzeit stoppen.",
    },
    {
      name: "allowAITerminalCommands",
      label: "KI darf Terminalbefehle ausführen",
      type: "checkbox",
      value: s.allowAITerminalCommands,
    },
    {
      name: "streaming",
      label: "Antworten während der Erstellung anzeigen",
      type: "checkbox",
      value: s.streaming,
    },
    {
      name: "temperature",
      label: "Temperatur",
      type: "number",
      value: s.temperature,
      min: 0,
      max: 1,
      step: 0.05,
      advanced: true,
    },
    {
      name: "maxTokensResponse",
      label: "Maximale Antwort-Tokens",
      type: "number",
      value: s.maxTokensResponse,
      min: 256,
      max: 32768,
      advanced: true,
    },
    {
      name: "autoCompact",
      label: "Kontext automatisch komprimieren",
      type: "checkbox",
      value: s.autoCompact,
      advanced: true,
    },
    ...[
      ["thresholdPercent", "Kontext komprimieren ab (%)", 10, 95],
      ["compactFloorPercent", "Kontext verkleinern auf (%)", 5, 90],
      ["keepRecentTokens", "Neuester wörtlicher Kontext (Tokens)", 0, 50000],
      ["chunkTokens", "Abschnittsgröße (Tokens)", 1000, 64000],
      [
        "summarizerMaxTokens",
        "Zusammenfassung je Abschnitt (Tokens)",
        200,
        8000,
      ],
      [
        "summaryBudgetTokens",
        "Gesamtbudget für Zusammenfassungen (Tokens)",
        200,
        64000,
      ],
      [
        "maxToolResultTokens",
        "Modellbudget je Werkzeugergebnis (Tokens)",
        256,
        64000,
      ],
      [
        "maxTotalToolResultTokens",
        "Modellbudget für Werkzeugausgaben je Runde (Tokens)",
        256,
        128000,
      ],
    ].map(([name, label, min, max]) => ({
      name,
      label,
      type: "number",
      value: s[name],
      min,
      max,
      advanced: true,
    })),
    {
      name: "summarizerPromptMode",
      label: "Zusammenfassungsprompt",
      type: "select",
      value: s.summarizerPromptMode,
      options: [
        { value: "auto", label: "Automatisch" },
        { value: "full", label: "Vollständig" },
        { value: "compact", label: "Kompakt" },
      ],
      advanced: true,
    },
    {
      name: "maxToolCallsPerTurn",
      label: "Maximale Tool-Aufrufe je Antwort",
      type: "number",
      value: s.maxToolCallsPerTurn,
      min: 1,
      max: 20,
      advanced: true,
    },
    {
      name: "compilationTimeout",
      label: "Kompilierungszeit (Millisekunden)",
      type: "number",
      value: s.compilationTimeout,
      min: 1000,
      max: 600000,
      advanced: true,
    },
    {
      name: "crossChatProfileEnabled",
      label: "Sprachprofil über Sessions hinweg verwenden",
      type: "checkbox",
      value: s.crossChatProfileEnabled,
      advanced: true,
    },
    {
      name: "autoUpdateProfileOnTaskDone",
      label: "Sprachprofil nach Aufgaben aktualisieren",
      type: "checkbox",
      value: s.autoUpdateProfileOnTaskDone,
      advanced: true,
    },
    ...languageOptions.map((l) => ({
      name: `enabled-${l.value}`,
      label: `Ausführen erlauben: ${l.label}`,
      type: "checkbox",
      value: s.allowedLanguages.includes(l.value),
      advanced: true,
    })),
    {
      name: "systemPrompt",
      label: "Systemanweisung",
      type: "textarea",
      rows: 8,
      value: s.systemPrompt,
      advanced: true,
    },
    {
      name: "resetPrompt",
      label: "Systemanweisung auf Standard zurücksetzen",
      type: "checkbox",
      value: false,
      advanced: true,
    },
  ];
  const result = await formDialog({
    title: "Einstellungen",
    fields,
    onPreview: (values) => applyTheme(values.theme),
    onSave: async (values) => {
      const updates = {
        ...values,
        activeModel: values.activeModel || null,
        allowedLanguages: languageOptions
          .filter((l) => values[`enabled-${l.value}`])
          .map((l) => l.value),
      };
      for (const l of languageOptions) delete updates[`enabled-${l.value}`];
      if (updates.resetPrompt)
        updates.systemPrompt = (await api("/api/chat/default-prompt")).prompt;
      delete updates.resetPrompt;
      state.settings = await api("/api/chat/settings", {
        method: "PATCH",
        body: updates,
      });
    },
  });
  if (!result) applyTheme(s.theme);
  else {
    applyTheme(state.settings.theme);
    updateEditorTheme();
    await Promise.all([refreshModels(), refreshRuntimes()]);
    toast("Einstellungen gespeichert.");
  }
}
async function init() {
  state.settings = await api("/api/chat/settings");
  applyTheme(state.settings.theme);
  for (const l of languageOptions) {
    const option = node("option", "", l.label);
    option.value = l.value;
    $("language-select").append(option);
  }
  initLayout();
  await initEditor();
  initWorkspace();
  initChat();
  initTerminal();
  $("changes-btn").addEventListener("click", () =>
    showChanges().catch((e) => toast(e.message, "error")),
  );
  $("new-session-btn").disabled = false;
  $("welcome-new").disabled = false;
  for (const id of ["new-session-btn", "welcome-new"])
    $(id).addEventListener("click", () =>
      createSession().catch((e) => toast(e.message, "error")),
    );
  $("save-btn").addEventListener("click", () =>
    flush().catch((e) => toast(e.message, "error")),
  );
  $("save-status").addEventListener("click", () =>
    resolveSave().catch((e) => toast(e.message, "error")),
  );
  $("settings-btn").addEventListener("click", () =>
    openSettings().catch((e) => toast(e.message, "error")),
  );
  $("refresh-models").addEventListener("click", () =>
    Promise.all([refreshModels(), refreshRuntimes()]).catch((e) =>
      toast(e.message, "error"),
    ),
  );
  $("model-select").addEventListener("change", async () => {
    try {
      state.settings = await api("/api/chat/settings", {
        method: "PATCH",
        body: { activeModel: $("model-select").value },
      });
      await refreshModels();
    } catch (e) {
      toast(e.message, "error");
    }
  });
  $("language-select").addEventListener("change", async () => {
    try {
      if (!state.session) return;
      await flush();
      state.session = await api(`/api/sessions/${state.session.id}`, {
        method: "PATCH",
        body: { language: $("language-select").value },
      });
      updateRunState();
    } catch (e) {
      toast(e.message, "error");
    }
  });
  const results = await Promise.allSettled([
    loadSessions(),
    refreshModels(),
    refreshRuntimes(),
  ]);
  for (const result of results)
    if (result.status === "rejected") toast(result.reason.message, "error");
  updateChatState();
  updateRunState();
  setInterval(
    () => refreshModels().catch((e) => toast(e.message, "error")),
    30000,
  );
  if (!state.settings.layoutVersion && state.settings.editorWidth) {
    state.settings.editorRatio = Math.max(
      0.3,
      Math.min(
        0.75,
        parseFloat(state.settings.editorWidth) / $("workbench").clientWidth,
      ),
    );
    persistLayout();
  }
  applyLayout();
}
init().catch((error) =>
  toast(
    `SterraCode konnte nicht vollständig starten: ${error.message}`,
    "error",
  ),
);
