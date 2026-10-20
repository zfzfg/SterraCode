import { t, formatNumber } from "./js/i18n.js";
import { openAIModelOptions } from "./js/providerModels.js";
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
import {
  createSession,
  loadSessions,
  languageOptions,
  openSession,
} from "./js/sessions.js";
import { initLocaleSwitch, restoreLocaleSwitch } from "./js/localeSwitch.js";
import { initWorkspace } from "./js/workspace.js";
import { initChat, updateChatState, showChanges } from "./js/chat.js";
import { initTerminal, updateRunState, showTerminal } from "./js/terminal.js";
import {
  ensureAccess,
  changePassword,
  configureModel,
  openCredentials,
} from "./js/setup.js";
import { openPrograms } from "./js/programs.js";
import { initTracer } from "./js/tracer.js";
import { initPreview } from "./js/preview.js";
import { openProfile } from "./js/profile.js";
import { openProjects, openExport, openJournal } from "./js/projects.js";

for (const [id, open] of [
  ["projects-btn", openProjects],
  ["project-export-btn", openExport],
  ["journal-btn", openJournal],
])
  $(id).addEventListener("click", () =>
    open().catch((e) => toast(e.message, "error")),
  );

$("profile-btn").addEventListener("click", () =>
  openProfile().catch((e) => toast(e.message, "error")),
);

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
    const modelKey =
      state.settings.provider === "openai" ? "openAIModel" : "activeModel";
    const providerName =
      state.settings.provider === "openai" ? "OpenAI" : "LM Studio";
    const select = $("model-select");
    select.replaceChildren();
    for (const model of data.models) {
      const option = node(
        "option",
        "",
        model.contextLength
          ? t("app:model.context", {
              name: model.name,
              tokens: formatNumber(model.contextLength),
            })
          : model.name,
      );
      option.value = model.id;
      select.append(option);
    }
    if (
      modelKey === "openAIModel" &&
      state.settings[modelKey] &&
      !data.models.some((model) => model.id === state.settings[modelKey])
    ) {
      const configured = node(
        "option",
        "",
        t("app:model.custom", { name: state.settings[modelKey] }),
      );
      configured.value = state.settings[modelKey];
      select.append(configured);
    }
    if (select.options.length) {
      if (
        modelKey === "activeModel" &&
        !data.models.some((m) => m.id === state.settings[modelKey])
      )
        state.settings = await api("/api/chat/settings", {
          method: "PATCH",
          body: { activeModel: data.models[0].id },
        });
      if (modelKey === "openAIModel" && !state.settings[modelKey]) {
        const placeholder = node("option", "", t("app:model.choose"));
        placeholder.value = "";
        select.prepend(placeholder);
      }
      select.value = state.settings[modelKey];
    } else {
      const option = node(
        "option",
        "",
        data.connected
          ? t("app:model.none")
          : t("app:model.offline", { provider: providerName }),
      );
      option.value = "";
      select.append(option);
    }
    select.disabled = !data.connected || !select.options.length;
    state.ready =
      data.connected &&
      (modelKey === "openAIModel"
        ? Boolean(state.settings[modelKey])
        : data.models.some((m) => m.id === state.settings[modelKey]));
    const text = state.ready
      ? t("app:model.connected", { provider: providerName })
      : data.connected
        ? modelKey === "openAIModel"
          ? t("app:model.chooseHelp")
          : t("app:model.loadHelp")
        : data.error ||
          t("app:model.credentialsHelp", { provider: providerName });
    $("connection-badge").className =
      `status-dot ${state.ready ? "ready" : "offline"}`;
    $("connection-badge").setAttribute("aria-label", text);
    $("connection-badge").title = text;
    $("connection-text").textContent = state.ready
      ? t("app:model.connected", { provider: providerName })
      : data.connected
        ? modelKey === "openAIModel"
          ? t("app:model.notSelected")
          : t("app:model.notLoaded")
        : t("app:model.offline", { provider: providerName });
    $("connection-help").textContent = state.ready ? "" : text;
    $("welcome-status").textContent = state.ready
      ? t("app:model.ready")
      : t("app:model.offlineHelp", { status: text });
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
function terminalMaxHeight() {
  return Math.max(120, Math.min(1200, $("editor-area").clientHeight - 180));
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
    `${Math.min(state.settings.terminalHeight || 180, terminalMaxHeight())}px`,
  );
  for (const [id, value, min, max] of [
    ["sidebar-resizer", state.settings.sidebarWidth || 256, 220, 360],
    ["editor-resizer", Math.round(ratio * 100), 30, 75],
    [
      "terminal-resizer",
      $("terminal-panel").hidden
        ? 0
        : Math.round(
            Math.min(state.settings.terminalHeight || 180, terminalMaxHeight()),
          ),
      0,
      terminalMaxHeight(),
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
        const height =
          $("editor-area").getBoundingClientRect().bottom - event.clientY;
        if (height < 50) {
          if (!$("terminal-panel").hidden) showTerminal(false);
          return;
        }
        state.settings.terminalHeight = Math.max(
          120,
          Math.min(terminalMaxHeight(), height),
        );
        if ($("terminal-panel").hidden) showTerminal(true);
      },
      (delta) => {
        if ($("terminal-panel").hidden) {
          if (delta < 0) showTerminal(true);
          return;
        }
        if (delta > 0 && state.settings.terminalHeight <= 120) {
          showTerminal(false);
          return;
        }
        state.settings.terminalHeight = Math.max(
          120,
          Math.min(
            terminalMaxHeight(),
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
      if (id === "terminal-resizer" && ["Enter", " "].includes(event.key)) {
        event.preventDefault();
        showTerminal($("terminal-panel").hidden);
        return;
      }
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
  const credentials = await api("/api/provider/credentials");
  const externalOpenAIKey = credentials.openai?.source === "file";
  let nextAction;
  const fields = [
    {
      name: "provider",
      label: t("auth:model.provider"),
      type: "select",
      value: s.provider || "lmstudio",
      options: [
        {
          value: "lmstudio",
          label: t("app:settings.lmstudio"),
        },
        { value: "openai", label: "OpenAI API" },
      ],
    },
    {
      name: "openAIApiKey",
      label: t("app:settings.apiKey"),
      type: "password",
      value: "",
      maxLength: 2048,
      autocomplete: "off",
      disabled: externalOpenAIKey,
      help: externalOpenAIKey
        ? t("app:settings.secret")
        : credentials.openai?.configured
          ? t("app:settings.keyExists")
          : t("app:settings.keyHelp"),
    },
    {
      name: "lmStudioUrl",
      label: t("auth:model.lmUrl"),
      value: s.lmStudioUrl,
      required: true,
    },
    {
      name: "activeModel",
      label: t("app:settings.lmModelId"),
      value: s.activeModel || "",
    },
    {
      name: "openAIModel",
      label: t("auth:model.openai"),
      type: "select",
      options: await openAIModelOptions(s.openAIModel),
      value: s.openAIModel || "",
      help: t("app:settings.modelHelp"),
    },
    {
      name: "theme",
      label: t("app:settings.theme"),
      type: "select",
      value: s.theme,
      options: [
        { value: "dark", label: t("app:settings.dark") },
        { value: "light", label: t("app:settings.light") },
        { value: "high-contrast", label: t("app:settings.contrast") },
        { value: "solarized", label: "Solarized" },
      ],
    },
    {
      name: "fontSize",
      label: t("app:settings.font"),
      type: "number",
      value: s.fontSize,
      min: 10,
      max: 24,
    },
    {
      name: "executionTimeout",
      label: t("app:settings.timeout"),
      type: "number",
      value: s.executionTimeout,
      min: 0,
      max: 600000,
      help: t("app:settings.timeoutHelp"),
    },
    {
      name: "allowAITerminalCommands",
      label: t("app:settings.aiCommands"),
      type: "checkbox",
      value: s.allowAITerminalCommands,
    },
    {
      name: "reviewAIChanges",
      label: t("app:static.changes"),
      type: "select",
      value: String(Boolean(s.reviewAIChanges)),
      options: [
        { value: "false", label: t("app:settings.accept") },
        { value: "true", label: t("app:settings.review") },
      ],
      help: t("app:settings.reviewHelp"),
    },
    {
      name: "streaming",
      label: t("app:settings.streaming"),
      type: "checkbox",
      value: s.streaming,
    },
    {
      name: "temperature",
      label: t("app:settings.temperature"),
      type: "number",
      value: s.temperature,
      min: 0,
      max: 1,
      step: 0.05,
      advanced: true,
    },
    {
      name: "maxTokensResponse",
      label: t("app:settings.maxResponse"),
      help: t("app:settings.maxResponseHelp"),
      type: "number",
      value: s.maxTokensResponse,
      min: 256,
      max: 32768,
      advanced: true,
    },
    {
      name: "autoCompact",
      label: t("app:settings.autoCompact"),
      help: t("app:settings.compactHelp"),
      type: "checkbox",
      value: s.autoCompact,
      advanced: true,
    },
    ...[
      ["thresholdPercent", t("app:settings.threshold"), 10, 95],
      ["compactFloorPercent", t("app:settings.floor"), 5, 90],
      ["keepRecentTokens", t("app:settings.recent"), 0, 50000],
      ["chunkTokens", t("app:settings.chunk"), 1000, 64000],
      ["summarizerMaxTokens", t("app:settings.summary"), 200, 8000],
      ["summaryBudgetTokens", t("app:settings.summaryBudget"), 200, 64000],
      ["maxToolResultTokens", t("app:settings.resultBudget"), 256, 64000],
      [
        "maxTotalToolResultTokens",
        t("app:settings.totalResultBudget"),
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
      label: t("app:settings.summaryPrompt"),
      type: "select",
      value: s.summarizerPromptMode,
      options: [
        { value: "auto", label: t("app:settings.auto") },
        { value: "full", label: t("app:settings.full") },
        { value: "compact", label: t("app:settings.compact") },
      ],
      advanced: true,
    },
    {
      name: "maxToolCallsPerTurn",
      label: t("app:settings.toolCalls"),
      type: "number",
      value: s.maxToolCallsPerTurn,
      min: 1,
      max: 20,
      advanced: true,
    },
    {
      name: "compilationTimeout",
      label: t("app:settings.compile"),
      type: "number",
      value: s.compilationTimeout,
      min: 1000,
      max: 600000,
      advanced: true,
    },
    {
      name: "crossChatProfileEnabled",
      label: t("app:settings.crossProfile"),
      type: "checkbox",
      value: s.crossChatProfileEnabled,
      advanced: true,
    },
    {
      name: "autoUpdateProfileOnTaskDone",
      label: t("app:settings.updateProfile"),
      type: "checkbox",
      value: s.autoUpdateProfileOnTaskDone,
      advanced: true,
    },
    ...languageOptions.map((l) => ({
      name: `enabled-${l.value}`,
      label: t("app:settings.allowRun", { language: l.label }),
      type: "checkbox",
      value: s.allowedLanguages.includes(l.value),
      advanced: true,
    })),
    {
      name: "systemPrompt",
      label: t("app:settings.systemPrompt"),
      type: "textarea",
      rows: 8,
      value: s.systemPrompt,
      advanced: true,
    },
    {
      name: "resetPrompt",
      label: t("app:settings.resetPrompt"),
      type: "checkbox",
      value: false,
      advanced: true,
    },
  ];
  const result = await formDialog({
    title: t("app:static.settings"),
    actions: [
      {
        label: t("auth:credentials.title"),
        onClick: () => {
          nextAction = async () => {
            await openCredentials();
            await refreshModels();
          };
        },
      },
      ...(state.server.mode === "docker" || state.server.authRequired
        ? [
            {
              label: t("app:settings.programs"),
              onClick: () => {
                nextAction = () => openPrograms();
              },
            },
            {
              label: t("app:settings.server"),
              onClick: () => {
                nextAction = showServer;
              },
            },
            {
              label: t("app:settings.password"),
              onClick: () => {
                nextAction = changePassword;
              },
            },
            {
              label: t("app:settings.logout"),
              onClick: () => {
                nextAction = async () => {
                  await flush();
                  await api("/api/logout", { method: "POST", body: {} });
                  location.reload();
                };
              },
            },
          ]
        : []),
    ],
    fields,
    onPreview: (values) => applyTheme(values.theme),
    onSave: async ({ openAIApiKey, ...values }) => {
      if (openAIApiKey.trim() && !externalOpenAIKey)
        await api("/api/provider/credentials", {
          method: "PATCH",
          body: { provider: "openai", apiKey: openAIApiKey.trim() },
        });
      const updates = {
        ...values,
        activeModel: values.activeModel || null,
        reviewAIChanges: values.reviewAIChanges === "true",
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
    toast(t("app:settings.saved"));
  }
  if (nextAction) await nextAction();
}
async function showServer() {
  const server = await api("/api/server");
  let diagnosis;
  try {
    diagnosis = await api("/api/diagnostics");
  } catch (error) {
    diagnosis = { error: error.message };
  }
  await formDialog({
    title: t("app:settings.server"),
    description: t("app:server.description"),
    fields: [
      {
        name: "address",
        label: t("app:server.address"),
        value: server.publicUrl || location.origin,
        readOnly: true,
      },
      {
        name: "source",
        label: t("app:server.source"),
        value: server.source || ".env / Compose",
        readOnly: true,
      },
      {
        name: "diagnostics",
        label: t("app:server.diagnostics"),
        type: "textarea",
        rows: 12,
        value: JSON.stringify(diagnosis, null, 2),
        readOnly: true,
      },
    ],
  });
}
async function init() {
  const access = await ensureAccess();
  state.server = await api("/api/server");
  if (state.server.mode === "docker" || access.authRequired)
    $("workspace-status").textContent = t("app:server.mode", {
      address: state.server.publicUrl || location.origin,
    });
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
  initTracer();
  initPreview();
  initLocaleSwitch({ openSession });
  $("changes-btn").addEventListener("click", () =>
    showChanges().catch((e) => toast(e.message, "error")),
  );
  $("new-session-btn").disabled = false;
  $("profile-btn").disabled = false;
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
        body: {
          [state.settings.provider === "openai"
            ? "openAIModel"
            : "activeModel"]: $("model-select").value,
        },
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
  await restoreLocaleSwitch();
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
  if (access.created) {
    await openPrograms({ initial: true });
    await configureModel();
    state.settings = await api("/api/chat/settings");
    await Promise.allSettled([refreshModels(), refreshRuntimes()]);
  }
}
window.addEventListener("auth-required", () => {
  ensureAccess().catch((error) => toast(error.message, "error"));
});
init().catch((error) =>
  toast(t("app:startup.failed", { message: error.message }), "error"),
);
