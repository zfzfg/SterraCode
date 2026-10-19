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
  const close = node("button", "", "Schließen");
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
  const box = dialog("Projektwerkstatt");
  const status = node("p", "", "Vorlagen werden geladen …");
  status.setAttribute("role", "status");
  box.append(status);
  try {
    const templates = await api("/api/projects/templates");
    if (!box.isConnected) return;
    status.textContent =
      "Vorlagen und Pakete öffnen eine neue Session. Es werden keine Programme installiert oder gestartet.";
    for (const t of templates) {
      const card = node("section", "project-card");
      card.append(
        node("h3", "", t.title),
        node("p", "", t.goal),
        node("p", "", `Voraussetzungen: ${t.prerequisites.join(", ")}`),
        node("p", "", `Erster Meilenstein: ${t.milestone}`),
        node("p", "", `${t.runtime} · Funktionen: ${t.features.join(", ")}`),
        node(
          "p",
          "muted",
          `${t.origin} · Version ${t.version} · ${t.license} · Dateien: ${t.files.join(", ")}`,
        ),
      );
      const list = node("ul");
      for (const item of t.checklist) list.append(node("li", "", item));
      const start = node("button", "", `${t.title} starten`);
      const operationId = randomUUID();
      start.onclick = async () => {
        start.disabled = true;
        try {
          await flush();
          const session = await api("/api/projects/import", {
            method: "POST",
            body: { templateId: t.id, operationId },
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
    const label = node(
      "label",
      "",
      "Projektpaket auswählen (JSON, maximal 3 MiB)",
    );
    const input = node("input");
    input.type = "file";
    input.accept = ".json,application/json";
    label.append(input);
    const review = node("p");
    const importButton = node(
      "button",
      "",
      "Paket in neue Session importieren",
    );
    importButton.disabled = true;
    let pkg,
      operationId,
      generation = 0;
    input.onchange = async () => {
      const token = ++generation;
      importButton.disabled = true;
      pkg = null;
      try {
        const file = input.files[0];
        if (!file) return;
        if (file.size > 3 * 1024 * 1024)
          throw new Error("Das Paket ist größer als 3 MiB.");
        const candidate = JSON.parse(await file.text());
        if (token !== generation || !box.isConnected) return;
        if (
          candidate?.format !== "sterracode-project" ||
          candidate.schemaVersion !== 1 ||
          !Array.isArray(candidate.files) ||
          candidate.files.some((f) => typeof f?.path !== "string")
        )
          throw new Error("Kein unterstütztes SterraCode-Projektpaket.");
        review.textContent = `${candidate.title} · ${candidate.language} · Dateien: ${candidate.files.map((f) => f.path).join(", ")} · Aufgabe: ${candidate.task?.title || "keine"}. Das Paket wird serverseitig auf Pfade, Umfang und Manifest geprüft.`;
        pkg = candidate;
        operationId = randomUUID();
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
          body: { package: pkg, operationId },
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
  if (!state.session) throw new Error("Bitte zuerst eine Session öffnen.");
  await flush();
  const sessionId = state.session.id;
  const box = dialog("Projekt exportieren");
  box.append(
    node(
      "p",
      "",
      "Wähle den Quelltext bewusst aus. Sichtbare Aufgabe und Tests werden mitgenommen. Profile, Journal, Zugangsdaten, Backups und Ausführungsartefakte gehören nicht zum Paket. Prüfe deine Quelldateien vor dem Weitergeben auf persönliche Inhalte.",
    ),
  );
  try {
    const files = await api(`${workspaceURL(sessionId)}/project-files`);
    if (!box.isConnected || state.session?.id !== sessionId) return;
    const inputs = [];
    const fieldset = node("fieldset");
    fieldset.append(node("legend", "", "Quelldateien (höchstens 50 / 2 MiB)"));
    for (const p of files) {
      const label = node("label", "package-file");
      const input = node("input");
      input.type = "checkbox";
      input.value = p;
      label.append(input, document.createTextNode(p));
      fieldset.append(label);
      inputs.push(input);
    }
    const save = node("button", "", "Ausgewählte Dateien exportieren");
    const status = node("p");
    status.setAttribute("role", "status");
    save.onclick = async () => {
      save.disabled = true;
      try {
        if (state.session?.id !== sessionId)
          throw new Error("Die Session wurde gewechselt.");
        await flush();
        const paths = inputs.filter((i) => i.checked).map((i) => i.value);
        if (!paths.length || paths.length > 50)
          throw new Error("Bitte 1–50 Dateien auswählen.");
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
        status.textContent = "Projektpaket erstellt.";
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
  if (!state.session) throw new Error("Bitte zuerst eine Session öffnen.");
  const sessionId = state.session.id;
  const box = dialog("Lernjournal");
  box.append(
    node(
      "p",
      "muted",
      "Deine freiwilligen persönlichen Notizen. Leerer Text entfernt einen Eintrag.",
    ),
  );
  try {
    const entries = await api(`${workspaceURL(sessionId)}/journal`);
    if (!box.isConnected || state.session?.id !== sessionId) return;
    if (!entries.some((e) => e.text))
      box.append(
        node(
          "p",
          "",
          "Noch keine Einträge. Du kannst direkt bei einer Aufgabe einen Satz festhalten.",
        ),
      );
    for (const entry of entries.filter((e) => e.text).reverse()) {
      const card = node("section", "project-card");
      card.append(
        node("h3", "", entry.title),
        node(
          "p",
          "muted",
          `Persönlicher Eintrag · Aufgabenstand ${entry.taskVersion} · ${new Date(entry.updatedAt).toLocaleString("de-DE")}${entry.testRunId ? ` · Testlauf ${entry.testRunId}` : ""}`,
        ),
        node("p", "", entry.text),
      );
      const edit = node("button", "", "Eintrag bearbeiten");
      edit.onclick = async () => {
        box.close();
        await formDialog({
          title: "Journaleintrag bearbeiten",
          fields: [
            {
              name: "text",
              label: "Persönliche Reflexion",
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
