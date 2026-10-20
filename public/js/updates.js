import { api, getPendingMutationCount } from "./api.js";
import { t } from "./i18n.js";
import { state } from "./state.js";
import { flushAll, hasUnsavedChanges } from "./editor.js";
import { toast, formDialog } from "./ui.js";
import { randomUUID } from "./uuid.js";

let started = false;
let lastInteraction = Date.now();
let current;
const id = randomUUID();
function button(key, action) {
  const element = document.createElement("button");
  element.type = "button";
  element.textContent = t(`updates:${key}`);
  element.addEventListener("click", async () => {
    element.disabled = true;
    try {
      await action();
    } catch (error) {
      toast(error.message, "error");
    } finally {
      element.disabled = false;
    }
  });
  return element;
}
async function refresh() {
  const previous = current;
  current = await api("/api/updates");
  if (
    previous?.operation &&
    ![
      "succeeded",
      "rolled-back",
      "failed",
      "deferred",
      "recovery-failed",
    ].includes(previous.operation.phase) &&
    ["succeeded", "rolled-back"].includes(current.operation?.phase) &&
    previous.operation.id === current.operation.id &&
    !hasUnsavedChanges() &&
    !state.busy &&
    !getPendingMutationCount()
  ) {
    location.reload();
    return;
  }
  render();
}
function render() {
  const banner = document.getElementById("update-banner");
  banner.replaceChildren();
  const busy =
    current.operation &&
    ![
      "succeeded",
      "failed",
      "deferred",
      "rolled-back",
      "recovery-failed",
    ].includes(current.operation.phase);
  banner.hidden = !current.available && !current.operation;
  const text = document.createElement("span");
  text.textContent = busy
    ? t("updates:progress")
    : current.operation?.phase === "recovery-failed"
      ? t("updates:recoveryFailed")
      : current.available
        ? t("updates:available", {
            installed: current.installed,
            latest: current.latest,
          })
        : t("updates:installed", { version: current.installed });
  banner.append(text);
  if (current.operation?.recoveryCommand)
    for (const command of current.operation.recoveryCommand) {
      const code = document.createElement("code");
      code.textContent = command;
      banner.append(code);
    }
  if (current.notesURL) {
    const a = document.createElement("a");
    a.href = current.notesURL;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.textContent = t("updates:notes");
    banner.append(a);
  }
  if (
    current.installable &&
    !busy &&
    current.operation?.phase !== "recovery-failed"
  )
    banner.append(
      button("install", async () => {
        await flushAll();
        await api("/api/updates/activity", {
          method: "POST",
          body: { id, busy: false, dirty: false },
        });
        current = await api("/api/updates/install", {
          method: "POST",
          body: {},
        });
        render();
      }),
    );
  if (current.available && !current.managed) {
    const link = document.createElement("a");
    link.href = "https://sterra.online/code-install/";
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = t("updates:takeover");
    banner.append(link);
  } else if (current.available && !current.installable) {
    const hint = document.createElement("span");
    hint.textContent = t("updates:incompatible");
    banner.append(hint);
  }
}
export async function openUpdateSettings() {
  await refresh();
  let check = false;
  const settings = current.settings;
  await formDialog({
    title: t("updates:title"),
    description: [
      t("updates:installed", { version: current.installed }),
      current.error ? t("updates:checkFailed") : "",
      !settings ? t("updates:unmanaged") : "",
    ]
      .filter(Boolean)
      .join(" "),
    submit: t(settings ? "updates:save" : "updates:close"),
    actions: [
      {
        label: t("updates:check"),
        onClick: () => {
          check = true;
        },
      },
    ],
    fields: settings
      ? [
          {
            name: "enabled",
            label: t("updates:automatic"),
            type: "checkbox",
            value: settings.enabled,
          },
          {
            name: "hour",
            label: t("updates:hour"),
            type: "number",
            min: 0,
            max: 23,
            step: 1,
            required: true,
            value: settings.hour,
          },
          {
            name: "timeZone",
            label: t("updates:zone"),
            value: settings.timeZone,
            required: true,
          },
        ]
      : [],
    onSave: async (values) => {
      if (settings) {
        await api("/api/updates/settings", { method: "PATCH", body: values });
        await refresh();
      }
    },
  });
  if (check) {
    await api("/api/updates/check", { method: "POST", body: {} });
    await refresh();
    toast(t(current.error ? "updates:checkFailed" : "updates:checked"));
    await openUpdateSettings();
  }
}
export function initUpdates() {
  if (started) return;
  started = true;
  const banner = document.createElement("aside");
  banner.id = "update-banner";
  banner.className = "update-banner";
  banner.hidden = true;
  banner.setAttribute("role", "status");
  document.body.prepend(banner);
  for (const name of ["keydown", "pointerdown", "input"])
    window.addEventListener(
      name,
      () => {
        lastInteraction = Date.now();
      },
      { passive: true },
    );
  window.addEventListener("locale-changed", () => {
    if (current) render();
  });
  const heartbeat = async () => {
    const dirty =
      getPendingMutationCount() > 0 || state.busy || hasUnsavedChanges();
    await api("/api/updates/activity", {
      method: "POST",
      body: {
        id,
        dirty: Boolean(dirty),
        busy: !document.hidden && Date.now() - lastInteraction < 120000,
      },
    });
  };
  refresh().catch(() => {});
  heartbeat().catch(() => {});
  setInterval(() => {
    refresh().catch(() => {});
    heartbeat().catch(() => {});
  }, 30000);
}
