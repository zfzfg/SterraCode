import { api } from "./api.js";
import { state, on, emit } from "./state.js";
import { $, node, toast, confirmDialog } from "./ui.js";
import { button } from "./icons.js";
import { t, getLocale, formatNumber } from "./i18n.js";
import {
  flush,
  revealRange,
  explainSelection,
  layoutEditor,
} from "./editor.js";
import { selectFile } from "./workspace.js";
import { sendMessage } from "./chat.js";
import { randomUUID } from "./uuid.js";
import { codebaseURL, isCodebase } from "./codebaseTree.js";
import { renderDemos } from "./codebaseDemos.js";
import { openSession } from "./sessions.js";

let generation = 0,
  navigation = 0,
  timer,
  snapshot,
  activeStep,
  view = "understand",
  scrollTop = 0,
  analysisStarting = false,
  focus = "",
  analysisDepth = "overview",
  explanationDepth = "simple";
const tr = (key, params) => t(`features:codebase.${key}`, params);
const report = (error) => toast(error.message, "error");
function showView(next) {
  view = next;
  const panel = $("editor-panel");
  if (next === "understand") {
    if (!$("preview-panel")?.hidden)
      $("preview-panel")
        .querySelector(".preview-controls button:last-child")
        ?.click();
    panel.classList.add("codebase-understanding");
    $("codebase-cockpit").scrollTop = scrollTop;
  } else {
    scrollTop = $("codebase-cockpit").scrollTop;
    panel.classList.remove("codebase-understanding");
  }
  for (const key of ["code", "understand"]) {
    $(`codebase-tab-${key}`).setAttribute(
      "aria-selected",
      String(next === key),
    );
    $(`codebase-tab-${key}`).tabIndex = next === key ? 0 : -1;
  }
  $("codebase-cockpit").hidden = next !== "understand";
  $("codebase-tour-return").hidden = next !== "code";
  layoutEditor();
}
export async function navigateReference(reference, trigger) {
  const id = state.session?.id,
    sequence = ++navigation;
  if (!id || (reference.sessionId && reference.sessionId !== id))
    throw new Error(tr("foreignReference"));
  await flush();
  const params = new URLSearchParams({
    path: reference.path,
    startLine: String(reference.startLine || 1),
    endLine: String(reference.endLine || reference.startLine || 1),
  });
  if (reference.fileVersion) params.set("fileVersion", reference.fileVersion);
  let resolved;
  try {
    resolved = await api(`${codebaseURL(id)}/references/resolve?${params}`);
  } catch (error) {
    if (error.status !== 409) throw error;
    if (!(await confirmDialog(tr("staleReference"), tr("openCurrent")))) return;
    if (state.session?.id !== id || sequence !== navigation) return;
    await selectFile(reference.path);
    if (state.session?.id === id && sequence === navigation) showView("code");
    return;
  }
  if (state.session?.id !== id || sequence !== navigation) return;
  await selectFile(reference.path);
  if (state.session?.id !== id || sequence !== navigation) return;
  showView("code");
  $("view-editor").click();
  if (
    resolved.editorEligible !== false &&
    resolved.kind !== "binary" &&
    resolved.kind !== "large"
  )
    revealRange(
      reference.startLine || 1,
      reference.endLine || reference.startLine || 1,
    );
  $("codebase-tour-return").onclick = () => {
    showView("understand");
    trigger?.focus();
  };
}
function references(items, owner) {
  const result = node("div", "codebase-references");
  for (const value of (items || []).slice(0, 20)) {
    const ref =
      typeof value === "string"
        ? snapshot?.analysis?.references?.find((r) => r.id === value)
        : value;
    if (!ref?.path) continue;
    const control = button(
      ref.label ||
        `${ref.path}:${ref.startLine || 1}${ref.endLine && ref.endLine !== ref.startLine ? `–${ref.endLine}` : ""}`,
      "file",
      () =>
        navigateReference(
          { ...ref, sessionId: ref.sessionId || owner },
          control,
        ).catch(report),
      "text-button",
    );
    result.append(control);
  }
  return result;
}
async function progress(step, action) {
  const id = state.session?.id;
  const tour = await api(`${codebaseURL(id)}/tour`, {
    method: "PATCH",
    body: {
      analysisId: snapshot.analysis.analysisId || snapshot.analysis.id,
      stepId: step.id,
      action,
      expectedVersion: snapshot.tour?.version || 0,
    },
  });
  if (state.session?.id !== id) return;
  snapshot.tour = tour;
  activeStep = step.id;
  render();
}
function section(title, text) {
  const section = node("section", "codebase-section");
  section.append(node("h3", "", title));
  if (text) section.append(node("p", "", text));
  return section;
}
async function explainStep(step) {
  const language = state.session?.tutorLocale || getLocale();
  const refs = (step.references || [])
    .map((r) =>
      typeof r === "string"
        ? snapshot.analysis.references?.find((item) => item.id === r)
        : r,
    )
    .filter(Boolean);
  await sendMessage(
    tr("stepPrompt", {
      lng: language,
      title: step.title,
      goal: step.goal || step.question || "",
      references: JSON.stringify(refs),
      depth: $("codebase-depth")?.value || "simple",
    }),
  );
  $("view-chat").click();
}
function render() {
  const host = $("codebase-cockpit"),
    id = state.session?.id;
  if (!isCodebase() || !host) return;
  const previousScroll = host.scrollTop;
  host.replaceChildren();
  const title = node("h2", "", state.session.title);
  title.tabIndex = -1;
  title.id = "codebase-project-title";
  host.append(title);
  const inventory = snapshot?.inventory;
  if (inventory)
    host.append(
      node(
        "p",
        "muted",
        tr("inventory", {
          files: formatNumber(inventory.fileCount || 0),
          languages:
            (inventory.languages || [])
              .map((l) => (typeof l === "string" ? l : l.language || l.name))
              .join(", ") || tr("unknownLanguage"),
        }),
      ),
    );
  const status = node("p", "codebase-status");
  status.setAttribute("role", "status");
  const job = snapshot?.job;
  const running =
    job &&
    ![
      "done",
      "completed",
      "cancelled",
      "failed",
      "interrupted",
      "expired",
    ].includes(job.status);
  status.textContent = running
    ? tr("analyzing", { phase: tr(`phases.${job.phase || job.status}`) })
    : snapshot?.freshness === "stale" || snapshot?.freshness?.stale
      ? tr("stale")
      : snapshot?.analysis
        ? tr("current")
        : tr("notAnalyzed");
  host.append(status);
  if (job?.error)
    host.append(
      node(
        "p",
        "form-error",
        tr("errors.analysis", {
          reason: job.error.code || job.error.message || String(job.error),
        }),
      ),
    );
  const actions = node("div", "codebase-actions");
  const start = button(
    snapshot?.analysis ? tr("reanalyze") : tr("analyze"),
    "bulb",
    () => startAnalysis().catch(report),
    "primary",
  );
  start.disabled = Boolean(running || analysisStarting || !state.ready);
  actions.append(
    start,
    button(tr("viewFiles"), "folder", () => {
      showView("code");
      $("tab-files").click();
      emit("close-sidebar");
    }),
  );
  if (running)
    actions.append(
      button(t("common:actions.cancel"), "stop", () =>
        api(
          `${codebaseURL(id)}/analyses/${encodeURIComponent(job.analysisId || job.id)}/cancel`,
          { method: "POST", body: {} },
        )
          .then(refresh)
          .catch(report),
      ),
    );
  if (!state.ready)
    actions.append(
      button(tr("connect"), "settings", () => $("settings-btn").click()),
    );
  host.append(actions, node("p", "muted", tr("manualOnly")));
  if (inventory?.applications?.length) {
    const label = node("label", "field", tr("focusApplication")),
      select = node("select");
    const all = node("option", "", tr("wholeProject"));
    all.value = "";
    select.append(all);
    for (const application of inventory.applications) {
      const value = application.path || application.root || "";
      if (!value) continue;
      const option = node("option", "", application.name || value);
      option.value = value;
      select.append(option);
    }
    select.value = focus;
    select.onchange = () => {
      focus = select.value;
    };
    label.append(select);
    host.append(label);
  }
  const analysisLabel = node("label", "field", tr("analysisDepth")),
    analysisSelect = node("select");
  for (const key of ["overview", "deep"]) {
    const option = node(
      "option",
      "",
      tr(key === "overview" ? "analysisOverview" : "analysisDeep"),
    );
    option.value = key;
    analysisSelect.append(option);
  }
  analysisSelect.value = analysisDepth;
  analysisSelect.onchange = () => {
    analysisDepth = analysisSelect.value;
  };
  analysisLabel.append(analysisSelect);
  host.append(analysisLabel);
  if (inventory) {
    const details = node("details");
    details.append(
      node("summary", "", tr("scope")),
      node(
        "p",
        "muted",
        tr("modelScope", {
          provider: inventory.provider || state.settings.provider || "",
          model:
            inventory.model ||
            state.settings.activeModel ||
            state.settings.openAIModel ||
            "",
          tokens: formatNumber(inventory.estimatedTokens || 0),
        }),
      ),
    );
    if (snapshot?.analysis?.coverage) {
      const coverage = snapshot.analysis.coverage;
      details.append(
        node(
          "p",
          "muted",
          tr("coverage", {
            examined: coverage.examinedFiles?.length || 0,
            total: coverage.totalFiles || 0,
            omissions: coverage.omissions || 0,
          }),
        ),
      );
      const sources = node("ul");
      for (const path of coverage.examinedFiles || [])
        sources.append(node("li", "", path));
      details.append(sources);
    }
    host.append(details);
  }
  const analysis = snapshot?.analysis;
  if (analysis) {
    const purpose = section(
      tr("overview"),
      typeof analysis.purpose === "string"
        ? analysis.purpose
        : analysis.purpose?.text,
    );
    purpose.append(references(analysis.purpose?.references, id));
    if (analysis.purpose?.inferred)
      purpose.append(node("small", "muted", tr("inferred")));
    host.append(purpose);
    if (analysis.uncertainties?.length)
      host.append(
        section(
          tr("partial"),
          analysis.uncertainties
            .map((x) => (typeof x === "string" ? x : x.text || x.reason))
            .join("\n"),
        ),
      );
    const entries = section(tr("startHere"));
    for (const entry of analysis.entryPoints || []) {
      const card = node("article");
      card.append(
        node("h4", "", entry.title),
        node("p", "", entry.reason),
        references(entry.references, id),
      );
      entries.append(card);
    }
    host.append(entries);
    const modules = section(tr("modules"));
    for (const [index, module] of (analysis.modules || []).entries()) {
      const card = node(index < 4 ? "article" : "details");
      card.append(
        node(index < 4 ? "h4" : "summary", "", module.title),
        node("p", "", module.responsibility),
        references(module.references, id),
      );
      modules.append(card);
    }
    host.append(modules);
    if (analysis.flows?.length) {
      const flows = section(tr("flows"));
      for (const flow of analysis.flows) {
        const details = node("details");
        const steps = node("ol");
        for (const step of flow.steps || []) {
          const li = node("li", "", step.text);
          li.append(references(step.references, id));
          steps.append(li);
        }
        details.append(node("summary", "", flow.title), steps);
        flows.append(details);
      }
      host.append(flows);
    }
    if (analysis.tour?.length) {
      const tour = section(tr("tour"));
      const list = node("ol", "codebase-tour-list");
      const current =
        analysis.tour.find(
          (s) => s.id === (activeStep || snapshot.tour?.currentStepId),
        ) || analysis.tour[0];
      for (const step of analysis.tour) {
        const row = node("li");
        const visit = button(step.title, null, () =>
          progress(step, "visit").catch(report),
        );
        visit.setAttribute("aria-current", String(step.id === current.id));
        row.append(visit);
        if (snapshot.tour?.understoodStepIds?.includes(step.id))
          row.append(node("small", "muted", tr("understoodShort")));
        else if (snapshot.tour?.visitedStepIds?.includes(step.id))
          row.append(node("small", "muted", tr("visited")));
        list.append(row);
      }
      const step = node("article", "codebase-tour-step");
      step.append(
        node("h4", "", current.title),
        node("p", "", current.goal),
        node(
          "p",
          "muted",
          Array.isArray(current.prerequisites)
            ? current.prerequisites.join(", ")
            : current.prerequisites || "",
        ),
        node("p", "", current.explanation || current.question || ""),
        references(current.references, id),
      );
      const understood = button(tr("understood"), "check", () =>
        progress(current, "understand").catch(report),
      );
      const stepActions = node("div", "codebase-actions");
      const index = analysis.tour.indexOf(current);
      const back = button(tr("previous"), null, () =>
        progress(analysis.tour[index - 1], "visit").catch(report),
      );
      back.disabled = index < 1;
      const next = button(tr("next"), null, () =>
        progress(analysis.tour[index + 1], "visit").catch(report),
      );
      next.disabled = index === analysis.tour.length - 1;
      const explain = button(tr("explainStep"), "bulb", () =>
        explainStep(current).catch(report),
      );
      explain.disabled = !state.ready;
      stepActions.append(back, next, understood, explain);
      step.append(stepActions);
      tour.append(list, step, node("p", "muted", tr("tourHelp")));
      host.append(tour);
    }
    const depthLabel = node("label", "field", tr("depth")),
      depth = node("select");
    depth.id = "codebase-depth";
    for (const key of ["simple", "technical", "brief"]) {
      const option = node("option", "", tr(key));
      option.value = key;
      depth.append(option);
    }
    depth.value = explanationDepth;
    depth.onchange = () => {
      explanationDepth = depth.value;
    };
    depthLabel.append(depth);
    host.append(depthLabel);
    const questions = section(tr("askMore"));
    for (const key of ["questionPurpose", "questionFlow", "questionTests"])
      questions.append(
        button(tr(key), "question", () => {
          sendMessage(
            tr(key, { lng: state.session.tutorLocale || getLocale() }),
          ).catch(report);
          $("view-chat").click();
        }),
      );
    host.append(questions);
  }
  const demos = section(tr("demos"));
  host.append(demos);
  renderDemos(demos, id).catch(report);
  host.scrollTop = previousScroll;
}
async function refresh() {
  const id = state.session?.id,
    token = generation;
  if (!isCodebase()) return;
  const data = await api(`${codebaseURL(id)}/analyses/current`);
  if (state.session?.id !== id || token !== generation) return;
  snapshot = data;
  const currentStep =
    data.analysis?.tour?.find(
      (step) => step.id === (activeStep || data.tour?.currentStepId),
    ) || data.analysis?.tour?.[0];
  if (currentStep && !data.tour?.visitedStepIds?.includes(currentStep.id)) {
    const tour = await api(`${codebaseURL(id)}/tour`, {
      method: "PATCH",
      body: {
        analysisId: data.analysis.analysisId,
        stepId: currentStep.id,
        action: "visit",
        expectedVersion: data.tour?.version || 0,
      },
    });
    if (state.session?.id !== id || token !== generation) return;
    snapshot.tour = tour;
  }
  render();
  clearTimeout(timer);
  if (
    data.job &&
    ![
      "completed",
      "done",
      "failed",
      "cancelled",
      "interrupted",
      "expired",
    ].includes(data.job.status)
  )
    timer = setTimeout(() => refresh().catch(report), 900);
}
async function startAnalysis() {
  if (analysisStarting) return;
  analysisStarting = true;
  const id = state.session?.id;
  render();
  try {
    await flush();
    if (state.session?.id !== id) return;
    const result = await api(`${codebaseURL(id)}/analyses`, {
      method: "POST",
      body: {
        operationId: randomUUID(),
        depth: analysisDepth,
        focus,
        expectedManifestDigest: snapshot?.inventory?.manifestDigest,
      },
    });
    if (state.session?.id !== id) return;
    snapshot = { ...snapshot, job: result };
    await refresh();
  } finally {
    analysisStarting = false;
    if (state.session?.id === id) render();
  }
}
export function initCodebase() {
  const panel = $("editor-panel");
  const tabs = node("nav", "codebase-tabs");
  tabs.id = "codebase-tabs";
  tabs.hidden = true;
  tabs.setAttribute("role", "tablist");
  tabs.setAttribute("aria-label", tr("views"));
  for (const key of ["code", "understand"]) {
    const tab = button(tr(key), null, () => showView(key));
    tab.id = `codebase-tab-${key}`;
    tab.setAttribute("role", "tab");
    tab.setAttribute(
      "aria-controls",
      key === "understand" ? "codebase-cockpit" : "editor-container",
    );
    tabs.append(tab);
    tab.onkeydown = (event) => {
      if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
        const target = key === "code" ? "understand" : "code";
        showView(target);
        $(`codebase-tab-${target}`).focus();
        event.preventDefault();
      }
    };
  }
  const cockpit = node("section", "codebase-cockpit");
  cockpit.id = "codebase-cockpit";
  cockpit.hidden = true;
  cockpit.setAttribute("role", "tabpanel");
  cockpit.setAttribute("aria-labelledby", "codebase-tab-understand");
  const back = button(
    tr("returnTour"),
    "plan",
    () => showView("understand"),
    "text-button",
  );
  back.id = "codebase-tour-return";
  back.hidden = true;
  panel.prepend(tabs);
  const parentLink = button(
    tr("returnProject"),
    "folder",
    () => openSession(state.session.project.parentSessionId),
    "text-button",
  );
  parentLink.id = "codebase-demo-parent";
  parentLink.hidden = true;
  panel.prepend(parentLink);
  panel.append(back, cockpit);
  const explain = node("div", "codebase-editor-actions");
  explain.id = "codebase-editor-actions";
  explain.hidden = true;
  explain.append(
    button(tr("explainSelection"), "bulb", () => explainSelection()),
    button(tr("explainContext"), "question", () => explainSelection(true)),
  );
  $("file-info")?.after(explain) || $("editor-container").before(explain);
  on("session-opened", async () => {
    generation++;
    navigation++;
    clearTimeout(timer);
    snapshot = null;
    activeStep = null;
    scrollTop = 0;
    focus = "";
    const codebase = isCodebase();
    parentLink.hidden =
      state.session?.mode !== "demo" || !state.session.project?.parentSessionId;
    panel.classList.toggle("codebase-session", codebase);
    tabs.hidden = explain.hidden = !codebase;
    cockpit.hidden = back.hidden = true;
    panel.classList.remove("codebase-understanding");
    if (codebase) {
      $("terminal-panel").hidden = true;
      showView("understand");
      await refresh();
      $("codebase-project-title")?.focus();
    }
  });
  on("models-changed", () => {
    if (isCodebase() && snapshot) render();
  });
  on("file-selected", () => {
    if (isCodebase()) {
      showView("code");
      $("view-editor").click();
    }
  });
  on("file-active", () => {
    if (isCodebase() && view !== "understand") showView("code");
  });
  on("save-state", (record) => {
    if (isCodebase() && snapshot?.analysis && record?.dirty) {
      snapshot.freshness = "stale";
      render();
    }
  });
  on("files-changed", () => {
    if (isCodebase()) refresh().catch(report);
  });
  on("explain-code-reference", async ({ reference, projectContext, draft }) => {
    const id = state.session?.id;
    await flush();
    if (state.session?.id !== id) return;
    // A dirty selection is saved first; resolving its previous hash would mislabel it.
    const query = new URLSearchParams({
      path: reference.path,
      startLine: reference.startLine,
      endLine: reference.endLine,
      bindCurrent: "true",
    });
    const resolved = await api(
      `${codebaseURL(id)}/references/resolve?${query}`,
    );
    if (state.session?.id !== id) return;
    await sendMessage(
      tr(projectContext ? "contextPrompt" : "selectionPrompt", {
        lng: state.session.tutorLocale || getLocale(),
        reference: JSON.stringify({
          ...reference,
          fileVersion:
            resolved.fileVersion || resolved.version || reference.fileVersion,
        }),
        draft: draft ? tr("savedDraft") : "",
      }),
      { codeReference: resolved },
    );
    $("view-chat").click();
  });
  on("codebase-reference", (reference) =>
    navigateReference(reference).catch(report),
  );
  window.addEventListener("code-reference-discovery", async ({ detail }) => {
    if (!isCodebase() || !detail.element.isConnected) return;
    const match = detail.text.match(/^(.+)#L(\d+)(?:-L(\d+))?$/);
    if (
      !match ||
      !/^[\w./-]+$/.test(match[1]) ||
      match[1].split("/").includes("..")
    )
      return;
    const id = state.session.id;
    const reference = {
      sessionId: id,
      path: match[1],
      startLine: Number(match[2]),
      endLine: Number(match[3] || match[2]),
    };
    try {
      const resolved = await api(
        `${codebaseURL(id)}/references/resolve?${new URLSearchParams({ ...reference, bindCurrent: "true" })}`,
      );
      if (state.session?.id !== id || !detail.element.isConnected) return;
      const control = button(
        detail.text,
        "file",
        () =>
          navigateReference(
            { ...reference, fileVersion: resolved.fileVersion },
            control,
          ).catch(report),
        "text-button",
      );
      detail.element.replaceWith(control);
    } catch {
      /* Unresolved source text remains plain text. */
    }
  });
}
