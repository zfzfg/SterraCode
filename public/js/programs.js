import { t, formatNumber, translateMessage } from "./i18n.js";
import { api } from "./api.js";
import { state, emit } from "./state.js";
import { node, toast } from "./ui.js";

const labels = () => ({
  "not-installed": t("features:programs.notInstalled"),
  queued: t("features:programs.queued"),
  installing: t("features:programs.installing"),
  installed: t("features:programs.installed"),
  removing: t("features:programs.removing"),
  error: t("features:shared.error"),
  reconciling: t("features:programs.reconciling"),
  succeeded: t("features:shared.finished"),
  failed: t("features:shared.failed"),
  cancelled: t("features:shared.cancelled"),
  interrupted: t("features:shared.interrupted"),
});
export async function openPrograms({ initial = false } = {}) {
  const dialog = node("dialog", "programs-dialog");
  const heading = node(
    "h2",
    "",
    initial ? t("features:programs.choose") : t("features:programs.title"),
  );
  heading.id = "programs-heading";
  dialog.setAttribute("aria-labelledby", heading.id);
  const content = node("div", "dialog-form");
  const status = node("p", "muted", t("features:programs.loading"));
  status.setAttribute("role", "status");
  const error = node("p", "form-error");
  error.setAttribute("role", "alert");
  const list = node("div", "program-list");
  const jobs = node("div", "program-jobs");
  const footer = node("div", "dialog-footer");
  const cache = action(t("features:programs.clearCache"), async () => {
    await api("/api/programs/cache", { method: "DELETE", body: {} });
    toast(t("features:programs.cacheCleared"));
    await refresh();
  });
  const close = action(
    initial ? t("features:programs.continue") : t("features:shared.close"),
    () => dialog.close(),
  );
  footer.append(cache, close);
  content.append(
    heading,
    node("p", "muted", t("features:programs.help")),
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
    status.textContent = t("features:programs.jobStarting", {
      p1: program.name || program.id,
    });
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
        ready: t("features:shared.ready"),
        maintenance: t("features:programs.maintenance"),
        reconciling: t("features:programs.reconciling"),
        starting: t("features:programs.starting"),
        error: t("features:shared.error"),
      };
      status.textContent = t("features:programs.runnerStatus", {
        status: runnerState[data.status] || data.status,
        cache:
          data.cache?.packageBytes !== undefined
            ? t("features:programs.cacheSize", {
                p1: formatNumber(Math.round(data.cache.packageBytes / 1048576)),
                p2: formatNumber(Math.round(data.cache.toolBytes / 1048576)),
              })
            : "",
      });
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
          t("features:programs.recovery");
        jobs.append(
          node(
            "p",
            "program-job-heading",
            `${programName} · ${labels()[current.state] || current.state}`,
          ),
        );
        const progress = node("progress", "program-progress");
        progress.max = current.stage?.total || 6;
        progress.setAttribute(
          "aria-label",
          t("features:programs.progressLabel", { p1: programName }),
        );
        if (current.state === "succeeded") progress.value = progress.max;
        else if (current.stage)
          progress.value = Math.max(0, current.stage.current - 1);
        const message = node(
          "p",
          "program-job-status",
          `${active && current.stage ? t("features:programs.stepPrefix", { p1: formatNumber(current.stage.current), p2: formatNumber(current.stage.total) }) : ""}${translateMessage(current.progressMessage, current.progress || labels()[current.state] || t("features:programs.preparing"))}`,
        );
        message.setAttribute("role", "status");
        jobs.append(progress, message);
        if (active?.download) {
          const { name, bytes, total } = active.download;
          jobs.append(
            node(
              "p",
              "muted",
              t("features:programs.downloaded", {
                p1: name,
                p2: formatNumber(bytes / 1048576, {
                  minimumFractionDigits: 1,
                  maximumFractionDigits: 1,
                }),
                p3: total
                  ? ` / ${formatNumber(total / 1048576, { minimumFractionDigits: 1, maximumFractionDigits: 1 })}`
                  : "",
              }),
            ),
          );
        }
        if (current.log) {
          const details = node("details", "program-job-details");
          details.open = detailsOpen;
          details.append(
            node("summary", "", t("features:programs.details")),
            node("pre", "program-job-log", current.log),
          );
          jobs.append(details);
        }
        if (current.error || current.errorKey)
          jobs.append(
            node(
              "p",
              "form-error",
              translateMessage(
                { messageKey: current.errorKey, params: current.errorParams },
                current.error,
              ),
            ),
          );
      }
      if (active) {
        for (const blocking of active.blockingJobs || [])
          jobs.append(
            node(
              "p",
              "muted",
              t("features:programs.waitingProcess", {
                p1: blocking.processId,
                p2: blocking.command,
              }),
            ),
          );
        if (active.state === "queued")
          jobs.append(
            action(t("features:programs.cancel"), async () => {
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
              t("features:programs.stopContinue"),
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
          node(
            "p",
            "muted",
            translateMessage(
              {
                messageKey: program.descriptionKey,
                params: program.descriptionParams,
              },
              program.description,
            ),
          ),
          node(
            "small",
            "",
            `${labels()[program.state] || program.state}${program.version ? ` · ${program.version}` : ""}${program.sizeMB ? t("features:programs.estimatedSize", { p1: program.sizeMB }) : ""}${program.base ? t("features:programs.base") : ""}`,
          ),
        );
        if (program.error || program.errorKey)
          description.append(
            node(
              "p",
              "form-error",
              translateMessage(
                { messageKey: program.errorKey, params: program.errorParams },
                program.error,
              ),
            ),
          );
        const controls = node("div", "program-controls");
        if (program.language) {
          const label = node(
            "label",
            "checkbox-label",
            t("features:programs.enabled"),
          );
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
              ? t("features:programs.upgradeJava")
              : program.installed
                ? t("features:programs.uninstall")
                : t("features:programs.install"),
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
              action(
                t("features:programs.uninstall"),
                () => run(program, "remove"),
                "danger",
              ),
            );
          if (program.state === "error") {
            controls.append(
              action(t("features:programs.retry"), () => run(program, "retry")),
            );
            controls.append(
              action(t("features:programs.repair"), () =>
                run(program, "repair"),
              ),
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
