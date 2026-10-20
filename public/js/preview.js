import {
  t,
  getLocale,
  getFormatLocale,
  formatNumber,
  translateMessage,
} from "./i18n.js";
import { api, workspaceURL } from "./api.js";
import { state, on, emit } from "./state.js";
import { flush, currentFile, revealLine } from "./editor.js";
import { selectFile } from "./workspace.js";
import { node, toast } from "./ui.js";
import { errorCard } from "./errorCards.js";
let pendingPreview = false;
export const previewWorkActive = () => pendingPreview;

export function initPreview() {
  const panel = node("section", "preview-panel");
  panel.id = "preview-panel";
  panel.hidden = true;
  panel.setAttribute("aria-label", t("features:preview.title"));
  const controls = node("div", "preview-controls");
  const label = node("label", "", t("features:preview.entrySpace"));
  const entry = node("select");
  entry.setAttribute("aria-label", t("features:preview.entry"));
  label.append(entry);
  const reload = node("button", "", t("features:preview.reload"));
  const pauseLabel = node("label", "", t("features:preview.auto"));
  const auto = node("input");
  auto.type = "checkbox";
  auto.checked = true;
  pauseLabel.append(auto);
  const clear = node("button", "", t("features:preview.clearLog"));
  const close = node("button", "", t("features:preview.close"));
  const switchView = node(
    "button",
    "preview-switch",
    t("features:preview.showEditor"),
  );
  switchView.type = "button";
  document.getElementById("preview-open").after(switchView);
  switchView.hidden = true;
  switchView.onclick = () => {
    const editing = document
      .getElementById("editor-panel")
      .classList.toggle("preview-editing");
    switchView.textContent = editing
      ? t("features:preview.showPreview")
      : t("features:preview.showEditor");
    emit("layout");
  };
  const status = node("p");
  status.setAttribute("role", "status");
  const log = node("div", "preview-log");
  log.setAttribute("aria-label", t("features:preview.log"));
  const frameHost = node("div", "preview-frame-host");
  controls.append(label, reload, pauseLabel, clear, close);
  panel.append(controls, status, frameHost, log);
  document.getElementById("editor-panel").append(panel);
  let frame,
    run,
    session,
    generation = 0,
    timer,
    expiryTimer,
    count = 0,
    bytes = 0,
    rate = 0,
    rateStart = 0,
    summarized = false;
  function resetLog() {
    log.replaceChildren();
    count = bytes = rate = 0;
    summarized = false;
  }
  function summary() {
    if (!summarized)
      log.append(node("p", "", t("features:preview.summarized")));
    summarized = true;
  }
  function stop() {
    generation++;
    clearTimeout(timer);
    clearTimeout(expiryTimer);
    frame?.remove();
    frame = run = null;
    pendingPreview = false;
    resetLog();
  }
  function hide() {
    stop();
    panel.hidden = true;
    switchView.hidden = true;
    document
      .getElementById("editor-panel")
      .classList.remove("preview-visible", "preview-editing");
    document
      .getElementById("preview-open")
      .setAttribute("aria-expanded", "false");
    updateAccess();
    emit("layout");
  }
  close.onclick = () => {
    hide();
    document.getElementById("preview-open").focus();
  };
  clear.onclick = resetLog;
  function addLog(data) {
    const text = translateMessage(data, data.text);
    if (++count > 200 || (bytes += data.text.length * 2) > 262144)
      return summary();
    const row = node("div", `preview-message preview-level-${data.level}`);
    row.append(node("span", "", `${data.level}: ${text}`));
    const knownFile =
      data.file && run.manifest.some((f) => f.path === data.file);
    if (data.level === "error")
      row.append(
        errorCard({
          message: data.text,
          messageKey: data.messageKey,
          params: data.params,
          file: knownFile ? data.file : null,
          line: data.line || 1,
          sessionId: session,
          runId: run.previewRunId,
          historical: true,
          onNavigate: () => {
            if (innerWidth < 960) {
              document
                .getElementById("editor-panel")
                .classList.add("preview-editing");
              switchView.textContent = t("features:preview.showPreview");
              emit("layout");
            }
          },
        }),
      );
    if (data.level !== "error" && knownFile) {
      const source = node(
        "button",
        "text-button",
        `${data.file}:${data.line || 1}`,
      );
      source.onclick = async () => {
        try {
          await selectFile(data.file);
          if (innerWidth < 960) {
            document
              .getElementById("editor-panel")
              .classList.add("preview-editing");
            switchView.textContent = t("features:preview.showPreview");
            emit("layout");
          }
          revealLine(data.line || 1);
        } catch (error) {
          toast(error.message, "error");
        }
      };
      row.append(source);
    }
    const discuss = node("button", "text-button", t("features:shared.discuss"));
    discuss.onclick = () => {
      const input = document.getElementById("chat-input");
      input.value = t("features:preview.discussPrompt", {
        lng: state.session?.tutorLocale || getLocale(),
        p1: run.previewRunId,
        p2: data.file || run.entry,
        p3: data.line || 1,
        p4: text,
      });
      input.dispatchEvent(new Event("input", { bubbles: true }));
      document.getElementById("view-chat").click();
      input.focus();
    };
    row.append(discuss);
    log.append(row);
  }
  window.addEventListener("message", (event) => {
    if (!run || !frame || event.source !== frame.contentWindow) return;
    const d = event.data;
    if (
      !d ||
      typeof d !== "object" ||
      Array.isArray(d) ||
      Object.keys(d)
        .filter((key) => !["messageKey", "params"].includes(key))
        .sort()
        .join(",") !== "file,level,line,previewRunId,renderId,text,type" ||
      (d.messageKey !== undefined &&
        ![
          "serverFeature:preview.suppressed",
          "serverFeature:preview.resourceFailed",
          "serverFeature:preview.policyBlocked",
          "serverFeature:preview.navigationUnsupported",
        ].includes(d.messageKey)) ||
      (d.params !== undefined &&
        (!d.params ||
          typeof d.params !== "object" ||
          Array.isArray(d.params) ||
          Object.entries(d.params).some(
            ([key, value]) =>
              key !== "directive" ||
              typeof value !== "string" ||
              value.length > 200,
          ))) ||
      d.type !== "preview-log" ||
      d.previewRunId !== run.previewRunId ||
      d.renderId !== run.renderId ||
      !["log", "info", "warn", "error"].includes(d.level) ||
      typeof d.text !== "string" ||
      d.text.length > 2000 ||
      typeof d.file !== "string" ||
      d.file.length > 1000 ||
      !Number.isInteger(d.line) ||
      d.line < 0 ||
      d.line > 1000000
    )
      return;
    if (Date.now() - rateStart > 1000) {
      rate = 0;
      rateStart = Date.now();
    }
    if (++rate > 40) return summary();
    addLog(d);
  });
  async function files(id = session) {
    const tree = await api(`${workspaceURL(id)}/files`);
    const result = [];
    const walk = (items) => {
      for (const item of items)
        item.children ? walk(item.children) : result.push(item.path);
    };
    walk(tree);
    return result;
  }
  async function render() {
    if (panel.hidden || !entry.value) return;
    pendingPreview = true;
    const selected = entry.value,
      token = ++generation,
      id = session;
    status.textContent = t("features:preview.preparing");
    reload.disabled = true;
    try {
      await flush();
      const expectedVersions = {};
      for (const file of (await files(id)).filter((p) =>
        /\.(html?|css|js)$/i.test(p),
      )) {
        if (token !== generation || state.session?.id !== id || panel.hidden)
          return;
        if (Object.keys(expectedVersions).length >= 50)
          throw new Error(t("features:preview.maxFiles"));
        expectedVersions[file] = (
          await api(
            `${workspaceURL(id)}/files/content?path=${encodeURIComponent(file)}`,
          )
        ).version;
      }
      const created = await api(`${workspaceURL(id)}/preview-runs`, {
        method: "POST",
        body: { entry: selected, expectedVersions },
      });
      if (token !== generation || state.session?.id !== id || panel.hidden)
        return;
      clearTimeout(expiryTimer);
      run = created;
      frame?.remove();
      resetLog();
      frame = node("iframe");
      frame.title = t("features:preview.isolated");
      frame.setAttribute("sandbox", "allow-scripts");
      frame.referrerPolicy = "no-referrer";
      frame.src = `${workspaceURL(id)}/preview-runs/${run.previewRunId}/document`;
      frameHost.replaceChildren(frame);
      status.textContent = t("features:preview.snapshot", {
        count: run.manifest.length,
        p1: new Date(run.createdAt).toLocaleTimeString(getFormatLocale()),
        p2: formatNumber(run.manifest.length),
        p3: auto.checked
          ? t("features:preview.automatic")
          : t("features:preview.paused"),
        p4: new Date(run.expiresAt).toLocaleTimeString(getFormatLocale()),
      });
      for (const d of run.diagnostics)
        addLog({ ...d, text: d.message, level: "warn" });
      expiryTimer = setTimeout(
        () => {
          frame?.remove();
          frame = null;
          status.textContent = t("features:preview.expired");
        },
        Math.max(0, run.expiresAt - Date.now()),
      );
    } catch (error) {
      if (token === generation)
        status.textContent = t("features:preview.updateError", {
          p1: error.message,
        });
    } finally {
      pendingPreview = false;
      if (token === generation) reload.disabled = false;
    }
  }
  function schedule() {
    if (panel.hidden) return;
    status.textContent = t("features:preview.stale");
    clearTimeout(timer);
    pendingPreview = auto.checked;
    if (auto.checked) timer = setTimeout(render, 450);
  }
  reload.onclick = render;
  entry.onchange = render;
  auto.onchange = () => {
    clearTimeout(timer);
    pendingPreview = false;
    if (auto.checked) schedule();
    else status.textContent = t("features:preview.autoPaused");
  };
  on("save-state", (record) => {
    if (
      !panel.hidden &&
      record?.sessionId === session &&
      ((!run && /\.(html?|css|js)$/i.test(record.path)) ||
        run?.manifest.some(
          (f) => f.path === record.path && f.version !== record.version,
        )) &&
      !record.dirty &&
      !record.saving &&
      !record.error
    )
      schedule();
  });
  on("files-changed", schedule);
  on("session-opened", hide);
  function updateAccess() {
    document.getElementById("preview-open").hidden =
      panel.hidden &&
      !/\.html?$/i.test(currentFile() || "") &&
      !(session === state.session?.id && entry.options.length);
  }
  on("file-active", updateAccess);
  document.getElementById("preview-open").onclick = async () => {
    if (!state.session) return toast(t("features:shared.openSession"));
    if (!panel.hidden) return hide();
    session = state.session.id;
    panel.hidden = false;
    switchView.hidden = false;
    switchView.textContent = t("features:preview.showEditor");
    document.getElementById("editor-panel").classList.add("preview-visible");
    const token = ++generation;
    document
      .getElementById("preview-open")
      .setAttribute("aria-expanded", "true");
    emit("layout");
    try {
      const paths = await files();
      if (token !== generation) return;
      entry.replaceChildren();
      for (const p of paths.filter((p) => /\.html?$/i.test(p))) {
        const option = node("option", "", p);
        option.value = p;
        entry.append(option);
      }
      if (paths.includes(currentFile()) && /\.html?$/i.test(currentFile()))
        entry.value = currentFile();
      if (!entry.value) {
        status.textContent = t("features:preview.createHTML");
        return;
      }
      await render();
    } catch (error) {
      if (token === generation) status.textContent = error.message;
    }
  };
}
