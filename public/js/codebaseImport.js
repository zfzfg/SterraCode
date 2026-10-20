import { api, uploadZip } from "./api.js";
import { $, node, toast } from "./ui.js";
import { button } from "./icons.js";
import { t, getLocale, LOCALES, translateMessage } from "./i18n.js";
import { randomUUID } from "./uuid.js";
import { openSession, loadSessions } from "./sessions.js";
import { formatBytes } from "./codebaseTree.js";
import { openGitCredentials } from "./gitCredentials.js";

const tr = (key, params) => t(`features:codebase.${key}`, params);
const base = "/api/codebase/imports";
let draft;
export async function openCodebaseImport() {
  if (document.getElementById("codebase-import-dialog")) return;
  const trigger = document.activeElement;
  const dialog = node("dialog", "codebase-import-dialog");
  dialog.id = "codebase-import-dialog";
  const form = node("form", "codebase-import-form");
  form.method = "dialog";
  const title = node("h2", "", tr("import"));
  title.id = "codebase-import-title";
  dialog.setAttribute("aria-labelledby", title.id);
  const head = node("div", "dialog-heading");
  let job = draft?.job || null,
    step = job?.state === "awaiting_selection" ? 2 : 1,
    busy = false,
    closed = false,
    controller,
    sequence = 0,
    treeToken = 0;
  const sourceDraft = draft?.source || {
    kind: "zip",
    repositoryUrl: "",
    ref: "",
    credentialId: "",
  };
  let gitUnavailable = false,
    gitCapabilities,
    selectionRules = draft?.rules || job?.selection?.rules || [],
    name = draft?.name || "",
    locale = draft?.locale || getLocale(),
    query = "",
    rootMapping = job?.selection?.rootMapping || "",
    file;
  const content = node("div", "codebase-import-content");
  const error = node("p", "form-error");
  error.setAttribute("role", "alert");
  const status = node("p", "muted");
  status.setAttribute("role", "status");
  const footer = node("div", "dialog-footer codebase-import-footer");
  const summary = node("span", "muted");
  const back = button(tr("previous"), null, () => {
    if (busy) return;
    step--;
    render();
  });
  const cancel = button(t("common:actions.cancel"), null, () =>
    cancelImport().catch(showError),
  );
  const background = button(tr("background"), null, () => dialog.close());
  const next = button(tr("next"), null, null, "primary");
  next.type = "submit";
  const close = button(
    t("common:actions.close"),
    "close",
    () => dialog.close(),
    "icon-only",
  );
  head.append(title, close);
  footer.append(summary, back, cancel, background, next);
  form.append(head, content, status, error, footer);
  dialog.append(form);
  document.body.append(dialog);
  const saveDraft = () => {
    draft = { job, source: sourceDraft, rules: selectionRules, name, locale };
  };
  function showError(e) {
    if (e.name !== "AbortError")
      error.textContent = e.message || translateMessage(e, e.code);
  }
  function field(label, input) {
    const row = node("label", "field", label);
    row.append(input);
    return row;
  }
  function textInput(value, oninput, type = "text") {
    const input = node("input");
    input.type = type;
    input.value = value;
    input.oninput = () => {
      oninput(input.value);
      saveDraft();
    };
    return input;
  }
  function updateSummary() {
    const value = job?.summary;
    summary.textContent = value
      ? tr("selectedSummary", {
          files: value.selectedFiles || 0,
          bytes: formatBytes(value.selectedBytes),
          excluded: Math.max(
            0,
            (value.files || 0) - (value.selectedFiles || 0),
          ),
        })
      : "";
    next.disabled =
      busy ||
      (step > 1 && !value?.selectedFiles) ||
      (step === 1 && sourceDraft.kind === "git" && gitUnavailable);
  }
  async function cancelImport() {
    sequence++;
    controller?.abort();
    if (job && !["completed", "committed"].includes(job.state))
      job = await api(
        `${base}/${encodeURIComponent(job.id || job.importId)}/cancel`,
        { method: "POST", body: {} },
      );
    draft = null;
    dialog.close();
  }
  async function waitJob() {
    const token = ++sequence;
    while (
      !closed &&
      token === sequence &&
      job &&
      ![
        "awaiting_selection",
        "completed",
        "committed",
        "failed",
        "cancelled",
        "expired",
        "interrupted",
      ].includes(job.state)
    ) {
      status.textContent = tr("importPhase", {
        phase: tr(`phases.${job.phase || job.state}`),
        bytes: formatBytes(job.progress?.bytes),
        files: job.progress?.files || 0,
      });
      await new Promise((resolve) => setTimeout(resolve, 700));
      if (closed || token !== sequence) return;
      job = await api(`${base}/${encodeURIComponent(job.id || job.importId)}`);
      saveDraft();
    }
    if (closed || token !== sequence) return;
    if (job?.error)
      throw new Error(translateMessage(job.error, tr("importFailed")));
    if (job?.sessionId) {
      const id = job.sessionId;
      draft = null;
      dialog.close();
      await loadSessions();
      await openSession(id);
      return;
    }
    if (job?.state === "awaiting_selection") {
      step = 2;
      render();
    }
  }
  async function source() {
    if (job?.state === "awaiting_selection" && !file) {
      step = 2;
      render();
      return;
    }
    if (
      job &&
      ![
        "completed",
        "committed",
        "cancelled",
        "failed",
        "expired",
        "interrupted",
      ].includes(job.state)
    )
      await api(
        `${base}/${encodeURIComponent(job.id || job.importId)}/cancel`,
        { method: "POST", body: {} },
      );
    const operationId = randomUUID();
    if (sourceDraft.kind === "zip" && !file) throw new Error(tr("chooseZip"));
    if (sourceDraft.kind === "git") {
      gitCapabilities ||= await api(`${base}/capabilities`);
      gitUnavailable = gitCapabilities?.available === false;
      if (gitUnavailable)
        throw new Error(
          translateMessage(gitCapabilities, tr("gitUnavailable")),
        );
    }
    job = await api(base, {
      method: "POST",
      body: {
        operationId,
        source:
          sourceDraft.kind === "zip" ? { kind: "zip" } : { ...sourceDraft },
        title: name || undefined,
        tutorLocale: locale,
      },
    });
    saveDraft();
    if (sourceDraft.kind === "zip") {
      controller = new AbortController();
      job = await uploadZip(
        `${base}/${encodeURIComponent(job.id || job.importId)}/upload`,
        file,
        {
          signal: controller.signal,
          onProgress: (bytes, total) => {
            status.textContent = tr("uploading", {
              name: file.name,
              bytes: formatBytes(bytes),
              total: total ? formatBytes(total) : tr("unknownSize"),
            });
          },
        },
      );
      saveDraft();
    }
    await waitJob();
  }
  async function applySelection(profile) {
    const result = await api(
      `${base}/${encodeURIComponent(job.id || job.importId)}/selection`,
      {
        method: "PATCH",
        body: {
          manifestVersion: job.manifestVersion,
          selectionVersion: job.selectionVersion,
          ...(profile ? { profile, rules: [] } : { rules: selectionRules }),
          rootMapping,
        },
      },
    );
    job = result.job || result;
    if (profile) selectionRules = [];
    saveDraft();
    updateSummary();
  }
  async function loadTree(parent, target, cursor, token = treeToken) {
    const params = new URLSearchParams({ parent, limit: "100", query });
    if (cursor) params.set("cursor", cursor);
    const data = await api(
      `${base}/${encodeURIComponent(job.id || job.importId)}/tree?${params}`,
    );
    if (closed || token !== treeToken || !target.isConnected) return;
    if (data.summary) {
      job.summary = data.summary;
      job.manifestVersion = data.manifestVersion;
      job.selectionVersion = data.selectionVersion;
      updateSummary();
    }
    for (const entry of data.entries) {
      const item = node("li"),
        row = node("div", "codebase-tree-row");
      const checkbox = node("input");
      checkbox.type = "checkbox";
      checkbox.checked = entry.selected === true;
      checkbox.indeterminate = entry.selected === null;
      checkbox.disabled = entry.locked === true;
      checkbox.setAttribute(
        "aria-label",
        tr("selectPath", { path: entry.path }),
      );
      checkbox.onchange = async () => {
        checkbox.disabled = true;
        try {
          selectionRules = [
            ...selectionRules.filter(
              (rule) =>
                rule.path !== entry.path &&
                !rule.path.startsWith(`${entry.path}/`),
            ),
            { path: entry.path, selected: checkbox.checked },
          ];
          await applySelection();
          // Refresh the bounded page to get server computed mixed folder states.
          renderReview();
        } catch (e) {
          showError(e);
          checkbox.disabled = false;
        }
      };
      const children = node("ul", "codebase-tree");
      children.hidden = true;
      if (entry.type === "folder") {
        const expand = button(
          entry.name,
          "folder",
          async () => {
            const opened = expand.getAttribute("aria-expanded") === "true";
            expand.setAttribute("aria-expanded", String(!opened));
            children.hidden = opened;
            if (!opened && !children.childElementCount)
              try {
                await loadTree(entry.path, children, null, token);
              } catch (e) {
                showError(e);
              }
          },
          "tree-open",
        );
        expand.setAttribute("aria-expanded", "false");
        row.append(checkbox, expand);
      } else {
        const preview = button(
          entry.name,
          "file",
          async () => {
            try {
              const result = await api(
                `${base}/${encodeURIComponent(job.id || job.importId)}/preview?path=${encodeURIComponent(entry.path)}`,
              );
              if (closed || token !== treeToken) return;
              const host = content.querySelector(".codebase-import-preview");
              host.replaceChildren(
                node("h3", "", result.path),
                node(
                  "p",
                  "muted",
                  `${formatBytes(result.bytes)} · ${result.editorEligible ? tr("textFile") : tr("infoOnly")}`,
                ),
              );
              if (result.content !== undefined)
                host.append(node("pre", "", result.content));
              else
                host.append(
                  node(
                    "p",
                    "",
                    result.reason
                      ? tr(`reasons.${result.reason}`)
                      : tr("binaryInfo"),
                  ),
                );
              if (result.truncated)
                host.append(node("p", "muted", tr("previewTruncated")));
            } catch (e) {
              showError(e);
            }
          },
          "tree-open",
        );
        row.append(checkbox, preview);
      }
      const reason = entry.locked
        ? tr("locked")
        : entry.reason
          ? tr(`reasons.${entry.reason}`)
          : entry.editorEligible === false
            ? tr("infoOnly")
            : entry.selected
              ? tr("selected")
              : tr("notSelected");
      row.append(
        node("small", "muted", `${formatBytes(entry.bytes)} · ${reason}`),
      );
      item.append(row, children);
      target.append(item);
    }
    if (data.nextCursor) {
      const more = button(tr("more"), null, async () => {
        more.disabled = true;
        try {
          await loadTree(parent, target, data.nextCursor, token);
          more.remove();
        } catch (e) {
          more.disabled = false;
          showError(e);
        }
      });
      const li = node("li");
      li.append(more);
      target.append(li);
    }
  }
  function renderReview() {
    content.replaceChildren();
    treeToken++;
    const root = textInput(rootMapping, (value) => {
      rootMapping = value;
    });
    root.onchange = () => applySelection().then(renderReview).catch(showError);
    const search = textInput(
      query,
      (value) => {
        query = value;
      },
      "search",
    );
    search.setAttribute("aria-label", tr("search"));
    search.placeholder = tr("search");
    let searchTimer;
    search.oninput = () => {
      clearTimeout(searchTimer);
      query = search.value;
      searchTimer = setTimeout(() => {
        treeToken++;
        list.replaceChildren();
        loadTree("", list).catch(showError);
      }, 250);
    };
    const profile = node("select");
    profile.setAttribute("aria-label", tr("selectionProfile"));
    for (const key of ["recommended", "all", "none"]) {
      const opt = node("option", "", tr(key));
      opt.value = key;
      profile.append(opt);
    }
    profile.onchange = async () => {
      if (
        profile.value === "recommended" &&
        selectionRules.length &&
        !window.confirm(tr("resetSelection"))
      )
        return;
      try {
        await applySelection(profile.value);
        renderReview();
      } catch (e) {
        showError(e);
      }
    };
    const details = node("details");
    details.append(
      node("summary", "", tr("selectionRules")),
      node("p", "muted", tr("selectionHelp")),
    );
    const columns = node("div", "codebase-import-columns"),
      list = node("ul", "codebase-tree codebase-import-tree"),
      preview = node("section", "codebase-import-preview");
    preview.append(node("p", "muted", tr("previewHelp")));
    columns.append(list, preview);
    content.append(
      field(tr("rootMapping"), root),
      search,
      field(tr("selectionProfile"), profile),
      details,
      columns,
    );
    loadTree("", list).catch(showError);
  }
  function renderSource() {
    const tabs = node("div", "codebase-actions");
    for (const kind of ["zip", "git"]) {
      const tab = button(tr(kind), null, () => {
        sourceDraft.kind = kind;
        render();
      });
      tab.setAttribute("aria-pressed", String(kind === sourceDraft.kind));
      tabs.append(tab);
    }
    content.append(tabs);
    if (sourceDraft.kind === "zip") {
      const input = node("input");
      input.type = "file";
      input.accept = ".zip,application/zip";
      input.onchange = () => {
        file = input.files[0];
        if (file && !name) name = file.name.replace(/\.zip$/i, "");
        status.textContent = file
          ? `${file.name} · ${formatBytes(file.size)}`
          : "";
      };
      const drop = node("div", "codebase-drop");
      drop.append(
        field(tr("chooseZip"), input),
        node("p", "muted", tr("dropZip")),
      );
      drop.ondragover = (e) => e.preventDefault();
      drop.ondrop = (e) => {
        e.preventDefault();
        if (e.dataTransfer.files[0]) {
          file = e.dataTransfer.files[0];
          status.textContent = `${file.name} · ${formatBytes(file.size)}`;
          if (!name) name = file.name.replace(/\.zip$/i, "");
        }
      };
      content.append(drop);
    } else {
      const url = textInput(sourceDraft.repositoryUrl, (value) => {
        sourceDraft.repositoryUrl = value;
      });
      url.required = true;
      const ref = textInput(sourceDraft.ref, (value) => {
        sourceDraft.ref = value;
      });
      const extra = node("details");
      extra.append(
        node("summary", "", tr("gitOptions")),
        field(tr("gitRef"), ref),
      );
      const credentials = node("select");
      credentials.setAttribute("aria-label", tr("gitAuth"));
      const publicOption = node("option", "", tr("publicGit"));
      publicOption.value = "";
      credentials.append(publicOption);
      credentials.onchange = () => {
        sourceDraft.credentialId = credentials.value;
        saveDraft();
      };
      const refreshCredentials = async () => {
        const data = await api("/api/git-credentials");
        let host;
        try {
          host = new URL(
            sourceDraft.repositoryUrl.replace(/^git@([^:]+):/, "ssh://git@$1/"),
          ).hostname;
        } catch {
          return;
        }
        credentials.replaceChildren(publicOption);
        for (const credential of data.credentials || [])
          if (credential.host === host) {
            const option = node("option", "", credential.name);
            option.value = credential.id;
            credentials.append(option);
          }
        credentials.value = sourceDraft.credentialId;
      };
      url.onchange = () => refreshCredentials().catch(showError);
      content.append(
        field(tr("gitUrl"), url),
        extra,
        field(tr("gitAuth"), credentials),
        button(tr("gitCredentials"), "settings", async () => {
          saveDraft();
          dialog.close();
          await openGitCredentials();
          await openCodebaseImport();
        }),
        node("p", "muted", tr("gitSnapshot")),
      );
      refreshCredentials().catch(showError);
      if (!gitCapabilities)
        api(`${base}/capabilities`)
          .then((caps) => {
            gitCapabilities = caps;
            gitUnavailable = caps?.available === false;
            if (closed || sourceDraft.kind !== "git") return;
            if (gitUnavailable)
              status.textContent = translateMessage(caps, tr("gitUnavailable"));
            updateSummary();
          })
          .catch(showError);
      else if (gitUnavailable) status.textContent = tr("gitUnavailable");
    }
  }
  function renderConfirmation() {
    const input = textInput(name, (value) => {
      name = value;
    });
    input.required = true;
    input.maxLength = 200;
    const language = node("select");
    for (const [value, entry] of Object.entries(LOCALES)) {
      const option = node("option", "", entry.name);
      option.value = value;
      language.append(option);
    }
    language.value = locale;
    language.onchange = () => {
      locale = language.value;
      saveDraft();
    };
    content.append(
      field(t("sessions:name"), input),
      field(t("sessions:tutor.label"), language),
      node(
        "p",
        "",
        sourceDraft.kind === "zip"
          ? file?.name || job.source?.name || tr("zip")
          : sourceDraft.repositoryUrl || job.source?.repositoryUrl || tr("git"),
      ),
    );
    if (job.source?.commit)
      content.append(
        node("p", "muted", `${job.source.ref || ""} · ${job.source.commit}`),
      );
    if (job.summary.selectedBytes > 500000000) {
      const confirmation = node("input");
      confirmation.id = "codebase-large-confirmation";
      confirmation.type = "checkbox";
      confirmation.required = true;
      const label = node("label", "checkbox-label");
      label.append(
        confirmation,
        node(
          "span",
          "",
          tr("largeConfirmation", {
            bytes: formatBytes(job.summary.selectedBytes),
          }),
        ),
      );
      content.append(label);
    }
    for (const warning of job.warnings || [])
      content.append(
        node(
          "p",
          "muted",
          typeof warning === "string"
            ? tr(`warnings.${warning}`)
            : translateMessage(warning, warning.code),
        ),
      );
    content.append(
      node("p", "muted", tr("manualOnly")),
      node("p", "muted", tr("deletionBackups")),
    );
  }
  function render() {
    content.replaceChildren();
    error.textContent = "";
    status.textContent = "";
    title.textContent = `${tr("import")} · ${step}/3`;
    back.hidden = step < 2;
    back.disabled = busy;
    background.hidden = !job;
    cancel.textContent = job ? tr("cancelImport") : t("common:actions.cancel");
    cancel.setAttribute("aria-label", cancel.textContent);
    next.textContent = step === 3 ? tr("openProject") : tr("next");
    next.setAttribute("aria-label", next.textContent);
    if (step === 1) renderSource();
    else if (step === 2) renderReview();
    else renderConfirmation();
    updateSummary();
  }
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (busy || !form.reportValidity()) return;
    busy = true;
    error.textContent = "";
    updateSummary();
    back.disabled = true;
    try {
      if (step === 1) await source();
      else if (step === 2) {
        step = 3;
        render();
      } else {
        job = await api(
          `${base}/${encodeURIComponent(job.id || job.importId)}/commit`,
          {
            method: "POST",
            body: {
              manifestVersion: job.manifestVersion,
              selectionVersion: job.selectionVersion,
              selectionDigest: job.selectionDigest,
              title: name,
              tutorLocale: locale,
              ...(job.summary.selectedBytes > 500000000
                ? {
                    confirmation: {
                      bytes: job.summary.selectedBytes,
                      selectionDigest: job.selectionDigest,
                      manifestVersion: job.manifestVersion,
                    },
                  }
                : {}),
            },
          },
        );
        saveDraft();
        status.textContent = tr("preparing");
        await waitJob();
      }
    } catch (e) {
      showError(e);
    } finally {
      busy = false;
      back.disabled = false;
      updateSummary();
    }
  };
  dialog.oncancel = (event) => {
    if (busy) {
      event.preventDefault();
      status.textContent = tr("backgroundHelp");
    }
  };
  dialog.onclose = () => {
    closed = true;
    sequence++;
    if (
      job &&
      ["completed", "committed", "cancelled", "expired"].includes(job.state)
    )
      draft = null;
    else saveDraft();
    dialog.remove();
    trigger?.focus();
  };
  render();
  dialog.showModal();
  (content.querySelector("input") || content.querySelector("button"))?.focus();
  if (!job) {
    try {
      const jobs = await api(base);
      const recoverable = (Array.isArray(jobs) ? jobs : jobs.jobs || []).find(
        (item) =>
          ![
            "completed",
            "committed",
            "cancelled",
            "failed",
            "expired",
            "interrupted",
          ].includes(item.state),
      );
      if (recoverable && !closed) {
        job = recoverable;
        sourceDraft.kind = job.source.kind;
        sourceDraft.repositoryUrl = job.source.repositoryUrl || "";
        name ||= job.title || "";
        selectionRules = job.selection?.rules || [];
        rootMapping = job.selection?.rootMapping || "";
        status.textContent = tr("recoveredImport");
        await waitJob();
      }
    } catch (e) {
      showError(e);
    }
  } else if (!["awaiting_selection", "cancelled", "failed"].includes(job.state))
    waitJob().catch(showError);
}
