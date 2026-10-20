import { t } from "./i18n.js";
import { api, workspaceURL } from "./api.js";
import { state } from "./state.js";
import { node, toast } from "./ui.js";
import { taskSection } from "./taskSections.js";

const drafts = new Map();

export const captureJournalDrafts = () => [...drafts];
export function restoreJournalDrafts(saved) {
  if (!Array.isArray(saved)) return;
  for (const entry of saved.slice(-100)) {
    if (
      Array.isArray(entry) &&
      typeof entry[0] === "string" &&
      typeof entry[1] === "string" &&
      entry[1].length <= 2000
    )
      drafts.set(entry[0], entry[1]);
  }
}

export function renderLearningSupport(container, task, rerender) {
  const sessionId = state.session.id;
  const version = task.taskVersion || 1;
  const draftKey = `${sessionId}:${task.id}:${version}`;
  const current = () =>
    section.isConnected &&
    state.session?.id === sessionId &&
    state.session.currentTask?.id === task.id &&
    (state.session.currentTask.taskVersion || 1) === version;
  const base = `${workspaceURL(sessionId)}/tasks/${encodeURIComponent(task.id)}`;
  const section = node("section", "learning-support");
  const opened = task.hintUsage?.count || 0;
  const hints = taskSection(
    task,
    "hint-ladder",
    t("features:learningSupport.hintsOpened", {
      count: task.hints?.length || 0,
      p1: opened,
      p2: task.hints?.length || 0,
    }),
  );
  hints.hidden = !task.hints?.length;
  if (task.hints?.length) {
    task.hints.slice(0, opened).forEach((hint, index) => {
      const detail = node("details");
      detail.open = index === opened - 1;
      detail.append(
        node(
          "summary",
          "",
          t("features:learningSupport.hint", { p1: index + 1 }),
        ),
        node("p", "", hint),
      );
      hints.append(detail);
    });
    const next = node(
      "button",
      "",
      opened >= task.hints.length
        ? t("features:learningSupport.allHints", { count: task.hints.length })
        : opened === 3
          ? t("features:learningSupport.solutionHint")
          : t("features:learningSupport.nextHint"),
    );
    next.disabled = opened >= task.hints.length;
    next.onclick = async () => {
      next.disabled = true;
      try {
        const result = await api(`${base}/hints`, {
          method: "POST",
          body: { taskVersion: version, index: opened + 1 },
        });
        if (!current()) return;
        if (result.revision >= state.session.revision) state.session = result;
        // Keep an unfinished journal draft intact while opening a hint.
        const draft = text.value;
        rerender();
        const restored = document.getElementById("task-journal-text");
        if (restored) restored.value = draft;
        document.querySelector(".hint-ladder button")?.focus();
      } catch (e) {
        if (current()) {
          toast(e.message, "error");
          next.disabled = false;
        }
      }
    };
    hints.append(
      next,
      node("p", "muted", t("features:learningSupport.hintHelp")),
    );
  }
  const entry = state.session.learningJournal?.find(
    (e) => e.taskId === task.id && e.taskVersion === version,
  );
  const label = node("label", "", t("features:learningSupport.reflection"));
  const text = node("textarea");
  text.id = "task-journal-text";
  label.htmlFor = text.id;
  text.maxLength = 2000;
  text.rows = 2;
  text.value = drafts.get(draftKey) ?? entry?.text ?? "";
  text.oninput = () => {
    if (!drafts.has(draftKey) && drafts.size >= 100)
      drafts.delete(drafts.keys().next().value);
    drafts.set(draftKey, text.value);
  };
  const save = node("button", "", t("features:learningSupport.save"));
  let expectedVersion = entry?.version || 0;
  save.onclick = async () => {
    save.disabled = true;
    const submitted = text.value;
    try {
      const result = await api(`${base}/journal`, {
        method: "PUT",
        body: {
          taskVersion: version,
          text: submitted,
          expectedVersion,
        },
      });
      if (!current()) return;
      expectedVersion =
        result.learningJournal?.find(
          (e) => e.taskId === task.id && e.taskVersion === version,
        )?.version || 0;
      if (result.revision >= state.session.revision) state.session = result;
      if (text.value === submitted) drafts.delete(draftKey);
      toast(t("features:learningSupport.saved"));
    } catch (e) {
      if (current()) toast(e.message, "error");
    } finally {
      if (current()) save.disabled = false;
    }
  };
  const reflection = node("details", "task-reflection");
  reflection.append(
    node("summary", "", t("features:learningSupport.journal")),
    label,
    text,
    save,
  );
  section.append(hints, reflection);
  if (!task.testSuite && !task.done) {
    const finish = node("button", "", t("features:learningSupport.finish"));
    finish.onclick = async () => {
      finish.disabled = true;
      try {
        const result = await api(`${base}/complete`, {
          method: "POST",
          body: { taskVersion: version, assistance: "not_recorded" },
        });
        if (!current()) return;
        if (result.revision >= state.session.revision) state.session = result;
        // Reflection is separately saved on purpose, never discarded by completion.
        const draft = text.value;
        rerender();
        const restored = document.getElementById("task-journal-text");
        if (restored) restored.value = draft;
      } catch (e) {
        if (current()) {
          toast(e.message, "error");
          finish.disabled = false;
        }
      }
    };
    section.append(
      finish,
      node("small", "muted", t("features:learningSupport.selfCompleted")),
    );
  }
  container.append(section);
}
