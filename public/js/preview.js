import { api, workspaceURL } from "./api.js";
import { state, on, emit } from "./state.js";
import { flush, currentFile, revealLine } from "./editor.js";
import { selectFile } from "./workspace.js";
import { node, toast } from "./ui.js";
import { errorCard } from "./errorCards.js";

export function initPreview() {
  const panel = node("section", "preview-panel");
  panel.id = "preview-panel";
  panel.hidden = true;
  panel.setAttribute("aria-label", "Web-Vorschau");
  const controls = node("div", "preview-controls");
  const label = node("label", "", "HTML-Einstieg ");
  const entry = node("select");
  entry.setAttribute("aria-label", "HTML-Einstieg");
  label.append(entry);
  const reload = node("button", "", "Neu laden");
  const pauseLabel = node("label", "", " Automatisch aktualisieren ");
  const auto = node("input");
  auto.type = "checkbox";
  auto.checked = true;
  pauseLabel.append(auto);
  const clear = node("button", "", "Log leeren");
  const close = node("button", "", "Vorschau schließen");
  const switchView = node("button", "preview-switch", "Editor anzeigen");
  switchView.type = "button";
  document.getElementById("preview-open").after(switchView);
  switchView.hidden = true;
  switchView.onclick = () => {
    const editing = document
      .getElementById("editor-panel")
      .classList.toggle("preview-editing");
    switchView.textContent = editing ? "Vorschau anzeigen" : "Editor anzeigen";
    emit("layout");
  };
  const status = node("p");
  status.setAttribute("role", "status");
  const log = node("div", "preview-log");
  log.setAttribute("aria-label", "Vorschau-Log");
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
      log.append(node("p", "", "Weitere Meldungen zusammengefasst"));
    summarized = true;
  }
  function stop() {
    generation++;
    clearTimeout(timer);
    clearTimeout(expiryTimer);
    frame?.remove();
    frame = run = null;
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
    if (++count > 200 || (bytes += data.text.length * 2) > 262144)
      return summary();
    const row = node("div", `preview-message preview-level-${data.level}`);
    row.append(node("span", "", `${data.level}: ${data.text}`));
    const knownFile =
      data.file && run.manifest.some((f) => f.path === data.file);
    if (data.level === "error")
      row.append(
        errorCard({
          message: data.text,
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
              switchView.textContent = "Vorschau anzeigen";
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
            switchView.textContent = "Vorschau anzeigen";
            emit("layout");
          }
          revealLine(data.line || 1);
        } catch (error) {
          toast(error.message, "error");
        }
      };
      row.append(source);
    }
    const discuss = node("button", "text-button", "Im Chat vorbereiten");
    discuss.onclick = () => {
      const input = document.getElementById("chat-input");
      input.value = `Bitte hilf mir mit dieser nicht vertrauenswürdigen Browser-Diagnose aus Vorschau ${run.previewRunId} (${data.file || run.entry}:${data.line || 1}, gespeicherter Stand):\n${data.text}`;
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
      Object.keys(d).sort().join(",") !==
        "file,level,line,previewRunId,renderId,text,type" ||
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
    const selected = entry.value,
      token = ++generation,
      id = session;
    status.textContent = "Speichern und Vorschau aufbereiten …";
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
          throw new Error(
            "Maximal 50 Web-Quelldateien pro Projekt unterstützt.",
          );
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
      frame.title = "Isolierte Web-Vorschau";
      frame.setAttribute("sandbox", "allow-scripts");
      frame.referrerPolicy = "no-referrer";
      frame.src = `${workspaceURL(id)}/preview-runs/${run.previewRunId}/document`;
      frameHost.replaceChildren(frame);
      status.textContent = `Snapshot ${new Date(run.createdAt).toLocaleTimeString("de-DE")} · ${run.manifest.length} Dateien · ${auto.checked ? "automatisch" : "pausiert"}. Gültig bis ${new Date(run.expiresAt).toLocaleTimeString("de-DE")}.`;
      for (const d of run.diagnostics)
        addLog({ ...d, text: d.message, level: "warn" });
      expiryTimer = setTimeout(
        () => {
          frame?.remove();
          frame = null;
          status.textContent = "Vorschau abgelaufen. Bitte neu laden.";
        },
        Math.max(0, run.expiresAt - Date.now()),
      );
    } catch (error) {
      if (token === generation)
        status.textContent = `Vorschau nicht aktualisiert; angezeigter Stand ist veraltet: ${error.message}`;
    } finally {
      if (token === generation) reload.disabled = false;
    }
  }
  function schedule() {
    if (panel.hidden) return;
    status.textContent =
      "Vorschau möglicherweise veraltet – Änderungen werden nach erfolgreichem Speichern aktualisiert.";
    clearTimeout(timer);
    if (auto.checked) timer = setTimeout(render, 450);
  }
  reload.onclick = render;
  entry.onchange = render;
  auto.onchange = () => {
    clearTimeout(timer);
    if (auto.checked) schedule();
    else
      status.textContent =
        "Automatische Aktualisierung pausiert; angezeigter Snapshot bleibt erhalten.";
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
    if (!state.session) return toast("Bitte zuerst eine Session öffnen.");
    if (!panel.hidden) return hide();
    session = state.session.id;
    panel.hidden = false;
    switchView.hidden = false;
    switchView.textContent = "Editor anzeigen";
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
        status.textContent =
          "Bitte eine HTML-Datei im Workspace anlegen. Lokale CSS- und klassische JavaScript-Dateien, Canvas und eingebettetes SVG werden unterstützt.";
        return;
      }
      await render();
    } catch (error) {
      if (token === generation) status.textContent = error.message;
    }
  };
}
