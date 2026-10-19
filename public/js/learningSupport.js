import { api, workspaceURL } from "./api.js";
import { state } from "./state.js";
import { node, toast } from "./ui.js";

const drafts = new Map();

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
  const hints = node("div", "hint-ladder");
  const opened = task.hintUsage?.count || 0;
  if (task.hints?.length) {
    hints.append(
      node("strong", "", `Hinweise: ${opened}/${task.hints.length} geöffnet`),
    );
    task.hints.slice(0, opened).forEach((hint, index) => {
      const detail = node("details");
      detail.open = index === opened - 1;
      detail.append(
        node("summary", "", `Hinweis ${index + 1}`),
        node("p", "", hint),
      );
      hints.append(detail);
    });
    const next = node(
      "button",
      "",
      opened >= task.hints.length
        ? "Alle Hinweise geöffnet"
        : opened === 3
          ? "Lösungshinweis freiwillig öffnen"
          : "Nächsten Hinweis öffnen",
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
      node(
        "p",
        "muted",
        "Hinweise ändern keine Datei. Verwendete Hilfe wird ohne Punktabzug erfasst.",
      ),
    );
  }
  const entry = state.session.learningJournal?.find(
    (e) => e.taskId === task.id && e.taskVersion === version,
  );
  const label = node(
    "label",
    "",
    "Freiwilliges Lernjournal: Was hast du verstanden, was war schwierig?",
  );
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
  const save = node("button", "", "Journaleintrag speichern");
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
      toast("Journaleintrag gespeichert.");
    } catch (e) {
      if (current()) toast(e.message, "error");
    } finally {
      if (current()) save.disabled = false;
    }
  };
  const reflection = node("details", "task-reflection");
  reflection.append(
    node("summary", "", "Freiwilliges Lernjournal"),
    label,
    text,
    save,
  );
  section.append(hints, reflection);
  if (!task.testSuite && !task.done) {
    const finish = node("button", "", "Nach eigener Prüfung abschließen");
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
      node("small", "muted", "Eigener Abschluss ohne Testnachweis."),
    );
  }
  container.append(section);
}
