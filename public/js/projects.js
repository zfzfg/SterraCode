import { t, getLocale, getFormatLocale } from "./i18n.js";
import { api, workspaceURL, sessionURL } from "./api.js";
import { state } from "./state.js";
import { node, toast, formDialog } from "./ui.js";
import { flush } from "./editor.js";
import { openSession, loadSessions } from "./sessions.js";
import { randomUUID } from "./uuid.js";

function dialog(title) {
  const opener = document.activeElement;
  const box = node("dialog", "learning-dialog");
  const heading = node("h2", "", title);
  heading.id = "learning-dialog-title";
  box.setAttribute("aria-labelledby", heading.id);
  const close = node("button", "", t("features:shared.close"));
  close.onclick = () => box.close();
  box.append(heading, close);
  document.body.append(box);
  box.addEventListener(
    "close",
    () => {
      box.remove();
      if (opener?.isConnected) opener.focus();
    },
    { once: true },
  );
  box.showModal();
  return box;
}
function download(pkg) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(pkg, null, 2)], { type: "application/json" }),
  );
  const link = node("a");
  link.href = url;
  link.download = "sterracode-projekt.json";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}
async function finishImport(box, session, sourceId) {
  await loadSessions();
  if (!box.isConnected || !box.open || state.session?.id !== sourceId) return;
  box.close();
  await openSession(session.id);
}
export async function openProjects() {
  const sourceId = state.session?.id;
  const box = dialog(t("features:projects.title"));
  const status = node("p", "", t("features:projects.loading"));
  status.setAttribute("role", "status");
  box.append(status);
  try {
    const templates = await api("/api/projects/templates");
    if (!box.isConnected) return;
    status.textContent = t("features:projects.help");
    for (const template of templates) {
      const card = node("section", "project-card");
      card.append(
        node("h3", "", template.title),
        node("p", "", template.goal),
        node(
          "p",
          "",
          t("features:projects.prerequisites", {
            p1: template.prerequisites.join(", "),
          }),
        ),
        node(
          "p",
          "",
          t("features:projects.milestone", { p1: template.milestone }),
        ),
        node(
          "p",
          "",
          t("features:projects.features", {
            p1: template.runtime,
            p2: template.features.join(", "),
          }),
        ),
        node(
          "p",
          "muted",
          t("features:projects.origin", {
            p1: template.origin,
            p2: template.version,
            p3: template.license,
            p4: template.files.join(", "),
          }),
        ),
      );
      const list = node("ul");
      for (const item of template.checklist) list.append(node("li", "", item));
      const start = node(
        "button",
        "",
        t("features:projects.start", { p1: template.title }),
      );
      const operationId = randomUUID();
      const contentLocale = getLocale();
      start.onclick = async () => {
        start.disabled = true;
        try {
          await flush();
          const session = await api("/api/projects/import", {
            method: "POST",
            body: {
              templateId: template.id,
              operationId,
              contentLocale,
              tutorLocale: contentLocale,
            },
          });
          await finishImport(box, session, sourceId);
        } catch (e) {
          toast(e.message, "error");
          start.disabled = false;
        }
      };
      card.append(list, start);
      box.append(card);
    }
    const label = node("label", "", t("features:projects.selectPackage"));
    const input = node("input");
    input.type = "file";
    input.accept = ".json,application/json";
    label.append(input);
    const review = node("p");
    const importButton = node("button", "", t("features:projects.import"));
    importButton.disabled = true;
    let pkg,
      operationId,
      contentLocale,
      generation = 0;
    input.onchange = async () => {
      const token = ++generation;
      importButton.disabled = true;
      pkg = null;
      try {
        const file = input.files[0];
        if (!file) return;
        if (file.size > 3 * 1024 * 1024)
          throw new Error(t("features:projects.tooLarge"));
        const candidate = JSON.parse(await file.text());
        if (token !== generation || !box.isConnected) return;
        if (
          candidate?.format !== "sterracode-project" ||
          candidate.schemaVersion !== 1 ||
          !Array.isArray(candidate.files) ||
          candidate.files.some((f) => typeof f?.path !== "string")
        )
          throw new Error(t("features:projects.unsupported"));
        review.textContent = t("features:projects.packagePreview", {
          p1: candidate.title,
          p2: candidate.language,
          p3: candidate.files.map((f) => f.path).join(", "),
          p4: candidate.task?.title || t("features:projects.noTask"),
        });
        pkg = candidate;
        operationId = randomUUID();
        contentLocale = getLocale();
        importButton.disabled = false;
      } catch (e) {
        if (token === generation) review.textContent = e.message;
      }
    };
    importButton.onclick = async () => {
      importButton.disabled = true;
      input.disabled = true;
      try {
        await flush();
        const session = await api("/api/projects/import", {
          method: "POST",
          body: {
            package: pkg,
            operationId,
            contentLocale,
            tutorLocale: contentLocale,
          },
        });
        await finishImport(box, session, sourceId);
      } catch (e) {
        toast(e.message, "error");
        importButton.disabled = false;
      } finally {
        input.disabled = false;
      }
    };
    box.append(label, review, importButton);
  } catch (e) {
    if (box.isConnected) status.textContent = e.message;
  }
}

export async function openExport() {
  if (!state.session) throw new Error(t("features:shared.openSession"));
  await flush();
  const sessionId = state.session.id;
  const box = dialog(t("features:projects.export"));
  box.append(node("p", "", t("features:projects.exportHelp")));
  try {
    const files = await api(`${workspaceURL(sessionId)}/project-files`);
    if (!box.isConnected || state.session?.id !== sessionId) return;
    const inputs = [];
    const fieldset = node("fieldset");
    fieldset.append(node("legend", "", t("features:projects.sources")));
    for (const p of files) {
      const label = node("label", "package-file");
      const input = node("input");
      input.type = "checkbox";
      input.value = p;
      label.append(input, document.createTextNode(p));
      fieldset.append(label);
      inputs.push(input);
    }
    const save = node("button", "", t("features:projects.exportSelected"));
    const status = node("p");
    status.setAttribute("role", "status");
    save.onclick = async () => {
      save.disabled = true;
      try {
        if (state.session?.id !== sessionId)
          throw new Error(t("features:projects.sessionChanged"));
        await flush();
        const paths = inputs.filter((i) => i.checked).map((i) => i.value);
        if (!paths.length || paths.length > 50)
          throw new Error(t("features:projects.selectFiles"));
        const session = await api(sessionURL(sessionId));
        const expectedVersions = {};
        for (const p of paths)
          expectedVersions[p] = (
            await api(
              `${workspaceURL(sessionId)}/files/content?path=${encodeURIComponent(p)}`,
            )
          ).version;
        const pkg = await api(`${workspaceURL(sessionId)}/project-export`, {
          method: "POST",
          body: {
            paths,
            expectedVersions,
            taskVersion: session.currentTask
              ? session.currentTask.taskVersion || 1
              : null,
          },
        });
        if (!box.isConnected || state.session?.id !== sessionId) return;
        download(pkg);
        status.textContent = t("features:projects.created");
      } catch (e) {
        if (box.isConnected) status.textContent = e.message;
      } finally {
        save.disabled = false;
      }
    };
    box.append(fieldset, save, status);
  } catch (e) {
    if (box.isConnected) box.append(node("p", "", e.message));
  }
}

export async function openJournal() {
  if (!state.session) throw new Error(t("features:shared.openSession"));
  const sessionId = state.session.id;
  const box = dialog(t("features:projects.journal"));
  box.append(node("p", "muted", t("features:projects.journalHelp")));
  try {
    const entries = await api(`${workspaceURL(sessionId)}/journal`);
    if (!box.isConnected || state.session?.id !== sessionId) return;
    if (!entries.some((e) => e.text))
      box.append(node("p", "", t("features:projects.noJournal")));
    for (const entry of entries.filter((e) => e.text).reverse()) {
      const card = node("section", "project-card");
      card.append(
        node("h3", "", entry.title),
        node(
          "p",
          "muted",
          t("features:projects.journalDetails", {
            p1: entry.taskVersion,
            p2: new Date(entry.updatedAt).toLocaleString(getFormatLocale()),
            p3: entry.testRunId
              ? t("features:projects.testRun", { p1: entry.testRunId })
              : "",
          }),
        ),
        node("p", "", entry.text),
      );
      const edit = node("button", "", t("features:projects.editEntry"));
      edit.onclick = async () => {
        box.close();
        await formDialog({
          title: t("features:projects.editJournal"),
          fields: [
            {
              name: "text",
              label: t("features:projects.reflection"),
              type: "textarea",
              maxLength: 2000,
              value: entry.text,
            },
          ],
          onSave: async ({ text }) => {
            const result = await api(
              `${workspaceURL(sessionId)}/tasks/${encodeURIComponent(entry.taskId)}/journal`,
              {
                method: "PUT",
                body: {
                  taskVersion: entry.taskVersion,
                  text,
                  expectedVersion: entry.version,
                },
              },
            );
            if (
              state.session?.id === sessionId &&
              result.revision >= state.session.revision
            )
              state.session = result;
          },
        });
        if (state.session?.id === sessionId) await openJournal();
      };
      card.append(edit);
      box.append(card);
    }
  } catch (e) {
    if (box.isConnected) box.append(node("p", "", e.message));
  }
}
