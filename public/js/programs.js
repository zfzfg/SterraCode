import { api } from "./api.js";
import { state, emit } from "./state.js";
import { node, toast } from "./ui.js";

const labels = {
  "not-installed": "Nicht installiert",
  queued: "Wartet",
  installing: "Wird installiert",
  installed: "Installiert",
  removing: "Wird entfernt",
  error: "Fehler",
  reconciling: "Wird wiederhergestellt",
  succeeded: "Abgeschlossen",
  failed: "Fehlgeschlagen",
  cancelled: "Abgebrochen",
  interrupted: "Unterbrochen",
};
export async function openPrograms({ initial = false } = {}) {
  const dialog = node("dialog", "programs-dialog");
  const heading = node("h2", "", initial ? "Programme auswählen" : "Programme");
  heading.id = "programs-heading";
  dialog.setAttribute("aria-labelledby", heading.id);
  const content = node("div", "dialog-form");
  const status = node("p", "muted", "Programmzustand wird geladen …");
  status.setAttribute("role", "status");
  const error = node("p", "form-error");
  error.setAttribute("role", "alert");
  const list = node("div", "program-list");
  const jobs = node("div", "program-jobs");
  const footer = node("div", "dialog-footer");
  const cache = action("Downloadcache leeren", async () => {
    await api("/api/programs/cache", { method: "DELETE", body: {} });
    toast(
      "Downloadcache geleert. Eine Offline-Wiederherstellung benötigt diesen Cache.",
    );
    await refresh();
  });
  const close = action(initial ? "Weiter zur KI-Verbindung" : "Schließen", () =>
    dialog.close(),
  );
  footer.append(cache, close);
  content.append(
    heading,
    node(
      "p",
      "muted",
      "Installiere die Sprachwerkzeuge, die du verwenden möchtest. Deaktivieren sperrt die Sprachausführung; Deinstallieren entfernt das Werkzeug und erhält deine Projekte.",
    ),
    status,
    error,
    jobs,
    list,
    footer,
  );
  dialog.append(content);
  document.body.append(dialog);
  let timer,
    closed = false,
    loading = false,
    detailsOpen = false;
  function action(label, callback, className = "") {
    const button = node("button", className, label);
    button.type = "button";
    button.addEventListener("click", async () => {
      button.disabled = true;
      error.textContent = "";
      try {
        await callback();
      } catch (reason) {
        error.textContent = reason.message;
      } finally {
        button.disabled = false;
      }
    });
    return button;
  }
  async function run(program, command, stopRunning = false) {
    status.textContent = `${program.name || program.id}: Auftrag wird gestartet …`;
    await api(`/api/programs/${program.id}/actions`, {
      method: "POST",
      body: { action: command, stopRunning },
    });
    await refresh();
  }
  async function refresh() {
    if (closed || loading) return;
    clearTimeout(timer);
    loading = true;
    try {
      const data = await api("/api/programs");
      const runnerState = {
        ready: "Bereit",
        maintenance: "Programme werden geändert",
        reconciling: "Wird wiederhergestellt",
        starting: "Startet",
        error: "Fehler",
      };
      status.textContent = `Runner: ${runnerState[data.status] || data.status}${data.cache?.packageBytes !== undefined ? ` · Paketcache: ${Math.round(data.cache.packageBytes / 1048576)} MiB · Werkzeugcache: ${Math.round(data.cache.toolBytes / 1048576)} MiB` : ""}`;
      list.replaceChildren();
      const active = data.activeJob;
      const displayedJob = active || data.latestJob;
      const oldDetails = jobs.querySelector("details");
      if (oldDetails) detailsOpen = oldDetails.open;
      jobs.replaceChildren();
      if (displayedJob) {
        const current = displayedJob;
        const programName =
          data.programs.find((p) => p.id === current.programId)?.name ||
          "Wiederherstellung";
        jobs.append(
          node(
            "p",
            "program-job-heading",
            `${programName} · ${labels[current.state] || current.state}`,
          ),
        );
        const progress = node("progress", "program-progress");
        progress.max = current.stage?.total || 6;
        progress.setAttribute("aria-label", `Fortschritt: ${programName}`);
        if (current.state === "succeeded") progress.value = progress.max;
        else if (current.stage)
          progress.value = Math.max(0, current.stage.current - 1);
        const message = node(
          "p",
          "program-job-status",
          `${active && current.stage ? `Schritt ${current.stage.current} von ${current.stage.total}: ` : ""}${current.progress || labels[current.state] || "Auftrag wird vorbereitet …"}`,
        );
        message.setAttribute("role", "status");
        jobs.append(progress, message);
        if (active?.download) {
          const { name, bytes, total } = active.download;
          jobs.append(
            node(
              "p",
              "muted",
              `${name}: ${(bytes / 1048576).toFixed(1)}${total ? ` / ${(total / 1048576).toFixed(1)}` : ""} MiB heruntergeladen`,
            ),
          );
        }
        if (current.log) {
          const details = node("details", "program-job-details");
          details.open = detailsOpen;
          details.append(
            node("summary", "", "Installationsdetails anzeigen"),
            node("pre", "program-job-log", current.log),
          );
          jobs.append(details);
        }
        if (current.error) jobs.append(node("p", "form-error", current.error));
      }
      if (active) {
        for (const blocking of active.blockingJobs || [])
          jobs.append(
            node(
              "p",
              "muted",
              `Wartet auf Prozess ${blocking.processId}: ${blocking.command}`,
            ),
          );
        if (active.state === "queued")
          jobs.append(
            action("Paketauftrag abbrechen", async () => {
              await api(`/api/programs/jobs/${active.id}/cancel`, {
                method: "POST",
                body: {},
              });
              await refresh();
            }),
          );
        if (active.blockingJobs?.length)
          jobs.append(
            action(
              "Laufende Prozesse stoppen und fortsetzen",
              () => run({ id: active.programId }, active.action, true),
              "danger",
            ),
          );
      }
      for (const program of data.programs) {
        const card = node("section", "program-card");
        card.setAttribute(
          "aria-busy",
          String(active?.programId === program.id),
        );
        const description = node("div");
        description.append(
          node("strong", "", program.name),
          node("p", "muted", program.description),
          node(
            "small",
            "",
            `${labels[program.state] || program.state}${program.version ? ` · ${program.version}` : ""}${program.sizeMB ? ` · etwa ${program.sizeMB} MiB` : ""}${program.base ? " · Grundkomponente" : ""}`,
          ),
        );
        if (program.error)
          description.append(node("p", "form-error", program.error));
        const controls = node("div", "program-controls");
        if (program.language) {
          const label = node("label", "checkbox-label", "Ausführung aktiviert");
          const input = node("input");
          input.type = "checkbox";
          input.checked =
            state.settings.allowedLanguages?.includes(program.language) ||
            false;
          input.addEventListener("change", async () => {
            input.disabled = true;
            try {
              const allowed = new Set(state.settings.allowedLanguages);
              if (input.checked) allowed.add(program.language);
              else allowed.delete(program.language);
              state.settings = await api("/api/chat/settings", {
                method: "PATCH",
                body: { allowedLanguages: [...allowed] },
              });
              state.runtimes = await api("/api/runtimes");
              emit("runtime-changed");
            } catch (reason) {
              input.checked = !input.checked;
              error.textContent = reason.message;
            } finally {
              input.disabled = false;
            }
          });
          label.prepend(input);
          controls.append(label);
        }
        if (!program.base) {
          const button = action(
            program.updateAvailable
              ? "Auf Java 25 aktualisieren"
              : program.installed
                ? "Deinstallieren"
                : "Installieren",
            () =>
              run(
                program,
                program.installed && !program.updateAvailable
                  ? "remove"
                  : "install",
              ),
            program.installed && !program.updateAvailable
              ? "danger"
              : "primary",
          );
          button.disabled = Boolean(active);
          controls.append(button);
          if (program.updateAvailable)
            controls.append(
              action("Deinstallieren", () => run(program, "remove"), "danger"),
            );
          if (program.state === "error") {
            controls.append(
              action("Erneut versuchen", () => run(program, "retry")),
            );
            controls.append(
              action("Paketdatenbank reparieren", () => run(program, "repair")),
            );
          }
        }
        card.append(description, controls);
        list.append(card);
      }
      cache.disabled = Boolean(active);
      if (!active) {
        state.runtimes = await api("/api/runtimes");
        emit("runtime-changed");
      }
    } catch (reason) {
      error.textContent = reason.message;
    } finally {
      loading = false;
      if (!closed) timer = setTimeout(refresh, 2000);
    }
  }
  const completion = new Promise((resolve) =>
    dialog.addEventListener(
      "close",
      () => {
        closed = true;
        clearTimeout(timer);
        dialog.remove();
        resolve();
      },
      { once: true },
    ),
  );
  dialog.showModal();
  await refresh();
  return completion;
}
